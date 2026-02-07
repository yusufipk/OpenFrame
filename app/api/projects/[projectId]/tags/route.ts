import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

type RouteParams = { params: Promise<{ projectId: string }> };

// Default tags to create for new projects
const DEFAULT_TAGS = [
    { name: 'Feedback', color: '#3B82F6', position: 0 },
    { name: 'Technical', color: '#EF4444', position: 1 },
    { name: 'Creative', color: '#8B5CF6', position: 2 },
    { name: 'Approved', color: '#22C55E', position: 3 },
    { name: 'Urgent', color: '#F59E0B', position: 4 },
];

// Helper to check project access
async function checkProjectAccess(projectId: string, userId: string) {
    const project = await db.project.findUnique({
        where: { id: projectId },
        include: { members: { where: { userId } } },
    });

    if (!project) return { project: null, canEdit: false };

    const isOwner = project.ownerId === userId;
    const isAdmin = project.members[0]?.role === 'ADMIN';

    // Check workspace-level access
    let workspaceCanEdit = false;
    if (!isOwner && !isAdmin) {
        const wsMember = await db.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
        });
        const wsOwner = await db.workspace.findUnique({
            where: { id: project.workspaceId },
            select: { ownerId: true },
        });
        workspaceCanEdit = wsOwner?.ownerId === userId || wsMember?.role === 'ADMIN';
    }

    return {
        project,
        canEdit: isOwner || isAdmin || workspaceCanEdit,
    };
}

// GET /api/projects/[projectId]/tags - Get all tags for a project
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const { project } = await checkProjectAccess(projectId, session.user.id);
        if (!project) {
            return apiErrors.notFound('Project');
        }

        let tags = await db.commentTag.findMany({
            where: { projectId },
            orderBy: { position: 'asc' },
        });

        // Auto-create default tags if none exist (idempotent with skipDuplicates
        // to handle race conditions from concurrent requests)
        if (tags.length === 0) {
            await db.commentTag.createMany({
                data: DEFAULT_TAGS.map((tag) => ({ ...tag, projectId })),
                skipDuplicates: true,
            });
            tags = await db.commentTag.findMany({
                where: { projectId },
                orderBy: { position: 'asc' },
            });
        }

        const response = successResponse(tags);
        return withCacheControl(response, 'private, max-age=120, stale-while-revalidate=300');
    } catch (error) {
        console.error('Error fetching tags:', error);
        return apiErrors.internalError('Failed to fetch tags');
    }
}

// POST /api/projects/[projectId]/tags - Create a new tag
export async function POST(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { projectId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const { canEdit, project } = await checkProjectAccess(projectId, session.user.id);
        if (!project) {
            return apiErrors.notFound('Project');
        }
        if (!canEdit) {
            return apiErrors.forbidden('Access denied');
        }

        const body = await request.json();
        const { name, color } = body;

        if (!name?.trim() || !color?.trim()) {
            return apiErrors.badRequest('Name and color are required');
        }

        // Hex color validation
        if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
            return apiErrors.badRequest('Invalid color format');
        }

        // Get max position
        const maxPos = await db.commentTag.aggregate({
            where: { projectId },
            _max: { position: true },
        });

        const tag = await db.commentTag.create({
            data: {
                name: name.trim(),
                color: color.toUpperCase(),
                position: (maxPos._max.position ?? -1) + 1,
                projectId,
            },
        });

        const response = successResponse(tag, 201);
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error creating tag:', error);
        if ((error as { code?: string }).code === 'P2002') {
            return apiErrors.conflict('Tag name already exists');
        }
        return apiErrors.internalError('Failed to create tag');
    }
}
