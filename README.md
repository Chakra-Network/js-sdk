# Chakra JavaScript/TypeScript SDK

[![npm version](https://badge.fury.io/js/@chakra-dev%2Fjs-sdk.svg)](https://badge.fury.io/js/@chakra-dev%2Fjs-sdk)  
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)  

A JavaScript/TypeScript SDK for interacting with the Chakra API, featuring:

## Features

- **Token-based Authentication**: Secure authentication using DB Session keys
- **Automatic Table Management**: Create and update tables with schema inference
- **Batch Operations**: Efficient data pushing with batched inserts

---

## Installation

```bash
npm install @chakra-dev/js-sdk
# or
yarn add @chakra-dev/js-sdk
```

---

## Quick Start

### CommonJS

```js
const { Chakra } = require('@chakra-dev/js-sdk');

async function main() {
  const client = new Chakra('ACCESSKEY:SECRET:USERNAME');
  await client.login();

  const rows = await client.execute(
    'SELECT id, name, score FROM students WHERE score > $1',
    [90]
  );
  console.table(rows);

  const originalStudents = [
    { id: 1, name: 'Alice', active: true },
    { id: 2, name: 'Bob', active: false }
  ];
  // First push - creates table and inserts both records
  await client.push('school.class.students', originalStudents, {
    createIfMissing: true,
    dedupeOnAppend: true, 
    primaryKeyColumns: ['id']
  });

  await client.push('school.class.students', originalStudents, {
    dedupeOnAppend: true, // no changes since records already exist
    primaryKeyColumns: ['id']
  });

  const updatedStudents = [
    { id: 1, name: 'Alice', active: false },
    { id: 2, name: 'Bob', active: false },
    // new student
    { id: 3, name: 'Charles', active: false }
  ];
  await client.push('school.class.students', updatedStudents, {
    dedupeOnAppend: true,   // only Charles will be updated since the other two will be deduped on id
    primaryKeyColumns: ['id']
  });

  await client.push('school.class.students', originalStudents, {
    createIfMissing: true,
    replaceIfExists: true // replace the table with just the original students data. Charles no longer in table
  });
}

main().catch(console.error);
```

### TypeScript

```ts
import { Chakra } from '@chakra-dev/js-sdk'

async function main() {
  const client = new Chakra('ACCESSKEY:SECRET:USERNAME');
  await client.login();

  const rows = await client.execute(
    'SELECT id, name, score FROM students WHERE score > $1',
    [90]
  );
  console.table(rows);

  const originalStudents = [
    { id: 1, name: 'Alice', active: true },
    { id: 2, name: 'Bob', active: false }
  ];
  // First push - creates table and inserts both records
  await client.push('school.class.students', originalStudents, {
    createIfMissing: true,
    dedupeOnAppend: true, 
    primaryKeyColumns: ['id']
  });

  await client.push('school.class.students', originalStudents, {
    dedupeOnAppend: true, // no changes since records already exist
    primaryKeyColumns: ['id']
  });

  const updatedStudents = [
    { id: 1, name: 'Alice', active: false },
    { id: 2, name: 'Bob', active: false },
    // new student
    { id: 3, name: 'Charles', active: false }
  ];
  await client.push('school.class.students', updatedStudents, {
    dedupeOnAppend: true,   // only Charles will be updated since the other two will be deduped on id
    primaryKeyColumns: ['id']
  });

  await client.push('school.class.students', originalStudents, {
    createIfMissing: true,
    replaceIfExists: true // replace the table with just the original students data. Charles no longer in table
  });
}

main().catch(console.error);
```

---

## API

### `new Chakra(dbSessionKey: string, quiet?: boolean)`

- `dbSessionKey`: your `accessKey:secretKey:username`  
- `quiet`: suppresses progress bars/logs  

### `client.login(): Promise<void>`

Authenticate and store the bearer token.

### `client.execute<T = any>(sql: string, params?: any[]): Promise<T[]>`

Run a SQL query (supports `$1, $2…` params) and return an array of row objects.

### `client.push<T = Record<string, any>>(tableName: string, data: T[], options?): Promise<void>`

Push a JS array to a table, handling schema, Parquet, upload, import, and cleanup.  
- `tableName`: `"db.schema.table"` or just `"table"` (defaults to `duckdb.main.table`)  
- `options`:
  - `createIfMissing`: Create table if it doesn't exist (default: true)
  - `replaceIfExists`: Drop and recreate table, removing all existing data (default: false)
  - `dedupeOnAppend`: Skip inserting records that match primary key values already in table (default: false)
  - `primaryKeyColumns`: Array of column names to use as primary key for deduplication (required if dedupeOnAppend=true)

---

## Development

1. **Clone**  
   ```bash
   git clone https://github.com/Chakra-Network/js-sdk.git
   cd js-sdk
   ```

2. **Install**  
   ```bash
   npm install
   ```

3. **Build & Test**  
   ```bash
   npm run build
   npm test
   ```

4. **Publish**  
   - Bump version in `package.json`  
   - `npm publish --access public`  

---

## License

MIT © Chakra Labs

