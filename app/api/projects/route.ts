import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProjectVisibility } from '@prisma/client';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

// GET /api/projects - List all projects for the authenticated user
export async function GET(request: NextRequest) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const { searchParams } = new URL(request.url);
        const page = parseInt(searchParams.get('page') || '1');
        const limit = parseInt(searchParams.get('limit') || '10');
        const workspaceId = searchParams.get('workspaceId');
        const skip = (page - 1) * limit;

        // Build base filter: user is owner OR a member
        const baseFilter: Record<string, unknown> = {
            OR: [
                { ownerId: session.user.id },
                { members: { some: { userId: session.user.id } } },
                // Also include projects in workspaces where the user is a workspace member
                ...(workspaceId ? [] : [{
                    workspace: {
                        members: { some: { userId: session.user.id } },
                    },
                }]),
            ],
        };

        // Filter by workspace if provided
        if (workspaceId) {
            baseFilter.workspaceId = workspaceId;
        }

        // Get projects where user is owner OR a member
        const [projects, total] = await Promise.all([
            db.project.findMany({
                where: baseFilter,
                include: {
                    owner: { select: { id: true, name: true, image: true } },
                    _count: { select: { videos: true, members: true } },
                },
                orderBy: { updatedAt: 'desc' },
                skip,
                take: limit,
            }),
            db.project.count({
                where: baseFilter,
            }),
        ]);

        const response = successResponse(
            { projects },
            200,
            {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            }
        );

        return withCacheControl(response, 'private, max-age=30, stale-while-revalidate=60');
    } catch (error) {
        console.error('Error fetching projects:', error);
        return apiErrors.internalError('Failed to fetch projects');
    }
}

// POST /api/projects - Create a new project
export async function POST(request: NextRequest) {
    try {
        const limited = await rateLimit(request, 'create-project');
        if (limited) return limited;

        const session = await auth();

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const body = await request.json();
        const { name, description, visibility, workspaceId } = body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return apiErrors.badRequest('Project name is required');
        }

        if (!workspaceId || typeof workspaceId !== 'string') {
            return apiErrors.badRequest('A workspace is required. Every project must belong to a workspace.');
        }

        // Generate URL-friendly slug
        const baseSlug = name
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-');

        // Find all existing slugs with the same prefix in a single query
        const existingProjects = await db.project.findMany({
            where: { slug: { startsWith: baseSlug } },
            select: { slug: true },
        });

        // Generate unique slug from the results
        const usedSlugs = new Set(existingProjects.map(p => p.slug));
        let slug = baseSlug;
        let counter = 1;
        while (usedSlugs.has(slug)) {
            slug = `${baseSlug}-${counter}`;
            counter++;
        }

        // Verify user has access to the workspace
        const workspace = await db.workspace.findUnique({
            where: { id: workspaceId },
            include: { members: { where: { userId: session.user.id } } },
        });

        if (!workspace) {
            return apiErrors.notFound('Workspace');
        }

        const isWsOwner = workspace.ownerId === session.user.id;
        const isWsAdmin = workspace.members[0]?.role === 'ADMIN';

        if (!isWsOwner && !isWsAdmin) {
            return apiErrors.forbidden('Only workspace owners and admins can create projects');
        }

        const project = await db.project.create({
            data: {
                name: name.trim(),
                description: description?.trim() || null,
                slug,
                visibility: visibility || ProjectVisibility.PRIVATE,
                ownerId: session.user.id,
                workspaceId,
            },
            include: {
                owner: { select: { id: true, name: true, image: true } },
                _count: { select: { videos: true, members: true } },
            },
        });

        const response = successResponse(project, 201);
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error creating project:', error);
        return apiErrors.internalError('Failed to create project');
    }
}
