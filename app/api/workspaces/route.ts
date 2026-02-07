import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

// GET /api/workspaces - List all workspaces for the authenticated user
export async function GET() {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        // Get workspaces where user is owner OR a member
        const workspaces = await db.workspace.findMany({
            where: {
                OR: [
                    { ownerId: session.user.id },
                    { members: { some: { userId: session.user.id } } },
                ],
            },
            include: {
                owner: { select: { id: true, name: true, image: true } },
                _count: { select: { projects: true, members: true } },
            },
            orderBy: { updatedAt: 'desc' },
        });

        const response = successResponse({ workspaces });
        return withCacheControl(response, 'private, max-age=60, stale-while-revalidate=120');
    } catch (error) {
        console.error('Error fetching workspaces:', error);
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

        let slug = baseSlug;
        let attempts = 0;
        while (attempts < 10) {
            const existing = await db.workspace.findUnique({ where: { slug } });
            if (!existing) break;
            slug = `${baseSlug}-${Math.random().toString(36).substring(2, 6)}`;
            attempts++;
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
        console.error('Error creating workspace:', error);
        return apiErrors.internalError('Failed to create workspace');
    }
}
