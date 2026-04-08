import Stripe from 'stripe';
import { hasStripeConfig, isStripeBillingEnabled } from '@/lib/feature-flags';

let stripeClient: Stripe | null = null;

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
    stripeClient = new Stripe(secretKey);
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
