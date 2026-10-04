import type { ExportCommentRow } from '@/lib/comment-export';
import { commentMarkerColor } from '@/lib/comment-tags';

export type NleFormat = 'edl' | 'xml';
export type CommentExportFormat = 'csv' | 'pdf' | NleFormat;
export const NLE_FORMATS: readonly NleFormat[] = ['edl', 'xml'];
export interface NleExportOptions {
  fps: string;
  origin: string;
  dropFrame: boolean;
}

// NTSC rates are ratios, never the rounded labels shown in editing applications.
export const NLE_FRAME_RATES = [
  '24',
  '25',
  '30',
  '48',
  '50',
  '60',
  '24000/1001',
  '30000/1001',
  '60000/1001',
] as const;

export class NleExportError extends Error {}

export function parseNleOptions(options: NleExportOptions) {
  if (!(NLE_FRAME_RATES as readonly string[]).includes(options.fps)) {
    throw new NleExportError('Select a supported frame rate. Use exact fractional rates.');
  }
  const [numerator, denominator = 1] = options.fps.split('/').map(Number);
  const nominal = Math.round(numerator / denominator);
  const drop = options.dropFrame ? nominal / 15 : 0;
  if (options.dropFrame && !['30000/1001', '60000/1001'].includes(options.fps)) {
    throw new NleExportError('Drop-frame is supported only at 30000/1001 and 60000/1001 fps.');
  }
  const match = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/.exec(options.origin);
  if (!match || match[4] !== (options.dropFrame ? ';' : ':')) {
    throw new NleExportError('Timeline origin must be HH:MM:SS:FF (NDF) or HH:MM:SS;FF (DF).');
  }
  const [hours, minutes, seconds, frames] = [match[1], match[2], match[3], match[5]].map(Number);
  if (
    hours > 23 ||
    minutes > 59 ||
    seconds > 59 ||
    frames >= nominal ||
    (drop && minutes % 10 !== 0 && seconds === 0 && frames < drop)
  ) {
    throw new NleExportError('Timeline origin is not a valid timecode at the selected frame rate.');
  }
  const totalMinutes = hours * 60 + minutes;
  const originFrames =
    (hours * 3600 + minutes * 60 + seconds) * nominal +
    frames -
    drop * (totalMinutes - Math.floor(totalMinutes / 10));
  const dayFrames = nominal * 86400 - drop * (1440 - 144);
  return { numerator, denominator, nominal, drop, originFrames, dayFrames };
}

type Rate = ReturnType<typeof parseNleOptions>;

// Convert the decimal representation of stored seconds to a rational before rounding.
// Half frames round up; no accumulated drift from 23.976/29.97/59.94 approximations.
export function secondsToNleFrames(seconds: number, rate: Rate): number {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) {
    throw new NleExportError('Comment timestamps must be finite and within one day.');
  }
  const [mantissa, exponent = '0'] = seconds.toString().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const power = Number(exponent) - fraction.length;
  let n = BigInt(whole + fraction) * BigInt(rate.numerator);
  let d = BigInt(rate.denominator);
  if (power >= 0) n *= BigInt(10) ** BigInt(power);
  else d *= BigInt(10) ** BigInt(-power);
  return Number((n * BigInt(2) + d) / (d * BigInt(2)));
}

export function nleTimecode(frame: number, rate: Rate): string {
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= rate.dayFrames) {
    throw new NleExportError(
      'Export timecodes must stay below 24 hours; choose an earlier origin.'
    );
  }
  let label = frame;
  if (rate.drop) {
    const tenMinutes = rate.nominal * 600 - rate.drop * 9;
    const minute = rate.nominal * 60 - rate.drop;
    const blocks = Math.floor(frame / tenMinutes);
    const remainder = frame % tenMinutes;
    label +=
      rate.drop * 9 * blocks +
      rate.drop * Math.max(0, Math.floor((remainder - rate.drop) / minute));
  }
  const frames = label % rate.nominal;
  const seconds = Math.floor(label / rate.nominal);
  return (
    [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map((value) => String(value).padStart(2, '0'))
      .join(':') +
    (rate.drop ? ';' : ':') +
    String(frames).padStart(2, '0')
  );
}

// Hue bands rather than the nearest RGB value: Premiere's palette is muted (its
// green is olive), so a distance match turns a bright green tag cyan. Each entry
// is the upper hue bound (exclusive) of the band.
const RESOLVE_HUES: [number, string][] = [
  [15, 'Red'],
  [70, 'Yellow'],
  [160, 'Green'],
  [200, 'Cyan'],
  [250, 'Blue'],
  [290, 'Purple'],
  [345, 'Pink'],
  [360, 'Red'],
];

// Premiere's marker palette: packed 0xAABBGGRR integers, the form XML `pproColor`
// takes, and the name in the UXP `Constants.MarkerColor` an editor plugin sets. UXP
// has no violet, so that band is magenta there.
const PREMIERE_HUES: [number, [number, string]][] = [
  [15, [4281740498, 'RED']],
  [33, [4280578025, 'ORANGE']],
  [70, [4281049552, 'YELLOW']],
  [160, [4281828977, 'GREEN']],
  [200, [4292277273, 'CYAN']],
  [250, [4294741314, 'BLUE']],
  [345, [4289825711, 'MAGENTA']],
  [360, [4281740498, 'RED']],
];
const PREMIERE_WHITE = 4294967295;

function hexRgb(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return match
    ? ([1, 2, 3].map((i) => parseInt(match[i], 16)) as [number, number, number])
    : [0, 0, 0];
}

function hsl(hex: string) {
  const [r, g, b] = hexRgb(hex).map((value) => value / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = 60 * (((g - b) / delta + 6) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  return { hue, saturation, lightness };
}

function band<T>(hue: number, bands: [number, T][]): T {
  return bands.find(([upper]) => hue < upper)![1];
}

export function resolveMarkerColor(hex: string): string {
  const { hue, saturation, lightness } = hsl(hex);
  if (saturation < 0.15) return lightness >= 0.5 ? 'Cream' : 'Cocoa';
  return band(hue, RESOLVE_HUES);
}

export function premiereMarkerColor(hex: string): number {
  const { hue, saturation } = hsl(hex);
  return saturation < 0.15 ? PREMIERE_WHITE : band(hue, PREMIERE_HUES)[0];
}

// The UXP palette lists no white, so a neutral tag keeps the marker's default color.
export function premierePanelColor(hex: string): string | null {
  const { hue, saturation } = hsl(hex);
  return saturation < 0.15 ? null : band(hue, PREMIERE_HUES)[1];
}

interface MarkerEntry {
  row: ExportCommentRow;
  // Replies above this one inside the same marker.
  depth: number;
  // Author of the parent when the parent sits on another marker.
  replyTo: string | null;
}

// Rows of one marker in thread order: each comment followed by its replies, so a
// reply is never listed under a different comment that happens to share the frame.
// A reply carries its own timestamp, so its parent can be on another marker; it is
// then listed at the top level and names the author it answers instead.
function threadOrder(rows: ExportCommentRow[], authors: Map<string, string>): MarkerEntry[] {
  const ids = new Set(rows.map((row) => row.commentId));
  const children = new Map<string, ExportCommentRow[]>();
  const tops: ExportCommentRow[] = [];
  for (const row of rows) {
    if (row.parentCommentId !== null && ids.has(row.parentCommentId)) {
      children.set(row.parentCommentId, [...(children.get(row.parentCommentId) ?? []), row]);
    } else tops.push(row);
  }
  const ordered: MarkerEntry[] = [];
  const visit = (row: ExportCommentRow, depth: number, replyTo: string | null) => {
    ordered.push({ row, depth, replyTo });
    for (const child of children.get(row.commentId) ?? []) visit(child, depth + 1, null);
  };
  for (const row of tops) {
    visit(row, 0, row.parentCommentId === null ? null : (authors.get(row.parentCommentId) ?? null));
  }
  if (ordered.length !== rows.length) {
    throw new NleExportError('Cannot export a cyclic comment thread.');
  }
  return ordered;
}

function attachmentLabels(row: ExportCommentRow): string[] {
  return [
    row.hasVoiceNote && '(voice note)',
    row.hasImageAttachment && '(image)',
    row.hasAnnotation && '(drawing)',
  ].filter((label): label is string => Boolean(label));
}

// What an editor reads on the marker: who said it, its tag and state, the text.
function commentHeading({ row, replyTo }: MarkerEntry): string {
  const labels = [
    replyTo !== null && `(reply to ${replyTo})`,
    row.tag && `[${row.tag}]`,
    row.isResolved && '(resolved)',
    ...attachmentLabels(row),
  ].filter(Boolean);
  return [row.authorName, ...labels].join(' ');
}

function xmlNote(entries: MarkerEntry[]): string {
  return entries
    .map((entry) => {
      const indent = '  '.repeat(Math.max(0, entry.depth - 1));
      const prefix = entry.depth > 0 ? `${indent}↳ ` : '';
      const [first, ...rest] = entry.row.content.split(/\r\n|\r|\n/);
      const continuation = ' '.repeat(prefix.length);
      return [
        `${prefix}${commentHeading(entry)}: ${first}`,
        ...rest.map((line) => continuation + line),
      ]
        .join('\n')
        .trimEnd();
    })
    .join('\n');
}

function xmlName(entries: MarkerEntry[]): string {
  const { row } = entries[0];
  // A voice note or drawing without text still gets a name that says what it is.
  const text =
    row.content.split(/\r\n|\r|\n/)[0].trim() || attachmentLabels(row).join(' ') || '(no text)';
  const line = `${row.authorName}: ${text}`;
  const chars = Array.from(line);
  const clipped = chars.length > 80 ? `${chars.slice(0, 79).join('').trimEnd()}…` : line;
  return entries.length > 1 ? `${clipped} (+${entries.length - 1})` : clipped;
}

// EDL marker text is one line. Resolve garbles characters outside the Basic
// Multilingual Plane (emoji) when it reads an EDL, so they are dropped, and a
// literal pipe would start a new directive, so it becomes a broken bar.
function edlText(value: string): string {
  return Array.from(value)
    .map((char) => {
      const code = char.codePointAt(0)!;
      if (code > 0xffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      if (code === 0x200d || code === 0xfe0e || code === 0xfe0f) return '';
      if (code < 32 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029)
        return ' ';
      return char === '|' ? '¦' : char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function edlNote(entries: MarkerEntry[]): string {
  return entries
    .map((entry) => {
      const prefix = entry.depth > 0 ? '↳ ' : '';
      return edlText(`${prefix}${commentHeading(entry)}: ${entry.row.content}`);
    })
    .join(' / ');
}

function xmlText(value: string): string {
  return Array.from(value)
    .map((char) => {
      const code = char.codePointAt(0)!;
      if (
        (code < 32 && ![9, 10, 13].includes(code)) ||
        (code >= 0xd800 && code <= 0xdfff) ||
        code === 0xfffe ||
        code === 0xffff
      ) {
        return `\\u${code.toString(16).padStart(4, '0')}`;
      }
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char] ?? char;
    })
    .join('');
}

// Comments grouped by the frame they start on, in timeline order, with the text
// order, color and done state every format shares.
function groupMarkers(rows: ExportCommentRow[], rate: Rate) {
  const groups = new Map<number, { start: number; end: number; rows: ExportCommentRow[] }>();
  for (const row of rows) {
    const start = secondsToNleFrames(row.timestamp, rate);
    if (row.timestampEnd !== null && row.timestampEnd < row.timestamp) {
      throw new NleExportError('Comment range ends before it starts.');
    }
    const end = Math.max(start + 1, secondsToNleFrames(row.timestampEnd ?? row.timestamp, rate));
    nleTimecode(rate.originFrames + end, rate);
    const group = groups.get(start);
    if (group) {
      group.end = Math.max(group.end, end);
      group.rows.push(row);
    } else groups.set(start, { start, end, rows: [row] });
  }
  const authors = new Map(rows.map((row) => [row.commentId, row.authorName]));
  const byId = new Map(rows.map((row) => [row.commentId, row]));
  // Resolution is set on a thread's root; a reply carries its own, unrelated flag.
  const rootResolved = (row: ExportCommentRow) => {
    const seen = new Set<string>();
    let current = row;
    while (current.parentCommentId !== null && !seen.has(current.commentId)) {
      seen.add(current.commentId);
      const parent = byId.get(current.parentCommentId);
      if (!parent) break;
      current = parent;
    }
    return current.isResolved;
  };
  return [...groups.values()]
    .sort((a, b) => a.start - b.start)
    .map((marker) => {
      const entries = threadOrder(marker.rows, authors);
      // The first comment of the marker decides its color, as in the player.
      const color = commentMarkerColor(entries[0].row.tagColor, entries[0].row.isResolved);
      // A marker is done only when every thread it opens is resolved.
      const done = entries.every((entry) => entry.depth > 0 || rootResolved(entry.row));
      return { ...marker, entries, color, done };
    });
}

export interface PanelMarker {
  // Frames from the start of the video, at the requested rate.
  startFrame: number;
  durationFrames: number;
  name: string;
  comments: string;
  color: string;
  premiereColor: string | null;
  resolveColor: string;
  done: boolean;
  commentIds: string[];
}

// Markers for an editor plugin that writes them into an open timeline itself, so
// it needs frames rather than timecode and no file format around them.
export function buildPanelMarkers(rows: ExportCommentRow[], fps: string): PanelMarker[] {
  const rate = parseNleOptions({ fps, origin: '00:00:00:00', dropFrame: false });
  return groupMarkers(rows, rate).map((marker) => ({
    startFrame: marker.start,
    durationFrames: marker.end - marker.start,
    name: xmlName(marker.entries),
    comments: xmlNote(marker.entries),
    color: marker.color,
    premiereColor: premierePanelColor(marker.color),
    resolveColor: resolveMarkerColor(marker.color),
    done: marker.done,
    commentIds: marker.entries.map((entry) => entry.row.commentId),
  }));
}

export function buildNleComments(
  rows: ExportCommentRow[],
  title: string,
  format: NleFormat,
  options: NleExportOptions
): string {
  const rate = parseNleOptions(options);
  const markers = groupMarkers(rows, rate);
  if (format === 'edl') {
    if (markers.length > 999)
      throw new NleExportError(
        'Resolve EDL supports at most 999 distinct marker frames per export. Use XML or CSV for larger exports.'
      );
    // A fixed title avoids injecting EDL headers through user-controlled video titles.
    const lines = [
      'TITLE: OpenFrame Comments',
      `FCM: ${rate.drop ? 'DROP' : 'NON-DROP'} FRAME`,
      '',
    ];
    markers.forEach((marker, index) => {
      const start = nleTimecode(rate.originFrames + marker.start, rate);
      const out = nleTimecode(rate.originFrames + marker.start + 1, rate);
      lines.push(
        `${String(index + 1).padStart(3, '0')}  001  V  C  ${start} ${out} ${start} ${out}`,
        ` |C:ResolveColor${resolveMarkerColor(marker.color)} |M:${edlNote(marker.entries)} |D:${marker.end - marker.start}`,
        ''
      );
    });
    return lines.join('\n');
  }
  const rateXml = `<rate><timebase>${rate.nominal}</timebase><ntsc>${rate.denominator === 1001 ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const duration = Math.max(1, ...markers.map((marker) => marker.end));
  const markerXml = markers
    .map((marker) => {
      // Only Premiere reads a marker color from XML; Resolve 20.3 shows every XML
      // marker blue whatever the file says.
      return `<marker><name>${xmlText(xmlName(marker.entries))}</name><comment>${xmlText(xmlNote(marker.entries))}</comment><in>${marker.start}</in><out>${marker.end}</out><pproColor>${premiereMarkerColor(marker.color)}</pproColor></marker>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xmeml version="5"><sequence id="openframe-comments"><name>${xmlText(title)}</name><duration>${duration}</duration>${rateXml}<timecode>${rateXml}<string>${options.origin}</string><frame>${rate.originFrames}</frame><displayformat>${rate.drop ? 'DF' : 'NDF'}</displayformat></timecode><media><video><format><samplecharacteristics>${rateXml}<width>1920</width><height>1080</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format><track/></video><audio><track/></audio></media>${markerXml}</sequence></xmeml>\n`;
}

// The API can store replies to replies. Keep the actual parent IDs at every
// depth, and apply the resolved filter to the root of each complete thread.
export function selectNleThreads(
  rows: ExportCommentRow[],
  includeResolved: boolean
): ExportCommentRow[] {
  const byId = new Map(rows.map((row) => [row.commentId, row]));
  const roots = new Map<string, ExportCommentRow>();
  for (const row of rows) {
    const path: ExportCommentRow[] = [];
    const visited = new Set<string>();
    let current = row;
    while (!roots.has(current.commentId) && current.parentCommentId !== null) {
      if (visited.has(current.commentId))
        throw new NleExportError('Cannot export a cyclic comment thread.');
      visited.add(current.commentId);
      path.push(current);
      const parent = byId.get(current.parentCommentId);
      if (!parent) throw new NleExportError('Cannot export an incomplete comment thread.');
      current = parent;
    }
    const root = roots.get(current.commentId) ?? current;
    roots.set(current.commentId, root);
    for (const entry of path) roots.set(entry.commentId, root);
  }
  return rows.filter((row) => includeResolved || !roots.get(row.commentId)!.isResolved);
}
