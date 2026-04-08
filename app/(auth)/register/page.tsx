import { isInviteCodeRequired } from '@/lib/feature-flags';
import RegisterPageClient from './register-page-client';

export default function RegisterPage() {
  return <RegisterPageClient requireInviteCode={isInviteCodeRequired()} />;
}
