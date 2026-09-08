/**
 * Re-reads each Stripe customer's authoritative subscription and writes it back onto the user
 * through the normal sync path.
 *
 * Needed once after a Stripe API version change: mirrored fields that moved between
 * versions stay wrong in the database until that customer happens to produce a webhook,
 * which for a customer whose payment already failed may never happen on its own.
 */
import { db, disconnectDb } from '../lib/db';
import { selectAuthoritativeSubscription, syncStripeCustomerSubscriptions } from '../lib/billing';
import { getStripe, isStripeConfigured } from '../lib/stripe';
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
      const label = user.email ?? user.id;

      // Selected exactly the way the write path selects, over the customer's whole set
      // rather than the live ones only. A mirror left wrong by the version change is most
      // likely on a customer whose subscription is already canceled or incomplete, which
      // is precisely who a live-only filter would skip.
      const { data: subscriptions } = await getStripe().subscriptions.list({
        customer: user.stripeCustomerId,
        status: 'all',
        limit: 100,
      });
      const subscription = selectAuthoritativeSubscription(subscriptions);

      if (!subscription) {
        withoutSubscription += 1;
        continue;
      }

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
          `${TAG} Synced ${label}: ${subscription.status}, period end ${updated.stripeCurrentPeriodEnd?.toISOString() ?? 'null'}, access ends ${updated.billingAccessEndedAt?.toISOString() ?? 'null'}`
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
  console.log(`${TAG} Without a subscription: ${withoutSubscription}`);
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
