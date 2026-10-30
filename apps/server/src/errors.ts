import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function toPublicError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: error.issues.map((i) => i.message).join('; '),
    };
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === '23505')
      return { status: 409, code: 'DUPLICATE_RECORD', message: 'A matching record already exists' };
    if (error.code === '23503' || error.code === '23514') {
      return {
        status: 422,
        code: 'INVALID_REFERENCE',
        message: 'The related record or value is invalid',
      };
    }
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
}
