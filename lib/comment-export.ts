interface ExportAuthor {
  name: string | null;
}

interface ExportTag {
  name: string;
  color?: string;
}

interface ExportComment {
  id: string;
  parentId: string | null;
  content: string | null;
  timestamp: number;
  timestampEnd: number | null;
  isResolved: boolean;
  voiceUrl: string | null;
  voiceDuration: number | null;
  imageUrl: string | null;
  annotationData: string | null;
  createdAt: Date;
  author: ExportAuthor | null;
  guestName: string | null;
  tag: ExportTag | null;
  replies: Omit<ExportComment, 'replies'>[];
}

export interface ExportCommentRow {
  commentId: string;
  parentCommentId: string | null;
  level: 0 | 1;
  authorName: string;
  authorType: 'user' | 'guest';
  content: string;
  timestamp: number;
  timestampEnd: number | null;
  tag: string;
  // Hex tag color; NLE exports turn it into a marker color. CSV/PDF ignore it.
  tagColor?: string | null;
  isResolved: boolean;
  hasVoiceNote: boolean;
  voiceDuration: number | null;
  hasImageAttachment: boolean;
  hasAnnotation: boolean;
  createdAtIso: string;
}

// A leading =, +, - or @ is what a spreadsheet reads as the start of a formula, so those
// cells get an apostrophe. A plain negative number is not a formula, and prefixing one
// stopped the spreadsheet reading a negative timestamp as a number at all.
const FORMULA_START = /^[\s]*[=+\-@]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

function csvCell(value: string | number | boolean | null): string {
  const raw = value === null ? '' : String(value);
  const needsPrefix = FORMULA_START.test(raw) && !PLAIN_NUMBER.test(raw);
  const neutralized = needsPrefix ? `'${raw}` : raw;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

export function formatTimestamp(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function sanitizeFileSegment(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return cleaned || 'comments';
}

export function buildExportFileBaseName(videoTitle: string, versionNumber: number): string {
  return `${sanitizeFileSegment(videoTitle)}-v${versionNumber}-comments`;
}

export function flattenCommentsForExport(comments: ExportComment[]): ExportCommentRow[] {
  const rows: ExportCommentRow[] = [];

  for (const comment of comments) {
    rows.push({
      commentId: comment.id,
      parentCommentId: null,
      level: 0,
      authorName: comment.author?.name || comment.guestName || 'Anonymous',
      authorType: comment.author ? 'user' : 'guest',
      content: comment.content || '',
      timestamp: comment.timestamp,
      timestampEnd: comment.timestampEnd,
      tag: comment.tag?.name || '',
      tagColor: comment.tag?.color ?? null,
      isResolved: comment.isResolved,
      hasVoiceNote: !!comment.voiceUrl,
      voiceDuration: comment.voiceDuration,
      hasImageAttachment: !!comment.imageUrl,
      hasAnnotation: !!comment.annotationData,
      createdAtIso: comment.createdAt.toISOString(),
    });

    for (const reply of comment.replies) {
      rows.push({
        commentId: reply.id,
        parentCommentId: comment.id,
        level: 1,
        authorName: reply.author?.name || reply.guestName || 'Anonymous',
        authorType: reply.author ? 'user' : 'guest',
        content: reply.content || '',
        timestamp: reply.timestamp,
        timestampEnd: reply.timestampEnd,
        tag: reply.tag?.name || '',
        tagColor: reply.tag?.color ?? null,
        isResolved: reply.isResolved,
        hasVoiceNote: !!reply.voiceUrl,
        voiceDuration: reply.voiceDuration,
        hasImageAttachment: !!reply.imageUrl,
        hasAnnotation: !!reply.annotationData,
        createdAtIso: reply.createdAt.toISOString(),
      });
    }
  }

  return rows;
}

export interface ExportMeta {
  videoTitle: string;
  versionNumber: number;
  versionLabel: string | null;
  mediaType?: 'VIDEO' | 'IMAGE';
}

// Always h:mm:ss, so a spreadsheet reads every cell as the same kind of duration and
// sorts a video longer than an hour correctly ("1:23" alone would mean 1 h 23 min).
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function formatCommentTime(row: ExportCommentRow): string {
  return row.timestampEnd === null
    ? formatClock(row.timestamp)
    : `${formatClock(row.timestamp)} - ${formatClock(row.timestampEnd)}`;
}

export function describeAttachments(row: ExportCommentRow): string {
  return [
    row.hasVoiceNote &&
      (row.voiceDuration === null
        ? 'Voice note'
        : `Voice note (${formatTimestamp(row.voiceDuration)})`),
    row.hasImageAttachment && 'Image',
    row.hasAnnotation && 'Drawing',
  ]
    .filter(Boolean)
    .join(', ');
}

// "2026-10-02T14:34:47.877Z" -> "2026-10-02 14:34 UTC"
export function formatCreatedAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// The thread a row belongs to, repeated on its replies. A dotted "1.10" would be read
// as the number 1.1 by a spreadsheet, so replies are told apart by "Reply to" instead.
export function threadNumbers(rows: ExportCommentRow[]): string[] {
  let thread = 0;
  return rows.map((row) => String(row.level === 0 ? ++thread : Math.max(thread, 1)));
}

// A spreadsheet is the audience: readable headers, one row per comment, and a byte
// order mark so Excel opens UTF-8 (Turkish letters, emoji) instead of guessing a
// legacy code page. IDs stay in the last two columns for scripts.
export function buildCommentsCsv(rows: ExportCommentRow[], meta: ExportMeta): string {
  const isImage = meta.mediaType === 'IMAGE';
  const authors = new Map(rows.map((row) => [row.commentId, row.authorName]));
  // Only a thread's root can be resolved in the app, so a reply shows its thread's status.
  const resolved = new Map(rows.map((row) => [row.commentId, row.isResolved]));
  const numbers = threadNumbers(rows);
  const header = [
    '#',
    ...(isImage ? [] : ['Time']),
    'Author',
    'Comment',
    'Reply to',
    'Tag',
    'Status',
    'Attachments',
    'Created',
    'Comment ID',
    'Parent comment ID',
  ];
  const lines = [header.map(csvCell).join(',')];
  rows.forEach((row, index) => {
    lines.push(
      [
        numbers[index],
        ...(isImage ? [] : [formatCommentTime(row)]),
        row.authorName,
        row.content,
        row.parentCommentId === null ? '' : (authors.get(row.parentCommentId) ?? ''),
        row.tag,
        (
          row.parentCommentId === null
            ? row.isResolved
            : (resolved.get(row.parentCommentId) ?? row.isResolved)
        )
          ? 'Resolved'
          : 'Open',
        describeAttachments(row),
        formatCreatedAt(row.createdAtIso),
        row.commentId,
        row.parentCommentId,
      ]
        .map(csvCell)
        .join(',')
    );
  });
  return `﻿${lines.join('\r\n')}\r\n`;
}
