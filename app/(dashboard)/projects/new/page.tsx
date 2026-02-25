import { requireAuthOrRedirect } from '@/lib/route-access';
import NewProjectPageClient from './new-project-page-client';

export default async function NewProjectPage() {
  await requireAuthOrRedirect();
  return <NewProjectPageClient />;
}
