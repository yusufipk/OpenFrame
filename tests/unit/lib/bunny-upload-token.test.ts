import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { createBunnyUploadToken, verifyBunnyUploadToken } from '@/lib/bunny-upload-token';

const SECRET = 'bunny-upload-token-test-secret';
const OTHER_SECRET = 'a-completely-different-secret';
const NOW = new Date('2026-01-15T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const ONE_HOUR = 60 * 60;

const SUBJECT = {
  userId: 'user-1',
  projectId: 'project-1',
  videoId: 'video-1',
};

/**
 * Mints a token over an arbitrary payload with a valid signature. No signature is
 * ever hardcoded here, because it depends on the configured secret; every
 * expectation is about behaviour. This helper exists only to reach the
 * payload-shape checks, which a forged signature can never get past.
 */
function signArbitrary(payload: unknown, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

/**
 * Signs raw JSON text rather than an object. JSON.stringify cannot emit a
 * non-finite number, so this is the only way to hand verify() a payload whose
 * `iat` or `exp` parses back as Infinity: a decimal exponent that overflows to
 * it, which JSON.parse accepts and turns into Infinity.
 */
function signRawJson(json: string, secret = SECRET): string {
  const encoded = Buffer.from(json, 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function wellFormedPayload(overrides: Record<string, unknown> = {}) {
  return {
    typ: 'bunny-upload',
    uid: SUBJECT.userId,
    pid: SUBJECT.projectId,
    vid: SUBJECT.videoId,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + ONE_HOUR,
    ...overrides,
  };
}

function decodePayload(token: string): Record<string, unknown> {
  const [encoded] = token.split('.');
  return JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv('BUNNY_UPLOAD_TOKEN_SECRET', SECRET);
  vi.stubEnv('NEXTAUTH_SECRET', undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('createBunnyUploadToken', () => {
  it('produces a two-part token separated by a dot', () => {
    expect(createBunnyUploadToken(SUBJECT).split('.')).toHaveLength(2);
  });

  it('encodes the subject and the issue and expiry times into the payload', () => {
    expect(decodePayload(createBunnyUploadToken(SUBJECT))).toEqual({
      fid: null,
      target: null,
      typ: 'bunny-upload',
      uid: 'user-1',
      pid: 'project-1',
      vid: 'video-1',
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + ONE_HOUR,
    });
  });

  it('defaults to a one hour lifetime', () => {
    const payload = decodePayload(createBunnyUploadToken(SUBJECT));

    expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
  });

  it('honours an explicit ttl', () => {
    const payload = decodePayload(createBunnyUploadToken(SUBJECT, 120));

    expect((payload.exp as number) - (payload.iat as number)).toBe(120);
  });

  it('uses base64url, so the token survives a query string unescaped', () => {
    const token = createBunnyUploadToken(SUBJECT);

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('prefers BUNNY_UPLOAD_TOKEN_SECRET over NEXTAUTH_SECRET', () => {
    vi.stubEnv('NEXTAUTH_SECRET', OTHER_SECRET);
    const token = createBunnyUploadToken(SUBJECT);

    // With only NEXTAUTH_SECRET left, verification must fail, which it can only
    // do if the dedicated variable was the one that signed.
    vi.stubEnv('BUNNY_UPLOAD_TOKEN_SECRET', undefined);
    expect(verifyBunnyUploadToken(token, SUBJECT)).toBe(false);
  });

  it('falls back to NEXTAUTH_SECRET when the dedicated secret is unset', () => {
    vi.stubEnv('BUNNY_UPLOAD_TOKEN_SECRET', undefined);
    vi.stubEnv('NEXTAUTH_SECRET', OTHER_SECRET);

    expect(verifyBunnyUploadToken(createBunnyUploadToken(SUBJECT), SUBJECT)).toBe(true);
  });

  it('refuses to mint a token when no secret is configured at all', () => {
    vi.stubEnv('BUNNY_UPLOAD_TOKEN_SECRET', undefined);
    vi.stubEnv('NEXTAUTH_SECRET', undefined);

    expect(() => createBunnyUploadToken(SUBJECT)).toThrow(
      'Missing BUNNY_UPLOAD_TOKEN_SECRET or NEXTAUTH_SECRET.'
    );
  });
});

describe('verifyBunnyUploadToken', () => {
  it('accepts a freshly signed token for the subject it was minted for', () => {
    expect(verifyBunnyUploadToken(createBunnyUploadToken(SUBJECT), SUBJECT)).toBe(true);
  });

  it('rejects a token whose payload was tampered with', () => {
    const [encodedPayload, signature] = createBunnyUploadToken(SUBJECT).split('.');
    const payload = JSON.parse(Buffer.from(encodedPayload!, 'base64url').toString('utf8'));
    payload.pid = 'project-victim';
    const forged = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

    expect(
      verifyBunnyUploadToken(`${forged}.${signature}`, { ...SUBJECT, projectId: 'project-victim' })
    ).toBe(false);
  });

  it('rejects a token whose signature was tampered with', () => {
    const [encodedPayload, signature] = createBunnyUploadToken(SUBJECT).split('.');
    const flipped = (signature![0] === 'A' ? 'B' : 'A') + signature!.slice(1);

    expect(verifyBunnyUploadToken(`${encodedPayload}.${flipped}`, SUBJECT)).toBe(false);
  });

  it('rejects a token signed under a different secret', () => {
    const token = createBunnyUploadToken(SUBJECT);

    vi.stubEnv('BUNNY_UPLOAD_TOKEN_SECRET', OTHER_SECRET);

    expect(verifyBunnyUploadToken(token, SUBJECT)).toBe(false);
  });

  it('rejects a token signed by the R2 grant path, which uses the same algorithm', () => {
    // Both modules HMAC-SHA256 a base64url payload and both fall back to
    // NEXTAUTH_SECRET, so the `typ` discriminator is the only thing keeping an
    // R2 grant from being replayed as a Bunny grant.
    const token = signArbitrary({
      typ: 'r2-upload',
      uid: SUBJECT.userId,
      pid: SUBJECT.projectId,
      vid: SUBJECT.videoId,
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + ONE_HOUR,
    });

    expect(verifyBunnyUploadToken(token, SUBJECT)).toBe(false);
  });

  it('rejects a token that has expired', () => {
    const token = createBunnyUploadToken(SUBJECT, 60);

    vi.setSystemTime(new Date(NOW.getTime() + 61_000));

    expect(verifyBunnyUploadToken(token, SUBJECT)).toBe(false);
  });

  it('still accepts a token in its final second', () => {
    const token = createBunnyUploadToken(SUBJECT, 60);

    vi.setSystemTime(new Date(NOW.getTime() + 59_000));

    expect(verifyBunnyUploadToken(token, SUBJECT)).toBe(true);
  });

  it('accepts a token at the exact expiry second and rejects it one second later', () => {
    const token = createBunnyUploadToken(SUBJECT, 60);

    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    expect(verifyBunnyUploadToken(token, SUBJECT)).toBe(true);

    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    expect(verifyBunnyUploadToken(token, SUBJECT)).toBe(false);
  });

  it.each([
    ['a different user', { userId: 'user-2' }],
    ['a different project', { projectId: 'project-2' }],
    ['a different video', { videoId: 'video-2' }],
  ])('rejects a valid token presented for %s', (_label, override) => {
    const token = createBunnyUploadToken(SUBJECT);

    expect(verifyBunnyUploadToken(token, { ...SUBJECT, ...override })).toBe(false);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a single segment', 'notatoken'],
    ['three segments', 'a.b.c'],
    ['a missing signature', 'YWJj.'],
    ['a missing payload', '.c2ln'],
    ['two empty segments', '.'],
    ['a jwt-shaped token', 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJ1c2VyLTEifQ.sig'],
    ['punctuation only', '!!!.???'],
  ])('refuses %s rather than throwing', (_label, token) => {
    expect(() => verifyBunnyUploadToken(token, SUBJECT)).not.toThrow();
    expect(verifyBunnyUploadToken(token, SUBJECT)).toBe(false);
  });

  it('refuses a signature of the wrong length without letting timingSafeEqual throw', () => {
    const [encodedPayload] = createBunnyUploadToken(SUBJECT).split('.');

    // crypto.timingSafeEqual throws on unequal buffer lengths, so the length
    // guard in front of it is load bearing.
    expect(() => verifyBunnyUploadToken(`${encodedPayload}.short`, SUBJECT)).not.toThrow();
    expect(verifyBunnyUploadToken(`${encodedPayload}.short`, SUBJECT)).toBe(false);
  });

  it('refuses a correctly signed payload that is not JSON', () => {
    const encoded = Buffer.from('not json at all', 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', SECRET).update(encoded).digest('base64url');

    expect(verifyBunnyUploadToken(`${encoded}.${signature}`, SUBJECT)).toBe(false);
  });

  it('refuses a correctly signed payload that is a JSON scalar rather than an object', () => {
    expect(verifyBunnyUploadToken(signArbitrary('user-1'), SUBJECT)).toBe(false);
    expect(verifyBunnyUploadToken(signArbitrary(null), SUBJECT)).toBe(false);
    expect(verifyBunnyUploadToken(signArbitrary(42), SUBJECT)).toBe(false);
  });

  it.each([['typ'], ['uid'], ['pid'], ['vid'], ['iat'], ['exp']])(
    'refuses a correctly signed payload missing %s',
    (field) => {
      const payload = wellFormedPayload();
      delete (payload as Record<string, unknown>)[field];

      expect(verifyBunnyUploadToken(signArbitrary(payload), SUBJECT)).toBe(false);
    }
  );

  it('refuses a correctly signed payload whose exp is a numeric string', () => {
    const token = signArbitrary(wellFormedPayload({ exp: String(NOW_SECONDS + ONE_HOUR) }));

    expect(verifyBunnyUploadToken(token, SUBJECT)).toBe(false);
  });

  it('refuses a correctly signed payload whose iat arrives as null', () => {
    // Named for what it actually exercises. JSON.stringify writes Infinity as
    // `null`, so a payload minted from a non-finite number reaches verify() as
    // null and is rejected one line earlier, by `typeof payload.iat === 'number'`.
    // The Number.isFinite guard is never consulted on this path; the two tests
    // below are the ones that reach it.
    const token = signArbitrary(wellFormedPayload({ iat: Number.POSITIVE_INFINITY }));

    expect(decodePayload(token).iat).toBeNull();
    expect(verifyBunnyUploadToken(token, SUBJECT)).toBe(false);
  });

  it.each([['iat'], ['exp']])(
    'refuses a correctly signed payload whose %s is a JSON literal that overflows to Infinity',
    (field) => {
      // The one way a non-finite number survives the wire: `1e999` is legal JSON
      // and JSON.parse turns it into Infinity, which passes the typeof check and
      // leaves Number.isFinite as the only thing standing. For exp that matters,
      // because Infinity < now is false, so without the guard the token would
      // verify and never expire. Minting one still needs the server secret, so
      // this is defence in depth rather than a reachable forgery.
      const json = JSON.stringify(wellFormedPayload()).replace(
        new RegExp(`"${field}":\\d+`),
        `"${field}":1e999`
      );

      expect(JSON.parse(json)[field]).toBe(Number.POSITIVE_INFINITY);
      expect(verifyBunnyUploadToken(signRawJson(json), SUBJECT)).toBe(false);
    }
  );

  it('accepts a correctly signed payload carrying unknown extra fields', () => {
    // The shape check allowlists the fields it needs rather than rejecting
    // extras, so a token minted by a newer version still verifies.
    const token = signArbitrary(wellFormedPayload({ scope: 'tus', v: 2 }));

    expect(verifyBunnyUploadToken(token, SUBJECT)).toBe(true);
  });

  // A missing signing secret is a configuration fault, not a forgery. Answering "invalid
  // token" for it turned a self-hosted misconfiguration into a silent, total upload
  // outage that reads like a client bug.
  it('throws rather than reporting a forgery when the server has no secret configured', () => {
    const token = createBunnyUploadToken(SUBJECT);

    vi.stubEnv('BUNNY_UPLOAD_TOKEN_SECRET', undefined);
    vi.stubEnv('NEXTAUTH_SECRET', undefined);

    expect(() => verifyBunnyUploadToken(token, SUBJECT)).toThrow();
  });
});
