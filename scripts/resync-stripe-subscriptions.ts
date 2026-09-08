/**
 * Re-reads every Stripe customer's live subscription and writes it back onto the user
 * through the normal sync path.
 *
 * Needed once after a Stripe API version change: mirrored fields that moved between
 * versions stay wrong in the database until that customer happens to produce a webhook,
 * which for a customer whose payment already failed may never happen on its own.
 */
import { db, disconnectDb } from '../lib/db';
import { findLiveStripeSubscription, syncStripeCustomerSubscriptions } from '../lib/billing';
import { isStripeConfigured } from '../lib/stripe';
import { logError } from '../lib/logger';

const TAG = '[resync-stripe-subscriptions]';

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!isStripeConfigured()) {
    console.log(`${TAG} Stripe is not configured, nothing to do`);
    return;
  }

  const users = await db.user.findMany({
    where: { stripeCustomerId: { not: null } },
    select: { id: true, email: true, stripeCustomerId: true, stripeCurrentPeriodEnd: true },
  });

  let synced = 0;
  let withoutSubscription = 0;
  let failed = 0;

  for (const user of users) {
    if (!user.stripeCustomerId) continue;

    try {
      const subscription = await findLiveStripeSubscription(user.stripeCustomerId);

      if (!subscription) {
        withoutSubscription += 1;
        continue;
      }

      const label = user.email ?? user.id;

      if (dryRun) {
        console.log(
          `${TAG} Would sync ${label}: ${subscription.id} (${subscription.status}), stored period end ${user.stripeCurrentPeriodEnd?.toISOString() ?? 'null'}`
        );
        synced += 1;
        continue;
      }

      const updated = await syncStripeCustomerSubscriptions(user.stripeCustomerId);
      if (updated) {
        console.log(
          `${TAG} Synced ${label}: ${subscription.status}, period end ${updated.stripeCurrentPeriodEnd?.toISOString() ?? 'null'}`
        );
        synced += 1;
      }
    } catch (error) {
      failed += 1;
      logError(`${TAG} Failed syncing ${user.email ?? user.id}:`, error);
    }
  }

  console.log(`${TAG} Summary${dryRun ? ' (dry run)' : ''}`);
  console.log(`${TAG} Customers: ${users.length}`);
  console.log(`${TAG} Synced: ${synced}`);
  console.log(`${TAG} Without a live subscription: ${withoutSubscription}`);
  console.log(`${TAG} Failed: ${failed}`);
}

main()
  .catch((error) => {
    logError(`${TAG} Fatal error:`, error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDb();
  });
