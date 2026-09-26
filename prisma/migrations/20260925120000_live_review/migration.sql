CREATE TABLE "live_review_sessions" (
  "id" TEXT NOT NULL,
  "videoId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "managerUserId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "presenterId" TEXT,
  "controlEpoch" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "playing" BOOLEAN NOT NULL DEFAULT false,
  "rate" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "playbackAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  CONSTRAINT "live_review_sessions_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "live_review_participants" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "userId" TEXT,
  "guestIdentityId" TEXT,
  "shareToken" TEXT,
  "name" TEXT NOT NULL,
  "isManager" BOOLEAN NOT NULL DEFAULT false,
  "canComment" BOOLEAN NOT NULL DEFAULT false,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "live_review_participants_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "live_review_tickets" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "participantId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "live_review_tickets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "live_review_active_video_unique" ON "live_review_sessions" ("videoId") WHERE "status" = 'active';
CREATE INDEX "live_review_sessions_videoId_status_idx" ON "live_review_sessions" ("videoId", "status");
CREATE INDEX "live_review_sessions_lastActiveAt_idx" ON "live_review_sessions" ("lastActiveAt");
CREATE INDEX "live_review_participants_sessionId_lastSeenAt_idx" ON "live_review_participants" ("sessionId", "lastSeenAt");
CREATE INDEX "live_review_participants_userId_idx" ON "live_review_participants" ("userId");
CREATE UNIQUE INDEX "live_review_tickets_tokenHash_key" ON "live_review_tickets" ("tokenHash");
CREATE INDEX "live_review_tickets_expiresAt_idx" ON "live_review_tickets" ("expiresAt");
ALTER TABLE "live_review_sessions" ADD CONSTRAINT "live_review_sessions_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_review_sessions" ADD CONSTRAINT "live_review_sessions_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "video_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_review_sessions" ADD CONSTRAINT "live_review_sessions_managerUserId_fkey" FOREIGN KEY ("managerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_review_participants" ADD CONSTRAINT "live_review_participants_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "live_review_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_review_participants" ADD CONSTRAINT "live_review_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_review_tickets" ADD CONSTRAINT "live_review_tickets_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "live_review_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_review_tickets" ADD CONSTRAINT "live_review_tickets_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "live_review_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
