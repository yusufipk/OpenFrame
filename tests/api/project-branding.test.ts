import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { db } from '@/lib/db';
import {
  DELETE as removeBrandAsset,
  POST as uploadBrandAsset,
} from '@/app/api/projects/[projectId]/branding/route';
import { GET as serveBrandAsset } from '@/app/api/projects/[projectId]/branding/[filename]/route';
import {
  DELETE as deleteProject,
  GET as getProject,
  PATCH as patchProject,
} from '@/app/api/projects/[projectId]/route';
import { GET as getWatch } from '@/app/api/watch/[videoId]/route';
import { GET as getProjectVideo } from '@/app/api/projects/[projectId]/videos/[videoId]/route';
import { DELETE as deleteWorkspace } from '@/app/api/workspaces/[workspaceId]/route';
import { DELETE as deleteComment } from '@/app/api/comments/[commentId]/route';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createComment,
  createExpiredUser,
  createShareLink,
  createUser,
  createVersion,
  createVideo,
  seedProject,
} from '../factories';

const { r2Send } = vi.hoisted(() => ({ r2Send: vi.fn() }));
vi.mock('@/lib/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/r2')>();
  return { ...actual, r2Client: { send: r2Send } };
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
);
const EXISTING_BANNER = 'branding/11111111-2222-3333-4444-555555555555.png';
const EXISTING_LOGO = 'branding/66666666-7777-8888-9999-aaaaaaaaaaaa.png';
const OTHER_BANNER = 'branding/bbbbbbbb-cccc-dddd-eeee-ffffffffffff.png';
const OTHER_LOGO = 'branding/12121212-3434-5656-7878-909090909090.png';
const fileOf = (key: string) => key.slice('branding/'.length);

function uploadRequest(projectId: string, kind: string, bytes: Buffer = PNG) {
  const form = new FormData();
  form.set('kind', kind);
  form.set('image', new File([new Uint8Array(bytes)], 'brand.png', { type: 'image/png' }));
  return apiRequest(`/api/projects/${projectId}/branding`, {
    rawBody: form,
    headers: { 'content-length': '4096' },
  });
}

function sentCommands<T>(type: new (...args: never[]) => T): T[] {
  return r2Send.mock.calls.map(([command]) => command).filter((c): c is T => c instanceof type);
}

function putKeys(): string[] {
  return sentCommands(PutObjectCommand).map((c) => c.input.Key!);
}

function deletedKeys(): string[] {
  return sentCommands(DeleteObjectCommand).map((c) => c.input.Key!);
}

async function brandingRow(projectId: string) {
  return db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { brandColor: true, brandBannerKey: true, brandLogoKey: true },
  });
}

async function commentatorOn(projectId: string) {
  const user = await createUser();
  await addProjectMember({ projectId, userId: user.id, role: 'COMMENTATOR' });
  return user;
}

beforeEach(() => {
  vi.stubEnv('R2_ACCESS_KEY_ID', 'test-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test-secret');
  vi.stubEnv('R2_BUCKET_NAME', 'test-bucket');
  vi.stubEnv('R2_ENDPOINT', 'http://minio-test:9000');
  r2Send.mockReset();
  r2Send.mockImplementation(async (command: unknown) =>
    command instanceof GetObjectCommand
      ? { Body: Readable.from([PNG]), ContentLength: PNG.length, ContentType: 'image/png' }
      : {}
  );
});

afterEach(() => vi.unstubAllEnvs());

describe('POST /api/projects/[projectId]/branding', () => {
  it('refuses an anonymous caller before touching storage', async () => {
    const { project } = await seedProject();
    signedOut();

    const response = await callRoute(uploadBrandAsset, uploadRequest(project.id, 'banner'), {
      projectId: project.id,
    });

    expect(response.status).toBe(401);
    expect(r2Send).not.toHaveBeenCalled();
    expect((await brandingRow(project.id)).brandBannerKey).toBeNull();
  });

  it('refuses a COMMENTATOR and a signed-in stranger', async () => {
    const { project } = await seedProject();

    signedInAs(await commentatorOn(project.id));
    const asCommentator = await callRoute(uploadBrandAsset, uploadRequest(project.id, 'banner'), {
      projectId: project.id,
    });
    signedInAs(await createUser());
    const asStranger = await callRoute(uploadBrandAsset, uploadRequest(project.id, 'logo'), {
      projectId: project.id,
    });

    expect(asCommentator.status).toBe(403);
    expect(asStranger.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
    expect(await brandingRow(project.id)).toEqual({
      brandColor: null,
      brandBannerKey: null,
      brandLogoKey: null,
    });
  });

  it('rejects an unknown kind and bytes that are not an image', async () => {
    const { project, owner } = await seedProject();
    signedInAs(owner);

    const badKind = await callRoute(uploadBrandAsset, uploadRequest(project.id, 'favicon'), {
      projectId: project.id,
    });
    const badBytes = await callRoute(
      uploadBrandAsset,
      uploadRequest(project.id, 'banner', Buffer.from('<svg onload=alert(1)>')),
      { projectId: project.id }
    );

    expect(badKind.status).toBe(400);
    expect(badBytes.status).toBe(400);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('stores a banner for the owner and deletes the one it replaces', async () => {
    const { project, owner } = await seedProject();
    await db.project.update({
      where: { id: project.id },
      data: { brandBannerKey: EXISTING_BANNER, brandLogoKey: EXISTING_LOGO },
    });
    signedInAs(owner);

    const response = await callRoute(uploadBrandAsset, uploadRequest(project.id, 'banner'), {
      projectId: project.id,
    });

    expect(response.status).toBe(201);
    const row = await brandingRow(project.id);
    expect(row.brandBannerKey).toMatch(/^branding\/[0-9a-f-]{36}\.png$/);
    expect(row.brandBannerKey).not.toBe(EXISTING_BANNER);
    expect(row.brandLogoKey).toBe(EXISTING_LOGO);
    expect(putKeys()).toEqual([row.brandBannerKey]);
    expect(deletedKeys()).toEqual([EXISTING_BANNER]);

    const { branding } = await readData<{ branding: unknown }>(response);
    expect(branding).toEqual({
      color: null,
      bannerUrl: `/api/projects/${project.id}/branding/${fileOf(row.brandBannerKey!)}`,
      logoUrl: `/api/projects/${project.id}/branding/${fileOf(EXISTING_LOGO)}`,
    });
  });

  it('refuses the owner once the workspace billing has ended', async () => {
    const { project, owner } = await seedProject({ ownerUser: await createExpiredUser() });
    signedInAs(owner);

    const response = await callRoute(uploadBrandAsset, uploadRequest(project.id, 'logo'), {
      projectId: project.id,
    });

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
    expect((await brandingRow(project.id)).brandLogoKey).toBeNull();
  });

  it('refuses files over 5MB, even when Content-Length claims less', async () => {
    const { project, owner } = await seedProject();
    signedInAs(owner);

    const declaredTooBig = uploadRequest(project.id, 'banner');
    declaredTooBig.headers.set('content-length', String(6 * 1024 * 1024));
    const oversized = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);

    const byHeader = await callRoute(uploadBrandAsset, declaredTooBig, { projectId: project.id });
    const bySize = await callRoute(
      uploadBrandAsset,
      uploadRequest(project.id, 'banner', oversized),
      {
        projectId: project.id,
      }
    );

    expect(byHeader.status).toBe(400);
    expect(bySize.status).toBe(400);
    expect(r2Send).not.toHaveBeenCalled();
    expect((await brandingRow(project.id)).brandBannerKey).toBeNull();
  });

  it('answers 409 and removes its own upload when the banner changed mid-upload', async () => {
    const { project, owner } = await seedProject();
    await db.project.update({
      where: { id: project.id },
      data: { brandBannerKey: EXISTING_BANNER },
    });
    // Another upload lands between this request reading the row and swapping the key.
    r2Send.mockImplementation(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        await db.project.update({
          where: { id: project.id },
          data: { brandBannerKey: OTHER_BANNER },
        });
      }
      return {};
    });
    signedInAs(owner);

    const response = await callRoute(uploadBrandAsset, uploadRequest(project.id, 'banner'), {
      projectId: project.id,
    });

    expect(response.status).toBe(409);
    expect((await brandingRow(project.id)).brandBannerKey).toBe(OTHER_BANNER);
    const [uploaded] = putKeys();
    expect(deletedKeys()).toEqual([uploaded]);
  });
});

describe('DELETE /api/projects/[projectId]/branding', () => {
  it('leaves the logo in place when a COMMENTATOR asks to remove it', async () => {
    const { project } = await seedProject();
    await db.project.update({ where: { id: project.id }, data: { brandLogoKey: EXISTING_LOGO } });
    signedInAs(await commentatorOn(project.id));

    const response = await callRoute(
      removeBrandAsset,
      apiRequest(`/api/projects/${project.id}/branding`, {
        method: 'DELETE',
        searchParams: { kind: 'logo' },
      }),
      { projectId: project.id }
    );

    expect(response.status).toBe(403);
    expect((await brandingRow(project.id)).brandLogoKey).toBe(EXISTING_LOGO);
    expect(deletedKeys()).toEqual([]);
  });

  it('clears the logo for the owner and deletes the file', async () => {
    const { project, owner } = await seedProject();
    await db.project.update({
      where: { id: project.id },
      data: { brandBannerKey: EXISTING_BANNER, brandLogoKey: EXISTING_LOGO },
    });
    signedInAs(owner);

    const response = await callRoute(
      removeBrandAsset,
      apiRequest(`/api/projects/${project.id}/branding`, {
        method: 'DELETE',
        searchParams: { kind: 'logo' },
      }),
      { projectId: project.id }
    );

    expect(response.status).toBe(200);
    expect(await brandingRow(project.id)).toEqual({
      brandColor: null,
      brandBannerKey: EXISTING_BANNER,
      brandLogoKey: null,
    });
    expect(deletedKeys()).toEqual([EXISTING_LOGO]);
    expect((await readData<{ branding: unknown }>(response)).branding).toEqual({
      color: null,
      bannerUrl: `/api/projects/${project.id}/branding/${fileOf(EXISTING_BANNER)}`,
      logoUrl: null,
    });
  });
});

describe('PATCH /api/projects/[projectId] brandColor', () => {
  function patchColor(projectId: string, brandColor: unknown) {
    return callRoute(
      patchProject,
      apiRequest(`/api/projects/${projectId}`, { method: 'PATCH', body: { brandColor } }),
      { projectId }
    );
  }

  it('stores a normalized color for the owner and clears it with null', async () => {
    const { project, owner } = await seedProject();
    signedInAs(owner);

    expect((await patchColor(project.id, '#E4572E')).status).toBe(200);
    expect((await brandingRow(project.id)).brandColor).toBe('#e4572e');

    expect((await patchColor(project.id, null)).status).toBe(200);
    expect((await brandingRow(project.id)).brandColor).toBeNull();
  });

  it('rejects a value that is not a plain hex color and keeps the old one', async () => {
    const { project, owner } = await seedProject();
    await db.project.update({ where: { id: project.id }, data: { brandColor: '#112233' } });
    signedInAs(owner);

    const response = await patchColor(project.id, '#e4572e; background: url(https://x)');

    expect(response.status).toBe(400);
    expect((await brandingRow(project.id)).brandColor).toBe('#112233');
  });

  it('leaves the color alone when another field is edited', async () => {
    const { project, owner } = await seedProject();
    await db.project.update({ where: { id: project.id }, data: { brandColor: '#112233' } });
    signedInAs(owner);

    const response = await callRoute(
      patchProject,
      apiRequest(`/api/projects/${project.id}`, { method: 'PATCH', body: { name: 'Renamed' } }),
      { projectId: project.id }
    );

    expect(response.status).toBe(200);
    expect((await brandingRow(project.id)).brandColor).toBe('#112233');
  });

  it('refuses a COMMENTATOR', async () => {
    const { project } = await seedProject();
    signedInAs(await commentatorOn(project.id));

    expect((await patchColor(project.id, '#e4572e')).status).toBe(403);
    expect((await brandingRow(project.id)).brandColor).toBeNull();
  });
});

describe('GET /api/projects/[projectId]/branding/[filename]', () => {
  const FILE = EXISTING_BANNER.slice('branding/'.length);

  async function brandedVideoScenario() {
    const scenario = await seedProject();
    await db.project.update({
      where: { id: scenario.project.id },
      data: { brandBannerKey: EXISTING_BANNER, brandLogoKey: EXISTING_LOGO },
    });
    const video = await createVideo({ projectId: scenario.project.id });
    await createVersion({ videoParentId: video.id });
    return { ...scenario, video };
  }

  function serve(projectId: string, filename: string, init: Parameters<typeof apiRequest>[1]) {
    return callRoute(
      serveBrandAsset,
      apiRequest(`/api/projects/${projectId}/branding/${filename}`, init),
      { projectId, filename }
    );
  }

  it('serves the banner to a project member', async () => {
    const { project } = await brandedVideoScenario();
    signedInAs(await commentatorOn(project.id));

    const response = await serve(project.id, FILE, {});

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    expect(sentCommands(GetObjectCommand).map((c) => c.input.Key)).toEqual([EXISTING_BANNER]);
  });

  it('serves the logo too, with the same locked-down headers', async () => {
    const { project, owner } = await brandedVideoScenario();
    signedInAs(owner);

    const response = await serve(project.id, fileOf(EXISTING_LOGO), {});

    expect(response.status).toBe(200);
    expect(sentCommands(GetObjectCommand).map((c) => c.input.Key)).toEqual([EXISTING_LOGO]);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('serves an anonymous visitor of a public project', async () => {
    const { project } = await brandedVideoScenario();
    await db.project.update({ where: { id: project.id }, data: { visibility: 'PUBLIC' } });
    signedOut();

    expect((await serve(project.id, FILE, {})).status).toBe(200);
  });

  it('serves someone granted only one video, when they name that video', async () => {
    const { project, video } = await brandedVideoScenario();
    const viewer = await createUser();
    await db.videoMember.create({ data: { videoId: video.id, userId: viewer.id } });
    signedInAs(viewer);

    const withVideo = await serve(project.id, FILE, { searchParams: { videoId: video.id } });
    const without = await serve(project.id, FILE, {});

    expect(withVideo.status).toBe(200);
    expect(without.status).toBe(403);
  });

  it('refuses a video from another project, even one the caller can open', async () => {
    const { project } = await brandedVideoScenario();
    const other = await brandedVideoScenario();
    signedInAs(other.owner);

    const response = await serve(project.id, FILE, { searchParams: { videoId: other.video.id } });

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('serves a member of a restricted folder only through a folder of this project', async () => {
    const { project } = await brandedVideoScenario();
    const other = await brandedVideoScenario();
    const viewer = await createUser();
    const folder = await db.projectFolder.create({
      data: { projectId: project.id, name: 'Client cut', accessMode: 'RESTRICTED' },
    });
    const otherFolder = await db.projectFolder.create({
      data: { projectId: other.project.id, name: 'Elsewhere', accessMode: 'RESTRICTED' },
    });
    await db.projectFolderMember.createMany({
      data: [
        { folderId: folder.id, userId: viewer.id },
        { folderId: otherFolder.id, userId: viewer.id },
      ],
    });
    signedInAs(viewer);

    const viaFolder = await serve(project.id, FILE, { searchParams: { folderId: folder.id } });
    const viaOtherFolder = await serve(project.id, FILE, {
      searchParams: { folderId: otherFolder.id },
    });
    const withoutFolder = await serve(project.id, FILE, {});

    expect(viaFolder.status).toBe(200);
    expect(viaOtherFolder.status).toBe(403);
    expect(withoutFolder.status).toBe(403);
  });

  it('refuses an anonymous caller and a signed-in stranger on a private project', async () => {
    const { project, video } = await brandedVideoScenario();

    signedOut();
    const anonymous = await serve(project.id, FILE, { searchParams: { videoId: video.id } });
    signedInAs(await createUser());
    const stranger = await serve(project.id, FILE, { searchParams: { videoId: video.id } });

    expect(anonymous.status).toBe(403);
    expect(stranger.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('serves a guest holding a share session for a video in the project', async () => {
    const { project, video } = await brandedVideoScenario();
    const link = await createShareLink({ projectId: project.id, videoId: video.id });
    signedOut();

    const response = await serve(project.id, FILE, {
      searchParams: { videoId: video.id },
      cookies: {
        [getShareSessionCookieName(video.id)]: createShareSessionValue(link.token, video.id, false),
      },
    });

    expect(response.status).toBe(200);
  });

  it('does not let a share link of another project unlock this banner', async () => {
    const { project } = await brandedVideoScenario();
    const other = await brandedVideoScenario();
    const link = await createShareLink({ projectId: other.project.id, videoId: other.video.id });
    signedOut();

    const response = await serve(project.id, FILE, {
      searchParams: { videoId: other.video.id },
      cookies: {
        [getShareSessionCookieName(other.video.id)]: createShareSessionValue(
          link.token,
          other.video.id,
          false
        ),
      },
    });

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('refuses a file name that is not the current banner or logo, even to the owner', async () => {
    const { project, owner } = await brandedVideoScenario();
    signedInAs(owner);

    const response = await serve(project.id, '99999999-8888-7777-6666-555555555555.png', {});

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });
});

describe('branding in project and watch payloads', () => {
  it('returns branding URLs in the project GET and the watch GET', async () => {
    const { project, owner } = await seedProject();
    await db.project.update({
      where: { id: project.id },
      data: { brandColor: '#e4572e', brandLogoKey: EXISTING_LOGO },
    });
    const video = await createVideo({ projectId: project.id });
    await createVersion({ videoParentId: video.id });
    const logoFile = EXISTING_LOGO.slice('branding/'.length);
    signedInAs(owner);

    const projectData = await readData<{ branding: unknown }>(
      await callRoute(getProject, apiRequest(`/api/projects/${project.id}`), {
        projectId: project.id,
      })
    );
    const watchData = await readData<{ branding: unknown }>(
      await callRoute(getWatch, apiRequest(`/api/watch/${video.id}`), { videoId: video.id })
    );

    // Clients get served URLs, never the storage keys behind them.
    expect(projectData).not.toHaveProperty('brandLogoKey');
    expect(projectData).not.toHaveProperty('brandBannerKey');
    expect(projectData.branding).toEqual({
      color: '#e4572e',
      bannerUrl: null,
      logoUrl: `/api/projects/${project.id}/branding/${logoFile}`,
    });
    expect(watchData.branding).toEqual({
      color: '#e4572e',
      bannerUrl: null,
      logoUrl: `/api/projects/${project.id}/branding/${logoFile}?videoId=${video.id}`,
    });
  });

  it('returns branding in the dashboard video GET, scoped to the video', async () => {
    const { project, owner } = await seedProject();
    await db.project.update({
      where: { id: project.id },
      data: { brandBannerKey: EXISTING_BANNER },
    });
    const video = await createVideo({ projectId: project.id });
    await createVersion({ videoParentId: video.id });
    signedInAs(owner);

    const data = await readData<{ branding: unknown }>(
      await callRoute(
        getProjectVideo,
        apiRequest(`/api/projects/${project.id}/videos/${video.id}`),
        { projectId: project.id, videoId: video.id }
      )
    );

    expect(data.branding).toEqual({
      color: null,
      bannerUrl: `/api/projects/${project.id}/branding/${fileOf(EXISTING_BANNER)}?videoId=${video.id}`,
      logoUrl: null,
    });
  });
});

describe('project deletion', () => {
  async function brandedBystander() {
    // Another tenant's branded project, whose files must survive every deletion below.
    const bystander = await seedProject();
    await db.project.update({
      where: { id: bystander.project.id },
      data: { brandBannerKey: OTHER_BANNER, brandLogoKey: OTHER_LOGO },
    });
  }

  it('deletes the banner and logo files with the project and nobody else', async () => {
    const { project, owner } = await seedProject();
    await db.project.update({
      where: { id: project.id },
      data: { brandBannerKey: EXISTING_BANNER, brandLogoKey: EXISTING_LOGO },
    });
    await brandedBystander();
    signedInAs(owner);

    const response = await callRoute(
      deleteProject,
      apiRequest(`/api/projects/${project.id}`, { method: 'DELETE' }),
      { projectId: project.id }
    );

    expect(response.status).toBe(200);
    expect(deletedKeys().sort()).toEqual([EXISTING_BANNER, EXISTING_LOGO].sort());
  });

  it('deletes branding files of the workspace projects when the workspace goes', async () => {
    const { project, owner, workspace } = await seedProject();
    await db.project.update({
      where: { id: project.id },
      data: { brandBannerKey: EXISTING_BANNER, brandLogoKey: EXISTING_LOGO },
    });
    await brandedBystander();
    signedInAs(owner);

    const response = await callRoute(
      deleteWorkspace,
      apiRequest(`/api/workspaces/${workspace.id}`, { method: 'DELETE' }),
      { workspaceId: workspace.id }
    );

    expect(response.status).toBe(200);
    expect(deletedKeys().sort()).toEqual([EXISTING_BANNER, EXISTING_LOGO].sort());
  });
});

describe('isolation from comment images', () => {
  it("does not delete another project's banner when a comment reusing its file name is deleted", async () => {
    // The banner's file name is visible to every viewer in its URL. Comment routes accept
    // any /api/upload/image/<file> URL, so this is what an outsider can attach.
    const victim = await seedProject();
    await db.project.update({
      where: { id: victim.project.id },
      data: { brandBannerKey: EXISTING_BANNER },
    });
    const attacker = await seedProject();
    const video = await createVideo({ projectId: attacker.project.id });
    const version = await createVersion({ videoParentId: video.id });
    const comment = await createComment({ versionId: version.id, authorId: attacker.owner.id });
    await db.commentImage.create({
      data: {
        commentId: comment.id,
        url: `/api/upload/image/${EXISTING_BANNER.slice('branding/'.length)}`,
      },
    });
    signedInAs(attacker.owner);

    const response = await callRoute(
      deleteComment,
      apiRequest(`/api/comments/${comment.id}`, { method: 'DELETE' }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(200);
    expect(deletedKeys()).toEqual([`images/${EXISTING_BANNER.slice('branding/'.length)}`]);
    expect(deletedKeys()).not.toContain(EXISTING_BANNER);
  });
});
