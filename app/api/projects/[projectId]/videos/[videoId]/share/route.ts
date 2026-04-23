import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { MAX_SHARE_PASSWORD_LENGTH } from '@/lib/share-links';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string; videoId: string }> };

async function requireShareManagementAccess(projectId: string, videoId: string, userId?: string) {
  const video = await db.video.findFirst({
    where: { id: videoId, projectId },
    include: {
      project: true,
    },
  });

  if (!video) {
    return { error: apiErrors.notFound('Video') as Response, video: null };
  }

  const access = await checkProjectAccess(video.project, userId);
  if (!access.canEdit) {
    return { error: apiErrors.forbidden('Access denied') as Response, video: null };
  }

  return { error: null, video };
}

function resolveShareBaseUrl(request: NextRequest): string {
  const configuredBaseUrl = process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  const normalizedConfiguredBaseUrl = configuredBaseUrl?.trim();

  if (normalizedConfiguredBaseUrl) {
    const withProtocol = /^https?:\/\//i.test(normalizedConfiguredBaseUrl)
      ? normalizedConfiguredBaseUrl
      : `https://${normalizedConfiguredBaseUrl}`;

    try {
      return new URL(withProtocol).origin;
    } catch {
      // Fallback to request origin when env configuration is invalid.
    }
  }

  return request.nextUrl.origin;
}

function buildWatchUrl(request: NextRequest, videoId: string, token: string): string {
  const url = new URL(`/watch/${videoId}`, resolveShareBaseUrl(request));
  url.searchParams.set('shareToken', token);
  return url.toString();
}

function serializeShareLink(
  request: NextRequest,
  videoId: string,
  link: {
    id: string;
    token: string;
    permission: string;
    allowGuests: boolean;
    allowDownloads: boolean;
    expiresAt: Date | null;
    createdAt: Date;
    passwordHash: string | null;
  } | null
) {
  if (!link) {
    return { link: null, shareUrl: null };
  }

  return {
    link: {
      id: link.id,
      token: link.token,
      permission: link.permission,
      allowGuests: link.allowGuests,
      allowDownloads: link.allowDownloads,
      expiresAt: link.expiresAt,
      createdAt: link.createdAt,
      hasPassword: !!link.passwordHash,
    },
    shareUrl: buildWatchUrl(request, videoId, link.token),
  };
}

// GET /api/projects/[projectId]/videos/[videoId]/share
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const { projectId, videoId } = await params;
    const { error } = await requireShareManagementAccess(projectId, videoId, session.user.id);
    if (error) return error;

    const link = await db.shareLink.findFirst({
      where: {
        projectId,
        videoId,
        permission: 'COMMENT',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        token: true,
        permission: true,
        allowGuests: true,
        allowDownloads: true,
        expiresAt: true,
        createdAt: true,
        passwordHash: true,
      },
    });

    const response = successResponse(serializeShareLink(request, videoId, link));

    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error fetching video share link:', error);
    return apiErrors.internalError('Failed to fetch video share link');
  }
}

// POST /api/projects/[projectId]/videos/[videoId]/share
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const { projectId, videoId } = await params;
    const { error } = await requireShareManagementAccess(projectId, videoId, session.user.id);
    if (error) return error;

    const body = await request.json().catch(() => ({}));
    const allowGuests = typeof body?.allowGuests === 'boolean' ? body.allowGuests : true;
    const allowDownloads = typeof body?.allowDownloads === 'boolean' ? body.allowDownloads : false;
    const password = typeof body?.password === 'string' ? body.password.trim() : '';
    if (password.length > MAX_SHARE_PASSWORD_LENGTH) {
      return apiErrors.badRequest(
        `Password must be ${MAX_SHARE_PASSWORD_LENGTH} characters or fewer`
      );
    }
    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    const token = randomBytes(24).toString('base64url');

    let link: {
      id: string;
      token: string;
      permission: string;
      allowGuests: boolean;
      allowDownloads: boolean;
      expiresAt: Date | null;
      createdAt: Date;
      passwordHash: string | null;
    } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        link = await db.$transaction(
          async (tx) => {
            const existing = await tx.shareLink.findFirst({
              where: {
                projectId,
                videoId,
                permission: 'COMMENT',
              },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            });

            if (existing) {
              return tx.shareLink.update({
                where: { id: existing.id },
                data: {
                  token,
                  allowGuests,
                  allowDownloads,
                  passwordHash,
                  expiresAt: null,
                },
                select: {
                  id: true,
                  token: true,
                  permission: true,
                  allowGuests: true,
                  allowDownloads: true,
                  expiresAt: true,
                  createdAt: true,
                  passwordHash: true,
                },
              });
            }

            return tx.shareLink.create({
              data: {
                token,
                projectId,
                videoId,
                permission: 'COMMENT',
                allowGuests,
                allowDownloads,
                passwordHash,
              },
              select: {
                id: true,
                token: true,
                permission: true,
                allowGuests: true,
                allowDownloads: true,
                expiresAt: true,
                createdAt: true,
                passwordHash: true,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
        break;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034' &&
          attempt < 2
        ) {
          continue;
        }
        throw error;
      }
    }

    if (!link) {
      return apiErrors.internalError('Failed to create video share link');
    }

    const response = successResponse(serializeShareLink(request, videoId, link));

    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error creating video share link:', error);
    return apiErrors.internalError('Failed to create video share link');
  }
}

// PATCH /api/projects/[projectId]/videos/[videoId]/share
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const { projectId, videoId } = await params;
    const { error } = await requireShareManagementAccess(projectId, videoId, session.user.id);
    if (error) return error;

    const body = await request.json().catch(() => ({}));
    const allowGuests = typeof body?.allowGuests === 'boolean' ? body.allowGuests : undefined;
    const allowDownloads =
      typeof body?.allowDownloads === 'boolean' ? body.allowDownloads : undefined;
    const rawPassword = typeof body?.password === 'string' ? body.password : undefined;
    const clearPassword = body?.clearPassword === true;
    if (rawPassword !== undefined && rawPassword.length > MAX_SHARE_PASSWORD_LENGTH) {
      return apiErrors.badRequest(
        `Password must be ${MAX_SHARE_PASSWORD_LENGTH} characters or fewer`
      );
    }

    const existing = await db.shareLink.findFirst({
      where: {
        projectId,
        videoId,
        permission: 'COMMENT',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!existing) {
      return apiErrors.notFound('Share link');
    }

    let passwordHashUpdate: string | null | undefined;
    if (clearPassword) {
      passwordHashUpdate = null;
    } else if (rawPassword !== undefined) {
      const trimmedPassword = rawPassword.trim();
      if (trimmedPassword.length > 0) {
        passwordHashUpdate = await bcrypt.hash(trimmedPassword, 12);
      }
    }

    const shouldRotateToken = clearPassword || rawPassword !== undefined;
    const updated = await db.shareLink.update({
      where: { id: existing.id },
      data: {
        ...(allowGuests !== undefined ? { allowGuests } : {}),
        ...(allowDownloads !== undefined ? { allowDownloads } : {}),
        ...(passwordHashUpdate !== undefined ? { passwordHash: passwordHashUpdate } : {}),
        ...(shouldRotateToken ? { token: randomBytes(24).toString('base64url') } : {}),
      },
      select: {
        id: true,
        token: true,
        permission: true,
        allowGuests: true,
        allowDownloads: true,
        expiresAt: true,
        createdAt: true,
        passwordHash: true,
      },
    });

    const response = successResponse(serializeShareLink(request, videoId, updated));
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error updating video share link:', error);
    return apiErrors.internalError('Failed to update video share link');
  }
}

// DELETE /api/projects/[projectId]/videos/[videoId]/share
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const { projectId, videoId } = await params;
    const { error } = await requireShareManagementAccess(projectId, videoId, session.user.id);
    if (error) return error;

    await db.shareLink.deleteMany({
      where: {
        projectId,
        videoId,
        permission: 'COMMENT',
      },
    });

    const response = successResponse({ message: 'Video share link revoked' });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error deleting video share link:', error);
    return apiErrors.internalError('Failed to delete video share link');
  }
}
