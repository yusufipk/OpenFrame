// lib/notifications.ts is stubbed wholesale in tests/setup/api.ts so the API
// suite never fans out to Telegram or SMTP. This file stubs the boundaries
// instead (Prisma, global fetch, nodemailer) and asserts on the decision the
// module actually owns: who receives a notification and who does not.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type NotificationEvent, notifyProjectOwner, notifyUsers } from '@/lib/notifications';

const dbMock = vi.hoisted(() => ({
  notificationSetting: { findMany: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ db: dbMock, default: dbMock, disconnectDb: vi.fn() }));

const mail = vi.hoisted(() => {
  const sendMail = vi.fn<
    (message: {
      from: string;
      to: string;
      subject: string;
      html: string;
    }) => Promise<{ messageId: string }>
  >(async () => ({ messageId: 'unit-test-message-id' }));
  const createTransport = vi.fn(() => ({ sendMail, verify: vi.fn(async () => true) }));
  return { sendMail, createTransport };
});
vi.mock('nodemailer', () => ({
  default: { createTransport: mail.createTransport },
  createTransport: mail.createTransport,
}));

type Settings = Parameters<typeof settingsRow>[0];

function settingsRow(overrides: {
  userId?: string;
  email?: string | null;
  emailEnabled?: boolean;
  telegramEnabled?: boolean;
  telegramChatId?: string | null;
  timezone?: string;
  onNewVideo?: boolean;
  onNewVersion?: boolean;
  onNewComment?: boolean;
  onNewReply?: boolean;
  onApprovalEvents?: boolean;
}) {
  const userId = overrides.userId ?? 'user-1';
  return {
    userId,
    emailEnabled: overrides.emailEnabled ?? true,
    telegramEnabled: overrides.telegramEnabled ?? true,
    telegramChatId: overrides.telegramChatId === undefined ? 'chat-1' : overrides.telegramChatId,
    timezone: overrides.timezone ?? 'UTC',
    onNewVideo: overrides.onNewVideo ?? true,
    onNewVersion: overrides.onNewVersion ?? true,
    onNewComment: overrides.onNewComment ?? true,
    onNewReply: overrides.onNewReply ?? true,
    onApprovalEvents: overrides.onApprovalEvents ?? true,
    user: { email: overrides.email === undefined ? `${userId}@example.com` : overrides.email },
  };
}

function recipients(...rows: ReturnType<typeof settingsRow>[]): void {
  dbMock.notificationSetting.findMany.mockResolvedValue(rows);
}

const COMMENT_EVENT: NotificationEvent = {
  type: 'new_comment',
  projectName: 'Launch Film',
  videoTitle: 'Teaser',
  commentAuthor: 'Ada',
  commentText: 'The cut at 0:12 is too fast',
  timestamp: '0:12',
  url: 'https://app.example.com/watch/video-1',
};

const VIDEO_EVENT: NotificationEvent = {
  type: 'new_video',
  projectName: 'Launch Film',
  videoTitle: 'Teaser',
  addedBy: 'Ada',
  url: 'https://app.example.com/watch/video-1',
};

const EVENTS: Record<string, NotificationEvent> = {
  new_video: VIDEO_EVENT,
  new_version: {
    type: 'new_version',
    projectName: 'Launch Film',
    videoTitle: 'Teaser',
    versionLabel: 'v2',
    addedBy: 'Ada',
    url: 'https://app.example.com/watch/video-1',
  },
  new_comment: COMMENT_EVENT,
  new_reply: {
    type: 'new_reply',
    projectName: 'Launch Film',
    videoTitle: 'Teaser',
    replyAuthor: 'Grace',
    replyText: 'Agreed',
    parentAuthor: 'Ada',
    timestamp: '0:12',
    url: 'https://app.example.com/watch/video-1',
  },
  approval_requested: {
    type: 'approval_requested',
    projectName: 'Launch Film',
    videoTitle: 'Teaser',
    versionLabel: 'v2',
    requestedBy: 'Ada',
    url: 'https://app.example.com/watch/video-1',
  },
  approval_action: {
    type: 'approval_action',
    projectName: 'Launch Film',
    videoTitle: 'Teaser',
    versionLabel: 'v2',
    actorName: 'Grace',
    action: 'approved',
    url: 'https://app.example.com/watch/video-1',
  },
  approval_completed: {
    type: 'approval_completed',
    projectName: 'Launch Film',
    videoTitle: 'Teaser',
    versionLabel: 'v2',
    approvedByCount: 2,
    url: 'https://app.example.com/watch/video-1',
  },
  approval_rejected: {
    type: 'approval_rejected',
    projectName: 'Launch Film',
    videoTitle: 'Teaser',
    versionLabel: 'v2',
    rejectedBy: 'Grace',
    url: 'https://app.example.com/watch/video-1',
  },
};

let fetchMock: ReturnType<typeof vi.fn>;

/** The parsed body of the Nth Telegram call. */
function telegramPayload(index = 0): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[index][1].body));
}

function sentMail(index = 0): { from: string; to: string; subject: string; html: string } {
  return mail.sendMail.mock.calls[index][0];
}

beforeEach(() => {
  dbMock.notificationSetting.findMany.mockReset();
  dbMock.notificationSetting.findMany.mockResolvedValue([]);
  mail.sendMail.mockReset();
  mail.sendMail.mockResolvedValue({ messageId: 'unit-test-message-id' });
  mail.createTransport.mockClear();

  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
  vi.stubGlobal('fetch', fetchMock);

  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'bot-token-unit');
  vi.stubEnv('SMTP_HOST', 'smtp.example.com');
  vi.stubEnv('SMTP_PORT', '587');
  vi.stubEnv('SMTP_USER', 'smtp-user');
  vi.stubEnv('SMTP_PASSWORD', 'smtp-password');
  vi.stubEnv('SMTP_FROM', undefined);
  vi.stubEnv('EMAIL_FROM', undefined);
  vi.stubEnv('NEXTAUTH_URL', 'https://app.example.com');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('choosing the recipient list', () => {
  it('does not query the database when no recipient was named', async () => {
    await notifyUsers([], COMMENT_EVENT);

    expect(dbMock.notificationSetting.findMany).not.toHaveBeenCalled();
  });

  it('does not query the database when every recipient id is empty', async () => {
    await notifyUsers(['', ''], COMMENT_EVENT);

    expect(dbMock.notificationSetting.findMany).not.toHaveBeenCalled();
  });

  it('deduplicates the recipient list and drops empty ids before querying', async () => {
    await notifyUsers(['user-1', 'user-1', '', 'user-2'], COMMENT_EVENT);

    expect(dbMock.notificationSetting.findMany).toHaveBeenCalledWith({
      where: { userId: { in: ['user-1', 'user-2'] } },
      include: { user: { select: { email: true } } },
    });
  });

  // A user with no settings row is simply absent from findMany's result, so the
  // fan-out silently skips them. That is the current contract.
  it('sends nothing to a named user who has no notification settings row', async () => {
    recipients();

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('reaches every recipient that does have a row', async () => {
    recipients(settingsRow({ userId: 'user-1' }), settingsRow({ userId: 'user-2' }));

    await notifyUsers(['user-1', 'user-2'], COMMENT_EVENT);

    expect(mail.sendMail).toHaveBeenCalledTimes(2);
    expect(sentMail(0).to).toBe('user-1@example.com');
    expect(sentMail(1).to).toBe('user-2@example.com');
  });
});

describe('per-user event settings', () => {
  it.each([
    ['new_video', 'onNewVideo'],
    ['new_version', 'onNewVersion'],
    ['new_comment', 'onNewComment'],
    ['new_reply', 'onNewReply'],
    ['approval_requested', 'onApprovalEvents'],
    ['approval_action', 'onApprovalEvents'],
    ['approval_completed', 'onApprovalEvents'],
    ['approval_rejected', 'onApprovalEvents'],
  ] as const)('sends a %s event only when %s is on', async (eventType, flag) => {
    recipients(settingsRow({ [flag]: false } as Settings));
    await notifyUsers(['user-1'], EVENTS[eventType]);

    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    recipients(settingsRow({ [flag]: true } as Settings));
    await notifyUsers(['user-1'], EVENTS[eventType]);

    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turning off one event type leaves the others alone', async () => {
    recipients(settingsRow({ onNewComment: false }));

    await notifyUsers(['user-1'], VIDEO_EVENT);

    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for an event type the settings do not map', async () => {
    recipients(settingsRow({}));

    await notifyUsers(['user-1'], { type: 'video_deleted' } as unknown as NotificationEvent);

    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('channel selection', () => {
  it('still sends the email to a user who has no Telegram chat id', async () => {
    recipients(settingsRow({ telegramEnabled: true, telegramChatId: null }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(sentMail(0).to).toBe('user-1@example.com');
  });

  it('still sends the email when the deployment has no Telegram bot token', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', undefined);
    recipients(settingsRow({}));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });

  it('skips Telegram for a user who turned it off', async () => {
    recipients(settingsRow({ telegramEnabled: false }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });

  it('skips email for a user who turned it off but still sends Telegram', async () => {
    recipients(settingsRow({ emailEnabled: false }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('skips email for a user with no address on file', async () => {
    recipients(settingsRow({ email: null }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing at all to a user with both channels off', async () => {
    recipients(settingsRow({ emailEnabled: false, telegramEnabled: false }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('does not build an SMTP transport when SMTP is unconfigured', async () => {
    vi.stubEnv('SMTP_HOST', undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    recipients(settingsRow({ telegramEnabled: false }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(mail.createTransport).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('uses an implicit TLS connection only on port 465', async () => {
    vi.stubEnv('SMTP_PORT', '465');
    recipients(settingsRow({}));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(mail.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com', port: 465, secure: true })
    );
  });
});

describe('one failing recipient does not stop the rest', () => {
  it('keeps delivering after a recipient whose email send rejects', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mail.sendMail.mockImplementation(async (message) => {
      if (message.to === 'user-1@example.com') throw new Error('mailbox full');
      return { messageId: 'ok' };
    });
    recipients(settingsRow({ userId: 'user-1' }), settingsRow({ userId: 'user-2' }));

    await notifyUsers(['user-1', 'user-2'], COMMENT_EVENT);

    expect(mail.sendMail).toHaveBeenCalledTimes(2);
    expect(sentMail(1).to).toBe('user-2@example.com');
    expect(logged).toHaveBeenCalled();
  });

  it('keeps delivering after a recipient whose Telegram call rejects', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error('telegram unreachable'));
    recipients(settingsRow({ userId: 'user-1' }), settingsRow({ userId: 'user-2' }));

    await notifyUsers(['user-1', 'user-2'], COMMENT_EVENT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mail.sendMail).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalled();
  });

  it('still emails a user whose own Telegram delivery failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'bot blocked' });
    recipients(settingsRow({}));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });

  it('resolves rather than throwing when the settings lookup fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.notificationSetting.findMany.mockRejectedValue(new Error('connection refused'));

    await expect(notifyUsers(['user-1'], COMMENT_EVENT)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith('Notification dispatch failed:', {
      type: 'Error',
      message: 'connection refused',
    });
  });

  it('resolves rather than throwing when a recipient has a malformed settings row', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // `user` is missing, so reading settings.user.email throws inside the map.
    dbMock.notificationSetting.findMany.mockResolvedValue([
      { ...settingsRow({}), user: undefined },
      settingsRow({ userId: 'user-2' }),
    ]);

    await expect(notifyUsers(['user-1', 'user-2'], COMMENT_EVENT)).resolves.toBeUndefined();
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(sentMail(0).to).toBe('user-2@example.com');
  });
});

describe('the Telegram message', () => {
  it('posts to the bot sendMessage endpoint with the chat id and preview disabled', async () => {
    recipients(settingsRow({ telegramChatId: 'chat-42', emailEnabled: false }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.telegram.org/botbot-token-unit/sendMessage'
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(telegramPayload()).toMatchObject({
      chat_id: 'chat-42',
      link_preview_options: { is_disabled: true },
    });
  });

  it('attaches the deep link as an inline button', async () => {
    recipients(settingsRow({ emailEnabled: false }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(telegramPayload().reply_markup).toEqual({
      inline_keyboard: [[{ text: 'View Comment', url: 'https://app.example.com/watch/video-1' }]],
    });
  });

  // Telegram rejects an inline keyboard whose url is not https, which would
  // fail the whole message rather than just the button.
  it('omits the button when the deep link is not https', async () => {
    recipients(settingsRow({ emailEnabled: false }));

    await notifyUsers(['user-1'], { ...COMMENT_EVENT, url: 'http://localhost:3000/watch/video-1' });

    expect(telegramPayload().reply_markup).toBeUndefined();
  });

  it('carries the project, video, author and comment body in the text', async () => {
    recipients(settingsRow({ emailEnabled: false }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    const text = String(telegramPayload().text);
    expect(text).toContain('Project: Launch Film');
    expect(text).toContain('Video: Teaser');
    expect(text).toContain('By: Ada at 0:12');
    expect(text).toContain('"The cut at 0:12 is too fast"');
    // The url lives on the button, not in the body.
    expect(text).not.toContain('https://app.example.com');
  });

  it('truncates a long comment body to 200 characters', async () => {
    recipients(settingsRow({ emailEnabled: false }));

    await notifyUsers(['user-1'], { ...COMMENT_EVENT, commentText: 'x'.repeat(250) });

    expect(String(telegramPayload().text)).toContain(`"${'x'.repeat(200)}..."`);
  });

  it('leaves a body at exactly 200 characters untruncated', async () => {
    recipients(settingsRow({ emailEnabled: false }));

    await notifyUsers(['user-1'], { ...COMMENT_EVENT, commentText: 'x'.repeat(200) });

    expect(String(telegramPayload().text)).toContain(`"${'x'.repeat(200)}"`);
  });

  it('omits the optional note block when an approval carries no note', async () => {
    // Rendered twice, once without a note and once with, so the assertion is
    // about the note block itself rather than about quotation marks in general:
    // the two bodies have to differ by exactly that block and nothing else. The
    // clock is frozen because the body carries a minute-precision timestamp, and
    // a rollover between the two calls would make them differ for an unrelated
    // reason.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
    recipients(settingsRow({ emailEnabled: false }));

    // Spelled out rather than taken from EVENTS so that `note` can be added to a
    // copy: EVENTS is typed as the whole NotificationEvent union, and only the
    // approval variants carry a note.
    const rejected = {
      type: 'approval_rejected',
      projectName: 'Launch Film',
      videoTitle: 'Teaser',
      versionLabel: 'v2',
      rejectedBy: 'Grace',
      url: 'https://app.example.com/watch/video-1',
    } satisfies NotificationEvent;

    await notifyUsers(['user-1'], rejected);
    await notifyUsers(['user-1'], { ...rejected, note: 'colour is off' });
    vi.useRealTimers();

    expect(String(telegramPayload(1).text)).toBe(
      `${String(telegramPayload(0).text)}\n\n"colour is off"`
    );
  });

  it('includes the note when an approval carries one', async () => {
    recipients(settingsRow({ emailEnabled: false }));

    const withNote: NotificationEvent = {
      type: 'approval_rejected',
      projectName: 'Launch Film',
      videoTitle: 'Teaser',
      versionLabel: 'v2',
      rejectedBy: 'Grace',
      note: 'colour is off',
      url: 'https://app.example.com/watch/video-1',
    };

    await notifyUsers(['user-1'], withNote);

    expect(String(telegramPayload().text)).toContain('"colour is off"');
  });
});

describe('the email message', () => {
  it.each([
    ['new_video', '[OpenFrame] New video in Launch Film: Teaser'],
    ['new_version', '[OpenFrame] New version of Teaser in Launch Film'],
    ['new_comment', '[OpenFrame] New comment on Teaser'],
    ['new_reply', '[OpenFrame] Grace replied on Teaser'],
    ['approval_requested', '[OpenFrame] Approval requested for v2 in Launch Film'],
    ['approval_action', '[OpenFrame] Approval approved by Grace'],
    ['approval_completed', '[OpenFrame] Approval completed for v2'],
    ['approval_rejected', '[OpenFrame] Approval rejected by Grace'],
  ])('subjects a %s event as %s', async (eventType, subject) => {
    recipients(settingsRow({ telegramEnabled: false }));

    await notifyUsers(['user-1'], EVENTS[eventType]);

    expect(sentMail(0).subject).toBe(subject);
  });

  it('falls back to the product address when no from address is configured', async () => {
    recipients(settingsRow({ telegramEnabled: false }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(sentMail(0).from).toBe('OpenFrame <info@open-frame.net>');
  });

  it('prefers SMTP_FROM over EMAIL_FROM', async () => {
    vi.stubEnv('SMTP_FROM', 'A <a@example.com>');
    vi.stubEnv('EMAIL_FROM', 'B <b@example.com>');
    recipients(settingsRow({ telegramEnabled: false }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(sentMail(0).from).toBe('A <a@example.com>');
  });

  it('escapes user-supplied text so a project name cannot inject markup', async () => {
    recipients(settingsRow({ telegramEnabled: false }));

    await notifyUsers(['user-1'], {
      ...COMMENT_EVENT,
      projectName: '<script>alert(1)</script>',
      commentText: '<img src=x onerror=alert(1)>',
    });

    const { html } = sentMail(0);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('links the footer at the configured app url', async () => {
    recipients(settingsRow({ telegramEnabled: false }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    expect(sentMail(0).html).toContain('https://app.example.com/settings');
  });

  it('truncates a long comment body to 300 characters', async () => {
    recipients(settingsRow({ telegramEnabled: false }));

    await notifyUsers(['user-1'], { ...COMMENT_EVENT, commentText: 'x'.repeat(400) });

    expect(sentMail(0).html).toContain(`${'x'.repeat(300)}...`);
    expect(sentMail(0).html).not.toContain('x'.repeat(301));
  });
});

describe('timestamp rendering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T23:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the time in the recipient timezone', async () => {
    recipients(settingsRow({ timezone: 'Europe/Istanbul', emailEnabled: false }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    // 23:30 UTC is 02:30 the next day in Istanbul (UTC+3). The date and the
    // time are asserted separately because the separator between them is an
    // ICU detail that differs between runtimes.
    const text = String(telegramPayload().text);
    expect(text).toContain('Jan 16, 2026');
    expect(text).toContain('2:30 AM');
  });

  it('falls back to UTC for a timezone the runtime rejects', async () => {
    recipients(settingsRow({ timezone: 'Mars/Olympus', emailEnabled: false }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    const text = String(telegramPayload().text);
    expect(text).toContain('Jan 15, 2026');
    expect(text).toContain('11:30 PM');
  });

  it('falls back to UTC when the row stores an empty timezone', async () => {
    recipients(settingsRow({ timezone: '', emailEnabled: false }));

    await notifyUsers(['user-1'], COMMENT_EVENT);

    const text = String(telegramPayload().text);
    expect(text).toContain('Jan 15, 2026');
    expect(text).toContain('11:30 PM');
  });
});

describe('notifyProjectOwner', () => {
  it('fans out to the single owner id', async () => {
    recipients(settingsRow({ userId: 'owner-1' }));

    await notifyProjectOwner('owner-1', VIDEO_EVENT);

    expect(dbMock.notificationSetting.findMany).toHaveBeenCalledWith({
      where: { userId: { in: ['owner-1'] } },
      include: { user: { select: { email: true } } },
    });
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the owner id is empty', async () => {
    await notifyProjectOwner('', VIDEO_EVENT);

    expect(dbMock.notificationSetting.findMany).not.toHaveBeenCalled();
  });
});

describe('still image notifications', () => {
  it('uses an image label and omits playback time from email and Telegram', async () => {
    dbMock.notificationSetting.findMany.mockResolvedValue([settingsRow({ userId: 'owner' })]);
    await notifyProjectOwner('owner', { ...COMMENT_EVENT, mediaType: 'IMAGE', timestamp: null });
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(sentMail().html).toContain('Image');
    expect(sentMail().html).not.toContain('>At<');
    expect(telegramPayload().text).toContain('Image:');
    expect(telegramPayload().text).not.toContain(' at null');
    expect(telegramPayload().text).not.toContain(' at 0:00');
  });
});
