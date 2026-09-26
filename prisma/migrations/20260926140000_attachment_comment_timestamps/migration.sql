ALTER TABLE "attachment_comments" ADD COLUMN "timestamp" DOUBLE PRECISION;

ALTER TABLE "attachment_comments" ADD CONSTRAINT "attachment_comments_timestamp_range_check"
  CHECK ("timestamp" >= 0 AND "timestamp" <= 86400);
