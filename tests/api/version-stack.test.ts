// Dragging one file card onto another posts here: the dragged file's versions
// join the target as its newest versions and the dragged file disappears.
//
// The fixture numbers versions with gaps (1 and 3) on both sides on purpose:
// with contiguous numbers, "count" and "max" agree, and so do "position" and
// "versionNumber", which would let a renumbering bug pass.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { POST as mergeVersions } from '@/app/api/projects/[projectId]/videos/[videoId]/versions/merge/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createComment,
  createProject,
  createShareLink,
  createUser,
  createVersion,
  createVideo,
  createVideoAsset,
  seedProject,
} from '../factories';

function merge(projectId: string, targetId: string, body: Record<string, unknown>) {
  return callRoute(
    mergeVersions,
    apiRequest(`/api/projects/${projectId}/videos/${targetId}/versions/merge`, { body }),
    { projectId, videoId: targetId }
  );
}

interface Preview {
  needsConfirmation?: boolean;
  confirmationToken?: string;
  message?: string;
}

/**
 * Target: v1 (inactive) and v3 (active). Source: v1 (active) and v3 (inactive),
 * so the source's own active flag points at its older cut.
 */
async function stackFixture() {
  const scenario = await seedProject({ visibility: 'PRIVATE' });
  const projectId = scenario.project.id;
  const target = await createVideo({ projectId, title: 'Original' });
  const targetV1 = await createVersion({
    videoParentId: target.id,
    versionNumber: 1,
    isActive: false,
  });
  const targetV3 = await createVersion({ videoParentId: target.id, versionNumber: 3 });
  const source = await createVideo({ projectId, title: 'New cut' });
  const sourceV1 = await createVersion({ videoParentId: source.id, versionNumber: 1 });
  const sourceV3 = await createVersion({
    videoParentId: source.id,
    versionNumber: 3,
    isActive: false,
  });
  return { ...scenario, projectId, target, targetV1, targetV3, source, sourceV1, sourceV3 };
}

type StackFixture = Awaited<ReturnType<typeof stackFixture>>;

async function expectNothingMoved(f: StackFixture) {
  expect(await db.video.findUnique({ where: { id: f.source.id } })).not.toBeNull();
  const versions = await db.videoVersion.findMany({
    where: { id: { in: [f.sourceV1.id, f.sourceV3.id] } },
    orderBy: { versionNumber: 'asc' },
    select: { videoParentId: true, versionNumber: true },
  });
  expect(versions).toEqual([
    { videoParentId: f.source.id, versionNumber: 1 },
    { videoParentId: f.source.id, versionNumber: 3 },
  ]);
  expect(await db.videoVersion.count({ where: { videoParentId: f.target.id } })).toBe(2);
}

async function previewToken(f: StackFixture, sourceVideoId = f.source.id, targetId = f.target.id) {
  const preview = await readData<Preview>(await merge(f.projectId, targetId, { sourceVideoId }));
  expect(preview.needsConfirmation).toBe(true);
  return preview.confirmationToken as string;
}

describe('POST /api/projects/[projectId]/videos/[videoId]/versions/merge', () => {
  it('refuses an anonymous caller', async () => {
    const f = await stackFixture();
    signedOut();

    const response = await merge(f.projectId, f.target.id, { sourceVideoId: f.source.id });

    expect(response.status).toBe(401);
    await expectNothingMoved(f);
  });

  it('refuses a project member who can only comment', async () => {
    const f = await stackFixture();
    const commenter = await createUser();
    await addProjectMember({ projectId: f.projectId, userId: commenter.id });
    signedInAs(commenter);

    const response = await merge(f.projectId, f.target.id, { sourceVideoId: f.source.id });

    expect(response.status).toBe(403);
    await expectNothingMoved(f);
  });

  it('refuses a folder admin when either file sits in a folder they cannot edit', async () => {
    const owner = await createUser();
    const folderAdmin = await createUser();
    const { project } = await seedProject({ ownerUser: owner });
    const [mine, theirs] = await Promise.all([
      db.projectFolder.create({
        data: { projectId: project.id, name: 'Mine', accessMode: 'RESTRICTED' },
      }),
      db.projectFolder.create({
        data: { projectId: project.id, name: 'Theirs', accessMode: 'RESTRICTED' },
      }),
    ]);
    await db.projectFolderMember.create({
      data: { folderId: mine.id, userId: folderAdmin.id, role: 'ADMIN' },
    });
    const editable = await db.video.create({
      data: { projectId: project.id, folderId: mine.id, title: 'Editable' },
    });
    const editableTwin = await db.video.create({
      data: { projectId: project.id, folderId: mine.id, title: 'Editable twin' },
    });
    const hidden = await db.video.create({
      data: { projectId: project.id, folderId: theirs.id, title: 'Hidden' },
    });
    await createVersion({ videoParentId: editable.id });
    await createVersion({ videoParentId: editableTwin.id });
    const hiddenVersion = await createVersion({ videoParentId: hidden.id });
    signedInAs(folderAdmin);

    // Pulling someone else's cut into a file I can edit.
    const pull = await merge(project.id, editable.id, { sourceVideoId: hidden.id });
    // Pushing my cut into a file I cannot edit.
    const push = await merge(project.id, hidden.id, { sourceVideoId: editable.id });
    // Inside my own folder the same caller is allowed, so the refusals above are
    // about the other folder and not about folder admins in general.
    const own = await merge(project.id, editable.id, { sourceVideoId: editableTwin.id });

    expect(pull.status).toBe(403);
    expect(push.status).toBe(403);
    expect((await readData<Preview>(own)).needsConfirmation).toBe(true);
    expect(await db.video.count({ where: { id: { in: [editable.id, hidden.id] } } })).toBe(2);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: hiddenVersion.id } })).videoParentId
    ).toBe(hidden.id);
  });

  it('asks for confirmation first and changes nothing until it is given', async () => {
    const f = await stackFixture();
    signedInAs(f.owner);

    const response = await merge(f.projectId, f.target.id, { sourceVideoId: f.source.id });

    expect(response.status).toBe(200);
    const preview = await readData<Preview>(response);
    expect(preview.needsConfirmation).toBe(true);
    expect(preview.confirmationToken).toMatch(/^[0-9a-f]{64}$/);
    await expectNothingMoved(f);
  });

  it('stacks the source after the target, makes its newest cut active, and removes the source', async () => {
    const f = await stackFixture();
    const comment = await createComment({ versionId: f.sourceV3.id, authorId: f.owner.id });
    const asset = await createVideoAsset({ videoId: f.source.id, billedUserId: f.owner.id });
    const sourceLink = await createShareLink({ projectId: f.projectId, videoId: f.source.id });
    const targetLink = await createShareLink({ projectId: f.projectId, videoId: f.target.id });
    const reviewer = await createUser();
    await db.videoMember.create({ data: { videoId: f.source.id, userId: reviewer.id } });
    await db.videoMember.create({ data: { videoId: f.target.id, userId: reviewer.id } });
    const sourceInvite = await db.invitation.create({
      data: {
        token: `stack-invite-${f.source.id}`,
        email: 'stack-invitee@example.com',
        scope: 'VIDEO',
        role: 'COMMENTATOR',
        projectId: f.projectId,
        videoId: f.source.id,
        invitedById: f.owner.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    signedInAs(f.owner);

    const token = await previewToken(f);
    const response = await merge(f.projectId, f.target.id, {
      sourceVideoId: f.source.id,
      confirmationToken: token,
    });

    expect(response.status).toBe(200);
    expect(await readData(response)).toEqual({
      targetVideoId: f.target.id,
      addedVersionNumbers: [4, 5],
      activeVersionNumber: 5,
      versionCount: 4,
    });
    expect(await db.video.findUnique({ where: { id: f.source.id } })).toBeNull();
    const versions = await db.videoVersion.findMany({
      where: { videoParentId: f.target.id },
      orderBy: { versionNumber: 'asc' },
      select: { id: true, versionNumber: true, isActive: true },
    });
    expect(versions).toEqual([
      { id: f.targetV1.id, versionNumber: 1, isActive: false },
      { id: f.targetV3.id, versionNumber: 3, isActive: false },
      { id: f.sourceV1.id, versionNumber: 4, isActive: false },
      { id: f.sourceV3.id, versionNumber: 5, isActive: true },
    ]);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).versionId).toBe(
      f.sourceV3.id
    );
    expect((await db.videoAsset.findUniqueOrThrow({ where: { id: asset.id } })).videoId).toBe(
      f.target.id
    );
    expect(await db.shareLink.findUnique({ where: { id: sourceLink.id } })).toBeNull();
    expect(await db.shareLink.findUnique({ where: { id: targetLink.id } })).not.toBeNull();
    expect(await db.invitation.findUnique({ where: { id: sourceInvite.id } })).toBeNull();
    expect(await db.videoMember.findMany({ where: { userId: reviewer.id } })).toEqual([
      expect.objectContaining({ videoId: f.target.id }),
    ]);
  });

  it('asks again instead of merging when the source gained a share link after the preview', async () => {
    const f = await stackFixture();
    signedInAs(f.owner);

    const token = await previewToken(f);
    await createShareLink({ projectId: f.projectId, videoId: f.source.id });
    const response = await merge(f.projectId, f.target.id, {
      sourceVideoId: f.source.id,
      confirmationToken: token,
    });

    expect((await readData<Preview>(response)).needsConfirmation).toBe(true);
    await expectNothingMoved(f);
  });

  it('asks again when a cut was uploaded to the source after the preview', async () => {
    const f = await stackFixture();
    signedInAs(f.owner);

    const token = await previewToken(f);
    const late = await createVersion({ videoParentId: f.source.id, versionNumber: 4 });
    const response = await merge(f.projectId, f.target.id, {
      sourceVideoId: f.source.id,
      confirmationToken: token,
    });

    expect((await readData<Preview>(response)).needsConfirmation).toBe(true);
    expect(await db.video.findUnique({ where: { id: f.source.id } })).not.toBeNull();
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: late.id } })).videoParentId
    ).toBe(f.source.id);
    expect(await db.videoVersion.count({ where: { videoParentId: f.target.id } })).toBe(2);
  });

  it('does not accept a token issued for the opposite direction', async () => {
    const f = await stackFixture();
    signedInAs(f.owner);

    // Previewed as "target onto source", committed as "source onto target".
    const reversed = await previewToken(f, f.target.id, f.source.id);
    const response = await merge(f.projectId, f.target.id, {
      sourceVideoId: f.source.id,
      confirmationToken: reversed,
    });

    expect((await readData<Preview>(response)).needsConfirmation).toBe(true);
    await expectNothingMoved(f);
  });

  it('refuses a source from another project', async () => {
    const f = await stackFixture();
    const other = await createProject({ ownerId: f.owner.id, workspaceId: f.workspace.id });
    const elsewhere = await createVideo({ projectId: other.id });
    const elsewhereVersion = await createVersion({ videoParentId: elsewhere.id });
    signedInAs(f.owner);

    const response = await merge(f.projectId, f.target.id, { sourceVideoId: elsewhere.id });

    expect(response.status).toBe(404);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: elsewhereVersion.id } }))
        .videoParentId
    ).toBe(elsewhere.id);
  });

  it('refuses a target from another project, even when the URL names this project', async () => {
    const f = await stackFixture();
    const other = await createProject({ ownerId: f.owner.id, workspaceId: f.workspace.id });
    const elsewhere = await createVideo({ projectId: other.id });
    await createVersion({ videoParentId: elsewhere.id });
    signedInAs(f.owner);

    const response = await merge(f.projectId, elsewhere.id, { sourceVideoId: f.source.id });

    expect(response.status).toBe(404);
    await expectNothingMoved(f);
    expect(await db.videoVersion.count({ where: { videoParentId: elsewhere.id } })).toBe(1);
  });

  it('refuses to stack an image onto a video', async () => {
    const f = await stackFixture();
    await db.video.update({ where: { id: f.source.id }, data: { mediaType: 'IMAGE' } });
    signedInAs(f.owner);

    const response = await merge(f.projectId, f.target.id, { sourceVideoId: f.source.id });

    expect(response.status).toBe(400);
    await expectNothingMoved(f);
  });

  it('refuses a source with no versions and keeps it', async () => {
    const f = await stackFixture();
    const empty = await createVideo({ projectId: f.projectId });
    signedInAs(f.owner);

    const response = await merge(f.projectId, f.target.id, { sourceVideoId: empty.id });

    expect(response.status).toBe(400);
    expect(await db.video.findUnique({ where: { id: empty.id } })).not.toBeNull();
  });

  it('needs both share and delete on an API token, beyond the manage the route is wrapped in', async () => {
    const f = await stackFixture();
    signedOut();
    // Written out by hand rather than imported, so a scope dropped from the
    // library fails here instead of agreeing with itself.
    const everything = [
      'read',
      'upload',
      'manage',
      'delete',
      'comments:read',
      'comments:write',
      'approvals',
      'share',
      'download',
    ];
    const call = async (fill: string, scopes: string[]) => {
      const token = `of_pat_${fill.repeat(43)}`;
      await db.apiToken.create({
        data: {
          userId: f.owner.id,
          name: 'Script',
          tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
          prefix: token.slice(0, 13),
          scopes,
        },
      });
      return callRoute(
        mergeVersions,
        apiRequest(`/api/projects/${f.projectId}/videos/${f.target.id}/versions/merge`, {
          headers: { authorization: `Bearer ${token}` },
          body: { sourceVideoId: f.source.id },
        }),
        { projectId: f.projectId, videoId: f.target.id }
      );
    };

    const noShare = await call(
      'a',
      everything.filter((scope) => scope !== 'share')
    );
    const noDelete = await call(
      'b',
      everything.filter((scope) => scope !== 'delete')
    );
    const allowed = await call('c', everything);

    expect(noShare.status).toBe(403);
    expect(await readError(noShare)).toContain('"share"');
    expect(noDelete.status).toBe(403);
    expect(await readError(noDelete)).toContain('"delete"');
    expect((await readData<Preview>(allowed)).needsConfirmation).toBe(true);
    await expectNothingMoved(f);
  });

  it('refuses to stack a file onto itself', async () => {
    const f = await stackFixture();
    signedInAs(f.owner);

    const response = await merge(f.projectId, f.target.id, { sourceVideoId: f.target.id });

    expect(response.status).toBe(400);
    expect(await db.videoVersion.count({ where: { videoParentId: f.target.id } })).toBe(2);
  });
});
