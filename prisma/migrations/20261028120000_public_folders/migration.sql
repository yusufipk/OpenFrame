-- A folder anyone with its URL can open. Only folders use it; the folders API refuses it for videos.
ALTER TYPE "ContentAccessMode" ADD VALUE 'PUBLIC';
