import {
  GetObjectCommand,
  type GetObjectCommandInput,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { apiErrors } from '@/lib/api-response';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { logError } from '@/lib/logger';

type ProxyR2MediaOptions = {
  request: Request;
  key: string;
  fallbackContentType: string;
  cacheControl: string;
  extraHeaders?: Record<string, string>;
  notFoundLabel?: string;
  internalErrorMessage: string;
};

type R2LikeError = {
  name?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
};

function isStrongEtag(value: string): boolean {
  return /^"[^"]+"$/.test(value);
}

function parseHttpDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getErrorStatus(error: unknown): number | null {
  const status = (error as R2LikeError | null | undefined)?.$metadata?.httpStatusCode;
  return typeof status === 'number' ? status : null;
}

function isNotFoundError(error: unknown): boolean {
  const err = error as R2LikeError | null | undefined;
  return err?.name === 'NoSuchKey' || err?.Code === 'NoSuchKey' || getErrorStatus(error) === 404;
}

function isInvalidRangeError(error: unknown): boolean {
  const err = error as R2LikeError | null | undefined;
  return (
    err?.name === 'InvalidRange' || err?.Code === 'InvalidRange' || getErrorStatus(error) === 416
  );
}

function isPreconditionFailed(error: unknown): boolean {
  return getErrorStatus(error) === 412;
}

function toWebStream(body: unknown): ReadableStream<Uint8Array> | null {
  if (!body) return null;

  const withTransform = body as { transformToWebStream?: () => ReadableStream<Uint8Array> };
  if (typeof withTransform.transformToWebStream === 'function') {
    return withTransform.transformToWebStream();
  }

  if (body instanceof Readable) {
    return Readable.toWeb(body) as ReadableStream<Uint8Array>;
  }

  if (body instanceof ReadableStream) {
    return body;
  }

  return null;
}

function setIfPresent(
  headers: Headers,
  key: string,
  value: string | number | null | undefined
): void {
  if (value === undefined || value === null) return;
  headers.set(key, String(value));
}

export async function proxyR2MediaObject({
  request,
  key,
  fallbackContentType,
  cacheControl,
  extraHeaders,
  notFoundLabel = 'File',
  internalErrorMessage,
}: ProxyR2MediaOptions): Promise<NextResponse> {
  const range = request.headers.get('range');
  const ifRange = request.headers.get('if-range');
  const commandInput: GetObjectCommandInput = {
    Bucket: R2_BUCKET_NAME,
    Key: key,
  };

  let usedConditionalIfRange = false;
  if (range) {
    commandInput.Range = range;

    if (ifRange) {
      const token = ifRange.trim();
      if (isStrongEtag(token)) {
        commandInput.IfMatch = token;
        usedConditionalIfRange = true;
      } else {
        const asDate = parseHttpDate(token);
        if (asDate) {
          commandInput.IfUnmodifiedSince = asDate;
          usedConditionalIfRange = true;
        }
      }
    }
  }

  let objectResponse: GetObjectCommandOutput;
  try {
    objectResponse = await r2Client.send(new GetObjectCommand(commandInput));
  } catch (error) {
    if (usedConditionalIfRange && range && isPreconditionFailed(error)) {
      try {
        objectResponse = await r2Client.send(
          new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
          })
        );
      } catch (retryError) {
        if (isNotFoundError(retryError)) {
          return apiErrors.notFound(notFoundLabel);
        }
        if (isInvalidRangeError(retryError)) {
          return new NextResponse(null, {
            status: 416,
            headers: {
              'Cache-Control': cacheControl,
              'Accept-Ranges': 'bytes',
            },
          });
        }
        logError('Error proxying R2 object:', retryError);
        return apiErrors.internalError(internalErrorMessage);
      }
    } else if (isNotFoundError(error)) {
      return apiErrors.notFound(notFoundLabel);
    } else if (isInvalidRangeError(error)) {
      return new NextResponse(null, {
        status: 416,
        headers: {
          'Cache-Control': cacheControl,
          'Accept-Ranges': 'bytes',
        },
      });
    } else {
      logError('Error proxying R2 object:', error);
      return apiErrors.internalError(internalErrorMessage);
    }
  }

  const stream = toWebStream(objectResponse.Body);
  if (!stream) {
    return apiErrors.internalError('Empty file');
  }

  const headers = new Headers();
  setIfPresent(headers, 'Content-Type', objectResponse.ContentType || fallbackContentType);
  setIfPresent(headers, 'Content-Length', objectResponse.ContentLength);
  setIfPresent(headers, 'Content-Range', objectResponse.ContentRange);
  setIfPresent(headers, 'ETag', objectResponse.ETag);
  setIfPresent(headers, 'Last-Modified', objectResponse.LastModified?.toUTCString());
  setIfPresent(headers, 'Accept-Ranges', objectResponse.AcceptRanges || 'bytes');
  headers.set('Cache-Control', cacheControl);

  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      headers.set(name, value);
    }
  }

  return new NextResponse(stream, {
    status: objectResponse.ContentRange ? 206 : 200,
    headers,
  });
}
