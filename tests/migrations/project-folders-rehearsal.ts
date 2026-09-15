// Run only against a fresh disposable database initialized with the pre-folder schema.
// This exercises the exact migration, not the API suite's current-schema bootstrap.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { legacyMedia, legacyFilename } from './media-fixture';
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { checkVideoAccess, visibleVideoWhere } from '@/lib/content-access';
import { validateShareLinkAccess } from '@/lib/share-links';

const url = process.env.DATABASE_URL;
assert(
  url &&
    new URL(url).pathname === '/openframe_test_legacyproof' &&
    ['127.0.0.1', 'localhost'].includes(new URL(url).hostname),
  'Use the dedicated legacy-proof test database'
);
const baselineSchemaSha256 = createHash('sha256')
  .update(readFileSync('/tmp/legacy-schema.prisma'))
  .digest('hex');
assert.equal(
  baselineSchemaSha256,
  'e7ac1124e0dd4d94464c668404d3868cdc830cdf49a48c424cab8dc4a9200577',
  'Baseline schema must match commit 2e4514e'
);
const migrationSql = readFileSync(
  'prisma/migrations/20260915120000_project_folders/migration.sql',
  'utf8'
);
const pool = new Pool({ connectionString: url });
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const now = new Date();
const future = new Date(Date.now() + 7 * 86400000);
async function insert(table: string, data: Record<string, unknown>) {
  const entries = Object.entries(data);
  await pool.query(
    `INSERT INTO ${quote(table)} (${entries.map(([key]) => quote(key)).join(',')}) VALUES (${entries.map((_, i) => `$${i + 1}`).join(',')})`,
    entries.map(([, value]) => value)
  );
}
try {
  assert.equal(
    (await pool.query('SELECT count(*)::int AS count FROM users')).rows[0].count,
    0,
    'Database must be empty'
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND table_name='videos' AND column_name='folderId'"
      )
    ).rows[0].count,
    0,
    'Must start with the old schema'
  );
  const storage = new S3Client({
    endpoint: 'http://127.0.0.1:59000',
    region: 'auto',
    forcePathStyle: true,
    credentials: { accessKeyId: 'openframe', secretAccessKey: 'openframe-test-secret' },
  });
  await Promise.all(
    [11, 12, 21, 22, 31, 32].map((id) =>
      storage.send(
        new PutObjectCommand({
          Bucket: 'openframe-test',
          Key: `videos/${legacyFilename(id)}`,
          Body: legacyMedia(id),
          ContentType: 'video/mp4',
        })
      )
    )
  );
  storage.destroy();
  const password = await bcrypt.hash('legacy-test-password', 4);
  for (const id of ['owner', 'member', 'workspace-member', 'outsider'])
    await insert('users', {
      id: `legacy-${id}`,
      name: id,
      email: `legacy-${id}@example.test`,
      password,
      emailVerified: now,
      onboardingCompletedAt: now,
      trialEndsAt: future,
      updatedAt: now,
    });
  await insert('workspaces', {
    id: 'legacy-workspace',
    name: 'Legacy workspace',
    slug: 'legacy-workspace',
    ownerId: 'legacy-owner',
    updatedAt: now,
  });
  await insert('workspace_members', {
    id: 'legacy-wm',
    workspaceId: 'legacy-workspace',
    userId: 'legacy-workspace-member',
    role: 'COMMENTATOR',
  });
  for (const visibility of ['PRIVATE', 'INVITE', 'PUBLIC']) {
    const suffix = visibility.toLowerCase();
    const projectId = `legacy-${suffix}`;
    const videoId = `legacy-video-${suffix}`;
    await insert('projects', {
      id: projectId,
      name: `Legacy ${suffix}`,
      slug: projectId,
      ownerId: 'legacy-owner',
      workspaceId: 'legacy-workspace',
      visibility,
      updatedAt: now,
    });
    await insert('project_members', {
      id: `legacy-pm-${suffix}`,
      projectId,
      userId: 'legacy-member',
      role: 'COMMENTATOR',
    });
    await insert('videos', {
      id: videoId,
      title: `Legacy cut ${suffix}`,
      projectId,
      position: 7,
      updatedAt: now,
    });
    for (const version of [1, 2]) {
      const number = (suffix === 'private' ? 10 : suffix === 'invite' ? 20 : 30) + version;
      const filename = legacyFilename(number);
      await insert('video_versions', {
        id: `${videoId}-v${version}`,
        videoParentId: videoId,
        versionNumber: version,
        versionLabel: `Cut ${version}`,
        providerId: 'r2',
        videoId: `/api/upload/video/${filename}`,
        originalUrl: `/api/upload/video/${filename}`,
        title: `Legacy cut ${suffix}`,
        duration: 2,
        size_bytes: legacyMedia(number).length,
        isActive: version === 2,
      });
    }
    await insert('comments', {
      id: `legacy-comment-${suffix}`,
      content: 'Existing review comment',
      timestamp: 1,
      authorId: 'legacy-member',
      versionId: `${videoId}-v2`,
      updatedAt: now,
    });
    await insert('share_links', {
      id: `legacy-link-${suffix}`,
      token: `legacy-token-${suffix}`,
      projectId,
      videoId,
      permission: 'COMMENT',
      allowDownloads: true,
      expiresAt: future,
    });
  }
  await insert('share_links', {
    id: 'legacy-password-link',
    token: 'legacy-password-token',
    projectId: 'legacy-private',
    videoId: 'legacy-video-private',
    permission: 'VIEW',
    passwordHash: await bcrypt.hash('legacy-share-password', 4),
    expiresAt: future,
  });
  await insert('share_links', {
    id: 'legacy-expired-link',
    token: 'legacy-expired-token',
    projectId: 'legacy-private',
    permission: 'VIEW',
    expiresAt: new Date(Date.now() - 86400000),
  });
  await insert('video_assets', {
    id: 'legacy-asset',
    videoId: 'legacy-video-private',
    kind: 'VIDEO',
    provider: 'R2_VIDEO',
    displayName: 'Original asset',
    sourceUrl: '/api/upload/video/11111111-1111-4111-8111-000000000011.mp4',
    billedUserId: 'legacy-owner',
    uploadedByUserId: 'legacy-owner',
    size_bytes: 128,
    updatedAt: now,
  });
  await insert('video_subtitles', {
    id: 'legacy-subtitle',
    versionId: 'legacy-video-private-v2',
    language: 'en',
    label: 'English',
    sourceUrl: '/api/upload/subtitle/11111111-1111-4111-8111-000000000001.vtt',
    billedUserId: 'legacy-owner',
    size_bytes: 50,
    updatedAt: now,
  });
  await insert('invitations', {
    id: 'legacy-invitation',
    token: 'legacy-invitation-token',
    email: 'pending@example.test',
    scope: 'PROJECT',
    role: 'COMMENTATOR',
    projectId: 'legacy-private',
    invitedById: 'legacy-owner',
    expiresAt: future,
    updatedAt: now,
  });
  await insert('upload_reservations', {
    id: 'legacy-reservation',
    billedUserId: 'legacy-owner',
    sizeBytes: 128,
    expiresAt: future,
    purpose: 'video',
  });
  await insert('video_upload_sessions', {
    id: 'legacy-upload',
    upload_jti: 'legacy-jti',
    userId: 'legacy-owner',
    projectId: 'legacy-private',
    billed_user_id: 'legacy-owner',
    object_key: 'videos/legacy-inflight.mp4',
    thumbnail_object_key: 'thumbnails/legacy.jpg',
    declared_size_bytes: 128,
    content_type: 'video/mp4',
    reservation_id: 'legacy-reservation',
    expires_at: future,
    updated_at: now,
  });
  await insert('watch_progress', {
    id: 'legacy-progress',
    userId: 'legacy-member',
    versionId: 'legacy-video-private-v2',
    progress: 1,
    duration: 2,
    percentage: 50,
    updatedAt: now,
  });
  const tables = (
    await pool.query(
      "SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS columns FROM information_schema.columns WHERE table_schema='public' GROUP BY table_name ORDER BY table_name"
    )
  ).rows as Array<{ table_name: string; columns: string[] }>;
  async function snapshot(table: (typeof tables)[number]) {
    return (
      await pool.query(
        `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM (SELECT ${table.columns.map(quote).join(',')} FROM ${quote(table.table_name)}) t`
      )
    ).rows[0].rows;
  }
  const before = await Promise.all(tables.map(snapshot));
  await pool.query(migrationSql);
  const after = await Promise.all(tables.map(snapshot));
  for (let i = 0; i < tables.length; i++)
    assert.deepEqual(after[i], before[i], `Old rows changed in ${tables[i].table_name}`);
  assert.equal(await db.video.count({ where: { folderId: null, accessMode: 'INHERIT' } }), 3);
  assert.equal(await db.videoVersion.count(), 6);
  for (const suffix of ['private', 'invite', 'public']) {
    const videoId = `legacy-video-${suffix}`;
    assert.equal((await checkVideoAccess(videoId, 'legacy-owner')).canEdit, true);
    for (const member of ['legacy-member', 'legacy-workspace-member']) {
      const access = await checkVideoAccess(videoId, member);
      assert.equal(access.hasAccess, true, `${member} retains access to ${suffix}`);
      assert.equal(access.canEdit, false, `${member} remains a commentator`);
      assert.equal(
        await db.video.count({
          where: {
            projectId: `legacy-${suffix}`,
            folderId: null,
            AND: visibleVideoWhere(member),
          },
        }),
        1
      );
    }
    assert.equal(
      (await checkVideoAccess(videoId, 'legacy-outsider')).hasAccess,
      suffix === 'public'
    );
    assert.equal((await checkVideoAccess(videoId)).hasAccess, suffix === 'public');
    assert.equal(
      (
        await validateShareLinkAccess({
          token: `legacy-token-${suffix}`,
          projectId: `legacy-${suffix}`,
          videoId,
          requiredPermission: 'COMMENT',
        })
      ).hasAccess,
      true
    );
    assert.equal(
      await db.video.count({
        where: {
          projectId: `legacy-${suffix}`,
          folderId: null,
          AND: visibleVideoWhere('legacy-member'),
        },
      }),
      1
    );
  }
  assert.equal(
    (
      await validateShareLinkAccess({
        token: 'legacy-password-token',
        projectId: 'legacy-private',
        videoId: 'legacy-video-private',
      })
    ).requiresPassword,
    true
  );
  assert.equal(
    (
      await validateShareLinkAccess({
        token: 'legacy-password-token',
        projectId: 'legacy-private',
        videoId: 'legacy-video-private',
        presentedPassword: 'legacy-share-password',
      })
    ).hasAccess,
    true
  );
  assert.equal(
    (await validateShareLinkAccess({ token: 'legacy-expired-token', projectId: 'legacy-private' }))
      .hasAccess,
    false
  );
  const result = {
    passed: true,
    baselineSchemaSha256,
    migrationSha256: createHash('sha256').update(migrationSql).digest('hex'),
    legacyTablesCompared: tables.length,
    populatedTables: tables.filter((_, i) => before[i].length > 0).map((t) => t.table_name),
    legacyRowsCompared: before.reduce((sum, rows) => sum + rows.length, 0),
    projects: 3,
    rootVideos: 3,
    versions: 6,
    accessAndShareChecks: 'passed',
  };
  writeFileSync('/tmp/openframe-legacy-proof.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
  await db.$disconnect();
}

process.exit(0);
