import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { apiErrors, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { createStoredZip } from '@/lib/zip-store';

type RouteParams = { params: Promise<{ name: string }> };

// The editor plugins are open source and hold no secrets, so anyone may download
// them. Files are listed by hand so nothing else in the folder ever ships.
const INTEGRATIONS = path.join(process.cwd(), 'integrations');
const DOWNLOADS: Record<
  string,
  { folder: string; files: string[]; fileName: string; contentType: string; zip: boolean }
> = {
  'premiere-panel': {
    folder: 'premiere-panel',
    files: ['manifest.json', 'index.html', 'panel.js', 'markers.js'],
    fileName: 'openframe-comments.ccx',
    contentType: 'application/octet-stream',
    zip: true,
  },
  'resolve-script': {
    folder: 'resolve',
    files: ['OpenFrame Comments.lua'],
    fileName: 'OpenFrame Comments.lua',
    contentType: 'text/plain; charset=utf-8',
    zip: false,
  },
};

// GET /api/integrations/premiere-panel | /api/integrations/resolve-script
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { name } = await params;
  const download = Object.hasOwn(DOWNLOADS, name) ? DOWNLOADS[name] : undefined;
  if (!download) return apiErrors.notFound('Download');
  try {
    const files = await Promise.all(
      download.files.map(async (file) => ({
        name: file,
        data: new Uint8Array(await readFile(path.join(INTEGRATIONS, download.folder, file))),
      }))
    );
    const body = download.zip ? createStoredZip(files) : files[0].data;
    return withCacheControl(
      new Response(Buffer.from(body), {
        headers: {
          'Content-Type': download.contentType,
          'Content-Disposition': `attachment; filename="${download.fileName}"`,
          'X-Content-Type-Options': 'nosniff',
        },
      }),
      'public, max-age=3600'
    );
  } catch (error) {
    logError('Error serving an editor integration:', error);
    return apiErrors.internalError('Failed to load the download');
  }
}
