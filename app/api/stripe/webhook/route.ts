import { NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { getInvoiceSubscriptionId, syncStripeCustomerSubscriptions } from '@/lib/billing';
import { getStripe, getStripeWebhookSecret } from '@/lib/stripe';
import { logError } from '@/lib/logger';

export const runtime = 'nodejs';

function getCustomerId(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null
): string | null {
  if (!customer) return null;
  return typeof customer === 'string' ? customer : customer.id;
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
    // Every subscription-related event re-derives the user's state from the
    // full set of the customer's Stripe subscriptions, so a stale event (e.g.
    // an old subscription being deleted) can never clobber a newer active one.
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === 'subscription') {
          const customerId = getCustomerId(session.customer);
          if (customerId) {
            await syncStripeCustomerSubscriptions(customerId);
          }
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = getCustomerId(subscription.customer);
        if (customerId) {
          await syncStripeCustomerSubscriptions(customerId);
        }
        break;
      }
      // Invoice events carry the payment health of a subscription earlier and more
      // reliably than the subscription events alone. Without them a customer whose card
      // failed keeps the mirror of a healthy subscription until Stripe eventually gives
      // up, which is the whole dunning window spent showing them the wrong state.
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.voided':
      case 'invoice.marked_uncollectible': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = getCustomerId(invoice.customer);
        // Only subscription invoices. A one-off invoice against a customer record left
        // behind by an abandoned checkout has no subscription, and syncing on it would
        // find an empty list, mark the account canceled and book a churn event for a
        // subscription that never existed.
        if (customerId && getInvoiceSubscriptionId(invoice)) {
          await syncStripeCustomerSubscriptions(customerId);
        }
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
