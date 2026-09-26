// Authorization tests for the five media routes under /api/upload.
//
// These are the routes that serve user media, and they are reachable without a
// session by design: a guest holding a share link has to be able to see the
// frame someone drew on, and a PUBLIC project has to render for a passer-by.
// That design is exactly what makes them worth testing. Every one of them runs
// `checkProjectAccess()` against the project that owns the referencing row, and
// nothing else stands between an anonymous request and somebody else's files.
//
// Before this file the only coverage was the anonymous sweep in
// tests/api/auth-matrix.test.ts. A 403 on its own proves very little here,
// because these routes have several ways to answer 400 or 500 before reaching
// the guard (an unparseable filename, a missing Content-Length, unconfigured
// object storage). Gap 4 of the test-gap inventory is exactly that failure:
// two matrix entries that passed with their authorization deleted. So every
// refusal below is paired with a genuine 2xx from the same route on the same
// seeded rows, with only the caller or the project's visibility changed.
//
// The positive control is possible because of the single mock in this file.
// `@/lib/r2` is re-mocked so `r2Client.send()` answers in-process: R2 is
// deliberately unconfigured in .env.test, and without this every authorized
// caller would land on a 500 from the storage client rather than a 200. Note
// what is *not* mocked: `lib/r2-media-proxy.ts` itself runs for real, so the
// content types, the object keys and the range handling asserted below are the
// production code paths. tests/unit/lib/r2-media-proxy.test.ts covers that
// module's own branches.

import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Project, User, Video, VideoVersion, Workspace } from '@prisma/client';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import { POST as uploadImage } from '@/app/api/upload/image/route';
import { POST as uploadAudio } from '@/app/api/upload/audio/route';
import { GET as serveImage } from '@/app/api/upload/image/[filename]/route';
import { GET as serveAudio } from '@/app/api/upload/audio/[filename]/route';
import { GET as serveVideo } from '@/app/api/upload/video/[filename]/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createComment,
  createExpiredUser,
  createShareLink,
  createUser,
  createVersion,
  createVideo,
  createVideoAsset,
  nextSeq,
  seedProject,
} from '../factories';

const { r2Send } = vi.hoisted(() => ({ r2Send: vi.fn() }));

// The one seam. tests/setup/api.ts already stubs the presigners in this module
// but leaves `r2Client` real, and the real one throws on first use because no
// R2_* variable is set for the api project. Replacing just the client keeps
// every other export, including R2_BUCKET_NAME.
vi.mock('@/lib/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/r2')>();
  return { ...actual, r2Client: { send: r2Send } };
});

const STORED_BYTES = 'stored-object-bytes';

beforeEach(() => {
  r2Send.mockReset();
  r2Send.mockImplementation(async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      return { ETag: '"stored"' };
    }
    if (command instanceof GetObjectCommand) {
      // ContentType is deliberately absent so the header on the response is the
      // one the *route* derived from the file extension, which is the part these
      // tests are asserting. The proxy's own content-type precedence is covered
      // in tests/unit/lib/r2-media-proxy.test.ts.
      const isRanged = Boolean(command.input.Range);
      return {
        Body: Readable.from([Buffer.from(STORED_BYTES)]),
        ContentLength: STORED_BYTES.length,
        ContentRange: isRanged ? `bytes 0-4/${STORED_BYTES.length}` : undefined,
      };
    }
    throw new Error(`Unexpected R2 command in this suite: ${String(command)}`);
  });
});

/** The Key of the nth object command R2 was asked for. */
function sentKey(call = 0): string {
  const command = r2Send.mock.calls[call]?.[0] as GetObjectCommand | PutObjectCommand;
  return String((command.input as { Key?: string }).Key);
}

// UUID-shaped names, because all three read routes gate the filename on a strict
// UUID regex before they look anything up. The sequence keeps them unique across
// a file that seeds several fixtures per test.
function uniqueFilename(extension: string): string {
  return `2f4a6c8e-1b3d-4f5a-8c7e-${String(nextSeq()).padStart(12, '0')}.${extension}`;
}

interface MediaFixture {
  owner: User;
  workspace: Workspace;
  project: Project;
  video: Video;
  version: VideoVersion;
  /** Attached to a comment on `version`. */
  imageFilename: string;
  /** Attached to the same comment. */
  audioFilename: string;
  /** The `originalUrl` of `version`. */
  videoFilename: string;
}

/**
 * A project with one video, one r2 version, and one comment carrying both an
 * annotation image and a voice note.
 *
 * All three read routes resolve their filename back to a project through a
 * referencing row, so a filename with no row behind it is refused no matter who
 * asks. Seeding all three at once means a single fixture serves every describe
 * block below and the caller is the only thing that changes between them.
 */
async function seedMedia(
  input: { visibility?: 'PRIVATE' | 'PUBLIC'; ownerUser?: User } = {}
): Promise<MediaFixture> {
  const { owner, workspace, project } = await seedProject({
    ownerUser: input.ownerUser,
    visibility: input.visibility ?? 'PRIVATE',
  });
  const imageFilename = uniqueFilename('png');
  const audioFilename = uniqueFilename('webm');
  const videoFilename = uniqueFilename('mp4');

  const video = await createVideo({ projectId: project.id, title: 'Video with media' });
  const version = await createVersion({
    videoParentId: video.id,
    providerId: 'r2',
    providerVideoId: `videos/${videoFilename}`,
    originalUrl: `/api/upload/video/${videoFilename}`,
    sizeBytes: BigInt(2048),
  });
  await createComment({
    versionId: version.id,
    authorId: owner.id,
    imageUrl: `/api/upload/image/${imageFilename}`,
    voiceUrl: `/api/upload/audio/${audioFilename}`,
    voiceDuration: 3,
  });

  return { owner, workspace, project, video, version, imageFilename, audioFilename, videoFilename };
}

function shareCookie(videoId: string, token: string): Record<string, string> {
  return { [getShareSessionCookieName(videoId)]: createShareSessionValue(token, videoId, false) };
}

// A one-pixel PNG header is enough: the upload route checks magic bytes, not
// that the file decodes.
function pngFile(): File {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  return new File([bytes], 'annotation.png', { type: 'image/png' });
}

// EBML header, which is what hasValidAudioMagicBytes() looks for on audio/webm.
function webmFile(): File {
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  return new File([bytes], 'note.webm', { type: 'audio/webm' });
}

function uploadForm(field: 'image' | 'audio', videoId: string): FormData {
  const form = new FormData();
  form.append(field, field === 'image' ? pngFile() : webmFile());
  form.append('videoId', videoId);
  return form;
}

// ---------------------------------------------------------------------------
// POST /api/upload/image
// ---------------------------------------------------------------------------
// The write half of the image path. Its guard is stricter than the read half's:
// membership alone is not enough for a guest, and a share link has to carry
// COMMENT rather than VIEW. Every body below is a real multipart with a real PNG
// and a real videoId, because both upload routes reject a malformed request
// before they authorize and an empty form produces the same 400 for everybody.
describe('POST /api/upload/image', () => {
  function imageRequest(videoId: string, cookies?: Record<string, string>) {
    return apiRequest('/api/upload/image', {
      rawBody: uploadForm('image', videoId),
      headers: { 'content-length': '2048' },
      cookies,
    });
  }

  it('refuses an anonymous caller with a well-formed image and a real video id', async () => {
    const fixture = await seedMedia();
    signedOut();

    const response = await callRoute(uploadImage, imageRequest(fixture.video.id));

    expect(response.status).toBe(403);
    expect(await readError(response)).toBe('Access denied');
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('refuses a signed-in stranger who owns a workspace of their own', async () => {
    const fixture = await seedMedia();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(uploadImage, imageRequest(fixture.video.id));

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  // The positive control for both refusals above: identical request, identical
  // rows, only the caller changed.
  it('stores the image for the project owner and returns a proxy url', async () => {
    const fixture = await seedMedia();
    signedInAs(fixture.owner);

    const response = await callRoute(uploadImage, imageRequest(fixture.video.id));

    expect(response.status).toBe(201);
    const { url } = await readData<{ url: string }>(response);
    expect(url).toMatch(/^\/api\/upload\/image\/[0-9a-f-]{36}\.png$/);
    expect(sentKey()).toMatch(/^images\/[0-9a-f-]{36}\.png$/);
  });

  // The upload gate is `hasAccess`, not `canEdit`: leaving an annotation is the
  // whole point of a COMMENTATOR seat.
  it('lets a project COMMENTATOR attach an image', async () => {
    const fixture = await seedMedia();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(uploadImage, imageRequest(fixture.video.id));

    expect(response.status).toBe(201);
  });

  // `hasAccess` is gated on the workspace owner's billing, so a lapsed trial
  // closes the upload path for the owner too.
  it('refuses the owner once their own billing access has lapsed', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedMedia({ ownerUser: expiredOwner });
    signedInAs(expiredOwner);

    const response = await callRoute(uploadImage, imageRequest(fixture.video.id));

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  // A VIEW share link is not enough to write. The read routes accept VIEW; this
  // one requires COMMENT, and the pair below is what pins the difference.
  it('refuses a guest holding a VIEW-only share link', async () => {
    const fixture = await seedMedia();
    const link = await createShareLink({
      projectId: fixture.project.id,
      videoId: fixture.video.id,
      permission: 'VIEW',
      allowGuests: true,
    });
    signedOut();

    const response = await callRoute(
      uploadImage,
      imageRequest(fixture.video.id, shareCookie(fixture.video.id, link.token))
    );

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  // With a COMMENT link the guest is past the access check and stops one step
  // later, on the upload token every guest write needs. 400 is a status no
  // unauthorized caller in this describe block can reach, which is what proves
  // the 403s above came from the guard.
  it('gets a guest holding a COMMENT share link past the access check', async () => {
    const fixture = await seedMedia();
    const link = await createShareLink({
      projectId: fixture.project.id,
      videoId: fixture.video.id,
      permission: 'COMMENT',
      allowGuests: true,
    });
    signedOut();

    const response = await callRoute(
      uploadImage,
      imageRequest(fixture.video.id, shareCookie(fixture.video.id, link.token))
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('uploadToken is required');
  });
});

// ---------------------------------------------------------------------------
// POST /api/upload/audio
// ---------------------------------------------------------------------------
describe('POST /api/upload/audio', () => {
  function audioRequest(videoId: string) {
    return apiRequest('/api/upload/audio', { rawBody: uploadForm('audio', videoId) });
  }

  it('refuses an anonymous caller with a well-formed voice note and a real video id', async () => {
    const fixture = await seedMedia();
    signedOut();

    const response = await callRoute(uploadAudio, audioRequest(fixture.video.id));

    expect(response.status).toBe(403);
    expect(await readError(response)).toBe('Access denied');
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('refuses a signed-in stranger who owns a workspace of their own', async () => {
    const fixture = await seedMedia();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(uploadAudio, audioRequest(fixture.video.id));

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('stores the voice note for the project owner and returns a proxy url', async () => {
    const fixture = await seedMedia();
    signedInAs(fixture.owner);

    const response = await callRoute(uploadAudio, audioRequest(fixture.video.id));

    expect(response.status).toBe(201);
    const { url } = await readData<{ url: string }>(response);
    expect(url).toMatch(/^\/api\/upload\/audio\/[0-9a-f-]{36}\.webm$/);
    expect(sentKey()).toMatch(/^voice\/[0-9a-f-]{36}\.webm$/);
  });

  it('lets a workspace COMMENTATOR attach a voice note', async () => {
    const fixture = await seedMedia();
    const commentator = await createUser();
    await addWorkspaceMember({
      workspaceId: fixture.workspace.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(uploadAudio, audioRequest(fixture.video.id));

    expect(response.status).toBe(201);
  });

  it('refuses the owner once their own billing access has lapsed', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedMedia({ ownerUser: expiredOwner });
    signedInAs(expiredOwner);

    const response = await callRoute(uploadAudio, audioRequest(fixture.video.id));

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  // Cross-tenant identifier substitution. The caller is a perfectly legitimate
  // user of their own project and swaps in a video id from another workspace.
  it('refuses a video id belonging to another workspace', async () => {
    const theirs = await seedMedia();
    const mine = await seedMedia();
    signedInAs(mine.owner);

    const response = await callRoute(uploadAudio, audioRequest(theirs.video.id));

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('lets the same caller upload against their own video', async () => {
    await seedMedia();
    const mine = await seedMedia();
    signedInAs(mine.owner);

    const response = await callRoute(uploadAudio, audioRequest(mine.video.id));

    expect(response.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// GET /api/upload/image/[filename]
// ---------------------------------------------------------------------------
// The read half. There is no project or video id in the URL: the route works
// backwards from the filename to whichever comment, asset or thumbnail
// references it, and authorizes against that project. So the filename alone
// decides which tenant gets checked, and a caller who knows one from another
// workspace is the case that matters.
describe('GET /api/upload/image/[filename]', () => {
  function serve(filename: string, init: { cookies?: Record<string, string> } = {}) {
    return callRoute(serveImage, apiRequest(`/api/upload/image/${filename}`, init), { filename });
  }

  it('refuses an anonymous caller on a private project', async () => {
    const fixture = await seedMedia();
    signedOut();

    const response = await serve(fixture.imageFilename);

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  // The positive control for the case above: same anonymous caller, same
  // filename, only the project's visibility changed. A PUBLIC project is meant
  // to render for a passer-by, annotations included.
  it('serves an anonymous caller the same image once the project is PUBLIC', async () => {
    const fixture = await seedMedia({ visibility: 'PUBLIC' });
    signedOut();

    const response = await serve(fixture.imageFilename);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(STORED_BYTES);
    expect(sentKey()).toBe(`images/${fixture.imageFilename}`);
  });

  it('refuses a signed-in stranger', async () => {
    const fixture = await seedMedia();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await serve(fixture.imageFilename);

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('serves the project owner', async () => {
    const fixture = await seedMedia();
    signedInAs(fixture.owner);

    const response = await serve(fixture.imageFilename);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('serves a later comment image without an asset while enforcing video access', async () => {
    const fixture = await seedMedia();
    const first = uniqueFilename('png');
    const second = uniqueFilename('webp');
    await createComment({
      versionId: fixture.version.id,
      authorId: fixture.owner.id,
      imageUrls: [`/api/upload/image/${first}`, `/api/upload/image/${second}`],
    });
    signedOut();
    expect((await serve(second)).status).toBe(403);
    signedInAs(await createUser());
    expect((await serve(second)).status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
    signedInAs(fixture.owner);
    const response = await serve(second);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(STORED_BYTES);
    expect(sentKey()).toBe(`images/${second}`);
  });

  // The sandboxing headers are the reason a stored .png that is really an HTML
  // document cannot run in the app's origin.
  it('serves the image with nosniff and a sandboxing content security policy', async () => {
    const fixture = await seedMedia();
    signedInAs(fixture.owner);

    const response = await serve(fixture.imageFilename);

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('serves a project COMMENTATOR', async () => {
    const fixture = await seedMedia();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await serve(fixture.imageFilename);

    expect(response.status).toBe(200);
  });

  it('serves a guest holding a VIEW share link for the video the comment hangs off', async () => {
    const fixture = await seedMedia();
    const link = await createShareLink({
      projectId: fixture.project.id,
      videoId: fixture.video.id,
      permission: 'VIEW',
      allowGuests: true,
    });
    signedOut();

    const response = await serve(fixture.imageFilename, {
      cookies: shareCookie(fixture.video.id, link.token),
    });

    expect(response.status).toBe(200);
  });

  // A share-link session for one video must not unlock media belonging to
  // another, even when the guest holds a genuine signed cookie.
  it('refuses a guest whose share link is for a different video', async () => {
    const theirs = await seedMedia();
    const mine = await seedMedia();
    const link = await createShareLink({
      projectId: mine.project.id,
      videoId: mine.video.id,
      permission: 'VIEW',
      allowGuests: true,
    });
    signedOut();

    const response = await serve(theirs.imageFilename, {
      cookies: shareCookie(mine.video.id, link.token),
    });

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  // 400 rather than 403, and reached before any database work. Its value here is
  // as a discriminator: it is proof that the 403s above are the authorization
  // check answering and not a rejected request shape.
  it('rejects a filename that is not a uuid before it looks anything up', async () => {
    await seedMedia();
    signedOut();

    const response = await serve('..%2Fsecrets.png');

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe('Invalid filename');
  });

  it('rejects a uuid filename carrying a traversal segment', async () => {
    const fixture = await seedMedia();
    signedInAs(fixture.owner);

    const response = await serve(`${fixture.imageFilename}/../../videos/secret.mp4`);

    expect(response.status).toBe(400);
    expect(r2Send).not.toHaveBeenCalled();
  });

  // An object nobody references is refused rather than served, so guessing a
  // valid-looking uuid buys nothing.
  it('refuses a well-formed filename that no row references', async () => {
    const fixture = await seedMedia();
    signedInAs(fixture.owner);

    const response = await serve(uniqueFilename('png'));

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  // When one filename is referenced from two different videos the route cannot
  // tell which project should authorize it, and refuses rather than picking one.
  // Pinned because "pick the first" would be the natural regression and it would
  // hand a caller access through whichever project they happen to be in.
  it('refuses an image referenced by two videos even for the owner of both', async () => {
    const fixture = await seedMedia();
    const secondVideo = await createVideo({ projectId: fixture.project.id, title: 'Second' });
    await createVideoAsset({
      videoId: secondVideo.id,
      billedUserId: fixture.owner.id,
      sourceUrl: `/api/upload/image/${fixture.imageFilename}`,
    });
    signedInAs(fixture.owner);

    const response = await serve(fixture.imageFilename);

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('refuses the owner once their own billing access has lapsed', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedMedia({ ownerUser: expiredOwner });
    signedInAs(expiredOwner);

    const response = await serve(fixture.imageFilename);

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/upload/audio/[filename]
// ---------------------------------------------------------------------------
describe('GET /api/upload/audio/[filename]', () => {
  function serve(filename: string, init: { cookies?: Record<string, string> } = {}) {
    return callRoute(serveAudio, apiRequest(`/api/upload/audio/${filename}`, init), { filename });
  }

  it('refuses an anonymous caller on a private project', async () => {
    const fixture = await seedMedia();
    signedOut();

    const response = await serve(fixture.audioFilename);

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('serves an anonymous caller the same voice note once the project is PUBLIC', async () => {
    const fixture = await seedMedia({ visibility: 'PUBLIC' });
    signedOut();

    const response = await serve(fixture.audioFilename);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(STORED_BYTES);
    expect(sentKey()).toBe(`voice/${fixture.audioFilename}`);
  });

  it('refuses a signed-in stranger', async () => {
    const fixture = await seedMedia();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await serve(fixture.audioFilename);

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('serves the project owner with the content type its extension implies', async () => {
    const fixture = await seedMedia();
    signedInAs(fixture.owner);

    const response = await serve(fixture.audioFilename);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/webm');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('serves a workspace COMMENTATOR', async () => {
    const fixture = await seedMedia();
    const commentator = await createUser();
    await addWorkspaceMember({
      workspaceId: fixture.workspace.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await serve(fixture.audioFilename);

    expect(response.status).toBe(200);
  });

  it('serves a guest holding a VIEW share link', async () => {
    const fixture = await seedMedia();
    const link = await createShareLink({
      projectId: fixture.project.id,
      videoId: fixture.video.id,
      permission: 'VIEW',
      allowGuests: true,
    });
    signedOut();

    const response = await serve(fixture.audioFilename, {
      cookies: shareCookie(fixture.video.id, link.token),
    });

    expect(response.status).toBe(200);
  });

  it('rejects a filename that is not a uuid', async () => {
    await seedMedia();
    signedOut();

    const response = await serve('recording.webm');

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe('Invalid filename');
  });

  it('refuses a well-formed filename that no row references', async () => {
    const fixture = await seedMedia();
    signedInAs(fixture.owner);

    const response = await serve(uniqueFilename('webm'));

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('refuses a voice note from another workspace to a caller with a project of their own', async () => {
    const theirs = await seedMedia();
    const mine = await seedMedia();
    signedInAs(mine.owner);

    const response = await serve(theirs.audioFilename);

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('serves the same caller their own voice note', async () => {
    await seedMedia();
    const mine = await seedMedia();
    signedInAs(mine.owner);

    const response = await serve(mine.audioFilename);

    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/upload/video/[filename]
// ---------------------------------------------------------------------------
// The one that matters most: this streams the source master, and it is the route
// a <video> element hits for every direct upload in the product.
describe('GET /api/upload/video/[filename]', () => {
  function serve(
    filename: string,
    init: { cookies?: Record<string, string>; headers?: Record<string, string> } = {}
  ) {
    return callRoute(serveVideo, apiRequest(`/api/upload/video/${filename}`, init), { filename });
  }

  it('refuses an anonymous caller on a private project', async () => {
    const fixture = await seedMedia();
    signedOut();

    const response = await serve(fixture.videoFilename);

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('streams the master to an anonymous caller once the project is PUBLIC', async () => {
    const fixture = await seedMedia({ visibility: 'PUBLIC' });
    signedOut();

    const response = await serve(fixture.videoFilename);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(STORED_BYTES);
    expect(sentKey()).toBe(`videos/${fixture.videoFilename}`);
  });

  it('refuses a signed-in stranger', async () => {
    const fixture = await seedMedia();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await serve(fixture.videoFilename);

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('streams the master to the project owner', async () => {
    const fixture = await seedMedia();
    signedInAs(fixture.owner);

    const response = await serve(fixture.videoFilename);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600');
  });

  // Seeking is the reason this route exists rather than a redirect to a signed
  // URL, so the range path has to survive authorization intact.
  it('answers a range request from the owner with 206 and a content range', async () => {
    const fixture = await seedMedia();
    signedInAs(fixture.owner);

    const response = await serve(fixture.videoFilename, { headers: { range: 'bytes=0-4' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-4/${STORED_BYTES.length}`);
  });

  it('refuses a range request from a signed-in stranger rather than serving a slice', async () => {
    const fixture = await seedMedia();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await serve(fixture.videoFilename, { headers: { range: 'bytes=0-4' } });

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('serves a project COMMENTATOR', async () => {
    const fixture = await seedMedia();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await serve(fixture.videoFilename);

    expect(response.status).toBe(200);
  });

  it('serves a guest holding a VIEW share link', async () => {
    const fixture = await seedMedia();
    const link = await createShareLink({
      projectId: fixture.project.id,
      videoId: fixture.video.id,
      permission: 'VIEW',
      allowGuests: true,
    });
    signedOut();

    const response = await serve(fixture.videoFilename, {
      cookies: shareCookie(fixture.video.id, link.token),
    });

    expect(response.status).toBe(200);
  });

  it('rejects a filename that is not a uuid', async () => {
    await seedMedia();
    signedOut();

    const response = await serve('master.mp4');

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe('Invalid filename');
  });

  it('refuses a well-formed filename that no version or asset references', async () => {
    const fixture = await seedMedia();
    signedInAs(fixture.owner);

    const response = await serve(uniqueFilename('mp4'));

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  // Straight identifier substitution against the route with the least context in
  // its URL. The caller has a real project and a real session; only the filename
  // is somebody else's.
  it('refuses a master belonging to another workspace', async () => {
    const theirs = await seedMedia();
    const mine = await seedMedia();
    signedInAs(mine.owner);

    const response = await serve(theirs.videoFilename);

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('serves the same caller their own master', async () => {
    await seedMedia();
    const mine = await seedMedia();
    signedInAs(mine.owner);

    const response = await serve(mine.videoFilename);

    expect(response.status).toBe(200);
  });

  it('refuses the owner once their own billing access has lapsed', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedMedia({ ownerUser: expiredOwner });
    signedInAs(expiredOwner);

    const response = await serve(fixture.videoFilename);

    expect(response.status).toBe(403);
    expect(r2Send).not.toHaveBeenCalled();
  });
});
