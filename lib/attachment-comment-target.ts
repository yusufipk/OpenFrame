export type AttachmentCommentTarget =
  | { type: 'asset'; id: string }
  | { type: 'comment-image'; id: string; url: string }
  | { type: 'comment-audio'; id: string };

export function attachmentCommentTargetKey(target: AttachmentCommentTarget): string {
  if (target.type === 'comment-image') return `comment-image:${target.id}:${target.url}`;
  return `${target.type}:${target.id}`;
}
