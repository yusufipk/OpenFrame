import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { hasCollaboratorBillingBackedAccess, requireBillingAccessOrRedirect } from '@/lib/route-access';
import { DashboardClient } from './dashboard-client';
import { buildBillingAccessWhereInput } from '@/lib/billing';
import { isBunnyUploadsEnabled } from '@/lib/feature-flags';

export default async function DashboardPage({
    searchParams,
}: {
    searchParams: Promise<{ ws?: string; sort?: string; page?: string }>
}) {
    const session = await auth();
    if (!session?.user?.id) {
        redirect('/login');
    }

    const hasCollaboratorAccess = await hasCollaboratorBillingBackedAccess(session.user.id);
    if (!hasCollaboratorAccess) {
        await requireBillingAccessOrRedirect({ userId: session.user.id });
    }

    const userOnboarding = await db.user.findUnique({
        where: { id: session.user.id },
        select: { onboardingCompletedAt: true },
    });
    if (!userOnboarding?.onboardingCompletedAt) {
        redirect('/onboarding');
    }

    const resolvedSearchParams = await searchParams;
    const { ws, sort, page: pageParam } = resolvedSearchParams || {};

    const page = Number(pageParam) || 1;
    const pageSize = 20;
    const skip = (page - 1) * pageSize;
    const orderByDirection = sort === 'asc' ? 'asc' : 'desc';

    // Base permission where clause
    const baseWhere: Prisma.ProjectWhereInput = {
        OR: [
            { ownerId: session.user.id },
            { members: { some: { userId: session.user.id } } },
            {
                workspace: {
                    owner: buildBillingAccessWhereInput(),
                    OR: [
                        { ownerId: session.user.id },
                        { members: { some: { userId: session.user.id } } },
                    ],
                },
            },
        ],
        workspace: {
            owner: buildBillingAccessWhereInput(),
        },
    };

    // Build unique workspace list for filter (Needs an unbounded list of accessible workspaces)
    const accessibleProjects = await db.project.findMany({
        where: baseWhere,
        select: {
            workspace: {
                select: { id: true, name: true }
            }
        },
        distinct: ['workspaceId']
    });

    const [creatableWorkspaces, editableProject] = await Promise.all([
        db.workspace.count({
            where: {
                OR: [
                    { ownerId: session.user.id },
                    { members: { some: { userId: session.user.id, role: 'ADMIN' } } },
                ],
            },
        }),
        db.project.findFirst({
            where: {
                OR: [
                    { ownerId: session.user.id },
                    { members: { some: { userId: session.user.id, role: 'ADMIN' } } },
                    {
                        workspace: {
                            OR: [
                                { ownerId: session.user.id },
                                { members: { some: { userId: session.user.id, role: 'ADMIN' } } },
                            ],
                        },
                    },
                ],
            },
            select: { id: true },
        }),
    ]);
    const canCreateProjects = creatableWorkspaces > 0;
    const canUploadVideos = Boolean(editableProject);

    const workspaceMap = new Map<string, string>();
    for (const project of accessibleProjects) {
        if (project.workspace) {
            workspaceMap.set(project.workspace.id, project.workspace.name);
        }
    }
    const workspaces = Array.from(workspaceMap, ([id, name]) => ({ id, name }));

    // Final query constraints
    const queryWhere: Prisma.ProjectWhereInput = {
        ...baseWhere,
        ...(ws && ws !== 'all' ? { workspaceId: ws } : {})
    };

    const [projects, totalProjects] = await Promise.all([
        db.project.findMany({
            skip,
            take: pageSize,
            where: queryWhere,
            include: {
                workspace: {
                    select: { id: true, name: true },
                },
                _count: {
                    select: {
                        videos: true,
                        members: true,
                    },
                },
            },
            orderBy: { updatedAt: orderByDirection },
        }),
        db.project.count({
            where: queryWhere
        })
    ]);

    const totalPages = Math.ceil(totalProjects / pageSize);

    const serializedProjects = projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        visibility: p.visibility,
        updatedAt: p.updatedAt.toISOString(),
        workspaceId: p.workspace?.id ?? null,
        workspaceName: p.workspace?.name ?? null,
        memberCount: p._count.members + 1,
        videoCount: p._count.videos,
    }));

    return (
        <DashboardClient
            serializedProjects={serializedProjects}
            workspaces={workspaces}
            totalPages={totalPages}
            canCreateProjects={canCreateProjects}
            canUploadVideos={canUploadVideos}
            bunnyUploadsEnabled={isBunnyUploadsEnabled()}
        />
    );
}
