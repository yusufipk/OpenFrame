import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';

// GET /api/workspaces - List all workspaces for the authenticated user
export async function GET() {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

        return NextResponse.json({ workspaces });
    } catch (error) {
        console.error('Error fetching workspaces:', error);
        return NextResponse.json(
            { error: 'Failed to fetch workspaces' },
            { status: 500 }
        );
    }
}

// POST /api/workspaces - Create a new workspace
export async function POST(request: NextRequest) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { name, description } = body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return NextResponse.json(
                { error: 'Workspace name is required' },
                { status: 400 }
            );
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

        return NextResponse.json(workspace, { status: 201 });
    } catch (error) {
        console.error('Error creating workspace:', error);
        return NextResponse.json(
            { error: 'Failed to create workspace' },
            { status: 500 }
        );
    }
}
