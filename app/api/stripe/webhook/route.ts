import { NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { markSubscriptionCanceledByCustomerId, syncStripeSubscriptionToUser } from '@/lib/billing';
import { getStripe, getStripeWebhookSecret } from '@/lib/stripe';
import { logError } from '@/lib/logger';

export const runtime = 'nodejs';

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const customerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;

  const currentPeriodEnd =
    'current_period_end' in subscription && typeof subscription.current_period_end === 'number'
      ? new Date(subscription.current_period_end * 1000)
      : null;
  const endedAt =
    'ended_at' in subscription && typeof subscription.ended_at === 'number'
      ? new Date(subscription.ended_at * 1000)
      : currentPeriodEnd;

  await markSubscriptionCanceledByCustomerId(customerId, {
    currentPeriodEnd,
    endedAt,
  });
}

export async function POST(request: NextRequest) {
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Missing Stripe signature', { status: 400 });
  }

  let event: Stripe.Event;

  try {
    const stripe = getStripe();
    const body = await request.text();
    event = stripe.webhooks.constructEvent(body, signature, getStripeWebhookSecret());
  } catch (error) {
    logError('Failed to verify Stripe webhook:', error);
    return new Response('Invalid webhook signature', { status: 400 });
  }

  try {
    const stripe = getStripe();

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === 'subscription' && session.subscription) {
          const subscriptionId =
            typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription.id;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          await syncStripeSubscriptionToUser(subscription);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        await syncStripeSubscriptionToUser(subscription);
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(subscription);
        break;
      }
      default:
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    logError('Failed to process Stripe webhook:', error);
    return new Response('Webhook processing failed', { status: 500 });
  }
}
