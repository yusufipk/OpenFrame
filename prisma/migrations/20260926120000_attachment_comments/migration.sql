CREATE TYPE "AttachmentCommentTargetType" AS ENUM ('ASSET', 'COMMENT_IMAGE', 'COMMENT_AUDIO');

CREATE TABLE "attachment_comments" (
    "id" TEXT NOT NULL,
    "targetType" "AttachmentCommentTargetType" NOT NULL,
    "assetId" TEXT,
    "sourceCommentId" TEXT,
    "sourceUrl" TEXT,
    "content" TEXT NOT NULL,
    "authorId" TEXT,
    "guestName" TEXT,
    "guestIdentityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attachment_comments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attachment_comments_exactly_one_target_check" CHECK (
      ("targetType" = 'ASSET' AND "assetId" IS NOT NULL AND "sourceCommentId" IS NULL AND "sourceUrl" IS NULL)
      OR ("targetType" = 'COMMENT_IMAGE' AND "assetId" IS NULL AND "sourceCommentId" IS NOT NULL AND "sourceUrl" IS NOT NULL)
      OR ("targetType" = 'COMMENT_AUDIO' AND "assetId" IS NULL AND "sourceCommentId" IS NOT NULL AND "sourceUrl" IS NULL)
    ),
    CONSTRAINT "attachment_comments_nonempty_content_check" CHECK (length(btrim("content")) > 0 AND length("content") <= 10000)
);

CREATE INDEX "attachment_comments_assetId_createdAt_id_idx" ON "attachment_comments"("assetId", "createdAt", "id");
CREATE INDEX "attachment_comments_source_target_idx" ON "attachment_comments"("sourceCommentId", "targetType", "sourceUrl", "createdAt", "id");

ALTER TABLE "attachment_comments" ADD CONSTRAINT "attachment_comments_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "video_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attachment_comments" ADD CONSTRAINT "attachment_comments_sourceCommentId_fkey" FOREIGN KEY ("sourceCommentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attachment_comments" ADD CONSTRAINT "attachment_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
