import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { InvitationRole, ProjectMemberRole } from '@prisma/client';
import { rateLimit } from '@/lib/rate-limit';
import { buildInvitationUrl, createOrRefreshInvitation, sendInvitationEmail } from '@/lib/invitations';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/members - List members
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const project = await db.project.findUnique({
            where: { id: projectId },
            include: {
                members: { where: { userId: session.user.id } },
            },
        });

        if (!project) {
            return apiErrors.notFound('Project');
        }

        const isOwner = project.ownerId === session.user.id;
        const isMember = project.members.length > 0;
        const isAdmin = project.members[0]?.role === ProjectMemberRole.ADMIN;

        if (!isOwner && !isMember) {
            return apiErrors.forbidden('Access denied');
        }

        const now = new Date();
        const canViewPendingInvitations = isOwner || isAdmin;
        const [members, owner, pendingInvitations] = await Promise.all([
            db.projectMember.findMany({
                where: { projectId },
                include: {
                    user: { select: { id: true, name: true, email: true, image: true } },
                },
                orderBy: { createdAt: 'asc' },
            }),
            db.user.findUnique({
                where: { id: project.ownerId },
                select: { id: true, name: true, email: true, image: true },
            }),
            canViewPendingInvitations
                ? db.invitation.findMany({
                    where: {
                        projectId,
                        scope: 'PROJECT',
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

        const response = successResponse({ members, owner, pendingInvitations });
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error fetching project members:', error);
        return apiErrors.internalError('Failed to fetch members');
    }
}

// POST /api/projects/[projectId]/members - Invite a member
export async function POST(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'invite-member');
        if (limited) return limited;

        const session = await auth();
        const { projectId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        // Check if user is owner or admin
        const project = await db.project.findUnique({
            where: { id: projectId },
            include: { members: { where: { userId: session.user.id } } },
        });

        if (!project) {
            return apiErrors.notFound('Project');
        }

        const isOwner = project.ownerId === session.user.id;
        const isAdmin = project.members[0]?.role === ProjectMemberRole.ADMIN;

        if (!isOwner && !isAdmin) {
            return apiErrors.forbidden('Only project owners and admins can invite members');
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

        if (userToInvite?.id === project.ownerId) {
            return apiErrors.badRequest('Cannot invite the project owner as a member');
        }

        if (userToInvite) {
            const existingMember = await db.projectMember.findUnique({
                where: { projectId_userId: { projectId, userId: userToInvite.id } },
            });

            if (existingMember) {
                return apiErrors.conflict('User is already a member of this project');
            }
        }

        const invitation = await createOrRefreshInvitation({
            email: normalizedEmail,
            scope: 'PROJECT',
            role: memberRole as InvitationRole,
            invitedById: session.user.id,
            projectId,
        });

        const invitationUrl = buildInvitationUrl(invitation.token, normalizedEmail);
        void sendInvitationEmail({
            to: normalizedEmail,
            inviterName: session.user.name || 'A team member',
            role: invitation.role,
            scope: invitation.scope,
            targetName: project.name,
            invitationUrl,
        });

        const response = successResponse({ message: 'Invitation email sent.' });
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error inviting project member:', error);
        return apiErrors.internalError('Failed to invite member');
    }
}
