import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { commentMarkerColor } from '@/lib/comment-tags';
import {
  describeAttachments,
  formatCreatedAt,
  formatTimestamp,
  type ExportCommentRow,
  type ExportMeta,
} from '@/lib/comment-export';

// Geist is the app's own type family and covers Turkish and the rest of Latin
// Extended. The runtime image ships node_modules and runs from the app root.
const FONT_DIR = path.join(process.cwd(), 'node_modules', 'geist', 'dist', 'fonts', 'geist-sans');
let fontFiles: Promise<[Buffer, Buffer]> | null = null;
function loadFontFiles() {
  fontFiles ??= Promise.all([
    readFile(path.join(FONT_DIR, 'Geist-Regular.ttf')),
    readFile(path.join(FONT_DIR, 'Geist-SemiBold.ttf')),
  ]).catch((error) => {
    fontFiles = null;
    throw error;
  });
  return fontFiles;
}

const PAGE = { width: 595.28, height: 841.89 }; // A4
const MARGIN = 48;
const TIME_COLUMN = 76;
const REPLY_INDENT = 16;
const FOOTER_SPACE = 28;
const INK = rgb(0.07, 0.09, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.9, 0.91, 0.92);
const RESOLVED = rgb(0.09, 0.64, 0.29);

function hexColor(hex: string): RGB {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return MUTED;
  return rgb(...([1, 2, 3].map((i) => parseInt(match[i], 16) / 255) as [number, number, number]));
}

// Keeps only what the embedded font can draw. Emoji have no glyph in Geist and would
// otherwise print as empty boxes; tabs and other controls become spaces.
export function pdfDrawableText(value: string, supported: Set<number>): string {
  return Array.from(value)
    .map((char) => {
      const code = char.codePointAt(0)!;
      if (code === 10) return '\n';
      if (code < 32 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
        return ' ';
      }
      return supported.has(code) ? char : '';
    })
    .join('')
    .replace(/[  ]{2,}/g, ' ');
}

// Greedy word wrap that measures real glyph widths. Explicit line breaks are kept;
// a word wider than the line is split by characters rather than overflowing.
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (value: string) => number
): string[] {
  const lines: string[] = [];
  const charWidths = new Map<string, number>();
  const charWidth = (char: string) => {
    let width = charWidths.get(char);
    if (width === undefined) charWidths.set(char, (width = measure(char)));
    return width;
  };
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let current = '';
    for (const word of paragraph.split(' ').filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = word;
      if (measure(word) <= maxWidth) continue;
      // One pass with cached per-character widths: a 10,000-character word must stay
      // linear, since every comment of a 5,000-comment export goes through here.
      current = '';
      let width = 0;
      for (const char of word) {
        const next = charWidth(char);
        if (current && width + next > maxWidth) {
          lines.push(current);
          current = '';
          width = 0;
        }
        current += char;
        width += next;
      }
    }
    lines.push(current);
  }
  return lines;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  supported: Set<number>;
}

class Layout {
  page!: PDFPage;
  y = 0;
  constructor(
    private readonly doc: PDFDocument,
    readonly fonts: Fonts
  ) {
    this.addPage();
  }
  addPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }
  // Starts a new page when the next `height` points would run into the footer.
  ensure(height: number) {
    if (this.y - height < MARGIN + FOOTER_SPACE) this.addPage();
  }
  text(value: string, x: number, size: number, font: PDFFont, color: RGB) {
    this.page.drawText(value, { x, y: this.y - size, size, font, color });
  }
  clean(value: string) {
    return pdfDrawableText(value, this.fonts.supported);
  }
}

function drawHeader(layout: Layout, rows: ExportCommentRow[], meta: ExportMeta) {
  const { regular, bold } = layout.fonts;
  const width = PAGE.width - MARGIN * 2;
  layout.text('Comments', MARGIN, 9, bold, MUTED);
  layout.y -= 16;
  for (const line of wrapText(layout.clean(meta.videoTitle) || 'Untitled', width, (v) =>
    bold.widthOfTextAtSize(v, 18)
  )) {
    layout.text(line, MARGIN, 18, bold, INK);
    layout.y -= 24;
  }
  const threads = rows.filter((row) => row.level === 0).length;
  const replies = rows.length - threads;
  const version = meta.versionLabel
    ? `Version ${meta.versionNumber}: ${meta.versionLabel}`
    : `Version ${meta.versionNumber}`;
  const counts = `${threads} comment${threads === 1 ? '' : 's'}, ${replies} repl${replies === 1 ? 'y' : 'ies'}`;
  const summary = layout.clean(
    `${version} | ${counts} | Exported ${new Date().toISOString().slice(0, 10)}`
  );
  for (const line of wrapText(summary, width, (v) => regular.widthOfTextAtSize(v, 9.5))) {
    layout.text(line, MARGIN, 9.5, regular, MUTED);
    layout.y -= 14;
  }
  layout.y -= 8;
  layout.page.drawLine({
    start: { x: MARGIN, y: layout.y },
    end: { x: PAGE.width - MARGIN, y: layout.y },
    thickness: 1,
    color: RULE,
  });
  layout.y -= 18;
}

// Clips one line to `width`, ending in an ellipsis when something had to go.
export function fitLine(value: string, width: number, measure: (value: string) => number): string {
  if (measure(value) <= width) return value;
  const chars = Array.from(value);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(`${chars.slice(0, mid).join('').trimEnd()}…`) <= width) low = mid;
    else high = mid - 1;
  }
  return `${chars.slice(0, low).join('').trimEnd()}…`;
}

function drawRow(layout: Layout, row: ExportCommentRow, isImage: boolean, isFirstThread: boolean) {
  const { regular, bold } = layout.fonts;
  const isReply = row.level === 1;
  const left = MARGIN + (isImage ? 0 : TIME_COLUMN) + (isReply ? REPLY_INDENT : 0);
  const width = PAGE.width - MARGIN - left;
  const nameSize = isReply ? 9.5 : 10;
  const bodySize = isReply ? 9.5 : 10;
  const leading = bodySize * 1.4;
  const accent = hexColor(commentMarkerColor(row.tagColor, row.isResolved));
  // Tag colors are tuned for a dark player; text in them needs more contrast on paper.
  const accentText = rgb(accent.red * 0.75, accent.green * 0.75, accent.blue * 0.75);

  const body = wrapText(layout.clean(row.content), width, (v) =>
    regular.widthOfTextAtSize(v, bodySize)
  );
  while (body.length > 0 && !body[0]) body.shift();
  while (body.length > 0 && !body[body.length - 1]) body.pop();
  const attachments = describeAttachments(row);

  // Keep the heading with its first lines; a long comment then flows onto later pages.
  const keep = 16 + Math.min(body.length, 3) * leading + 6;
  if (!isReply && !isFirstThread) {
    layout.ensure(keep + 14);
    if (layout.y < PAGE.height - MARGIN) {
      layout.y -= 4;
      layout.page.drawLine({
        start: { x: MARGIN, y: layout.y },
        end: { x: PAGE.width - MARGIN, y: layout.y },
        thickness: 0.5,
        color: RULE,
      });
      layout.y -= 10;
    }
  } else layout.ensure(keep);

  // A reply's guide line is drawn per page, so it follows the reply across a break.
  let guideTop = layout.y;
  const drawGuide = () => {
    if (!isReply) return;
    layout.page.drawLine({
      start: { x: left - 8, y: Math.min(guideTop + 2, PAGE.height - MARGIN) },
      end: { x: left - 8, y: layout.y },
      thickness: 1,
      color: RULE,
    });
  };
  const room = (height: number) => {
    if (layout.y - height >= MARGIN + FOOTER_SPACE) return;
    drawGuide();
    layout.addPage();
    guideTop = layout.y;
  };

  if (!isImage && !isReply) {
    layout.text(layout.clean(formatTimestamp(row.timestamp)), MARGIN, 9.5, bold, accentText);
    if (row.timestampEnd !== null) {
      layout.y -= 12;
      layout.text(`to ${formatTimestamp(row.timestampEnd)}`, MARGIN, 8.5, regular, accentText);
      layout.y += 12;
    }
  }

  // Author, tag and status share the line with the right-aligned creation date, so
  // each is clipped to the room left before the date.
  const created = formatCreatedAt(row.createdAtIso);
  const createdX = PAGE.width - MARGIN - regular.widthOfTextAtSize(created, 7.5);
  // Only a thread's root can be resolved in the app; a reply's own flag means nothing.
  const showResolved = row.isResolved && !isReply;
  const statusWidth = showResolved ? bold.widthOfTextAtSize('Resolved', 8) + 8 : 0;
  const lineEnd = createdX - 12 - statusWidth;
  const author = fitLine(layout.clean(row.authorName) || 'Anonymous', (lineEnd - left) * 0.6, (v) =>
    bold.widthOfTextAtSize(v, nameSize)
  );
  layout.text(author, left, nameSize, bold, INK);
  let x = left + bold.widthOfTextAtSize(author, nameSize) + 8;
  const tag = layout.clean(row.tag)
    ? fitLine(layout.clean(row.tag), lineEnd - x - 10, (v) => regular.widthOfTextAtSize(v, 8))
    : '';
  if (tag && tag !== '…') {
    const tagWidth = regular.widthOfTextAtSize(tag, 8);
    layout.page.drawRectangle({
      x,
      y: layout.y - 10.5,
      width: tagWidth + 10,
      height: 12,
      color: accent,
      opacity: 0.15,
      borderColor: accent,
      borderWidth: 0.5,
      borderOpacity: 0.6,
    });
    layout.page.drawText(tag, { x: x + 5, y: layout.y - 8, size: 8, font: regular, color: INK });
    x += tagWidth + 18;
  }
  if (showResolved) {
    layout.page.drawText('Resolved', {
      x,
      y: layout.y - 8.5,
      size: 8,
      font: bold,
      color: RESOLVED,
    });
  }
  layout.page.drawText(created, {
    x: createdX,
    y: layout.y - 8.5,
    size: 7.5,
    font: regular,
    color: MUTED,
  });
  layout.y -= row.timestampEnd !== null && !isImage && !isReply ? 18 : 16;

  for (const line of body) {
    room(leading);
    if (line) layout.text(line, left, bodySize, regular, INK);
    layout.y -= leading;
  }
  if (attachments) {
    room(13);
    layout.text(layout.clean(attachments), left, 8.5, regular, MUTED);
    layout.y -= 13;
  }
  layout.y -= 6;
  drawGuide();
}

function drawFooters(doc: PDFDocument, fonts: Fonts, meta: ExportMeta) {
  const pages = doc.getPages();
  const label = pdfDrawableText(
    `OpenFrame | ${meta.videoTitle} | v${meta.versionNumber}`,
    fonts.supported
  );
  const clipped = fitLine(label, 360, (v) => fonts.regular.widthOfTextAtSize(v, 8));
  pages.forEach((page, index) => {
    page.drawText(clipped, {
      x: MARGIN,
      y: MARGIN - 16,
      size: 8,
      font: fonts.regular,
      color: MUTED,
    });
    const number = `Page ${index + 1} of ${pages.length}`;
    page.drawText(number, {
      x: PAGE.width - MARGIN - fonts.regular.widthOfTextAtSize(number, 8),
      y: MARGIN - 16,
      size: 8,
      font: fonts.regular,
      color: MUTED,
    });
  });
}

export async function buildCommentsPdf(
  rows: ExportCommentRow[],
  meta: ExportMeta
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await loadFontFiles();
  const regular = await doc.embedFont(regularBytes, { subset: true });
  const bold = await doc.embedFont(boldBytes, { subset: true });
  const supported = new Set(regular.getCharacterSet());
  const fonts = { regular, bold, supported };

  doc.setTitle(`${meta.videoTitle} v${meta.versionNumber} comments`);
  doc.setCreator('OpenFrame');
  doc.setProducer('OpenFrame');

  const layout = new Layout(doc, fonts);
  drawHeader(layout, rows, meta);
  if (rows.length === 0) {
    layout.text('No comments on this version.', MARGIN, 10, regular, MUTED);
  }
  const isImage = meta.mediaType === 'IMAGE';
  let threads = 0;
  for (const row of rows) {
    drawRow(layout, row, isImage, row.level === 0 && threads++ === 0);
  }
  drawFooters(doc, fonts, meta);
  return doc.save();
}
