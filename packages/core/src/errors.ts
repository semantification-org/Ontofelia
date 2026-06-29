import { ErrorCode } from './types/common.js';

export class OntofeliaError extends Error {
  public code: ErrorCode;
  public details?: unknown;

  constructor(message: string, code: ErrorCode = "INTERNAL_ERROR", details?: unknown) {
    super(message);
    this.name = "OntofeliaError";
    this.code = code;
    this.details = details;
  }
}
