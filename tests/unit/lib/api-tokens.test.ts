import { describe, expect, it, vi } from 'vitest';

// lib/api-tokens.ts imports the Prisma client and NextAuth for the functions
// that talk to the database. The two tested here are pure, so both are stubbed
// out rather than loaded.
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

import { generateApiToken, hashApiToken, readBearerToken } from '@/lib/api-tokens';

const VALID = 'of_pat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

function withAuthorization(value?: string): Request {
  const headers = new Headers();
  if (value !== undefined) headers.set('authorization', value);
  return new Request('http://localhost/api/projects', { headers });
}

describe('readBearerToken', () => {
  it('answers null when no Authorization header is sent', () => {
    expect(readBearerToken(withAuthorization())).toBeNull();
  });

  it('returns a well-formed OpenFrame token', () => {
    expect(readBearerToken(withAuthorization(`Bearer ${VALID}`))).toBe(VALID);
    expect(readBearerToken(withAuthorization(`bearer   ${VALID}  `))).toBe(VALID);
  });

  it.each([
    ['basic auth from a reverse proxy', `Basic ${VALID}`],
    ['a bare scheme', 'Bearer'],
    ["another service's bearer", 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.signature'],
    [
      'a foreign prefix with a valid body',
      'Bearer xx_pat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
    ],
    ['an empty header', ''],
  ])('answers null for %s, so the session still decides', (_label, value) => {
    expect(readBearerToken(withAuthorization(value))).toBeNull();
  });

  it.each([
    ['two values', `Bearer ${VALID} extra`],
    ['a body one character short', `Bearer ${VALID.slice(0, -1)}`],
    ['a body one character long', `Bearer ${VALID}Z`],
    ['a character outside base64url', 'Bearer of_pat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP+'],
  ])(
    'answers an empty string for an OpenFrame token with %s, so the caller refuses',
    (_label, value) => {
      expect(readBearerToken(withAuthorization(value))).toBe('');
    }
  );
});

describe('generateApiToken', () => {
  it('produces a token readBearerToken accepts, with its hash and display prefix', () => {
    const { token, tokenHash, prefix } = generateApiToken();

    expect(token).toMatch(/^of_pat_[A-Za-z0-9_-]{43}$/);
    expect(readBearerToken(withAuthorization(`Bearer ${token}`))).toBe(token);
    expect(prefix).toBe(token.slice(0, 13));
    expect(tokenHash).toBe(hashApiToken(token));
  });

  it('never repeats', () => {
    expect(generateApiToken().token).not.toBe(generateApiToken().token);
  });
});

describe('hashApiToken', () => {
  it('is the hex SHA-256 of the token', () => {
    expect(hashApiToken('of_pat_x')).toBe(
      'adcd7fc692e5b4f2e748950f7dc996e9e6fb87a0a1e5f8dcb701efd96527f610'
    );
  });
});
