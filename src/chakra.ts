import fs from 'fs';
import path from 'path';
import os from 'os';
import tmp from 'tmp-promise';
import { v4 as uuidv4 } from 'uuid';
import axios, { AxiosInstance } from 'axios';
import chalk from 'chalk';
import { SingleBar, Presets } from 'cli-progress';
import { ParquetSchema, ParquetWriter } from '@dsnp/parquetjs';
import { ChakraAPIError, ChakraAuthError } from './exceptions.js';
import { Transform } from 'stream';

const BASE_URL = 'https://api.chakra.dev';
const TOKEN_PREFIX = 'DDB_';
export const VERSION = '1.0.22';

class ProgressStream extends Transform {
  private transferred = 0;
  constructor(private total: number, private bar: SingleBar) {
    super();
    this.bar.start(total, 0);
  }
  _transform(chunk: Buffer, _enc: string, cb: () => void) {
    this.transferred += chunk.length;
    this.bar.update(this.transferred);
    this.push(chunk);
    cb();
  }
  _flush(cb: () => void) {
    this.bar.stop();
    cb();
  }
}

export class Chakra {
  private dbSessionKey: string;
  private tokenValue: string | null = null;
  private axiosInstance: AxiosInstance;
  private quiet: boolean;

  constructor(dbSessionKey: string, quiet = false) {
    this.dbSessionKey = dbSessionKey;
    this.quiet = quiet;
    this.axiosInstance = axios.create({ baseURL: BASE_URL });
    if (!quiet) {
      console.log(chalk.green(`\nChakra SDK v${VERSION}\n`));
    }
  }

  get token(): string | null {
    return this.tokenValue;
  }

  set token(val: string | null) {
    this.tokenValue = val;
    if (val) {
      this.axiosInstance.defaults.headers.common['Authorization'] = `Bearer ${val}`;
    } else {
      delete this.axiosInstance.defaults.headers.common['Authorization'];
    }
  }

  private async fetchToken(): Promise<string> {
    const [accessKeyId, secretAccessKey, username] = this.dbSessionKey.split(':');
    try {
      const res = await this.axiosInstance.post('/api/v1/servers', {
        accessKey: accessKeyId,
        secretKey: secretAccessKey,
        username: username,
      });
      return res.data.token;
    } catch (err: any) {
      this.handleApiError(err);
    }
    throw new ChakraAuthError('Unable to fetch token', {} as any);
  }

  public async login(): Promise<void> {
    if (!this.quiet) console.log(chalk.green('Authenticating with Chakra DB...'));
    const bar = new SingleBar({ format: 'Authenticating |{bar}| {percentage}%'}, Presets.rect);
    if (!this.quiet) bar.start(100, 0);
    try {
      if (!this.quiet) bar.update(30);
      const token = await this.fetchToken();
      if (!this.quiet) bar.update(70);
      if (!token.startsWith(TOKEN_PREFIX)) {
        throw new Error(`Token must start with '${TOKEN_PREFIX}'`);
      }
      this.token = token;
      if (!this.quiet) bar.update(100);
    } finally {
      if (!this.quiet) bar.stop();
    }
    if (!this.quiet) console.log(chalk.green('✓ Successfully authenticated!\n'));
  }

  private async ensureAuthenticated<T>(operation: () => Promise<T>): Promise<T> {
    const maxAttempts = 3;
    let attempt = 0;

    while (attempt < maxAttempts) {
      if (!this.token) {
        await this.login();
      }
      try {
        return await operation();
      } catch (err: any) {
        const status = err.response?.status;
        const isAuthError =
          (axios.isAxiosError(err) && status === 401) ||
          (err instanceof ChakraAPIError && status === 401);

        attempt += 1;
        if (isAuthError) {
          console.log(
            `Attempt ${attempt} failed with 401. Stale token. Attempting login...`
          );
          await this.login();
        } else {
          throw err;
        }
      }
    }

    throw new ChakraAuthError(
      `Failed to authenticate after ${maxAttempts} attempts.`
    );
  }

  private queryHasPositionalParameters(query: string): boolean {
    return /\$\d+/.test(query);
  }

  private replacePositionalParameters(query: string, parameters: any[]): { query: string; parameters: any[] } {
    const placeholderRegex = /\$(\d+)/g;
    const newParameters: any[] = [];
    const newQuery = query.replace(placeholderRegex, (_, g1) => {
      const idx = parseInt(g1, 10) - 1;
      if (idx < 0 || idx >= parameters.length) {
        throw new Error('Chakra DB does not support more than 8 positional parameters');
      }
      newParameters.push(parameters[idx]);
      return '?';
    });
    return { query: newQuery, parameters: newParameters };
  }

  private mapJsTypeToDuckDbType(value: any): string {
    if (typeof value === 'number') {
      return Number.isInteger(value) ? 'BIGINT' : 'DOUBLE';
    } else if (typeof value === 'boolean') {
      return 'BOOLEAN';
    } else if (value instanceof Date) {
      return 'TIMESTAMP';
    }
    return 'VARCHAR';
  }

  private async createDatabaseAndSchema(tableName: string): Promise<void> {
    const [databaseName, schemaName] = tableName.split('.');
    try {
      await this.axiosInstance.post('/api/v1/databases', {
        name: databaseName,
        insert_database: true,
      });
    } catch (err: any) {
      if (!(err.response && err.response.status === 409)) {
        this.handleApiError(err);
      }
    }
    console.log(chalk.yellow(`Creating schema if it doesn't exist: ${databaseName}.${schemaName}...`));
    const sql = `CREATE SCHEMA IF NOT EXISTS ${databaseName}.${schemaName}`;
    await this.axiosInstance.post('/api/v1/query', { sql });
  }

  private async createTable(tableName: string, data: any[]): Promise<void> {
    const sample = data[0];
    const columns = Object.entries(sample).map(
      ([col, val]) => `${col} ${this.mapJsTypeToDuckDbType(val)}`
    );
    console.log(chalk.yellow(`Creating table if it doesn't exist: ${tableName} (${columns.join(', ')})...`));
    const createSql = `CREATE TABLE IF NOT EXISTS ${tableName} (${columns.join(', ')})`;
    await this.axiosInstance.post('/api/v1/query', { sql: createSql });
  }

  private async replaceExistingTable(tableName: string): Promise<void> {
    console.log(chalk.yellow(`Replacing table ${tableName}...`));
    const dropSql = `DROP TABLE IF EXISTS ${tableName}`;
    await this.axiosInstance.post('/api/v1/query', { sql: dropSql });
  }

  private async requestPresignedUploadUrl(fileName: string): Promise<{ presignedUrl: string; key: string }> {
    const res = await this.axiosInstance.get('/api/v1/presigned-upload', {
      params: { filename: fileName },
    });
    return { presignedUrl: res.data.presignedUrl, key: res.data.key };
  }

  private async uploadParquetUsingPresignedUrl(presignedUrl: string, filePath: string): Promise<void> {
    const { size } = await fs.promises.stat(filePath);
    const bar = new SingleBar(Presets.shades_classic);
    bar.start(size, 0);

    const rawStream = fs.createReadStream(filePath);

    const prog = new ProgressStream(size, new SingleBar(Presets.shades_classic));
    rawStream.pipe(prog);

    await axios.put(presignedUrl, prog as any, {
      headers: {
        'Content-Type': 'application/parquet',
        'Content-Length': size,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    bar.stop();
  }

  private async importDataFromPresignedUrl(tableName: string, s3Key: string): Promise<void> {
    await this.axiosInstance.post('/api/v1/tables/s3_parquet_import', {
      table_name: tableName,
      s3_key: s3Key,
    });
  }

  private async importDataFromAppendOnlyDedup(
    tableName: string,
    s3Key: string,
    primaryKeyColumns: string[]
  ): Promise<void> {
    await this.axiosInstance.post(
      '/api/v1/tables/s3_parquet_import_append_only_dedupe',
      {
        table_name: tableName,
        s3_key: s3Key,
        primary_key_columns: primaryKeyColumns,
      }
    );
  }

  private async deleteFileFromS3(s3Key: string): Promise<void> {
    await this.axiosInstance.delete('/api/v1/files', {
      data: { fileName: s3Key },
    });
  }

  private handleApiError(err: any): never {
    if (axios.isAxiosError(err) && err.response) {
      const msg = err.response.data?.error || err.message;
      throw new ChakraAPIError(msg, err.response);
    }
    throw err;
  }
  
  public async push(
    tableName: string,
    data: any[],
    options: {
      createIfMissing?: boolean,
      replaceIfExists?: boolean,
      dedupeOnAppend?: boolean,
      primaryKeyColumns?: string[]
    } = {}
  ): Promise<void> {
    await this.ensureAuthenticated(() => this.authenticated_push(tableName, data, options));
  }

  private async authenticated_push(
    tableName: string,
    data: any[],
    options: {
      createIfMissing?: boolean,
      replaceIfExists?: boolean,
      dedupeOnAppend?: boolean,
      primaryKeyColumns?: string[]
    } = {}
  ): Promise<void> {
    let fullName = tableName;
    const parts = tableName.split('.');
    if (parts.length !== 1 && parts.length !== 3) {
      throw new Error(
        "Table name must be either a simple name or 'db.schema.table'"
      );
    }
    if (parts.length === 1) {
      fullName = `duckdb.main.${tableName}`;
    }
    if (!this.token) throw new Error('Authentication required');

    const { createIfMissing = true, replaceIfExists = false, dedupeOnAppend = false, primaryKeyColumns = [] } = options;

    try {
      if (createIfMissing || replaceIfExists) {
        await this.createDatabaseAndSchema(fullName);
      }
      if (replaceIfExists) {
        await this.replaceExistingTable(fullName);
      }
      if (createIfMissing || replaceIfExists) {
        await this.createTable(fullName, data);
      }

      const { path: tempFile, cleanup } = await tmp.file({ postfix: '.parquet' });
      try {
        const sample = data[0];
        const schemaFields: any = {};
        for (const [col, val] of Object.entries<any>(sample)) {
          if (typeof val === 'number') {
            schemaFields[col] = { type: 'DOUBLE' };
          } else if (typeof val === 'boolean') {
            schemaFields[col] = { type: 'BOOLEAN' };
          } else if (val instanceof Date) {
            schemaFields[col] = { type: 'TIMESTAMP_MILLIS' };
          } else {
            schemaFields[col] = { type: 'UTF8' };
          }
        }
        const parquetSchema = new ParquetSchema(schemaFields);
        const writer = await ParquetWriter.openFile(parquetSchema, tempFile);
        for (const row of data) {
          await writer.appendRow(row);
        }
        await writer.close();

        const uuidStr = uuidv4();
        const filename = `${fullName}_${uuidStr}.parquet`;
        const presigned = await this.requestPresignedUploadUrl(filename);
        await this.uploadParquetUsingPresignedUrl(
          presigned.presignedUrl,
          tempFile
        );

        if (dedupeOnAppend) {
          await this.importDataFromAppendOnlyDedup(
            fullName,
            presigned.key,
            primaryKeyColumns
          );
        } else {
          await this.importDataFromPresignedUrl(fullName, presigned.key);
        }

        await this.deleteFileFromS3(presigned.key);
        if (!this.quiet)
          console.log(
            chalk.green(`✓ Successfully pushed ${data.length} records to ${fullName}!`)
          );
      } finally {
        cleanup();
      }
    } catch (err: any) {
      this.handleApiError(err);
    }
  }

  public async execute(
    query: string,
    parameters: any[] = []
  ): Promise<Record<string, any>[]> {
    return this.ensureAuthenticated(() => this.authenticated_execute(query, parameters));
  }

  private async authenticated_execute(
    query: string,
    parameters: any[] = []
  ): Promise<Record<string, any>[]> {
    if (!this.token) throw new Error('Authentication required');
    try {
      if (this.queryHasPositionalParameters(query)) {
        const repl = this.replacePositionalParameters(query, parameters);
        query = repl.query;
        parameters = repl.parameters;
      }
      const res = await this.axiosInstance.post('/api/v1/query', {
        sql: query,
        parameters: parameters,
      });
      const { rows, columns } = res.data;
      const result = rows.map((row: any[]) => {
        const obj: Record<string, any> = {};
        columns.forEach((col: string, idx: number) => {
          obj[col] = row[idx];
        });
        return obj;
      });
      if (!this.quiet)
        console.log(chalk.green('✓ Query executed successfully!\n'));
      return result;
    } catch (err: any) {
      this.handleApiError(err);
    }
  }
}
