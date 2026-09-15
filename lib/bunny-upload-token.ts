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
  /**
   * The storage reservation this upload holds, when it holds one.
   *
   * Carried inside the signature rather than handed to the client as its own
   * field, because a reservation id the caller can name is a reservation the
   * caller can drop: it would take two inits and one cancel to release the
   * quota of an upload that is still running, which is the exact hole the
   * reservation exists to close. Signed alongside `vid`, releasing it means
   * presenting the token for that video, which also deletes that video.
   */
  rid?: string;
  /**
   * The size the client declared when it asked for this grant, as a decimal
   * string because JSON has no integer wide enough.
   *
   * Signed for the same reason as the reservation: it is written onto the row
   * the upload creates and counted as storage until Bunny reports a figure of
   * its own, so a client that could restate it at that point would be declaring
   * one size to pass the quota check and another to be billed for.
   */
  sz?: string;
  fid?: string | null;
  target?: string | null;
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
    Number.isFinite(payload.exp) &&
    (payload.rid === undefined || typeof payload.rid === 'string') &&
    (payload.sz === undefined || typeof payload.sz === 'string')
  );
}

export function createBunnyUploadToken(
  subject: BunnyUploadTokenSubject & {
    folderId?: string | null;
    targetVideoId?: string | null;
    reservationId?: string | null;
    declaredSizeBytes?: bigint | null;
  },
  ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: BunnyUploadTokenPayload = {
    fid: subject.folderId ?? null,
    target: subject.targetVideoId ?? null,
    typ: BUNNY_UPLOAD_TOKEN_TYPE,
    uid: subject.userId,
    pid: subject.projectId,
    vid: subject.videoId,
    iat: now,
    exp: now + ttlSeconds,
    ...(subject.reservationId ? { rid: subject.reservationId } : {}),
    ...(subject.declaredSizeBytes ? { sz: subject.declaredSizeBytes.toString() } : {}),
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signPayload(encodedPayload, getBunnyUploadTokenSecret());
  return `${encodedPayload}.${signature}`;
}

/**
 * The verified payload, or null when the token is not a genuine grant for this
 * subject. Everything `verifyBunnyUploadToken` promises holds here too; it is
 * the same check, returning what it read instead of throwing it away.
 */
function readBunnyUploadToken(
  token: string,
  subject: BunnyUploadTokenSubject
): BunnyUploadTokenPayload | null {
  // Resolved before the try. A missing signing secret is a configuration fault, and
  // swallowing that throw made every upload grant look like a forgery instead.
  const secret = getBunnyUploadTokenSecret();

  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [encodedPayload, providedSignature] = parts;
    if (!encodedPayload || !providedSignature) return null;

    const expectedSignature = signPayload(encodedPayload, secret);
    const providedBuffer = Buffer.from(providedSignature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (providedBuffer.length !== expectedBuffer.length) return null;
    if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return null;

    const payloadJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const payloadUnknown: unknown = JSON.parse(payloadJson);

    if (!isValidPayload(payloadUnknown)) return null;

    const payload = payloadUnknown;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;

    if (
      payload.uid !== subject.userId ||
      payload.pid !== subject.projectId ||
      payload.vid !== subject.videoId
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function verifyBunnyUploadToken(token: string, subject: BunnyUploadTokenSubject): boolean {
  return readBunnyUploadToken(token, subject) !== null;
}

export interface BunnyUploadGrant {
  targetVideoId: string | null;
  folderId: string | null;
  /** The storage reservation this upload holds, or null if it holds none. */
  reservationId: string | null;
  /** What the client said it was uploading, or null on a grant that predates the claim. */
  declaredSizeBytes: bigint | null;
}

/**
 * What a genuine grant for this subject carries, or null when the token is not
 * one.
 *
 * Null and empty fields mean the same thing to every caller: there is nothing
 * here to release and nothing to bill, so a grant issued before either claim
 * existed keeps working rather than failing an upload in flight.
 */
export function readBunnyUploadGrant(
  token: string,
  subject: BunnyUploadTokenSubject
): BunnyUploadGrant | null {
  const payload = readBunnyUploadToken(token, subject);
  if (!payload) return null;

  let declaredSizeBytes: bigint | null = null;
  if (payload.sz) {
    try {
      const parsed = BigInt(payload.sz);
      declaredSizeBytes = parsed > BigInt(0) ? parsed : null;
    } catch {
      declaredSizeBytes = null;
    }
  }

  return {
    reservationId: payload.rid ?? null,
    declaredSizeBytes,
    folderId: payload.fid ?? null,
    targetVideoId: payload.target ?? null,
  };
}
