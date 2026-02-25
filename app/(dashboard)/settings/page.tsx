import { requireAuthOrRedirect } from '@/lib/route-access';
import SettingsPageClient from './settings-page-client';

export default async function SettingsPage() {
  await requireAuthOrRedirect();
  return <SettingsPageClient />;
}
