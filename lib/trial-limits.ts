// What a cardless trial is allowed to consume.
//
// The trial exists to let somebody run one real review cycle before paying: upload
// a cut, share it, collect feedback, upload the revision. Everything that costs us
// nothing (YouTube and Vimeo embeds, share links, guests, comments, approvals) is
// therefore unlimited, and the caps sit only on the two things that do cost money
// or invite abuse: how much we store, and how many workspaces one unpaid account
// can hold open.
//
// These take a plain `isPaid` boolean rather than a user row so this module stays
// free of imports from `lib/billing.ts`, which imports the limits back.

/** One workspace, so an unpaid account cannot park a whole agency here. */
export const TRIAL_WORKSPACE_LIMIT = 1;

/**
 * One project at a time. There is no archive flag on Project, so "active" means
 * "exists": deleting a project frees the slot.
 */
export const TRIAL_PROJECT_LIMIT = 1;

/**
 * 3 GiB of direct uploads. Enough for a first cut plus two revisions at a real
 * bitrate, small enough that a farm of throwaway accounts is not worth running.
 * Anyone who hits it can still work through YouTube imports, which cost nothing.
 */
export const TRIAL_STORAGE_LIMIT_BYTES = BigInt(3) * BigInt(1024) * BigInt(1024) * BigInt(1024);

// There is deliberately no separate per-file ceiling for trials. The default
// per-file limit is 5 GiB and the trial's total is 3 GiB, so the quota check
// already refuses anything bigger, and a second limit would only add a second
// way to be told no.

export function getStorageLimitBytes(isPaid: boolean, planLimitBytes: bigint): bigint {
  if (isPaid) return planLimitBytes;
  return planLimitBytes < TRIAL_STORAGE_LIMIT_BYTES ? planLimitBytes : TRIAL_STORAGE_LIMIT_BYTES;
}
