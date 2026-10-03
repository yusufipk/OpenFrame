export interface DefaultCommentTag {
  name: string;
  color: string;
  position: number;
}

export const DEFAULT_COMMENT_TAGS: DefaultCommentTag[] = [
  { name: 'Feedback', color: '#3B82F6', position: 0 },
  { name: 'Technical', color: '#EF4444', position: 1 },
  { name: 'Creative', color: '#8B5CF6', position: 2 },
  { name: 'Approved', color: '#22C55E', position: 3 },
  { name: 'Urgent', color: '#F59E0B', position: 4 },
];

// Timeline marker colors for comments without a tag. NLE exports reuse them so a
// marker keeps the color it has in the OpenFrame player.
export const UNTAGGED_COMMENT_COLOR = '#22D3EE';
export const RESOLVED_COMMENT_COLOR = '#22C55E';

export function commentMarkerColor(tagColor: string | null | undefined, isResolved: boolean) {
  return tagColor || (isResolved ? RESOLVED_COMMENT_COLOR : UNTAGGED_COMMENT_COLOR);
}
