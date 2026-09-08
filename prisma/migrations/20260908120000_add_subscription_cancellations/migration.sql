-- One row per in-app cancellation, carrying the single answer the customer
-- gave on the way out. Written when the request is made, before Stripe
-- confirms it, so a reason is never lost to a webhook that arrives late.
CREATE TYPE "CancellationReason" AS ENUM ('NOT_USING', 'MISSING_FEATURE', 'PRICE_OR_BILLING', 'PROJECT_ENDED', 'OTHER');

CREATE TABLE "subscription_cancellations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "reason" "CancellationReason",
    "note" VARCHAR(500),
    "periodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_cancellations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "subscription_cancellations_userId_createdAt_idx" ON "subscription_cancellations"("userId", "createdAt" DESC);
CREATE INDEX "subscription_cancellations_createdAt_idx" ON "subscription_cancellations"("createdAt" DESC);

ALTER TABLE "subscription_cancellations" ADD CONSTRAINT "subscription_cancellations_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
