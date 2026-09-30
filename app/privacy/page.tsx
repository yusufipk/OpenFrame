import Link from 'next/link';
import { Video } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy | OpenFrame',
  description: 'Privacy Policy for OpenFrame by IPEK TECH LLC.',
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
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
        <p className="text-sm text-muted-foreground mb-10">Last updated: September 30, 2026</p>

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
            <p className="mt-3">
              If you import files from Google Drive, we receive the files you pick and their basic
              details. Section 5 describes this in full.
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
            <h2 className="text-base font-semibold text-foreground mb-3">5. Google User Data</h2>
            <p>
              You can import videos, images and audio files from your Google Drive into the Service.
              This section explains what we receive from Google when you do, and what we do with it.
            </p>

            <h3 className="text-sm font-semibold text-foreground mb-2 mt-4">5.1 What we access</h3>
            <p>
              We ask Google for the <code>drive.file</code> permission only. It gives the Service
              access only to the individual files you choose for OpenFrame in the Google Drive file
              picker: we cannot list, open or change any other file or folder in your Drive. For
              each file you pick we read its name, file type, size and preview image, and its
              content.
            </p>

            <h3 className="text-sm font-semibold text-foreground mb-2 mt-4">5.2 How we use it</h3>
            <p>
              We use this data only to copy the files you picked into the Service, where they become
              videos, image reviews, new versions or attachments in the project you chose, and to
              show you how the import is going. We do not use Google user data for advertising, we
              do not sell it, and we do not use it to develop, improve or train generalized
              artificial intelligence or machine learning models. No person at IPEK TECH LLC reads
              the imported data unless you ask us to for support, it is needed for security or abuse
              investigation, or the law requires it.
            </p>

            <h3 className="text-sm font-semibold text-foreground mb-2 mt-4">5.3 How we share it</h3>
            <p>
              To make the copy, the imported files are transferred to the providers that store and
              deliver content for the Service: our video hosting provider (Bunny) and our object
              storage provider. For a video, the video hosting provider downloads the file from
              Google Drive directly, using a short-lived access token from your Google authorization
              that reaches only files you have picked for OpenFrame and expires within an hour. We
              send the token to the provider only to start that download. These providers process
              the data only to store and deliver your content. Imported content is shared with other
              people only in the ways you share any other content in your projects.
            </p>

            <h3 className="text-sm font-semibold text-foreground mb-2 mt-4">
              5.4 Storage, retention and deletion
            </h3>
            <p>
              Copies of imported files are stored and kept like any other User Content, as described
              in Section 6, and are removed when you delete them from the Service or delete your
              account. We do not save your Google access token. Your browser keeps it in memory, and
              our servers use it only while carrying out the imports you start. We keep a record of
              each import (the Drive file id, file name, file type, size, where it was imported to
              and the outcome) so we can show its progress and troubleshoot it; the record is
              deleted with the project or your account. You can revoke the Service&apos;s access to
              your Google Drive at any time from your{' '}
              <a
                href="https://myaccount.google.com/permissions"
                className="text-primary hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google Account permissions
              </a>{' '}
              page; files already imported stay in the Service until you delete them.
            </p>

            <h3 className="text-sm font-semibold text-foreground mb-2 mt-4">5.5 Limited Use</h3>
            <p>
              OpenFrame&apos;s use and transfer to any other app of information received from Google
              APIs will adhere to the{' '}
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                className="text-primary hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">6. Data Retention</h2>
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
            <h2 className="text-base font-semibold text-foreground mb-3">7. Security</h2>
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
              8. Your Rights and Choices
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
            <h2 className="text-base font-semibold text-foreground mb-3">9. Cookies</h2>
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
              10. Children&apos;s Privacy
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
              11. International Data Transfers
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
              12. Third-Party Services
            </h2>
            <p>
              The Service may integrate with or link to third-party services (e.g., GitHub, Google,
              Google Drive, Stripe, Bunny CDN). This Privacy Policy does not apply to those
              services, and we encourage you to review their respective privacy policies.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              13. Changes to This Policy
            </h2>
            <p>
              We may update this Privacy Policy from time to time. We will notify you of material
              changes by posting the updated policy on this page and updating the &ldquo;Last
              updated&rdquo; date. Your continued use of the Service after changes constitutes
              acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">14. Contact Us</h2>
            <p>
              If you have any questions or concerns about this Privacy Policy or our data practices,
              please contact us:
            </p>
            <div className="mt-3 border border-border bg-card/40 p-4 text-sm space-y-1">
              <p className="font-medium text-foreground">IPEK TECH LLC</p>
              <p>30 North Gould Street, Suite N</p>
              <p>Sheridan, WY 82801, United States</p>
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
