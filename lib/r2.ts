import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME ?? '';
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;

let cachedR2Client: S3Client | null = null;

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

function getOrCreateR2Client(): S3Client {
  if (cachedR2Client) {
    return cachedR2Client;
  }

  cachedR2Client = new S3Client({
    region: 'auto',
    endpoint: getR2Endpoint(),
    forcePathStyle: Boolean(R2_ENDPOINT),
    credentials: {
      accessKeyId: requireStorageValue('R2_ACCESS_KEY_ID', R2_ACCESS_KEY_ID),
      secretAccessKey: requireStorageValue('R2_SECRET_ACCESS_KEY', R2_SECRET_ACCESS_KEY),
    },
  });

  return cachedR2Client;
}

export const r2Client = new Proxy({} as S3Client, {
  get(_target, prop, receiver) {
    if (prop === 'destroy') {
      return () => {
        if (!cachedR2Client) return;
        cachedR2Client.destroy();
        cachedR2Client = null;
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

export { R2_BUCKET_NAME };
