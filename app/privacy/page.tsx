import Link from 'next/link';
import { Video } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy | OpenFrame',
  description: 'Privacy Policy for OpenFrame by IPEK TECH LLC.',
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-4 py-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-[900px] items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 text-sm font-semibold hover:text-primary transition-colors"
          >
            <Video className="h-4 w-4 text-primary" />
            OpenFrame
          </Link>
          <Link
            href="/"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            ← Back to Home
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[900px] px-4 py-12 sm:px-6 lg:px-8">
        <h1 className="text-3xl font-semibold tracking-tight mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: April 10, 2026</p>

        <div className="prose prose-sm prose-invert max-w-none space-y-8 text-sm leading-relaxed text-foreground/80">
          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">1. Introduction</h2>
            <p>
              <strong className="text-foreground">IPEK TECH LLC</strong> (&ldquo;Company&rdquo;,
              &ldquo;we&rdquo;, &ldquo;us&rdquo;, or &ldquo;our&rdquo;), a Wyoming limited liability
              company, operates the OpenFrame platform at open-frame.net (the
              &ldquo;Service&rdquo;). This Privacy Policy explains how we collect, use, share, and
              protect information about you when you use our Service.
            </p>
            <p className="mt-3">
              By using the Service, you agree to the collection and use of information in accordance
              with this Privacy Policy.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              2. Information We Collect
            </h2>

            <h3 className="text-sm font-semibold text-foreground mb-2 mt-4">
              2.1 Information You Provide
            </h3>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong className="text-foreground">Account information:</strong> Name, email
                address, and password when you register.
              </li>
              <li>
                <strong className="text-foreground">Profile information:</strong> Avatar image and
                display name.
              </li>
              <li>
                <strong className="text-foreground">Billing information:</strong> Payment details
                processed securely through Stripe. We do not store full card numbers on our servers.
              </li>
              <li>
                <strong className="text-foreground">User Content:</strong> Videos, comments,
                annotations, and other content you upload or create within the Service.
              </li>
              <li>
                <strong className="text-foreground">Communications:</strong> Messages you send us
                via email or feedback forms.
              </li>
            </ul>

            <h3 className="text-sm font-semibold text-foreground mb-2 mt-4">
              2.2 Information Collected Automatically
            </h3>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong className="text-foreground">Usage data:</strong> Pages viewed, features
                used, actions taken within the Service, and timestamps.
              </li>
              <li>
                <strong className="text-foreground">Device and browser data:</strong> IP address,
                browser type, operating system, and referring URLs.
              </li>
              <li>
                <strong className="text-foreground">Cookies and similar technologies:</strong>{' '}
                Session cookies for authentication and preference storage. We do not use third-party
                advertising cookies.
              </li>
            </ul>

            <h3 className="text-sm font-semibold text-foreground mb-2 mt-4">
              2.3 Information from Third Parties
            </h3>
            <p>
              If you sign in via a third-party OAuth provider (Google or GitHub), we receive basic
              profile information (name, email, avatar) as permitted by your settings with that
              provider.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              3. How We Use Your Information
            </h2>
            <p>We use the information we collect to:</p>
            <ul className="mt-3 list-disc pl-5 space-y-2">
              <li>Provide, operate, and improve the Service.</li>
              <li>Process transactions and manage your subscription.</li>
              <li>
                Send transactional emails (account confirmations, password resets, billing
                notifications).
              </li>
              <li>Respond to your inquiries and support requests.</li>
              <li>Send product updates or announcements (you may opt out at any time).</li>
              <li>Monitor and analyze usage patterns to improve the Service.</li>
              <li>Detect, investigate, and prevent fraudulent or abusive activity.</li>
              <li>Comply with legal obligations.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              4. How We Share Your Information
            </h2>
            <p>We do not sell your personal information. We may share your information with:</p>
            <ul className="mt-3 list-disc pl-5 space-y-2">
              <li>
                <strong className="text-foreground">Service providers:</strong> Third parties who
                assist us in operating the Service (e.g., cloud storage, video delivery, payment
                processing via Stripe). These providers are contractually bound to protect your
                data.
              </li>
              <li>
                <strong className="text-foreground">Other users:</strong> User Content you choose to
                share via share links is accessible to recipients of those links per the permissions
                you configure.
              </li>
              <li>
                <strong className="text-foreground">Legal requirements:</strong> We may disclose
                information if required by law, court order, or governmental authority, or to
                protect the rights and safety of IPEK TECH LLC or others.
              </li>
              <li>
                <strong className="text-foreground">Business transfers:</strong> In the event of a
                merger, acquisition, or sale of assets, your information may be transferred as part
                of the transaction.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">5. Data Retention</h2>
            <p>
              We retain your personal information for as long as your account is active or as needed
              to provide the Service. If you delete your account, we will delete or anonymize your
              personal information within a reasonable period, except where we are required to
              retain it for legal, regulatory, or legitimate business purposes (such as billing
              disputes).
            </p>
            <p className="mt-3">
              User Content you delete from the Service will be removed from our active storage;
              however, backup copies may persist for a limited time before being purged.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">6. Security</h2>
            <p>
              We implement industry-standard security measures to protect your information,
              including encryption in transit (TLS) and access controls. However, no method of
              transmission over the internet or electronic storage is 100% secure. We cannot
              guarantee absolute security and encourage you to use strong, unique passwords and to
              keep your account credentials confidential.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              7. Your Rights and Choices
            </h2>
            <p>
              Depending on your location, you may have rights regarding your personal information,
              including:
            </p>
            <ul className="mt-3 list-disc pl-5 space-y-2">
              <li>
                <strong className="text-foreground">Access and portability:</strong> Request a copy
                of the data we hold about you.
              </li>
              <li>
                <strong className="text-foreground">Correction:</strong> Request correction of
                inaccurate data.
              </li>
              <li>
                <strong className="text-foreground">Deletion:</strong> Request deletion of your
                personal information (subject to legal retention requirements).
              </li>
              <li>
                <strong className="text-foreground">Opt-out of marketing:</strong> Unsubscribe from
                marketing emails at any time via the unsubscribe link in any email or by contacting
                us.
              </li>
            </ul>
            <p className="mt-3">
              To exercise these rights, contact us at{' '}
              <a href="mailto:info@open-frame.net" className="text-primary hover:underline">
                info@open-frame.net
              </a>
              . We will respond within a reasonable timeframe.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">8. Cookies</h2>
            <p>
              We use cookies strictly necessary for the operation of the Service (authentication
              sessions, CSRF protection) and limited analytics cookies to understand how the Service
              is used. We do not use third-party advertising cookies or tracking pixels. You may
              disable cookies in your browser settings, but doing so may affect your ability to use
              the Service.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              9. Children&apos;s Privacy
            </h2>
            <p>
              The Service is not directed to individuals under the age of 18. We do not knowingly
              collect personal information from minors. If you believe we have inadvertently
              collected information from a minor, please contact us immediately at{' '}
              <a href="mailto:info@open-frame.net" className="text-primary hover:underline">
                info@open-frame.net
              </a>{' '}
              and we will take steps to delete such information.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              10. International Data Transfers
            </h2>
            <p>
              Your information may be stored and processed in the United States or other countries
              where our service providers operate. By using the Service, you consent to the transfer
              of your information to these locations, which may have different data protection laws
              than your country of residence.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              11. Third-Party Services
            </h2>
            <p>
              The Service may integrate with or link to third-party services (e.g., GitHub, Google,
              Stripe, Bunny CDN). This Privacy Policy does not apply to those services, and we
              encourage you to review their respective privacy policies.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              12. Changes to This Policy
            </h2>
            <p>
              We may update this Privacy Policy from time to time. We will notify you of material
              changes by posting the updated policy on this page and updating the &ldquo;Last
              updated&rdquo; date. Your continued use of the Service after changes constitutes
              acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">13. Contact Us</h2>
            <p>
              If you have any questions or concerns about this Privacy Policy or our data practices,
              please contact us:
            </p>
            <div className="mt-3 border border-border bg-card/40 p-4 text-sm space-y-1">
              <p className="font-medium text-foreground">IPEK TECH LLC</p>
              <p>Wyoming, United States</p>
              <p>
                Email:{' '}
                <a href="mailto:info@open-frame.net" className="text-primary hover:underline">
                  info@open-frame.net
                </a>
              </p>
            </div>
          </section>
        </div>
      </main>

      <footer className="border-t border-border px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-[900px] items-center justify-between">
          <span className="font-mono text-xs text-muted-foreground">
            © 2026 IPEK TECH LLC. All rights reserved.
          </span>
          <div className="flex gap-4">
            <Link
              href="/terms"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Terms of Service
            </Link>
            <Link
              href="/refund"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Refund Policy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
