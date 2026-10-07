import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseInvitationEmails, sendInvitationBatch } from '@/lib/invitation-batch';

afterEach(() => vi.unstubAllGlobals());

describe('parseInvitationEmails', () => {
  it('normalizes and deduplicates comma and newline separated addresses', () => {
    expect(parseInvitationEmails(' A@Example.com, b@example.com\r\n a@example.com\n\n')).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
  });
  it.each(['', ' , \n ', 'good@example.com,not-an-email'])(
    'rejects invalid input before sending any invitations',
    (input) => {
      expect(() => parseInvitationEmails(input)).toThrow();
    }
  );
  it('accepts 20 distinct recipients and refuses 21', () => {
    const input = Array.from({ length: 20 }, (_, index) => `person${index}@example.com`).join(',');
    expect(parseInvitationEmails(input)).toHaveLength(20);
    expect(() => parseInvitationEmails(`${input},extra@example.com`)).toThrow('up to 20');
  });
});

describe('sendInvitationBatch', () => {
  it('bounds concurrent sends and preserves each recipient outcome after a partial failure', async () => {
    let active = 0;
    let peak = 0;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const { email, role } = JSON.parse(init.body);
        expect(role).toBe('COMMENTATOR');
        calls.push(email);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, email === 'one@example.com' ? 10 : 1));
        active--;
        if (email === 'two@example.com') throw new Error('offline');
        return Response.json({
          data: {
            invitationUrl: `https://example.com/${email}`,
            emailSent: email !== 'three@example.com',
          },
        });
      })
    );
    const emails = [
      'one@example.com',
      'two@example.com',
      'three@example.com',
      'four@example.com',
      'five@example.com',
    ];
    const results = await sendInvitationBatch('/invitations', emails, { role: 'COMMENTATOR' });
    expect(peak).toBe(3);
    expect(calls).toEqual(emails);
    expect(results.map((result) => result.email)).toEqual(emails);
    expect(results[0]).toEqual({
      email: emails[0],
      invitationUrl: 'https://example.com/one@example.com',
      emailSent: true,
    });
    expect(results[1].error).toBe('Could not send invitation. Try again.');
    expect(results[2]).toEqual({
      email: emails[2],
      invitationUrl: 'https://example.com/three@example.com',
      emailSent: false,
    });
    expect(results[4].emailSent).toBe(true);
  });
  it('retries an uncommitted content conflict but never retries other refusals', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: 'Content or access changed. Refresh and try again.' },
          { status: 409 }
        )
      )
      .mockResolvedValueOnce(
        Response.json({ data: { invitationUrl: 'https://example.com/link', emailSent: true } })
      )
      .mockResolvedValueOnce(
        Response.json({ error: 'Editor limit reached', code: 'EDITOR_LIMIT' }, { status: 403 })
      );
    vi.stubGlobal('fetch', fetchMock);
    expect((await sendInvitationBatch('/invite', ['one@example.com'], {}))[0].emailSent).toBe(true);
    expect((await sendInvitationBatch('/invite', ['two@example.com'], {}))[0].error).toBe(
      'Editor limit reached'
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
