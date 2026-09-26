import { spawn } from 'node:child_process';
import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

const servers: Server[] = [];
const secret = 'healthcheck-test-secret';

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  return String(address.port);
}

function probe(port: string, providedSecret = secret) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn('bun', ['scripts/live-review-healthcheck.ts'], {
      env: { ...process.env, LIVE_REVIEW_PORT: port, LIVE_REVIEW_SECRET: providedSecret },
      stdio: 'ignore',
      timeout: 5000,
    });
    child.on('error', reject);
    child.on('exit', resolve);
  });
}

describe('live review container healthcheck', () => {
  it('authenticates against the configured local port and accepts only 204', async () => {
    const port = await serve((request, response) => {
      const allowed =
        request.url === '/health' && request.headers['x-live-review-secret'] === secret;
      response.writeHead(allowed ? 204 : 403).end();
    });
    expect(await probe(port)).toBe(0);
    expect(await probe(port, 'wrong-secret')).toBe(1);
  });

  it.each([200, 403, 500])('rejects HTTP %i', async (status) => {
    const port = await serve((_request, response) => response.writeHead(status).end());
    expect(await probe(port)).toBe(1);
  });

  it('rejects a missing secret without making a request', async () => {
    let requests = 0;
    const port = await serve((_request, response) => {
      requests += 1;
      response.writeHead(204).end();
    });
    expect(await probe(port, '')).toBe(1);
    expect(requests).toBe(0);
  });

  it('does not follow redirects to another server', async () => {
    let redirectedRequests = 0;
    const target = await serve((_request, response) => {
      redirectedRequests += 1;
      response.writeHead(204).end();
    });
    const port = await serve((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${target}/health` }).end();
    });
    expect(await probe(port)).toBe(1);
    expect(redirectedRequests).toBe(0);
  });

  it('fails when the server does not respond', async () => {
    const port = await serve(() => {});
    expect(await probe(port)).toBe(1);
  });
});
