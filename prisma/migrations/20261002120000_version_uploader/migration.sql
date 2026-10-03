-- Who uploaded each version. Rows created before this column existed stay NULL:
-- the information was never recorded, so there is nothing to backfill from.
ALTER TABLE "video_versions" ADD COLUMN "uploaded_by_id" TEXT;

CREATE INDEX "video_versions_uploaded_by_id_idx" ON "video_versions"("uploaded_by_id");

ALTER TABLE "video_versions" ADD CONSTRAINT "video_versions_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The acting user on an analytics event, beside the account it is counted against.
ALTER TABLE "analytics_events" ADD COLUMN "actor_id" TEXT;

CREATE INDEX "analytics_events_actor_id_idx" ON "analytics_events"("actor_id");

ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
