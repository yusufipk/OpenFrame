import { visibleVideoWhere } from '@/lib/content-access';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse } from '@/lib/api-response';
import { buildBillingAccessWhereInput } from '@/lib/billing';
import { checkRateLimit, rateLimitHeaders, RATE_LIMIT_CONFIGS } from '@/lib/rate-limit';
import { logError } from '@/lib/logger';

const MAX_Q_LENGTH = 100;
const RESULTS_PER_CATEGORY = 5;

// GET /api/search?q=term : search projects, workspaces, and videos accessible to the user
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const userId = session.user.id;

    const cfg = RATE_LIMIT_CONFIGS['search'];
    const rl = await checkRateLimit(userId, 'search', cfg);
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: 'Too many requests. Please try again later.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...rateLimitHeaders(rl, cfg.maxRequests) },
      });
    }

    const { searchParams } = new URL(request.url);
    const term = (searchParams.get('q') ?? '').trim();

    if (term.length < 2) {
      return successResponse({ projects: [], workspaces: [], videos: [] });
    }

    if (term.length > MAX_Q_LENGTH) {
      return apiErrors.badRequest('Query too long.');
    }

    // Access filter reused across queries. The billing condition is the same one every
    // other read path carries (GET /api/projects, checkProjectAccess): without it search
    // kept returning project names, descriptions and video titles for a tenant whose
    // access had otherwise been cut off, which is a lapsed-tenant surface no other read
    // path leaves open.
    const ownerWithBillingAccess = buildBillingAccessWhereInput();

    const projectAccessFilter = {
      workspace: { owner: ownerWithBillingAccess },
      OR: [
        { ownerId: userId },
        { members: { some: { userId } } },
        { workspace: { members: { some: { userId } } } },
        { workspace: { ownerId: userId } },
      ],
    };

    const workspaceAccessFilter = {
      owner: ownerWithBillingAccess,
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    };

    const [projects, workspaces, videos] = await Promise.all([
      db.project.findMany({
        where: {
          AND: [
            projectAccessFilter,
            {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { description: { contains: term, mode: 'insensitive' } },
              ],
            },
          ],
        },
        select: {
          id: true,
          name: true,
          description: true,
          workspace: { select: { id: true, name: true } },
        },
        take: RESULTS_PER_CATEGORY,
      }),

      db.workspace.findMany({
        where: {
          AND: [
            workspaceAccessFilter,
            {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { description: { contains: term, mode: 'insensitive' } },
              ],
            },
          ],
        },
        select: {
          id: true,
          name: true,
          description: true,
        },
        take: RESULTS_PER_CATEGORY,
      }),

      db.video.findMany({
        where: {
          AND: visibleVideoWhere(userId, false, false),
          title: { contains: term, mode: 'insensitive' },
        },
        select: {
          id: true,
          title: true,
          projectId: true,
        },
        take: RESULTS_PER_CATEGORY,
      }),
    ]);

    const videoProjects = await db.project.findMany({
      where: { id: { in: videos.map((video) => video.projectId) }, AND: projectAccessFilter },
      select: { id: true, name: true },
    });
    const response = successResponse({
      projects,
      workspaces,
      videos: videos.map((video) => ({
        ...video,
        project: videoProjects.find((project) => project.id === video.projectId) ?? {
          id: video.projectId,
          name: 'Shared video',
        },
      })),
    });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (err) {
    logError('[search] error:', err);
    return apiErrors.internalError();
  }
}
