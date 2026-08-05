const MAX_EMAIL_LENGTH = 254;
const MAX_EMAIL_LOCAL_LENGTH = 64;
const MAX_EMAIL_DOMAIN_LABEL_LENGTH = 63;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmailAddress(email: string): boolean {
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH) return false;

  const atIndex = email.indexOf('@');
  if (atIndex <= 0 || atIndex !== email.lastIndexOf('@')) return false;

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  if (local.length > MAX_EMAIL_LOCAL_LENGTH || !domain.includes('.')) return false;

  for (const char of email) {
    const code = char.charCodeAt(0);
    if (code <= 32 || code === 127) return false;
  }

  const labels = domain.split('.');
  if (labels.length < 2) return false;

  return labels.every((label) => label.length > 0 && label.length <= MAX_EMAIL_DOMAIN_LABEL_LENGTH);
}

/**
 * Throwaway mailbox providers, refused at signup.
 *
 * The free trial is granted to any address somebody can read a link at, so a
 * mailbox that costs nothing and expires in ten minutes is the cheapest way to
 * take the trial repeatedly. This list is deliberately short and specific: it
 * holds services whose entire purpose is a disposable inbox, and none of the
 * forwarding or aliasing services (SimpleLogin, AnonAddy, Apple's Hide My Email,
 * Fastmail masked addresses) that real paying customers use every day. A list
 * that catches a genuine buyer costs far more than one that misses a scraper.
 */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com',
  'discard.email',
  'dispostable.com',
  'emailondeck.com',
  'fakeinbox.com',
  'getnada.com',
  'grr.la',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'harakirimail.com',
  'inboxkitten.com',
  'mailcatch.com',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'mintemail.com',
  'moakt.com',
  'mohmal.com',
  'nada.email',
  'sharklasers.com',
  'spam4.me',
  'spamgourmet.com',
  'temp-mail.org',
  'tempinbox.com',
  'tempmail.com',
  'tempr.email',
  'throwawaymail.com',
  'tmpmail.org',
  'trashmail.com',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
]);

/**
 * True when the address belongs to a known disposable mailbox provider.
 *
 * Parent domains are checked too, because several of these hand out per-visit
 * subdomains (`anything.mailinator.com`) that would otherwise walk straight past
 * an exact-match lookup.
 */
export function isDisposableEmailDomain(email: string): boolean {
  const atIndex = email.lastIndexOf('@');
  if (atIndex < 0) return false;

  const domain = normalizeEmail(email.slice(atIndex + 1));
  const labels = domain.split('.');

  for (let index = 0; index < labels.length - 1; index += 1) {
    if (DISPOSABLE_EMAIL_DOMAINS.has(labels.slice(index).join('.'))) {
      return true;
    }
  }

  return false;
}
