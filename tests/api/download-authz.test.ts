// Authorization tests for the two download routes, from callers who are signed
// in but not entitled.
//
// Both routes are listed in tests/api/auth-matrix.test.ts, which proves only that
// an anonymous caller is refused. Downloads are the one place in this product
// where the read gate and the export gate are deliberately different: a
// COMMENTATOR may watch every frame of a project and still not be allowed to walk
// away with the files, and that distinction lives entirely in
// `canDownloadProjectMedia()`. Deleting it, or widening it from `access.canEdit ||
// allowDownloads` to `access.hasAccess`, does not move a single assertion in the
// anonymous matrix.
//
// The pairs below are built so the difference is visible: the same caller, the
// same URL, the same seeded rows, and only `project.allowDownloads` flipped
// between the refusal and the success.
//
// On /api/versions/[versionId]/download every fixture is an `r2` version on
// purpose. The route checks access first and only then rejects non-Bunny
// providers, so an authorized caller lands on a 400 that no unauthorized caller
// can reach. That 400 is the proof that the 403 came from the access check rather
// than from a malformed request: the two are different numbers on the same input.
// A `bunny` fixture would instead send the handler out to the Bunny CDN over the
// network, which has no place in this suite.

import { describe, expect, it } from 'vitest';
import type { Project, User, Video, VideoVersion, Workspace } from '@prisma/client';
import { db } from '@/lib/db';
import { GET as downloadProject } from '@/app/api/projects/[projectId]/download/route';
import { GET as downloadVersion } from '@/app/api/versions/[versionId]/download/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createExpiredUser,
  createUser,
  createVersion,
  createVideo,
  nextSeq,
  seedProject,
} from '../factories';

interface DownloadFixture {
  owner: User;
  workspace: Workspace;
  project: Project;
  video: Video;
  version: VideoVersion;
  /** The proxy path the manifest is expected to hand back for `version`. */
  videoPath: string;
}

/**
 * A project holding one video with one `r2` version.
 *
 * The provider matters twice over. `versionDownloadUrl()` only emits a manifest
 * entry for a `bunny`, `r2` or `direct` version, so the default youtube fixture
 * would produce an empty manifest and a 400 for every caller, authorized or not,
 * which is exactly the "the route never reached the guard" trap. And
 * `video_versions` carries a partial unique index on the provider video id, so
 * two fixtures in one test need two distinct file names.
 */
async function seedDownloadable(
  input: { allowDownloads: boolean; visibility?: 'PRIVATE' | 'PUBLIC'; ownerUser?: User } = {
    allowDownloads: false,
  }
): Promise<DownloadFixture> {
  const { owner, workspace, project } = await seedProject({
    ownerUser: input.ownerUser,
    visibility: input.visibility ?? 'PRIVATE',
    allowDownloads: input.allowDownloads,
  });
  const fileName = `44444444-4444-4444-8444-${String(nextSeq()).padStart(12, '0')}.mp4`;
  const videoPath = `/api/upload/video/${fileName}`;
  const video = await createVideo({ projectId: project.id, title: 'Downloadable video' });
  const version = await createVersion({
    videoParentId: video.id,
    versionNumber: 1,
    providerId: 'r2',
    providerVideoId: `videos/${fileName}`,
    originalUrl: videoPath,
    sizeBytes: BigInt(2048),
    isActive: true,
  });

  return { owner, workspace, project, video, version, videoPath };
}

async function seedDownloadableImage(allowDownloads: boolean): Promise<DownloadFixture> {
  const { owner, workspace, project } = await seedProject({
    visibility: 'PRIVATE',
    allowDownloads,
  });
  const fileName = `55555555-5555-4555-8555-${String(nextSeq()).padStart(12, '0')}.png`;
  const videoPath = `/api/upload/image/${fileName}`;
  const video = await db.video.create({
    data: { projectId: project.id, title: 'Approved still', mediaType: 'IMAGE' },
  });
  const version = await createVersion({
    videoParentId: video.id,
    providerId: 'r2-image',
    providerVideoId: `images/${fileName}`,
    originalUrl: videoPath,
    thumbnailUrl: videoPath,
    duration: null,
    sizeBytes: BigInt(2048),
  });
  return { owner, workspace, project, video, version, videoPath };
}

function projectDownloadUrl(projectId: string): string {
  return `/api/projects/${projectId}/download`;
}

function versionDownloadUrl(versionId: string): string {
  return `/api/versions/${versionId}/download`;
}

interface Manifest {
  projectName: string;
  files: Array<{ fileName: string; url: string }>;
  totalFiles: number;
}

// ---------------------------------------------------------------------------
// GET /api/projects/[projectId]/download
// ---------------------------------------------------------------------------
describe('GET /api/projects/[projectId]/download', () => {
  it('includes an image review in the project manifest for its owner', async () => {
    const fixture = await seedDownloadableImage(false);
    signedInAs(fixture.owner);
    const response = await callRoute(
      downloadProject,
      apiRequest(projectDownloadUrl(fixture.project.id)),
      { projectId: fixture.project.id }
    );
    expect(response.status).toBe(200);
    expect((await readData<Manifest>(response)).files).toEqual([
      { fileName: '01-Approved still-v1.png', url: fixture.videoPath, sizeBytes: 2048 },
    ]);
  });

  it('refuses image exports to a commentator until project downloads are enabled', async () => {
    const fixture = await seedDownloadableImage(false);
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);
    const url = projectDownloadUrl(fixture.project.id);
    expect(
      (await callRoute(downloadProject, apiRequest(url), { projectId: fixture.project.id })).status
    ).toBe(403);
    await db.project.update({ where: { id: fixture.project.id }, data: { allowDownloads: true } });
    const allowed = await callRoute(downloadProject, apiRequest(url), {
      projectId: fixture.project.id,
    });
    expect(allowed.status).toBe(200);
    expect((await readData<Manifest>(allowed)).files[0]?.url).toBe(fixture.videoPath);
  });

  it('returns 403 to a signed-in stranger even when downloads are allowed', async () => {
    const fixture = await seedDownloadable({ allowDownloads: true });
    // The stranger owns a real tenant of their own, so nothing about this call is
    // malformed: they simply have no relationship to the target project.
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      downloadProject,
      apiRequest(projectDownloadUrl(fixture.project.id)),
      {
        projectId: fixture.project.id,
      }
    );

    expect(response.status).toBe(403);
  });

  it('returns 403 to a project COMMENTATOR when downloads are disabled', async () => {
    const fixture = await seedDownloadable({ allowDownloads: false });
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      downloadProject,
      apiRequest(projectDownloadUrl(fixture.project.id)),
      {
        projectId: fixture.project.id,
      }
    );

    expect(response.status).toBe(403);
  });

  // The positive control for the case above. Same role, same route, same seeded
  // rows; only allowDownloads changed. If this one did not pass, the 403 above
  // would prove nothing about the flag.
  it('lets the same project COMMENTATOR download once allowDownloads is on', async () => {
    const fixture = await seedDownloadable({ allowDownloads: true });
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      downloadProject,
      apiRequest(projectDownloadUrl(fixture.project.id)),
      {
        projectId: fixture.project.id,
      }
    );

    expect(response.status).toBe(200);
    const manifest = await readData<Manifest>(response);
    expect(manifest.totalFiles).toBe(1);
    expect(manifest.files[0]?.url).toBe(fixture.videoPath);
  });

  it('returns 403 to a workspace COMMENTATOR when downloads are disabled', async () => {
    const fixture = await seedDownloadable({ allowDownloads: false });
    const workspaceCommentator = await createUser();
    await addWorkspaceMember({
      workspaceId: fixture.workspace.id,
      userId: workspaceCommentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(workspaceCommentator);

    const response = await callRoute(
      downloadProject,
      apiRequest(projectDownloadUrl(fixture.project.id)),
      {
        projectId: fixture.project.id,
      }
    );

    expect(response.status).toBe(403);
  });

  // A PUBLIC project hands `hasAccess` to anybody. It must not also hand out the
  // source files: that is what the separate allowDownloads flag is for.
  it('returns 403 to a signed-in passer-by on a PUBLIC project with downloads off', async () => {
    const fixture = await seedDownloadable({ allowDownloads: false, visibility: 'PUBLIC' });
    const passerBy = await createUser();
    signedInAs(passerBy);

    const response = await callRoute(
      downloadProject,
      apiRequest(projectDownloadUrl(fixture.project.id)),
      {
        projectId: fixture.project.id,
      }
    );

    expect(response.status).toBe(403);
  });

  it('lets a signed-in passer-by download a PUBLIC project with downloads on', async () => {
    const fixture = await seedDownloadable({ allowDownloads: true, visibility: 'PUBLIC' });
    const passerBy = await createUser();
    signedInAs(passerBy);

    const response = await callRoute(
      downloadProject,
      apiRequest(projectDownloadUrl(fixture.project.id)),
      {
        projectId: fixture.project.id,
      }
    );

    expect(response.status).toBe(200);
    expect((await readData<Manifest>(response)).totalFiles).toBe(1);
  });

  // `canDownloadProjectMedia` starts from `access.hasAccess`, which is itself
  // gated on the workspace owner's billing. A lapsed trial therefore closes the
  // export path for the owner too, not only for the collaborators.
  it('returns 403 to the owner once their own billing access has lapsed', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedDownloadable({ allowDownloads: true, ownerUser: expiredOwner });
    signedInAs(expiredOwner);

    const response = await callRoute(
      downloadProject,
      apiRequest(projectDownloadUrl(fixture.project.id)),
      {
        projectId: fixture.project.id,
      }
    );

    expect(response.status).toBe(403);
  });

  // The IDOR shape for this route: the caller is legitimately entitled to the
  // project in the path, and smuggles a foreign id through the `videoIds` filter.
  // The video query is scoped by projectId, so the foreign id resolves to nothing
  // and the route refuses the whole selection rather than silently dropping it.
  it('returns 400 for a videoIds selection naming a video from another workspace', async () => {
    const mine = await seedDownloadable({ allowDownloads: true });
    const theirs = await seedDownloadable({ allowDownloads: true });
    signedInAs(mine.owner);

    const response = await callRoute(
      downloadProject,
      apiRequest(projectDownloadUrl(mine.project.id), {
        searchParams: { videoIds: theirs.video.id },
      }),
      { projectId: mine.project.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('do not belong to this project');
  });

  // And the mixed selection, which is the version an attacker would actually
  // send: one id they own, one they do not. Partial success would be the bug.
  it('returns 400 for a videoIds selection mixing my video with a foreign one', async () => {
    const mine = await seedDownloadable({ allowDownloads: true });
    const theirs = await seedDownloadable({ allowDownloads: true });
    signedInAs(mine.owner);

    const response = await callRoute(
      downloadProject,
      apiRequest(projectDownloadUrl(mine.project.id), {
        searchParams: { videoIds: `${mine.video.id},${theirs.video.id}` },
      }),
      { projectId: mine.project.id }
    );

    expect(response.status).toBe(400);
  });

  // Positive control for the two cases above: the identical request shape with
  // only ids the caller owns succeeds, so the 400s are the scoping check and not
  // a rejected query string.
  it('lets the owner download an explicit selection of their own videos', async () => {
    const mine = await seedDownloadable({ allowDownloads: true });
    signedInAs(mine.owner);

    const response = await callRoute(
      downloadProject,
      apiRequest(projectDownloadUrl(mine.project.id), {
        searchParams: { videoIds: mine.video.id },
      }),
      { projectId: mine.project.id }
    );

    expect(response.status).toBe(200);
    const manifest = await readData<Manifest>(response);
    expect(manifest.totalFiles).toBe(1);
    expect(manifest.files[0]?.url).toBe(mine.videoPath);
  });

  it('lets the owner download even when allowDownloads is off', async () => {
    const fixture = await seedDownloadable({ allowDownloads: false });
    signedInAs(fixture.owner);

    const response = await callRoute(
      downloadProject,
      apiRequest(projectDownloadUrl(fixture.project.id)),
      {
        projectId: fixture.project.id,
      }
    );

    expect(response.status).toBe(200);
    expect((await readData<Manifest>(response)).totalFiles).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/versions/[versionId]/download
// ---------------------------------------------------------------------------
// This route takes a bare versionId with no project in the path, so the only
// thing standing between a signed-in caller and any file in the database is the
// access check on the version's project. Every refusal below also asserts that no
// DownloadEgressEvent row was written, because that row is the billing record: a
// refusal that still bills the workspace owner would be its own bug.
describe('GET /api/versions/[versionId]/download', () => {
  // 404 rather than 403 for a caller with no relationship to the project: a 403 would
  // confirm the id exists. The comment export route has always answered 404 for the
  // identical shape, and the three download paths now agree.
  it('returns 404 to a signed-in stranger and records no egress', async () => {
    const fixture = await seedDownloadable({ allowDownloads: true });
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      downloadVersion,
      apiRequest(versionDownloadUrl(fixture.version.id)),
      { versionId: fixture.version.id }
    );

    expect(response.status).toBe(404);
    expect(await db.downloadEgressEvent.count()).toBe(0);
  });

  it('returns 403 to a project COMMENTATOR when downloads are disabled', async () => {
    const fixture = await seedDownloadable({ allowDownloads: false });
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      downloadVersion,
      apiRequest(versionDownloadUrl(fixture.version.id)),
      { versionId: fixture.version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.downloadEgressEvent.count()).toBe(0);
  });

  // The positive control. Same COMMENTATOR, same version, allowDownloads flipped
  // on: the access check now passes and the request dies further down the handler
  // on the provider check instead. 400 rather than 403 is what proves the 403
  // above was the guard.
  it('gets the same COMMENTATOR past the access check once allowDownloads is on', async () => {
    const fixture = await seedDownloadable({ allowDownloads: true });
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      downloadVersion,
      apiRequest(versionDownloadUrl(fixture.version.id)),
      { versionId: fixture.version.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('Bunny');
  });

  it('returns 403 to a workspace COMMENTATOR when downloads are disabled', async () => {
    const fixture = await seedDownloadable({ allowDownloads: false });
    const workspaceCommentator = await createUser();
    await addWorkspaceMember({
      workspaceId: fixture.workspace.id,
      userId: workspaceCommentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(workspaceCommentator);

    const response = await callRoute(
      downloadVersion,
      apiRequest(versionDownloadUrl(fixture.version.id)),
      { versionId: fixture.version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.downloadEgressEvent.count()).toBe(0);
  });

  it('returns 403 to the owner once their own billing access has lapsed', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedDownloadable({ allowDownloads: true, ownerUser: expiredOwner });
    signedInAs(expiredOwner);

    const response = await callRoute(
      downloadVersion,
      apiRequest(versionDownloadUrl(fixture.version.id)),
      { versionId: fixture.version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.downloadEgressEvent.count()).toBe(0);
  });

  // Straight identifier substitution. There is no projectId in this URL to
  // cross-check against, so the version id alone decides which project gets
  // authorized. A caller who owns a perfectly good project of their own gets 404
  // for somebody else's version, and never learns whether it exists.
  it('returns 404 for a version id belonging to another workspace', async () => {
    const mine = await seedDownloadable({ allowDownloads: true });
    const theirs = await seedDownloadable({ allowDownloads: true });
    signedInAs(mine.owner);

    const response = await callRoute(
      downloadVersion,
      apiRequest(versionDownloadUrl(theirs.version.id)),
      { versionId: theirs.version.id }
    );

    expect(response.status).toBe(404);
    expect(await db.downloadEgressEvent.count()).toBe(0);
  });

  // Positive control for the substitution case: the very same caller asking for
  // their own version reaches the provider check. Only the id changed.
  it('gets the same caller past the access check on their own version', async () => {
    const mine = await seedDownloadable({ allowDownloads: true });
    await seedDownloadable({ allowDownloads: true });
    signedInAs(mine.owner);

    const response = await callRoute(
      downloadVersion,
      apiRequest(versionDownloadUrl(mine.version.id)),
      { versionId: mine.version.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('Bunny');
  });

  // `canDownloadProjectMedia` short-circuits on canEdit, so the owner is past the
  // gate with allowDownloads off. Pinned because it is the one asymmetry that
  // makes the COMMENTATOR cases above meaningful.
  it('gets the owner past the access check even when allowDownloads is off', async () => {
    const fixture = await seedDownloadable({ allowDownloads: false });
    signedInAs(fixture.owner);

    const response = await callRoute(
      downloadVersion,
      apiRequest(versionDownloadUrl(fixture.version.id)),
      { versionId: fixture.version.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('Bunny');
  });
});
