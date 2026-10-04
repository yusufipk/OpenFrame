import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GET } from '@/app/api/integrations/[name]/route';
import { apiRequest, callRoute } from '../helpers/request';
import { signedOut } from '../helpers/session';
import { readStoredZip } from '../helpers/zip-reader';

function download(name: string) {
  return callRoute(GET, apiRequest(`/api/integrations/${name}`), { name });
}

const integrations = path.join(process.cwd(), 'integrations');

describe('editor plugin downloads', () => {
  it('serves the Premiere panel as a .ccx with exactly its four files, to anyone', async () => {
    signedOut();
    const response = await download('premiere-panel');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="openframe-comments.ccx"'
    );
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    const entries = readStoredZip(new Uint8Array(await response.arrayBuffer()));
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      'index.html',
      'manifest.json',
      'markers.js',
      'panel.js',
    ]);
    for (const entry of entries) {
      expect(new TextDecoder().decode(entry.data)).toBe(
        readFileSync(path.join(integrations, 'premiere-panel', entry.name), 'utf8')
      );
    }
    const manifest = JSON.parse(
      new TextDecoder().decode(entries.find((entry) => entry.name === 'manifest.json')!.data)
    );
    expect(manifest.host).toEqual({ app: 'premierepro', minVersion: '25.6.0' });
  });

  it('serves the Resolve script as plain text', async () => {
    signedOut();
    const response = await download('resolve-script');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="OpenFrame Comments.lua"'
    );
    expect(await response.text()).toBe(
      readFileSync(path.join(integrations, 'resolve', 'OpenFrame Comments.lua'), 'utf8')
    );
  });

  it.each(['../package.json', 'resolve', 'toString', '__proto__', 'premiere-panel.ccx'])(
    'refuses anything but the two downloads: %s',
    async (name) => {
      const response = await download(name);
      expect(response.status).toBe(404);
    }
  );
});
