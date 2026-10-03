import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  HttpStatus,
  apiErrors,
  errorResponse,
  successResponse,
  withCacheControl,
} from '@/lib/api-response';

describe('errorResponse', () => {
  it('returns the message and status with no code when none is given', async () => {
    const response = errorResponse('Something broke', 500);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Something broke' });
  });

  it('includes the machine-readable code when given', async () => {
    const response = errorResponse('Nope', 403, ErrorCode.FORBIDDEN);

    await expect(response.json()).resolves.toEqual({ error: 'Nope', code: 'FORBIDDEN' });
  });

  it('keeps only the field entries that are arrays of strings', async () => {
    const response = errorResponse('Invalid input', 422, ErrorCode.VALIDATION_ERROR, {
      email: ['Invalid email format'],
      password: ['Too short', 'No digit'],
      leak: 'not-an-array' as unknown as string[],
      nested: [{ secret: 'value' }] as unknown as string[],
      mixed: ['ok', 42 as unknown as string],
    });

    await expect(response.json()).resolves.toEqual({
      error: 'Invalid input',
      code: 'VALIDATION_ERROR',
      details: {
        email: ['Invalid email format'],
        password: ['Too short', 'No digit'],
      },
    });
  });

  it('omits the details key entirely when every entry was rejected', async () => {
    const response = errorResponse('Invalid input', 422, ErrorCode.VALIDATION_ERROR, {
      leak: { internal: true } as unknown as string[],
    });

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('details');
  });

  it('accepts an empty string array as a valid field entry', async () => {
    const response = errorResponse('Invalid input', 422, ErrorCode.VALIDATION_ERROR, {
      email: [],
    });

    await expect(response.json()).resolves.toMatchObject({ details: { email: [] } });
  });
});

describe('apiErrors', () => {
  const cases: Array<{
    name: string;
    response: ReturnType<typeof errorResponse>;
    status: number;
    code: string;
    message: string;
  }> = [
    {
      name: 'unauthorized',
      response: apiErrors.unauthorized(),
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Unauthorized',
    },
    {
      name: 'forbidden',
      response: apiErrors.forbidden(),
      status: 403,
      code: 'FORBIDDEN',
      message: 'Forbidden',
    },
    {
      name: 'notFound',
      response: apiErrors.notFound(),
      status: 404,
      code: 'NOT_FOUND',
      message: 'Resource not found',
    },
    {
      name: 'badRequest',
      response: apiErrors.badRequest(),
      status: 400,
      code: 'INVALID_INPUT',
      message: 'Bad request',
    },
    {
      name: 'validationError',
      response: apiErrors.validationError('Invalid input'),
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'Invalid input',
    },
    {
      name: 'conflict',
      response: apiErrors.conflict('Email already registered'),
      status: 409,
      code: 'ALREADY_EXISTS',
      message: 'Email already registered',
    },
    {
      name: 'rateLimited',
      response: apiErrors.rateLimited(),
      status: 429,
      code: 'RATE_LIMITED',
      message: 'Too many requests',
    },
    {
      name: 'internalError',
      response: apiErrors.internalError(),
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
    {
      name: 'storageExceeded',
      response: apiErrors.storageExceeded(),
      status: 507,
      code: 'STORAGE_LIMIT_EXCEEDED',
      message: 'Storage limit exceeded. Please delete some files to free up space.',
    },
  ];

  it.each(cases)(
    '$name responds $status with code $code',
    async ({ response, status, code, message }) => {
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: message, code });
    }
  );

  it('interpolates the resource name into the notFound message', async () => {
    await expect(apiErrors.notFound('Project').json()).resolves.toEqual({
      error: 'Project not found',
      code: 'NOT_FOUND',
    });
  });

  it('lets the caller override the default message', async () => {
    await expect(apiErrors.forbidden('You are not a workspace admin').json()).resolves.toEqual({
      error: 'You are not a workspace admin',
      code: 'FORBIDDEN',
    });
  });

  it('passes field details through validationError', async () => {
    const response = apiErrors.validationError('Invalid input', { title: ['Required'] });

    await expect(response.json()).resolves.toMatchObject({ details: { title: ['Required'] } });
  });

  it('uses distinct status codes for every helper', () => {
    const statuses = cases.map((entry) => entry.status);
    expect(new Set(statuses).size).toBe(statuses.length);
  });
});

describe('successResponse', () => {
  it('wraps the payload in a data envelope and defaults to 200', async () => {
    const response = successResponse({ projects: [] });

    expect(response.status).toBe(HttpStatus.OK);
    await expect(response.json()).resolves.toEqual({ data: { projects: [] } });
  });

  it('honours an explicit status such as 201', () => {
    expect(successResponse({ id: 'p1' }, HttpStatus.CREATED).status).toBe(201);
  });

  it('sets a json content type', () => {
    expect(successResponse({ ok: true }).headers.get('content-type')).toBe('application/json');
  });

  it('omits meta when none is supplied', async () => {
    const body = (await successResponse({ ok: true }).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('meta');
  });

  it('serialises pagination meta alongside the data', async () => {
    const response = successResponse({ projects: [] }, 200, {
      page: 1,
      limit: 10,
      total: 100,
      totalPages: 10,
    });

    await expect(response.json()).resolves.toEqual({
      data: { projects: [] },
      meta: { page: 1, limit: 10, total: 100, totalPages: 10 },
    });
  });

  it('renders a BigInt as a string instead of throwing', async () => {
    const response = successResponse({ sizeBytes: BigInt('9007199254740993') });

    await expect(response.json()).resolves.toEqual({
      data: { sizeBytes: '9007199254740993' },
    });
  });

  it('renders BigInt values nested in arrays and objects', async () => {
    const response = successResponse({
      versions: [{ sizeBytes: BigInt(0) }, { sizeBytes: BigInt(-5) }],
      quota: { used: BigInt(1024), limit: BigInt(5) * BigInt(1024) },
    });

    await expect(response.json()).resolves.toEqual({
      data: {
        versions: [{ sizeBytes: '0' }, { sizeBytes: '-5' }],
        quota: { used: '1024', limit: '5120' },
      },
    });
  });

  it('serialises a Date the same way JSON.stringify would', async () => {
    const response = successResponse({ createdAt: new Date('2026-01-15T00:00:00.000Z') });

    await expect(response.json()).resolves.toEqual({
      data: { createdAt: '2026-01-15T00:00:00.000Z' },
    });
  });
});

describe('withCacheControl', () => {
  it('sets the Cache-Control header and returns the same response instance', () => {
    const response = successResponse({ ok: true });

    const returned = withCacheControl(response, 'public, max-age=60');

    expect(returned).toBe(response);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('overwrites a previously set Cache-Control value', () => {
    const response = new Response(null, { headers: { 'Cache-Control': 'no-store' } });

    withCacheControl(response, 'public, max-age=300');

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('copies a response whose headers are immutable instead of throwing', () => {
    const response = Response.redirect('https://example.com/login', 302);

    const returned = withCacheControl(response, 'private, no-store');

    expect(returned.status).toBe(302);
    expect(returned.headers.get('Location')).toBe('https://example.com/login');
    expect(returned.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
