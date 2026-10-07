import { isValidEmailAddress, normalizeEmail } from '@/lib/email-validation';

export function parseInvitationEmails(input: string): string[] {
  const emails = [
    ...new Set(
      input
        .split(/[,\r\n]+/)
        .map(normalizeEmail)
        .filter(Boolean)
    ),
  ];
  if (!emails.length) throw new Error('Enter at least one email address.');
  if (emails.length > 20) throw new Error('Invite up to 20 people at a time.');
  const invalid = emails.filter((email) => !isValidEmailAddress(email));
  if (invalid.length) throw new Error(`Invalid email address: ${invalid.join(', ')}`);
  return emails;
}

export type InvitationResult = {
  email: string;
  invitationUrl?: string;
  emailSent?: boolean;
  error?: string;
  errorPayload?: { error?: string; code?: string };
};

/** Keep each recipient's outcome when only part of a batch succeeds. */
export async function sendInvitationBatch(
  url: string,
  emails: string[],
  body: Record<string, unknown>
): Promise<InvitationResult[]> {
  const results: InvitationResult[] = new Array(emails.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, emails.length) }, async () => {
      while (next < emails.length) {
        const index = next++;
        const email = emails[index];
        try {
          for (let attempt = 0; attempt < 3; attempt++) {
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...body, email }),
            });
            const payload = await response.json();
            const error =
              typeof payload.error === 'string' ? payload.error : payload.error?.message;
            // Concurrent content invitations can conflict on the project lock.
            // Retrying this specific refusal is safe because no invitation was committed.
            if (
              response.status === 409 &&
              error === 'Content or access changed. Refresh and try again.' &&
              attempt < 2
            )
              continue;
            results[index] = response.ok
              ? {
                  email,
                  invitationUrl: payload.data.invitationUrl,
                  emailSent: payload.data.emailSent,
                }
              : {
                  email,
                  error: error || 'Could not send invitation',
                  errorPayload: { error, code: payload.code },
                };
            break;
          }
        } catch {
          results[index] = { email, error: 'Could not send invitation. Try again.' };
        }
      }
    })
  );
  return results;
}

export function invitationDeliveryMessage(result: InvitationResult): string {
  return result.emailSent
    ? `Invitation email sent to ${result.email}.`
    : `Invitation created for ${result.email}, but email could not be sent. Copy the link to share it.`;
}
