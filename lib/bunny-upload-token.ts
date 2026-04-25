import crypto from 'crypto';

const BUNNY_UPLOAD_TOKEN_TYPE = 'bunny-upload';
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60;

interface BunnyUploadTokenPayload {
  typ: typeof BUNNY_UPLOAD_TOKEN_TYPE;
  uid: string;
  pid: string;
  vid: string;
  iat: number;
  exp: number;
}

interface BunnyUploadTokenSubject {
  userId: string;
  projectId: string;
  videoId: string;
}

function getBunnyUploadTokenSecret(): string {
  const secret = process.env.BUNNY_UPLOAD_TOKEN_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('Missing BUNNY_UPLOAD_TOKEN_SECRET or NEXTAUTH_SECRET.');
  }
  return secret;
}

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function isValidPayload(value: unknown): value is BunnyUploadTokenPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<BunnyUploadTokenPayload>;
  return (
    payload.typ === BUNNY_UPLOAD_TOKEN_TYPE &&
    typeof payload.uid === 'string' &&
    typeof payload.pid === 'string' &&
    typeof payload.vid === 'string' &&
    typeof payload.iat === 'number' &&
    Number.isFinite(payload.iat) &&
    typeof payload.exp === 'number' &&
    Number.isFinite(payload.exp)
  );
}

export function createBunnyUploadToken(
  subject: BunnyUploadTokenSubject,
  ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: BunnyUploadTokenPayload = {
    typ: BUNNY_UPLOAD_TOKEN_TYPE,
    uid: subject.userId,
    pid: subject.projectId,
    vid: subject.videoId,
    iat: now,
    exp: now + ttlSeconds,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signPayload(encodedPayload, getBunnyUploadTokenSecret());
  return `${encodedPayload}.${signature}`;
}

export function verifyBunnyUploadToken(token: string, subject: BunnyUploadTokenSubject): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return false;

    const [encodedPayload, providedSignature] = parts;
    if (!encodedPayload || !providedSignature) return false;

    const expectedSignature = signPayload(encodedPayload, getBunnyUploadTokenSecret());
    const providedBuffer = Buffer.from(providedSignature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (providedBuffer.length !== expectedBuffer.length) return false;
    if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return false;

    const payloadJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const payloadUnknown: unknown = JSON.parse(payloadJson);

    if (!isValidPayload(payloadUnknown)) return false;

    const payload = payloadUnknown;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return false;

    return (
      payload.uid === subject.userId &&
      payload.pid === subject.projectId &&
      payload.vid === subject.videoId
    );
  } catch {
    return false;
  }
}
