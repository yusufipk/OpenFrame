import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { buildBillingAccessWhereInput, getWorkspaceCreationEligibility } from '@/lib/billing';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

// GET /api/workspaces - List all workspaces for the authenticated user
export async function GET(request: NextRequest) {
    try {
        const session = await auth();
        const MAX_LIMIT = 100;
        const MAX_PAGE = 1000;
        const MAX_OFFSET = 10000;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const searchParams = request.nextUrl.searchParams;
        const pageParam = searchParams.get('page');
        const limitParam = searchParams.get('limit');

        const pageRaw = pageParam === null ? 1 : Number(pageParam);
        if (!Number.isSafeInteger(pageRaw) || pageRaw < 1 || pageRaw > MAX_PAGE) {
            return apiErrors.badRequest('Invalid page. Must be a positive integer.');
        }

        const limitRaw = limitParam === null ? 20 : Number(limitParam);
        if (!Number.isSafeInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
            return apiErrors.badRequest('Invalid limit. Must be a positive integer between 1 and 100.');
        }

        const page = pageRaw;
        const limit = limitRaw;
        const skip = (page - 1) * limit;
        if (!Number.isSafeInteger(skip) || skip > MAX_OFFSET) {
            return apiErrors.badRequest('Invalid page range. Offset must be 10000 or less.');
        }

        const where = {
            OR: [
                { ownerId: session.user.id, owner: buildBillingAccessWhereInput() },
                { members: { some: { userId: session.user.id } }, owner: buildBillingAccessWhereInput() },
            ],
        };

        // Get workspaces where user is owner OR a member
        const [workspaces, total] = await Promise.all([
            db.workspace.findMany({
                where,
                include: {
                    owner: { select: { id: true, name: true, image: true } },
                    _count: { select: { projects: true, members: true } },
                },
                orderBy: { updatedAt: 'desc' },
                skip,
                take: limit,
            }),
            db.workspace.count({ where }),
        ]);

        const response = successResponse(
            { workspaces },
            200,
            {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            }
        );
        return withCacheControl(response, 'private, max-age=60, stale-while-revalidate=120');
    } catch (error) {
        logError('Error fetching workspaces:', error);
        return apiErrors.internalError('Failed to fetch workspaces');
    }
}

// POST /api/workspaces - Create a new workspace
export async function POST(request: NextRequest) {
    try {
        const limited = await rateLimit(request, 'create-workspace');
        if (limited) return limited;

        const session = await auth();

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const billing = await getWorkspaceCreationEligibility(session.user.id);
        if (!billing.canCreateWorkspace) {
            return apiErrors.forbidden(
                billing.reason || 'Upgrade your account to create another workspace'
            );
        }

        const body = await request.json();
        const { name, description } = body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return apiErrors.badRequest('Workspace name is required');
        }

        // Generate slug
        const baseSlug = name
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-');

        // Find all existing slugs with the same prefix in a single query
        const existingWorkspaces = await db.workspace.findMany({
            where: { slug: { startsWith: baseSlug } },
            select: { slug: true },
        });

        // Generate unique slug from the results
        const usedSlugs = new Set(existingWorkspaces.map(w => w.slug));
        let slug = baseSlug;
        let counter = 1;
        while (usedSlugs.has(slug)) {
            slug = `${baseSlug}-${counter}`;
            counter++;
        }

        const workspace = await db.workspace.create({
            data: {
                name: name.trim(),
                description: description?.trim() || null,
                slug,
                ownerId: session.user.id,
            },
            include: {
                owner: { select: { id: true, name: true, image: true } },
                _count: { select: { projects: true, members: true } },
            },
        });

        const response = successResponse(workspace, 201);
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        logError('Error creating workspace:', error);
        return apiErrors.internalError('Failed to create workspace');
    }
}
