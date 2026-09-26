ALTER TABLE "attachment_comments" ADD COLUMN "annotationData" TEXT;

ALTER TABLE "attachment_comments" DROP CONSTRAINT "attachment_comments_nonempty_content_check";
ALTER TABLE "attachment_comments" ADD CONSTRAINT "attachment_comments_nonempty_content_check"
  CHECK (
    length("content") <= 10000
    AND (length(btrim("content")) > 0 OR ("annotationData" IS NOT NULL AND "annotationData" <> '[]'))
  );
