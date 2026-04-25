interface ExportAuthor {
  name: string | null;
}

interface ExportTag {
  name: string;
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
  isResolved: boolean;
  hasVoiceNote: boolean;
  voiceDuration: number | null;
  hasImageAttachment: boolean;
  hasAnnotation: boolean;
  createdAtIso: string;
}

function csvCell(value: string | number | boolean | null): string {
  const raw = value === null ? '' : String(value);
  const neutralized = /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

function formatTimestamp(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function toPdfSafeAscii(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '?');
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrapLine(value: string, maxChars: number): string[] {
  const text = value.trim();
  if (!text) return [''];

  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }

    if (current) lines.push(current);

    if (word.length <= maxChars) {
      current = word;
      continue;
    }

    let chunk = word;
    while (chunk.length > maxChars) {
      lines.push(chunk.slice(0, maxChars));
      chunk = chunk.slice(maxChars);
    }
    current = chunk;
  }

  if (current) lines.push(current);
  return lines;
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

export function buildCommentsCsv(
  rows: ExportCommentRow[],
  meta: { videoTitle: string; versionNumber: number; versionLabel: string | null }
): string {
  const header = [
    'video_title',
    'version_number',
    'version_label',
    'comment_id',
    'parent_comment_id',
    'thread_level',
    'author_name',
    'author_type',
    'timestamp_seconds',
    'timestamp_hhmmss',
    'timestamp_end_seconds',
    'is_resolved',
    'tag',
    'content',
    'has_voice_note',
    'voice_duration_seconds',
    'has_image_attachment',
    'has_annotation',
    'created_at_iso',
  ];

  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(
      [
        meta.videoTitle,
        meta.versionNumber,
        meta.versionLabel || '',
        row.commentId,
        row.parentCommentId,
        row.level,
        row.authorName,
        row.authorType,
        row.timestamp.toFixed(3),
        formatTimestamp(row.timestamp),
        row.timestampEnd === null ? '' : row.timestampEnd.toFixed(3),
        row.isResolved,
        row.tag,
        row.content,
        row.hasVoiceNote,
        row.voiceDuration === null ? '' : row.voiceDuration.toFixed(3),
        row.hasImageAttachment,
        row.hasAnnotation,
        row.createdAtIso,
      ]
        .map(csvCell)
        .join(',')
    );
  }

  return lines.join('\n');
}

export function buildCommentsPdf(
  rows: ExportCommentRow[],
  meta: { videoTitle: string; versionNumber: number; versionLabel: string | null }
): Buffer {
  const lines: string[] = [];
  const versionTitle = meta.versionLabel
    ? `v${meta.versionNumber} (${meta.versionLabel})`
    : `v${meta.versionNumber}`;

  lines.push(`OpenFrame Comments Export`);
  lines.push(`Video: ${meta.videoTitle}`);
  lines.push(`Version: ${versionTitle}`);
  lines.push(`Generated At: ${new Date().toISOString()}`);
  lines.push(`Total Entries: ${rows.length}`);
  lines.push('');

  rows.forEach((row, index) => {
    const prefix = row.level === 1 ? '  Reply' : 'Comment';
    const base = `${index + 1}. ${prefix} ${formatTimestamp(row.timestamp)} by ${row.authorName}`;
    const details = [
      `resolved=${row.isResolved ? 'yes' : 'no'}`,
      `voice=${row.hasVoiceNote ? 'yes' : 'no'}`,
      `image=${row.hasImageAttachment ? 'yes' : 'no'}`,
      `annotation=${row.hasAnnotation ? 'yes' : 'no'}`,
      row.tag ? `tag=${row.tag}` : null,
    ]
      .filter((item): item is string => item !== null)
      .join(', ');

    lines.push(base);
    lines.push(`   ${details}`);
    if (row.content) {
      lines.push(...wrapLine(`   ${row.content}`, 96));
    }
    lines.push(`   created_at=${row.createdAtIso}`);
    lines.push('');
  });

  return buildSimplePdf(lines);
}

function buildSimplePdf(lines: string[]): Buffer {
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 40;
  const lineHeight = 14;
  const maxLinesPerPage = Math.floor((pageHeight - margin * 2) / lineHeight);

  const pages: string[][] = [];
  let currentPage: string[] = [];

  for (const line of lines) {
    if (currentPage.length >= maxLinesPerPage) {
      pages.push(currentPage);
      currentPage = [];
    }
    currentPage.push(line);
  }
  if (currentPage.length > 0) pages.push(currentPage);
  if (pages.length === 0) pages.push(['No comments']);

  const objects: string[] = [];
  const pageRefs: string[] = [];

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = '';
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  for (const pageLines of pages) {
    const contentLines = ['BT', '/F1 11 Tf'];
    pageLines.forEach((line, lineIndex) => {
      const y = pageHeight - margin - lineIndex * lineHeight;
      const safeLine = escapePdfText(toPdfSafeAscii(line));
      contentLines.push(`1 0 0 1 ${margin} ${y} Tm (${safeLine}) Tj`);
    });
    contentLines.push('ET');

    const stream = contentLines.join('\n');
    const contentObject = `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`;
    const contentObjNumber = objects.length + 1;
    objects.push(contentObject);

    const pageObjNumber = objects.length + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNumber} 0 R >>`
    );
    pageRefs.push(`${pageObjNumber} 0 R`);
  }

  objects[1] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];

  objects.forEach((obj, index) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    const objNum = index + 1;
    pdf += `${objNum} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${offsets[i].toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, 'utf8');
}
