CREATE TYPE "BillingPlan" AS ENUM ('SOLO', 'STUDIO');
CREATE TYPE "BillingInterval" AS ENUM ('MONTH', 'YEAR');

ALTER TABLE "users"
  ADD COLUMN "billingPlan" "BillingPlan" NOT NULL DEFAULT 'SOLO',
  ADD COLUMN "billingInterval" "BillingInterval" NOT NULL DEFAULT 'MONTH',
  ADD COLUMN "storageBlocks" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pendingBillingPlan" "BillingPlan",
  ADD COLUMN "pendingBillingInterval" "BillingInterval",
  ADD COLUMN "pendingStorageBlocks" INTEGER,
  ADD COLUMN "pendingChangeAt" TIMESTAMP(3),
  ADD COLUMN "pendingEditorDemotions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "foundingSubscriptionId" TEXT,
  ADD COLUMN "billingChangeLockedUntil" TIMESTAMP(3);

-- Subscriptions that are live when this ships keep their original terms, including
-- one that is behind on payment while Stripe retries it. A Stripe trial has not been
-- paid for yet, so TRIALING is left out.
UPDATE "users"
SET "foundingSubscriptionId" = "stripeSubscriptionId"
WHERE "stripeSubscriptionId" IS NOT NULL
  AND "subscriptionStatus" IN ('ACTIVE', 'PAST_DUE', 'UNPAID');
