import { requireAuthOrRedirect } from '@/lib/route-access';
import NewWorkspacePageClient from './new-workspace-page-client';

export default async function NewWorkspacePage() {
  await requireAuthOrRedirect();
  return <NewWorkspacePageClient />;
}
