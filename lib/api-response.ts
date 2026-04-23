import { NextResponse } from 'next/server';

/**
 * Standardized API error response format
 * All API routes should use this format for consistency
 */
export interface ApiErrorResponse {
  error: string;
  code?: string;
  details?: Record<string, string[]>;
}

/**
 * Standardized API success response format
 */
export interface ApiSuccessResponse<T = unknown> {
  data: T;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
  };
}

/**
 * HTTP status codes used in the API
 */
export const HttpStatus = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INSUFFICIENT_STORAGE: 507,
  INTERNAL_SERVER_ERROR: 500,
} as const;

/**
 * Error codes for client-side handling
 */
export const ErrorCode = {
  // Authentication errors
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',

  // Resource errors
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',

  // Validation errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',

  // Rate limiting
  RATE_LIMITED: 'RATE_LIMITED',

  // Server errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // Storage errors
  STORAGE_LIMIT_EXCEEDED: 'STORAGE_LIMIT_EXCEEDED',
} as const;

/**
 * Creates a standardized error response
 *
 * @param message - Human-readable error message
 * @param status - HTTP status code
 * @param code - Machine-readable error code for client handling
 * @param details - Additional error details for validation errors (field -> messages[])
 *
 * @example
 * ```ts
 * return errorResponse("Project not found", 404, ErrorCode.NOT_FOUND);
 * return errorResponse("Invalid input", 400, ErrorCode.VALIDATION_ERROR, { email: ["Invalid email format"] });
 * ```
 */
export function errorResponse(
  message: string,
  status: number,
  code?: string,
  details?: Record<string, string[]>
): NextResponse<ApiErrorResponse> {
  const body: ApiErrorResponse = { error: message };
  if (code) body.code = code;
  if (details) {
    // Sanitize: only allow string arrays to prevent accidental data leakage
    const sanitized: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(details)) {
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        sanitized[key] = value;
      }
    }
    if (Object.keys(sanitized).length > 0) {
      body.details = sanitized;
    }
  }

  return NextResponse.json(body, { status });
}

/**
 * Creates a standardized success response
 *
 * @param data - Response data
 * @param status - HTTP status code (default: 200)
 * @param meta - Pagination or other metadata (optional)
 *
 * @example
 * ```ts
 * return successResponse({ projects: [] });
 * return successResponse({ projects: [] }, 200, { page: 1, limit: 10, total: 100 });
 * ```
 */
export function successResponse<T>(
  data: T,
  status: number = HttpStatus.OK,
  meta?: ApiSuccessResponse['meta']
): NextResponse<ApiSuccessResponse<T>> {
  const body: ApiSuccessResponse<T> = { data };
  if (meta) body.meta = meta;

  return NextResponse.json(body, { status });
}

export function withCacheControl(response: Response, value: string): Response {
  response.headers.set('Cache-Control', value);
  return response;
}

/**
 * Common error response helpers
 */
export const apiErrors = {
  unauthorized: (message = 'Unauthorized') =>
    errorResponse(message, HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHORIZED),

  forbidden: (message = 'Forbidden') =>
    errorResponse(message, HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN),

  notFound: (resource = 'Resource') =>
    errorResponse(`${resource} not found`, HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND),

  badRequest: (message = 'Bad request') =>
    errorResponse(message, HttpStatus.BAD_REQUEST, ErrorCode.INVALID_INPUT),

  validationError: (message: string, details?: Record<string, string[]>) =>
    errorResponse(message, HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.VALIDATION_ERROR, details),

  conflict: (message: string) =>
    errorResponse(message, HttpStatus.CONFLICT, ErrorCode.ALREADY_EXISTS),

  rateLimited: (message = 'Too many requests') =>
    errorResponse(message, HttpStatus.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMITED),

  internalError: (message = 'Internal server error') =>
    errorResponse(message, HttpStatus.INTERNAL_SERVER_ERROR, ErrorCode.INTERNAL_ERROR),

  storageExceeded: (
    message = 'Storage limit exceeded. Please delete some files to free up space.'
  ) => errorResponse(message, HttpStatus.INSUFFICIENT_STORAGE, ErrorCode.STORAGE_LIMIT_EXCEEDED),
};
