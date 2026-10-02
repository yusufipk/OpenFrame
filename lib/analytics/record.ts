// The only way anything in this repo writes an analytics row.
//
// Two things are centralised here so that no call site has to remember them:
//
//  1. The feature flag. Every function below returns without touching the
//     database when OPENFRAME_ENABLE_ANALYTICS is off, which is why the ~15 call
//     sites scattered through app/api are unconditional one-liners.
//  2. Failure. Measurement must never be able to fail a product request, so
//     every write is caught and logged. An event that is not recorded is a hole
//     in a chart; an event that throws is a user who cannot create a project.

import type { AcquisitionChannel, AnalyticsEventName } from '@prisma/client';
import { db } from '@/lib/db';
import { isProductAnalyticsEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import type { FirstTouch } from '@/lib/analytics/cookies';

export interface RecordEventInput {
  name: AnalyticsEventName;
  /**
   * What makes this event unique. The column is UNIQUE, so a replayed webhook, a
   * double-submitted form or a refreshed page collide here and the second write
   * is dropped by the database rather than by a check somebody might forget.
   */
  dedupeKey: string;
  userId?: string | null;
  /**
   * Who did it, when that can differ from `userId`. The scoreboard counts events
   * per account through `userId`; this keeps the team member who acted on that
   * account's behalf without moving the event to them. Only VIDEO_ADDED sets it
   * so far, so NULL on any other event means "not recorded", not "the owner".
   */
  actorId?: string | null;
  anonymousId?: string | null;
  /**
   * Only set for events that happen before there is an account. Once a user
   * exists their channel lives in user_acquisitions and the scoreboard reads it
   * from there, so a later correction applies to their whole history.
   */
  channel?: AcquisitionChannel | null;
  occurredAt?: Date;
}

/** `<event>:<subject>`, for something that can only ever happen once per subject. */
export function eventKey(name: AnalyticsEventName, subject: string): string {
  return `${name}:${subject}`;
}

/**
 * `<event>:<subject>:<UTC day>`, for something repeatable that should still count
 * once per visitor per day (a landing view, a CTA click).
 */
export function dailyEventKey(
  name: AnalyticsEventName,
  subject: string,
  at: Date = new Date()
): string {
  return `${name}:${subject}:${at.toISOString().slice(0, 10)}`;
}

export async function recordEvent(input: RecordEventInput): Promise<void> {
  if (!isProductAnalyticsEnabled()) return;

  try {
    await db.analyticsEvent.createMany({
      data: [
        {
          name: input.name,
          dedupeKey: input.dedupeKey,
          userId: input.userId ?? null,
          actorId: input.actorId ?? null,
          anonymousId: input.anonymousId ?? null,
          channel: input.channel ?? null,
          ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        },
      ],
      skipDuplicates: true,
    });
  } catch (error) {
    logError('Failed to record analytics event:', error);
  }
}

/**
 * Stores the first touch for a visitor with no account yet.
 *
 * Never updated. A visitor who comes back a week later through a different link
 * keeps the channel that brought them the first time, which is the question the
 * scoreboard is asking.
 */
export async function recordFirstTouch(anonymousId: string, touch: FirstTouch): Promise<void> {
  if (!isProductAnalyticsEnabled()) return;

  try {
    await db.acquisitionTouch.createMany({
      data: [
        {
          anonymousId,
          channel: touch.channel,
          utmSource: touch.utmSource,
          utmMedium: touch.utmMedium,
          utmCampaign: touch.utmCampaign,
          referrerHost: touch.referrerHost,
          landingPath: touch.landingPath,
        },
      ],
      skipDuplicates: true,
    });
  } catch (error) {
    logError('Failed to record acquisition touch:', error);
  }
}

/**
 * Copies the first touch onto a freshly created account and claims the events
 * that visitor produced before they had one.
 *
 * The backfill is what joins the two halves of the funnel: without it a landing
 * view and the signup it led to are two unrelated rows, and no query can tell
 * you that GitHub traffic converts and Google traffic does not.
 */
export async function attachAcquisitionToUser(params: {
  userId: string;
  anonymousId: string | null;
  touch: FirstTouch | null;
}): Promise<void> {
  if (!isProductAnalyticsEnabled()) return;

  const { userId, anonymousId, touch } = params;

  try {
    await db.userAcquisition.createMany({
      data: [
        {
          userId,
          anonymousId,
          channel: touch?.channel ?? 'DIRECT',
          utmSource: touch?.utmSource ?? null,
          utmMedium: touch?.utmMedium ?? null,
          utmCampaign: touch?.utmCampaign ?? null,
          referrerHost: touch?.referrerHost ?? null,
          landingPath: touch?.landingPath ?? null,
        },
      ],
      skipDuplicates: true,
    });

    if (anonymousId) {
      await db.analyticsEvent.updateMany({
        where: { anonymousId, userId: null },
        data: { userId },
      });
    }
  } catch (error) {
    logError('Failed to attach acquisition to user:', error);
  }
}

/**
 * The answer to the onboarding question, which is a check on the cookie rather
 * than a replacement for it: it survives a cleared cookie and a phone-to-laptop
 * switch, and it is the only signal that can catch a channel the UTM tags miss
 * entirely ("a friend told me").
 */
export async function setSelfReportedSource(params: {
  userId: string;
  selfReported: AcquisitionChannel;
  note?: string | null;
}): Promise<void> {
  if (!isProductAnalyticsEnabled()) return;

  const note = params.note?.trim().slice(0, 200) || null;

  try {
    await db.userAcquisition.upsert({
      where: { userId: params.userId },
      create: {
        userId: params.userId,
        channel: 'DIRECT',
        selfReported: params.selfReported,
        selfReportedNote: note,
      },
      update: {
        selfReported: params.selfReported,
        selfReportedNote: note,
      },
    });
  } catch (error) {
    logError('Failed to store self-reported acquisition source:', error);
  }
}
