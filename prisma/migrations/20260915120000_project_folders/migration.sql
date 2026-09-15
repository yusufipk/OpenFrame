CREATE TYPE "ContentAccessMode" AS ENUM ('INHERIT', 'RESTRICTED');
ALTER TYPE "InvitationScope" ADD VALUE 'FOLDER';
ALTER TYPE "InvitationScope" ADD VALUE 'VIDEO';
CREATE TABLE "project_folders" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "parentId" TEXT,
  "name" VARCHAR(100) NOT NULL,
  "accessMode" "ContentAccessMode" NOT NULL DEFAULT 'INHERIT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("id", "projectId"),
  FOREIGN KEY ("parentId", "projectId") REFERENCES "project_folders"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX "project_folders_projectId_parentId_idx" ON "project_folders"("projectId", "parentId");
ALTER TABLE "videos" ADD COLUMN "folderId" TEXT, ADD COLUMN "accessMode" "ContentAccessMode" NOT NULL DEFAULT 'INHERIT';
ALTER TABLE "videos" ADD CONSTRAINT "videos_folderId_projectId_fkey" FOREIGN KEY ("folderId", "projectId") REFERENCES "project_folders"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE TABLE "project_folder_members" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "folderId" TEXT NOT NULL REFERENCES "project_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "role" "ProjectMemberRole" NOT NULL DEFAULT 'COMMENTATOR',
  UNIQUE ("folderId", "userId")
);
CREATE INDEX "project_folder_members_userId_idx" ON "project_folder_members"("userId");
CREATE TABLE "video_members" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "videoId" TEXT NOT NULL REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "role" "ProjectMemberRole" NOT NULL DEFAULT 'COMMENTATOR',
  UNIQUE ("videoId", "userId")
);
CREATE INDEX "video_members_userId_idx" ON "video_members"("userId");
ALTER TABLE "invitations" ADD COLUMN "folderId" TEXT REFERENCES "project_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE, ADD COLUMN "videoId" TEXT REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Retain the selected id even if the destination is deleted. Finalization must reject it, never fall back to root.
ALTER TABLE "video_upload_sessions" ADD COLUMN "folderId" TEXT, ADD COLUMN "targetVideoId" TEXT;

-- Custom invariants, also installed by the test database bootstrap.
CREATE OR REPLACE FUNCTION validate_project_folder_tree() RETURNS trigger AS $fn$
DECLARE total_count integer; reachable_count integer; deepest integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."projectId", 715));
  SELECT count(*) INTO total_count FROM project_folders WHERE "projectId" = NEW."projectId";
  WITH RECURSIVE tree AS (
    SELECT id, 1 AS depth FROM project_folders WHERE "projectId" = NEW."projectId" AND "parentId" IS NULL
    UNION ALL
    SELECT f.id, t.depth + 1 FROM project_folders f JOIN tree t ON f."parentId" = t.id WHERE t.depth < 11
  ) SELECT count(*), max(depth) INTO reachable_count, deepest FROM tree;
  IF reachable_count <> total_count OR deepest > 10 THEN
    RAISE EXCEPTION 'Folder tree must be acyclic and at most 10 levels deep' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER project_folder_tree_guard AFTER INSERT OR UPDATE OF "parentId", "projectId" ON project_folders FOR EACH ROW EXECUTE FUNCTION validate_project_folder_tree();
