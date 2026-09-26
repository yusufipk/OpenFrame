CREATE TYPE "MediaType" AS ENUM ('VIDEO', 'IMAGE');
ALTER TABLE "videos" ADD COLUMN "mediaType" "MediaType" NOT NULL DEFAULT 'VIDEO';
ALTER TABLE "video_versions" ADD COLUMN "thumbnail_size_bytes" BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "video_versions_r2_image_key_unique" ON "video_versions" ("videoId") WHERE "providerId" = 'r2-image';
