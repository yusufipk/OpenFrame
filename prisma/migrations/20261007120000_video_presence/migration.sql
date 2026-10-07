CREATE TABLE "video_presences" (
  "id" TEXT NOT NULL,
  "videoId" TEXT NOT NULL,
  "identityKey" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "userId" TEXT,
  "shareToken" TEXT,
  "sharePasswordHash" TEXT,
  "name" TEXT NOT NULL,
  "isPlaying" BOOLEAN NOT NULL DEFAULT false,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "video_presences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "video_presences_videoId_identityKey_clientId_key" ON "video_presences"("videoId", "identityKey", "clientId");
CREATE INDEX "video_presences_videoId_lastSeenAt_idx" ON "video_presences"("videoId", "lastSeenAt");
CREATE INDEX "video_presences_lastSeenAt_idx" ON "video_presences"("lastSeenAt");
ALTER TABLE "video_presences" ADD CONSTRAINT "video_presences_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
