-- Google Drive imports. One row per picked file, written before any bytes move,
-- so the uploader can watch the copy and a failed one can be told apart from a
-- slow one. The video, version or attachment it produces is written only once the bytes land.
CREATE TYPE "DriveImportBackend" AS ENUM ('BUNNY', 'S3');

CREATE TYPE "DriveImportStatus" AS ENUM ('TRANSFERRING', 'FINALIZING', 'DONE', 'FAILED');

CREATE TABLE "drive_imports" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "folderId" TEXT,
    "targetVideoId" TEXT,
    "assetVideoId" TEXT,
    "driveFileId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "billedUserId" TEXT NOT NULL,
    "reservationId" TEXT,
    "backend" "DriveImportBackend" NOT NULL,
    "status" "DriveImportStatus" NOT NULL DEFAULT 'TRANSFERRING',
    "bunnyVideoId" TEXT,
    "objectKey" TEXT,
    "multipartUploadId" TEXT,
    "thumbnailObjectKey" TEXT,
    "transferredAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdVideoId" TEXT,
    "createdVersionId" TEXT,
    "createdAssetId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drive_imports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "drive_imports_projectId_userId_status_idx" ON "drive_imports"("projectId", "userId", "status");
CREATE INDEX "drive_imports_status_idx" ON "drive_imports"("status");
CREATE INDEX "drive_imports_bunnyVideoId_idx" ON "drive_imports"("bunnyVideoId");

ALTER TABLE "drive_imports" ADD CONSTRAINT "drive_imports_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "drive_imports" ADD CONSTRAINT "drive_imports_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
