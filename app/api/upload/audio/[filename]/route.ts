import { NextResponse } from 'next/server';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { apiErrors } from '@/lib/api-response';

// Only allow UUID filenames with safe extensions
const SAFE_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;

// Map extensions to content types
const CONTENT_TYPE_MAP: Record<string, string> = {
  webm: 'audio/webm',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

function getContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return CONTENT_TYPE_MAP[ext] || 'audio/webm';
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename } = await params;

    // Validate filename to prevent path traversal
    if (!SAFE_FILENAME.test(filename)) {
      return apiErrors.badRequest('Invalid filename');
    }

    const key = `voice/${filename}`;

    // Get file metadata to determine content type
    const headResponse = await r2Client.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      })
    );

    // Use the stored content-type or infer from filename extension
    const contentType = headResponse.ContentType || getContentType(filename);

    // Get the object
    const objectResponse = await r2Client.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      })
    );

    // Handle the body properly - AWS SDK returns a stream
    const body = objectResponse.Body;
    if (!body) {
      return apiErrors.internalError('Empty file');
    }

    // Convert stream to Uint8Array
    const chunks: Uint8Array[] = [];
    // @ts-expect-error - body is an iterable
    for await (const chunk of body) {
      chunks.push(chunk);
    }
    const uint8Array = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      uint8Array.set(chunk, offset);
      offset += chunk.length;
    }

    // Create response with proper content-type
    return new NextResponse(uint8Array, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Accept-Ranges': 'bytes',
      },
    });
  } catch (error: unknown) {
    const errorName = error instanceof Error ? error.name : '';
    if (errorName === 'NoSuchKey') {
      return apiErrors.notFound('File');
    }
    console.error('Error serving audio:', error);
    return apiErrors.internalError('Failed to retrieve audio');
  }
}
