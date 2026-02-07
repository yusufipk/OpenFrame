import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProjectVisibility } from '@prisma/client';

// GET /api/projects - List all projects for the authenticated user
export async function GET(request: NextRequest) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

        return NextResponse.json({
            projects,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        console.error('Error fetching projects:', error);
        return NextResponse.json(
            { error: 'Failed to fetch projects' },
            { status: 500 }
        );
    }
}

// POST /api/projects - Create a new project
export async function POST(request: NextRequest) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { name, description, visibility, workspaceId } = body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return NextResponse.json(
                { error: 'Project name is required' },
                { status: 400 }
            );
        }

        if (!workspaceId || typeof workspaceId !== 'string') {
            return NextResponse.json(
                { error: 'A workspace is required. Every project must belong to a workspace.' },
                { status: 400 }
            );
        }

        // Generate URL-friendly slug
        const baseSlug = name
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-');

        // Ensure uniqueness by appending random suffix if needed
        let slug = baseSlug;
        let attempts = 0;
        while (attempts < 10) {
            const existing = await db.project.findUnique({ where: { slug } });
            if (!existing) break;
            slug = `${baseSlug}-${Math.random().toString(36).substring(2, 6)}`;
            attempts++;
        }

        // Verify user has access to the workspace
        const workspace = await db.workspace.findUnique({
            where: { id: workspaceId },
            include: { members: { where: { userId: session.user.id } } },
        });

        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        const isWsOwner = workspace.ownerId === session.user.id;
        const isWsAdmin = workspace.members[0]?.role === 'ADMIN';

        if (!isWsOwner && !isWsAdmin) {
            return NextResponse.json(
                { error: 'Only workspace owners and admins can create projects' },
                { status: 403 }
            );
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

        return NextResponse.json(project, { status: 201 });
    } catch (error) {
        console.error('Error creating project:', error);
        return NextResponse.json(
            { error: 'Failed to create project' },
            { status: 500 }
        );
    }
}
