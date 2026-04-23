import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { buildBillingAccessWhereInput, getBillingOverview } from '@/lib/billing';
import {
  hasCollaboratorBillingBackedAccess,
  requireBillingAccessOrRedirect,
} from '@/lib/route-access';
import { WorkspacesClient } from './workspaces-client';

export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const hasCollaboratorAccess = await hasCollaboratorBillingBackedAccess(session.user.id);
  if (!hasCollaboratorAccess) {
    await requireBillingAccessOrRedirect({ userId: session.user.id });
  }

  const resolvedSearchParams = await searchParams;
  const page = Number(resolvedSearchParams?.page) || 1;
  const pageSize = 20;
  const skip = (page - 1) * pageSize;

  const [workspaces, totalWorkspaces, billing] = await Promise.all([
    db.workspace.findMany({
      skip,
      take: pageSize,
      where: {
        OR: [
          { ownerId: session.user.id, owner: buildBillingAccessWhereInput() },
          { members: { some: { userId: session.user.id } }, owner: buildBillingAccessWhereInput() },
        ],
      },
      include: {
        owner: { select: { id: true, name: true } },
        _count: {
          select: {
            projects: true,
            members: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    }),
    db.workspace.count({
      where: {
        OR: [
          { ownerId: session.user.id, owner: buildBillingAccessWhereInput() },
          { members: { some: { userId: session.user.id } }, owner: buildBillingAccessWhereInput() },
        ],
      },
    }),
    getBillingOverview(session.user.id),
  ]);

  const totalPages = Math.ceil(totalWorkspaces / pageSize);

  const serializedWorkspaces = workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    description: w.description,
    updatedAt: w.updatedAt.toISOString(),
    _count: w._count,
  }));

  return (
    <WorkspacesClient
      workspaces={serializedWorkspaces}
      totalPages={totalPages}
      currentPage={page}
      workspaceCreation={billing.workspaceCreation}
    />
  );
}
