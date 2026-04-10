import Link from 'next/link';
import { Video } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Refund Policy | OpenFrame',
  description: 'Refund Policy for OpenFrame by IPEK TECH LLC.',
};

export default function RefundPolicyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-4 py-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-[900px] items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold hover:text-primary transition-colors">
            <Video className="h-4 w-4 text-primary" />
            OpenFrame
          </Link>
          <Link href="/" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            ← Back to Home
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[900px] px-4 py-12 sm:px-6 lg:px-8">
        <h1 className="text-3xl font-semibold tracking-tight mb-2">Refund Policy</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: April 10, 2026</p>

        <div className="prose prose-sm prose-invert max-w-none space-y-8 text-sm leading-relaxed text-foreground/80">

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">1. Overview</h2>
            <p>
              This Refund Policy applies to all paid subscriptions to the OpenFrame platform operated by <strong className="text-foreground">IPEK TECH LLC</strong>, a Wyoming limited liability company. By subscribing, you acknowledge and agree to this policy.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">2. Free Trial</h2>
            <p>
              All new accounts are eligible for a <strong className="text-foreground">7-day free trial</strong> with full access to paid features. We strongly encourage you to evaluate the Service fully during this period before subscribing.
            </p>
            <p className="mt-3">
              You may cancel at any time during your free trial without being charged. If you do not cancel before the trial ends, your chosen plan will automatically activate and payment will be collected.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">3. General No-Refund Policy</h2>
            <p>
              Because we offer a full-featured free trial, <strong className="text-foreground">all subscription fees are non-refundable</strong> once charged. This includes:
            </p>
            <ul className="mt-3 list-disc pl-5 space-y-2">
              <li>Monthly subscription charges</li>
              <li>Annual subscription charges (including unused months)</li>
              <li>Storage add-on charges</li>
              <li>Any other paid feature or upgrade</li>
            </ul>
            <p className="mt-3">
              Canceling your subscription stops future billing but does not entitle you to a refund for the current billing period. You will continue to have access to the Service until the end of your current paid period.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">4. Exceptions — Extreme Circumstances</h2>
            <p>
              Refunds may be considered <strong className="text-foreground">only in exceptional circumstances</strong>, at the sole discretion of IPEK TECH LLC. Circumstances that <em>may</em> qualify include:
            </p>
            <ul className="mt-3 list-disc pl-5 space-y-2">
              <li><strong className="text-foreground">Extended platform outage:</strong> A verified, prolonged service disruption (greater than 72 consecutive hours) caused by our infrastructure that rendered the Service completely unusable during a billing period.</li>
              <li><strong className="text-foreground">Duplicate charge:</strong> A billing error that resulted in you being charged more than once for the same subscription period.</li>
              <li><strong className="text-foreground">Unauthorized transaction:</strong> A charge made to your account that you did not authorize and that was reported to us promptly (within 14 days of the charge).</li>
            </ul>
            <p className="mt-3 border-l-2 border-border pl-4 text-muted-foreground">
              Dissatisfaction with the product, a change in business circumstances, forgetting to cancel before renewal, or failure to use the Service during a billing period are not considered exceptional circumstances and do not qualify for a refund.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">5. How to Request a Refund</h2>
            <p>
              If you believe your situation qualifies as an exceptional circumstance, contact us within <strong className="text-foreground">14 days</strong> of the charge in question:
            </p>
            <div className="mt-3 border border-border bg-card/40 p-4 text-sm space-y-1">
              <p>Email: <a href="mailto:info@open-frame.net" className="text-primary hover:underline">info@open-frame.net</a></p>
              <p>Subject line: <span className="font-mono text-xs">Refund Request — [your account email]</span></p>
            </div>
            <p className="mt-3">
              Please include: your registered email address, the date of the charge, the amount charged, and a description of the circumstances. We will review your request and respond within 5 business days.
            </p>
            <p className="mt-3">
              Approved refunds will be issued to the original payment method and may take 5–10 business days to appear depending on your bank or card issuer.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">6. Chargebacks</h2>
            <p>
              Filing a chargeback with your bank or payment provider without first contacting us to resolve the issue may result in immediate suspension of your account. We reserve the right to dispute chargebacks that are inconsistent with this Refund Policy.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">7. Changes to This Policy</h2>
            <p>
              We reserve the right to modify this Refund Policy at any time. Material changes will be communicated via the Service or by email. Your continued use of the Service after changes constitutes your acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">8. Contact</h2>
            <p>
              For billing questions or refund requests:
            </p>
            <div className="mt-3 border border-border bg-card/40 p-4 text-sm space-y-1">
              <p className="font-medium text-foreground">IPEK TECH LLC</p>
              <p>Wyoming, United States</p>
              <p>Email: <a href="mailto:info@open-frame.net" className="text-primary hover:underline">info@open-frame.net</a></p>
            </div>
          </section>

        </div>
      </main>

      <footer className="border-t border-border px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-[900px] items-center justify-between">
          <span className="font-mono text-xs text-muted-foreground">© 2026 IPEK TECH LLC. All rights reserved.</span>
          <div className="flex gap-4">
            <Link href="/terms" className="text-xs text-muted-foreground hover:text-foreground transition-colors">Terms of Service</Link>
            <Link href="/privacy" className="text-xs text-muted-foreground hover:text-foreground transition-colors">Privacy Policy</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
