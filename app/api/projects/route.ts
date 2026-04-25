import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkWorkspaceAccess } from '@/lib/auth';
import { ProjectVisibility } from '@prisma/client';
import { rateLimit } from '@/lib/rate-limit';
import { buildBillingAccessWhereInput } from '@/lib/billing';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { DEFAULT_COMMENT_TAGS } from '@/lib/comment-tags';
import { logError } from '@/lib/logger';

// GET /api/projects - List all projects for the authenticated user
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    const MAX_LIMIT = 100;
    const MAX_PAGE = 1000;
    const MAX_OFFSET = 10000;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const { searchParams } = new URL(request.url);
    const pageParam = searchParams.get('page');
    const limitParam = searchParams.get('limit');
    const workspaceId = searchParams.get('workspaceId');

    const pageRaw = pageParam === null ? 1 : Number(pageParam);
    if (!Number.isSafeInteger(pageRaw) || pageRaw < 1 || pageRaw > MAX_PAGE) {
      return apiErrors.badRequest('Invalid page. Must be a positive integer.');
    }

    const limitRaw = limitParam === null ? 10 : Number(limitParam);
    if (!Number.isSafeInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
      return apiErrors.badRequest('Invalid limit. Must be a positive integer between 1 and 100.');
    }

    const page = pageRaw;
    const limit = limitRaw;
    const skip = (page - 1) * limit;
    if (!Number.isSafeInteger(skip) || skip > MAX_OFFSET) {
      return apiErrors.badRequest('Invalid page range. Offset must be 10000 or less.');
    }

    // Build base filter: user is owner OR a member
    const baseFilter: Record<string, unknown> = {
      OR: [
        { ownerId: session.user.id },
        { members: { some: { userId: session.user.id } } },
        // Also include projects in workspaces where the user is a workspace member
        ...(workspaceId
          ? []
          : [
              {
                workspace: {
                  owner: buildBillingAccessWhereInput(),
                  members: { some: { userId: session.user.id } },
                },
              },
            ]),
      ],
      workspace: {
        owner: buildBillingAccessWhereInput(),
      },
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

    const response = successResponse({ projects }, 200, {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });

    return withCacheControl(response, 'private, max-age=30, stale-while-revalidate=60');
  } catch (error) {
    logError('Error fetching projects:', error);
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
      return apiErrors.badRequest(
        'A workspace is required. Every project must belong to a workspace.'
      );
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
    const usedSlugs = new Set(existingProjects.map((p) => p.slug));
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

    const access = await checkWorkspaceAccess(
      { id: workspace.id, ownerId: workspace.ownerId },
      session.user.id
    );

    if (!access.canEdit) {
      return apiErrors.forbidden('Only workspace owners and admins can create projects');
    }

    const project = await db.$transaction(async (tx) => {
      const createdProject = await tx.project.create({
        data: {
          name: name.trim(),
          description: description?.trim() || null,
          slug,
          visibility: visibility || ProjectVisibility.PRIVATE,
          ownerId: workspace.ownerId,
          workspaceId,
        },
        include: {
          owner: { select: { id: true, name: true, image: true } },
          _count: { select: { videos: true, members: true } },
        },
      });

      await tx.commentTag.createMany({
        data: DEFAULT_COMMENT_TAGS.map((tag) => ({
          ...tag,
          projectId: createdProject.id,
        })),
        skipDuplicates: true,
      });

      return createdProject;
    });

    const response = successResponse(project, 201);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error creating project:', error);
    return apiErrors.internalError('Failed to create project');
  }
}
