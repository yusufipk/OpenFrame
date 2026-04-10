import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkWorkspaceAccess } from '@/lib/auth';
import { InvitationRole, WorkspaceMemberRole } from '@prisma/client';
import { rateLimit } from '@/lib/rate-limit';
import { buildInvitationUrl, createOrRefreshInvitation, sendInvitationEmail } from '@/lib/invitations';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/[workspaceId]/members - List members
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { workspaceId } = await params;
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

        const workspace = await db.workspace.findUnique({
            where: { id: workspaceId },
            include: {
                members: { where: { userId: session.user.id } },
            },
        });

        if (!workspace) {
            return apiErrors.notFound('Workspace');
        }

        const access = await checkWorkspaceAccess(
            { id: workspace.id, ownerId: workspace.ownerId },
            session.user.id
        );
        const isOwner = workspace.ownerId === session.user.id;
        const isMember = workspace.members.length > 0;
        const isAdmin = workspace.members[0]?.role === WorkspaceMemberRole.ADMIN;

        if (!access.hasAccess || (!isOwner && !isMember)) {
            return apiErrors.forbidden('Access denied');
        }

        const now = new Date();
        const canViewPendingInvitations = isOwner || isAdmin;
        const [members, total, pendingInvitations] = await Promise.all([
            db.workspaceMember.findMany({
                where: { workspaceId },
                include: {
                    user: { select: { id: true, name: true, email: true, image: true } },
                },
                orderBy: { createdAt: 'asc' },
                skip,
                take: limit,
            }),
            db.workspaceMember.count({
                where: { workspaceId },
            }),
            canViewPendingInvitations
                ? db.invitation.findMany({
                    where: {
                        workspaceId,
                        scope: 'WORKSPACE',
                        status: 'PENDING',
                        expiresAt: { gt: now },
                    },
                    select: {
                        id: true,
                        email: true,
                        role: true,
                        createdAt: true,
                        expiresAt: true,
                        invitedBy: {
                            select: { id: true, name: true, email: true },
                        },
                    },
                    orderBy: { createdAt: 'desc' },
                })
                : Promise.resolve([]),
        ]);

        // Include the owner as well
        const owner = await db.user.findUnique({
            where: { id: workspace.ownerId },
            select: { id: true, name: true, email: true, image: true },
        });

        const response = successResponse(
            { members, owner, pendingInvitations },
            200,
            {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            }
        );
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        logError('Error fetching workspace members:', error);
        return apiErrors.internalError('Failed to fetch members');
    }
}

// POST /api/workspaces/[workspaceId]/members - Invite a member
export async function POST(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'invite-member');
        if (limited) return limited;

        const session = await auth();
        const { workspaceId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        // Check if user is owner or admin
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
        const isOwner = workspace.ownerId === session.user.id;
        const isAdmin = workspace.members[0]?.role === WorkspaceMemberRole.ADMIN;

        if (!access.canEdit || (!isOwner && !isAdmin)) {
            return apiErrors.forbidden('Only workspace owners and admins can invite members');
        }

        const body = await request.json();
        const { email, role } = body;

        if (!email || typeof email !== 'string') {
            return apiErrors.badRequest('Email is required');
        }

        const normalizedEmail = email.toLowerCase().trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(normalizedEmail)) {
            return apiErrors.validationError('Invalid email format');
        }

        // Validate role
        const validRoles = ['ADMIN', 'COMMENTATOR'];
        const memberRole = validRoles.includes(role) ? role : 'COMMENTATOR';

        // If this email belongs to an existing user, validate owner/member conflicts.
        const userToInvite = await db.user.findUnique({
            where: { email: normalizedEmail },
            select: { id: true },
        });

        if (userToInvite?.id === workspace.ownerId) {
            return apiErrors.badRequest('Cannot invite the workspace owner as a member');
        }

        if (userToInvite) {
            const existingMember = await db.workspaceMember.findUnique({
                where: { workspaceId_userId: { workspaceId, userId: userToInvite.id } },
            });

            if (existingMember) {
                return apiErrors.conflict('User is already a member of this workspace');
            }
        }

        const invitation = await createOrRefreshInvitation({
            email: normalizedEmail,
            scope: 'WORKSPACE',
            role: memberRole as InvitationRole,
            invitedById: session.user.id,
            workspaceId,
        });

        const invitationUrl = buildInvitationUrl(invitation.token, normalizedEmail);
        void sendInvitationEmail({
            to: normalizedEmail,
            inviterName: session.user.name || 'A team member',
            role: invitation.role,
            scope: invitation.scope,
            targetName: workspace.name,
            invitationUrl,
        });

        const response = successResponse({ message: 'Invitation email sent.' });
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        logError('Error inviting workspace member:', error);
        return apiErrors.internalError('Failed to invite member');
    }
}
