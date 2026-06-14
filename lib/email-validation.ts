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
