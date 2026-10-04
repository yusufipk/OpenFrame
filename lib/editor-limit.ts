// The editor limit: how many people may upload under one account.
//
// Every place that can make somebody an ADMIN (an invitation, accepting one, or
// a role change, at the workspace, project, folder or video level) asks
// `checkEditorAddition` first. Turning somebody into a COMMENTATOR is never
// limited, and the check never runs on an account whose plan has no limit.

import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { apiErrors } from '@/lib/api-response';
import { hasActiveTrial, isPaidTier } from '@/lib/billing';
import { isStripeFeatureEnabled } from '@/lib/feature-flags';
import { getEditorLimit, isFoundingAccount } from '@/lib/billing-plans';
import { listAccountEditorIds } from '@/lib/account-editors';

type Client = Prisma.TransactionClient;

export const EDITOR_BILLING_SELECT = {
  subscriptionStatus: true,
  trialEndsAt: true,
  stripeCurrentPeriodEnd: true,
  billingAccessEndedAt: true,
  stripeSubscriptionId: true,
  billingPlan: true,
  pendingBillingPlan: true,
  foundingSubscriptionId: true,
} as const satisfies Prisma.UserSelect;

type EditorBillingRow = Prisma.UserGetPayload<{ select: typeof EDITOR_BILLING_SELECT }>;

export function getEditorLimitForUser(user: EditorBillingRow, now: Date = new Date()) {
  return getEditorLimit({
    billingEnabled: isStripeFeatureEnabled(),
    isPaid: isPaidTier(user, now),
    hasActiveTrial: hasActiveTrial(user.trialEndsAt, now),
    billingPlan: user.billingPlan,
    pendingBillingPlan: user.pendingBillingPlan,
    isFounding: isFoundingAccount(user),
  });
}

/** The account a membership is billed to: the owner of the workspace it sits in. */
export async function getWorkspaceOwnerId(
  target: { workspaceId: string } | { projectId: string },
  client: Client = db
): Promise<string | null> {
  if ('workspaceId' in target) {
    const workspace = await client.workspace.findUnique({
      where: { id: target.workspaceId },
      select: { ownerId: true },
    });
    return workspace?.ownerId ?? null;
  }
  const project = await client.project.findUnique({
    where: { id: target.projectId },
    select: { workspace: { select: { ownerId: true } } },
  });
  return project?.workspace.ownerId ?? null;
}

export type EditorAdditionResult = { ok: true } | { ok: false; message: string; askOwner: boolean };

/**
 * Whether one more person may become an editor on `ownerId`'s account.
 *
 * `candidate` is the person being promoted or invited: a user id when the account
 * exists, an email address when it does not yet. Somebody who already counts as
 * an editor on this account takes up no new seat, so promoting them elsewhere in
 * the same account is always allowed.
 */
export async function checkEditorAddition(params: {
  ownerId: string;
  actorUserId: string;
  candidate: { userId: string } | { email: string };
  client?: Client;
}): Promise<EditorAdditionResult> {
  const client = params.client ?? db;
  const owner = await client.user.findUnique({
    where: { id: params.ownerId },
    select: EDITOR_BILLING_SELECT,
  });
  if (!owner) return { ok: true };

  const limit = getEditorLimitForUser(owner);
  if (limit === null) return { ok: true };

  const candidateUserId =
    'userId' in params.candidate
      ? params.candidate.userId
      : ((
          await client.user.findUnique({
            where: { email: params.candidate.email },
            select: { id: true },
          })
        )?.id ?? null);

  const editors = await listAccountEditorIds(params.ownerId, client);
  if (candidateUserId && editors.has(candidateUserId)) return { ok: true };
  if (editors.size < limit) return { ok: true };

  const askOwner = params.actorUserId !== params.ownerId;
  return {
    ok: false,
    askOwner,
    message: askOwner
      ? 'This account’s plan includes one editor. Ask the account owner to upgrade to Studio to add more editors, or invite this person as a reviewer.'
      : 'Your plan includes one editor: you. Studio has unlimited editors, or you can invite this person as a reviewer. Reviewers are always free.',
  };
}

export function editorLimitResponse(result: Extract<EditorAdditionResult, { ok: false }>) {
  return apiErrors.editorLimitReached(result.message, result.askOwner);
}
