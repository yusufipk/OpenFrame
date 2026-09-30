/**
 * How long the live review server keeps an empty room open in the e2e run.
 *
 * Production uses 20 seconds (EMPTY_ROOM_GRACE_MS in
 * scripts/live-review-server.ts). The spec that exercises the grace window has
 * to sit through it three times, so at the production value it spent over 40
 * seconds asleep. The behaviour under test does not depend on the length, only
 * on waits that are placed before and after the deadline, and the spec derives
 * those from this value.
 */
export const LIVE_REVIEW_EMPTY_ROOM_GRACE_MS = 8_000;
