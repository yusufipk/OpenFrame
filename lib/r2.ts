import type { Readable } from 'stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetBucketCorsCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  UploadPartCommand,
  S3Client,
  type CORSRule,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { VIDEO_OBJECT_KEY_PREFIX } from '@/lib/video-upload-validation';

const IMAGE_OBJECT_KEY_PREFIX = 'images/';
const AUDIO_OBJECT_KEY_PREFIX = 'voice/';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME ?? '';
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_PRESIGN_ENDPOINT = process.env.R2_PRESIGN_ENDPOINT;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;

let cachedR2Client: S3Client | null = null;
let cachedR2PresignClient: S3Client | null = null;

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function requireStorageValue(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing ${name} for S3-compatible storage`);
  }

  return value;
}

function getR2Endpoint(): string {
  if (R2_ENDPOINT) {
    return trimTrailingSlashes(R2_ENDPOINT);
  }

  if (!R2_ACCOUNT_ID) {
    throw new Error('Missing R2_ENDPOINT or R2_ACCOUNT_ID for S3-compatible storage');
  }

  return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

function getR2PresignEndpoint(): string {
  if (R2_PRESIGN_ENDPOINT) {
    return trimTrailingSlashes(R2_PRESIGN_ENDPOINT);
  }
  return getR2Endpoint();
}

function getOrCreateR2Client(): S3Client {
  if (cachedR2Client) {
    return cachedR2Client;
  }

  cachedR2Client = new S3Client({
    region: 'auto',
    endpoint: getR2Endpoint(),
    forcePathStyle: Boolean(R2_ENDPOINT),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: requireStorageValue('R2_ACCESS_KEY_ID', R2_ACCESS_KEY_ID),
      secretAccessKey: requireStorageValue('R2_SECRET_ACCESS_KEY', R2_SECRET_ACCESS_KEY),
    },
  });

  return cachedR2Client;
}

function getOrCreateR2PresignClient(): S3Client {
  if (cachedR2PresignClient) {
    return cachedR2PresignClient;
  }

  cachedR2PresignClient = new S3Client({
    region: 'auto',
    endpoint: getR2PresignEndpoint(),
    forcePathStyle: Boolean(R2_PRESIGN_ENDPOINT || R2_ENDPOINT),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: requireStorageValue('R2_ACCESS_KEY_ID', R2_ACCESS_KEY_ID),
      secretAccessKey: requireStorageValue('R2_SECRET_ACCESS_KEY', R2_SECRET_ACCESS_KEY),
    },
  });

  return cachedR2PresignClient;
}

export const r2Client = new Proxy({} as S3Client, {
  get(_target, prop, receiver) {
    if (prop === 'destroy') {
      return () => {
        // Both are destroyed independently. Returning early when the send client was
        // never created leaked the presign client in a process that only ever presigned.
        if (cachedR2Client) {
          cachedR2Client.destroy();
          cachedR2Client = null;
        }
        if (cachedR2PresignClient) {
          cachedR2PresignClient.destroy();
          cachedR2PresignClient = null;
        }
      };
    }

    const client = getOrCreateR2Client();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

export function getR2PublicObjectUrl(key: string): string {
  const sanitizedKey = key.replace(/^\/+/, '');

  if (R2_PUBLIC_BASE_URL) {
    return `${trimTrailingSlashes(R2_PUBLIC_BASE_URL)}/${sanitizedKey}`;
  }

  if (R2_ENDPOINT) {
    return `${trimTrailingSlashes(R2_ENDPOINT)}/${R2_BUCKET_NAME}/${sanitizedKey}`;
  }

  if (!R2_ACCOUNT_ID) {
    throw new Error('Missing R2_PUBLIC_BASE_URL or R2_ACCOUNT_ID for public object URLs');
  }

  return `https://${R2_BUCKET_NAME}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${sanitizedKey}`;
}

export async function ensureR2BucketExists(): Promise<void> {
  try {
    await r2Client.send(new HeadBucketCommand({ Bucket: R2_BUCKET_NAME }));
    return;
  } catch (error) {
    const statusCode = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    if (statusCode && statusCode !== 404 && statusCode !== 301 && statusCode !== 403) {
      throw error;
    }
  }

  await r2Client.send(new CreateBucketCommand({ Bucket: R2_BUCKET_NAME }));
}

export async function uploadAudio(
  buffer: Buffer,
  filename: string,
  contentType: string = 'audio/webm'
): Promise<string> {
  // Sanitize: strip any path components, use only the basename
  const sanitized = filename.replace(/^.*[\\/]/, '').replace(/\.\.+/g, '');
  if (!sanitized) throw new Error('Invalid filename');
  const key = `voice/${sanitized}`;

  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  return getR2PublicObjectUrl(key);
}

const DEFAULT_PRESIGNED_PUT_TTL_SECONDS = 60 * 60;

export function getR2UploadCorsOrigins(extraOrigins: string[] = []): string[] {
  const origins = new Set<string>();

  for (const raw of [process.env.NEXTAUTH_URL, process.env.NEXT_PUBLIC_APP_URL, ...extraOrigins]) {
    if (!raw?.trim()) continue;
    try {
      origins.add(new URL(trimTrailingSlashes(raw.trim())).origin);
    } catch {
      // Ignore invalid origin URLs.
    }
  }

  if (process.env.NODE_ENV === 'development') {
    origins.add('http://localhost:3000');
    origins.add('http://127.0.0.1:3000');
  }

  return [...origins];
}

function corsRulesMatchOrigins(
  existing:
    | {
        AllowedOrigins?: string[];
        AllowedMethods?: string[];
      }
    | undefined,
  requiredOrigins: string[]
): boolean {
  if (!existing?.AllowedOrigins?.length || !existing.AllowedMethods?.length) {
    return false;
  }

  const allowedOrigins = new Set(existing.AllowedOrigins);
  const methods = new Set(existing.AllowedMethods.map((method) => method.toUpperCase()));
  const hasRequiredOrigins = requiredOrigins.every((origin) => allowedOrigins.has(origin));
  const hasPut = methods.has('PUT');
  const hasGet = methods.has('GET') || methods.has('HEAD');

  return hasRequiredOrigins && hasPut && hasGet;
}

export async function ensureR2UploadCors(extraOrigins: string[] = []): Promise<string[]> {
  const allowedOrigins = getR2UploadCorsOrigins(extraOrigins);
  if (allowedOrigins.length === 0) {
    throw new Error(
      'No origins configured for R2 upload CORS (set NEXTAUTH_URL or NEXT_PUBLIC_APP_URL)'
    );
  }

  const managedRule = {
    AllowedOrigins: allowedOrigins,
    AllowedMethods: ['GET', 'PUT', 'HEAD'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 3600,
  };

  // The catch covers the read only. Wrapping the write in it too meant a transient write
  // failure was mistaken for "this bucket has no CORS config", and the retry below then
  // sent the managed rule on its own, discarding whatever the bucket already had.
  let existingRules: CORSRule[] | null = null;
  try {
    const existing = await r2Client.send(
      new GetBucketCorsCommand({
        Bucket: R2_BUCKET_NAME,
      })
    );
    existingRules = existing.CORSRules ?? [];
  } catch {
    // No CORS config yet, or insufficient permissions to read — write the managed rule.
  }

  if (existingRules) {
    if (existingRules.some((rule) => corsRulesMatchOrigins(rule, allowedOrigins))) {
      return allowedOrigins;
    }

    await r2Client.send(
      new PutBucketCorsCommand({
        Bucket: R2_BUCKET_NAME,
        CORSConfiguration: {
          CORSRules: [...existingRules, managedRule],
        },
      })
    );
    return allowedOrigins;
  }

  await r2Client.send(
    new PutBucketCorsCommand({
      Bucket: R2_BUCKET_NAME,
      CORSConfiguration: {
        CORSRules: [managedRule],
      },
    })
  );

  return allowedOrigins;
}

export async function createPresignedVideoPutUrl(
  key: string,
  contentType: string,
  contentLength: bigint,
  expiresInSeconds = DEFAULT_PRESIGNED_PUT_TTL_SECONDS
): Promise<string> {
  if (!key.startsWith(VIDEO_OBJECT_KEY_PREFIX)) {
    throw new Error('Invalid video object key');
  }

  if (contentLength <= BigInt(0) || contentLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Invalid video content length');
  }

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
    ContentLength: Number(contentLength),
  });

  return getSignedUrl(getOrCreateR2PresignClient(), command, {
    expiresIn: expiresInSeconds,
    // Passing ContentType to the command is not enough: unless the header is signable the
    // grant does not bind it, and whoever holds the url can put any media type at the key.
    // The client sends the same value back, so the signature covers what actually lands.
    signableHeaders: new Set(['content-type']),
  });
}

export async function createMultipartVideoUpload(
  key: string,
  contentType: string,
  abortSignal?: AbortSignal
): Promise<string> {
  if (!key.startsWith(VIDEO_OBJECT_KEY_PREFIX)) {
    throw new Error('Invalid video object key');
  }

  const result = await r2Client.send(
    new CreateMultipartUploadCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    }),
    { abortSignal }
  );

  if (!result.UploadId) {
    throw new Error('Failed to create multipart upload');
  }

  return result.UploadId;
}

export async function createPresignedUploadPartUrl(
  key: string,
  uploadId: string,
  partNumber: number,
  expiresInSeconds = DEFAULT_PRESIGNED_PUT_TTL_SECONDS
): Promise<string> {
  if (!key.startsWith(VIDEO_OBJECT_KEY_PREFIX)) {
    throw new Error('Invalid video object key');
  }

  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    throw new Error('Invalid part number');
  }

  const command = new UploadPartCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });

  return getSignedUrl(getOrCreateR2PresignClient(), command, { expiresIn: expiresInSeconds });
}

export async function completeMultipartVideoUpload(
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
  abortSignal?: AbortSignal
): Promise<void> {
  if (!key.startsWith(VIDEO_OBJECT_KEY_PREFIX)) {
    throw new Error('Invalid video object key');
  }

  if (parts.length === 0) {
    throw new Error('No parts provided for multipart completion');
  }

  const orderedParts = [...parts]
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag }));

  await r2Client.send(
    new CompleteMultipartUploadCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: orderedParts },
    }),
    { abortSignal }
  );
}

export async function abortMultipartVideoUpload(key: string, uploadId: string): Promise<void> {
  if (!key.startsWith(VIDEO_OBJECT_KEY_PREFIX)) {
    throw new Error('Invalid video object key');
  }

  await r2Client.send(
    new AbortMultipartUploadCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
    })
  );
}

/**
 * Server-side part upload, for bytes this server is copying itself (a Google
 * Drive import on a self-hosted instance). Browser uploads use presigned part urls.
 */
export async function uploadVideoPart(
  key: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
  abortSignal?: AbortSignal
): Promise<string> {
  if (!key.startsWith(VIDEO_OBJECT_KEY_PREFIX)) {
    throw new Error('Invalid video object key');
  }

  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    throw new Error('Invalid part number');
  }

  const result = await r2Client.send(
    new UploadPartCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
      ContentLength: body.byteLength,
    }),
    { abortSignal }
  );

  if (!result.ETag) {
    throw new Error('Storage did not return an ETag for the uploaded part');
  }

  return result.ETag;
}

export async function putImageObject(
  key: string,
  contentType: string,
  body: Uint8Array,
  abortSignal?: AbortSignal
): Promise<void> {
  if (!key.startsWith(IMAGE_OBJECT_KEY_PREFIX)) {
    throw new Error('Invalid image object key');
  }

  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      Body: body,
      ContentLength: body.byteLength,
    }),
    { abortSignal }
  );
}

/**
 * Streams an image or audio attachment into storage without holding it in
 * memory. The length must be known up front: S3 needs it for a streamed body,
 * and a body that turns out shorter or longer makes the request fail.
 */
export async function putAttachmentObjectStream(
  key: string,
  contentType: string,
  body: Readable,
  contentLength: number,
  abortSignal?: AbortSignal
): Promise<void> {
  if (!key.startsWith(IMAGE_OBJECT_KEY_PREFIX) && !key.startsWith(AUDIO_OBJECT_KEY_PREFIX)) {
    throw new Error('Invalid attachment object key');
  }

  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      Body: body,
      ContentLength: contentLength,
    }),
    { abortSignal }
  );
}

export async function createPresignedImagePutUrl(
  key: string,
  contentType: string,
  expiresInSeconds = DEFAULT_PRESIGNED_PUT_TTL_SECONDS
): Promise<string> {
  if (!key.startsWith(IMAGE_OBJECT_KEY_PREFIX)) {
    throw new Error('Invalid image object key');
  }

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(getOrCreateR2PresignClient(), command, {
    expiresIn: expiresInSeconds,
    // Without this the grant binds only the host, so an image upload url accepts any
    // media type at an `images/` key the app then serves as an image.
    signableHeaders: new Set(['content-type']),
  });
}

export async function headVideoObject(key: string): Promise<{
  contentLength: bigint;
  contentType: string | undefined;
} | null> {
  if (!key.startsWith(VIDEO_OBJECT_KEY_PREFIX)) {
    return null;
  }

  try {
    const result = await r2Client.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      })
    );

    const contentLength =
      typeof result.ContentLength === 'number' && result.ContentLength >= 0
        ? BigInt(result.ContentLength)
        : BigInt(0);

    return {
      contentLength,
      contentType: result.ContentType,
    };
  } catch (error) {
    const statusCode = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    if (statusCode === 404) return null;
    throw error;
  }
}

export async function readVideoObjectBytes(
  key: string,
  byteLength: number
): Promise<Uint8Array | null> {
  if (!key.startsWith(VIDEO_OBJECT_KEY_PREFIX) || byteLength <= 0) {
    return null;
  }

  const rangeEnd = Math.max(0, byteLength - 1);
  try {
    const result = await r2Client.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Range: `bytes=0-${rangeEnd}`,
      })
    );

    if (!result.Body) return null;
    const body = result.Body as { transformToByteArray?: () => Promise<Uint8Array> };
    if (typeof body.transformToByteArray !== 'function') return null;
    return await body.transformToByteArray();
  } catch (error) {
    const statusCode = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    if (statusCode === 404 || statusCode === 416) return null;
    throw error;
  }
}

function assertAllowedObjectKey(key: string): void {
  // `voice/` belongs here because uploadAudio() writes under it. Leaving it out meant
  // deleteR2Object('voice/...') always threw, so a voice note attached to a comment could
  // never be removed by the module that stored it and outlived the comment in the bucket.
  if (
    !key.startsWith(VIDEO_OBJECT_KEY_PREFIX) &&
    !key.startsWith(IMAGE_OBJECT_KEY_PREFIX) &&
    !key.startsWith(AUDIO_OBJECT_KEY_PREFIX)
  ) {
    throw new Error('Invalid object key');
  }
}

export async function deleteVideoObject(key: string): Promise<void> {
  if (!key.startsWith(VIDEO_OBJECT_KEY_PREFIX)) {
    throw new Error('Invalid video object key');
  }

  await deleteR2Object(key);
}

export async function deleteR2Object(key: string): Promise<void> {
  assertAllowedObjectKey(key);

  await r2Client.send(
    new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    })
  );
}

export { R2_BUCKET_NAME };
