export class ChakraAPIError extends Error {
  public response?: any;

  constructor(message: string, response?: any) {
    super(message);
    this.name = 'ChakraAPIError';
    this.response = response;
    // Restore prototype chain
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ChakraAuthError extends ChakraAPIError {
  constructor(message: string, response?: any) {
    super(message, response);
    this.name = 'ChakraAuthError';
    // Restore prototype chain
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
