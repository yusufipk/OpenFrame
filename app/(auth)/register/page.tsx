import { isInviteCodeRequired } from '@/lib/feature-flags';
import RegisterPageClient from './register-page-client';

export default function RegisterPage() {
  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const githubEnabled = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);

  return (
    <RegisterPageClient
      requireInviteCode={isInviteCodeRequired()}
      googleEnabled={googleEnabled}
      githubEnabled={githubEnabled}
    />
  );
}
