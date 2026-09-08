import Stripe from 'stripe';
import { hasStripeConfig, isStripeBillingEnabled } from '@/lib/feature-flags';

let stripeClient: Stripe | null = null;

// Pinned on purpose. Without it the SDK silently follows whatever version it ships
// with, and field moves between versions (the subscription period moving onto items,
// the invoice subscription link moving under `parent`) turn into null reads instead
// of build failures. `satisfies` makes an SDK bump a compile error here first.
const STRIPE_API_VERSION = '2026-02-25.clover' satisfies Stripe.LatestApiVersion;

export function isStripeConfigured() {
  return isStripeBillingEnabled();
}

export function hasStripeRuntimeConfig() {
  return hasStripeConfig();
}

export function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }

  if (!stripeClient) {
    stripeClient = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
  }

  return stripeClient;
}

export function getStripePriceId() {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) {
    throw new Error('STRIPE_PRICE_ID is not configured');
  }

  return priceId;
}

export function getStripeWebhookSecret() {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }

  return webhookSecret;
}
