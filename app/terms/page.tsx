import Link from 'next/link';
import { Video } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service | OpenFrame',
  description: 'Terms of Service for OpenFrame by IPEK TECH LLC.',
};

export default function TermsOfServicePage() {
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
        <h1 className="text-3xl font-semibold tracking-tight mb-2">Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: April 10, 2026</p>

        <div className="prose prose-sm prose-invert max-w-none space-y-8 text-sm leading-relaxed text-foreground/80">
          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">1. Agreement to Terms</h2>
            <p>
              These Terms of Service (&ldquo;Terms&rdquo;) constitute a legally binding agreement
              between you (&ldquo;User&rdquo;, &ldquo;you&rdquo;, or &ldquo;your&rdquo;) and{' '}
              <strong className="text-foreground">IPEK TECH LLC</strong>, a Wyoming limited
              liability company (&ldquo;Company&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;, or
              &ldquo;our&rdquo;), governing your access to and use of the OpenFrame platform,
              available at open-frame.net (the &ldquo;Service&rdquo;).
            </p>
            <p className="mt-3">
              By creating an account or accessing the Service in any manner, you agree to be bound
              by these Terms. If you do not agree to these Terms, you may not access or use the
              Service.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              2. Description of Service
            </h2>
            <p>
              OpenFrame is a video review and approval platform that enables creative professionals
              and their clients to collaborate on video projects through timestamped comments,
              annotations, version management, and approval workflows. The Service is offered on a
              subscription basis with a free trial period.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">3. Eligibility</h2>
            <p>
              You must be at least 18 years old to use the Service. By using the Service, you
              represent that you are at least 18 years of age and have the legal authority to enter
              into these Terms. If you are using the Service on behalf of an organization, you
              represent that you have authority to bind that organization to these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">4. Accounts</h2>
            <p>
              To access most features of the Service, you must register for an account. You agree to
              provide accurate, current, and complete information during registration and to keep
              your account information updated. You are responsible for maintaining the
              confidentiality of your account credentials and for all activities that occur under
              your account.
            </p>
            <p className="mt-3">
              You agree to notify us immediately at{' '}
              <a href="mailto:info@open-frame.net" className="text-primary hover:underline">
                info@open-frame.net
              </a>{' '}
              of any unauthorized use of your account. We are not liable for any losses arising from
              unauthorized use of your account.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              5. Subscriptions and Free Trial
            </h2>
            <p>
              Certain features of the Service require a paid subscription. We offer a{' '}
              <strong className="text-foreground">7-day free trial</strong> for new accounts, during
              which you may access paid features at no charge. At the end of the trial period, your
              subscription will automatically convert to a paid plan unless you cancel before the
              trial ends.
            </p>
            <p className="mt-3">
              Subscription fees are billed in advance on a monthly or annual basis depending on the
              plan you select. All fees are non-refundable except as expressly stated in our{' '}
              <Link href="/refund" className="text-primary hover:underline">
                Refund Policy
              </Link>
              .
            </p>
            <p className="mt-3">
              We reserve the right to change subscription pricing with reasonable advance notice.
              Continued use of the Service after a price change constitutes your agreement to the
              new pricing.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">6. User Content</h2>
            <p>
              You retain all ownership rights to the content you upload or create through the
              Service (&ldquo;User Content&rdquo;). By uploading User Content, you grant us a
              limited, non-exclusive, royalty-free license to store, process, and display your User
              Content solely to provide the Service to you.
            </p>
            <p className="mt-3">
              You are solely responsible for your User Content and represent that you have all
              necessary rights to upload and share it. You agree not to upload content that: (a)
              infringes any third-party intellectual property rights; (b) is unlawful, defamatory,
              or harmful; (c) contains malware or malicious code; or (d) violates any applicable law
              or regulation.
            </p>
            <p className="mt-3">
              We may remove or suspend access to User Content that violates these Terms at our sole
              discretion.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">7. Acceptable Use</h2>
            <p>You agree not to:</p>
            <ul className="mt-3 list-disc pl-5 space-y-2">
              <li>Use the Service in any manner that violates applicable laws or regulations.</li>
              <li>
                Attempt to gain unauthorized access to any part of the Service or its related
                systems.
              </li>
              <li>Interfere with or disrupt the integrity or performance of the Service.</li>
              <li>
                Reverse engineer, decompile, or attempt to extract the source code of the Service
                (except where permitted by applicable open-source licenses).
              </li>
              <li>Use the Service to send spam or unsolicited communications.</li>
              <li>
                Use the Service to collect or harvest any personally identifiable information
                without authorization.
              </li>
              <li>
                Resell or sublicense access to the Service without written authorization from us.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              8. Intellectual Property
            </h2>
            <p>
              Excluding your User Content, the Service and all content, features, and functionality
              thereof — including but not limited to software, text, graphics, logos, and design —
              are owned by IPEK TECH LLC or its licensors and are protected by applicable
              intellectual property laws.
            </p>
            <p className="mt-3">
              The core platform code is made available as open-source software; please refer to the
              applicable license in the GitHub repository for details on permitted use.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">9. Privacy</h2>
            <p>
              Your use of the Service is also governed by our{' '}
              <Link href="/privacy" className="text-primary hover:underline">
                Privacy Policy
              </Link>
              , which is incorporated into these Terms by reference. By using the Service, you
              consent to the collection and use of your information as described therein.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">10. Disclaimers</h2>
            <p>
              THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT
              WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
              IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
              NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED,
              ERROR-FREE, OR FREE OF VIRUSES OR OTHER HARMFUL COMPONENTS.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              11. Limitation of Liability
            </h2>
            <p>
              TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, IPEK TECH LLC AND ITS OFFICERS,
              DIRECTORS, EMPLOYEES, AGENTS, AND LICENSORS SHALL NOT BE LIABLE FOR ANY INDIRECT,
              INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES — INCLUDING LOST PROFITS, DATA
              LOSS, OR BUSINESS INTERRUPTION — ARISING FROM YOUR USE OF OR INABILITY TO USE THE
              SERVICE, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
            </p>
            <p className="mt-3">
              OUR TOTAL CUMULATIVE LIABILITY TO YOU FOR ALL CLAIMS ARISING FROM OR RELATED TO THESE
              TERMS OR THE SERVICE WILL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID TO US IN
              THE 12 MONTHS PRECEDING THE CLAIM OR (B) USD $50.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">12. Indemnification</h2>
            <p>
              You agree to indemnify, defend, and hold harmless IPEK TECH LLC and its officers,
              directors, employees, agents, and licensors from and against any claims, damages,
              losses, liabilities, costs, and expenses (including reasonable attorneys&apos; fees)
              arising from: (a) your use of the Service; (b) your User Content; (c) your violation
              of these Terms; or (d) your violation of any third-party rights.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">13. Termination</h2>
            <p>
              We may suspend or terminate your access to the Service at any time, with or without
              cause and with or without notice, if we believe you have violated these Terms or for
              any other reason at our sole discretion.
            </p>
            <p className="mt-3">
              You may cancel your account at any time through your billing settings or by contacting
              us at{' '}
              <a href="mailto:info@open-frame.net" className="text-primary hover:underline">
                info@open-frame.net
              </a>
              . Upon termination, your right to access the Service will immediately cease. Sections
              that by their nature should survive termination (including Sections 8, 10, 11, 12, 14,
              and 15) will survive.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              14. Governing Law and Dispute Resolution
            </h2>
            <p>
              These Terms are governed by the laws of the State of Wyoming, United States, without
              regard to its conflict-of-law provisions. Any disputes arising from or relating to
              these Terms or the Service shall be resolved exclusively in the state or federal
              courts located in Wyoming, and you consent to personal jurisdiction in such courts.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">15. Changes to Terms</h2>
            <p>
              We reserve the right to modify these Terms at any time. We will notify you of material
              changes by posting the updated Terms on this page and updating the &ldquo;Last
              updated&rdquo; date. Your continued use of the Service after any changes constitutes
              your acceptance of the new Terms.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">16. Contact</h2>
            <p>If you have any questions about these Terms, please contact us:</p>
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
              href="/privacy"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Privacy Policy
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
