import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import * as preferencesRoute from '@/app/api/settings/preferences/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { createUser } from '../factories';

const ORIGIN_HEADERS = { origin: 'http://localhost:3000' };

function patchRequest(body: unknown, headers: Record<string, string> = ORIGIN_HEADERS) {
  return apiRequest('/api/settings/preferences', { method: 'PATCH', headers, body });
}

async function storedPreference(userId: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return user.requireProjectDeleteNameConfirmation;
}

describe('GET /api/settings/preferences', () => {
  it('returns 401 without a session', async () => {
    signedOut();

    const response = await callRoute(preferencesRoute.GET, apiRequest('/api/settings/preferences'));

    expect(response.status).toBe(401);
  });

  it('keeps typed-name confirmation on for a new account', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(preferencesRoute.GET, apiRequest('/api/settings/preferences'));

    expect(response.status).toBe(200);
    const data = await readData<{ requireProjectDeleteNameConfirmation: boolean }>(response);
    expect(data.requireProjectDeleteNameConfirmation).toBe(true);
  });

  it('returns the stored value once the user has turned it off', async () => {
    const user = await createUser();
    await db.user.update({
      where: { id: user.id },
      data: { requireProjectDeleteNameConfirmation: false },
    });
    signedInAs(user);

    const response = await callRoute(preferencesRoute.GET, apiRequest('/api/settings/preferences'));

    expect(response.status).toBe(200);
    const data = await readData<{ requireProjectDeleteNameConfirmation: boolean }>(response);
    expect(data.requireProjectDeleteNameConfirmation).toBe(false);
  });
});

describe('PATCH /api/settings/preferences', () => {
  it('returns 401 without a session', async () => {
    signedOut();

    const response = await callRoute(
      preferencesRoute.PATCH,
      patchRequest({ requireProjectDeleteNameConfirmation: false })
    );

    expect(response.status).toBe(401);
  });

  it('rejects a cross-origin request and leaves the preference on', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(
      preferencesRoute.PATCH,
      patchRequest({ requireProjectDeleteNameConfirmation: false }, { origin: 'https://evil.test' })
    );

    expect(response.status).toBe(403);
    expect(await storedPreference(user.id)).toBe(true);
  });

  it('turns typed-name confirmation off and back on for the caller only', async () => {
    const user = await createUser();
    const other = await createUser();
    signedInAs(user);

    const off = await callRoute(
      preferencesRoute.PATCH,
      patchRequest({ requireProjectDeleteNameConfirmation: false })
    );
    expect(off.status).toBe(200);
    expect(await storedPreference(user.id)).toBe(false);
    expect(await storedPreference(other.id)).toBe(true);

    const on = await callRoute(
      preferencesRoute.PATCH,
      patchRequest({ requireProjectDeleteNameConfirmation: true })
    );
    expect(on.status).toBe(200);
    expect(await storedPreference(user.id)).toBe(true);
  });

  // A string "false" is truthy; accepting it would silently leave the check off or on
  // depending on how it was coerced.
  // The row starts off, so a coercion that lands on true also shows up in the row.
  it('rejects a non-boolean value and leaves the row unchanged', async () => {
    const user = await createUser();
    await db.user.update({
      where: { id: user.id },
      data: { requireProjectDeleteNameConfirmation: false },
    });
    signedInAs(user);

    for (const body of [
      { requireProjectDeleteNameConfirmation: 'false' },
      { requireProjectDeleteNameConfirmation: 'true' },
      { requireProjectDeleteNameConfirmation: 1 },
      {},
      null,
    ]) {
      const response = await callRoute(preferencesRoute.PATCH, patchRequest(body));
      expect(response.status).toBe(400);
    }
    expect(await storedPreference(user.id)).toBe(false);
  });
});
