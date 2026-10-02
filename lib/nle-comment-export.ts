import type { ExportCommentRow } from '@/lib/comment-export';

export type CommentExportFormat = 'csv' | 'pdf' | 'edl' | 'xml';
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

// JSON retains controls, line breaks, IDs, reply relationships and attachment flags.
// Literal pipes could start Resolve directives; JSON unicode escapes are reversible.
function markerNote(rows: ExportCommentRow[]): string {
  return JSON.stringify(rows)
    .replace(/\|/g, '\\u007c')
    .replace(/[\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16)}`);
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

export function buildNleComments(
  rows: ExportCommentRow[],
  title: string,
  format: 'edl' | 'xml',
  options: NleExportOptions
): string {
  const rate = parseNleOptions(options);
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
  const markers = [...groups.values()].sort((a, b) => a.start - b.start);
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
        ` |C:ResolveColorBlue |M:${markerNote(marker.rows)} |D:${marker.end - marker.start}`,
        ''
      );
    });
    return lines.join('\n');
  }
  const rateXml = `<rate><timebase>${rate.nominal}</timebase><ntsc>${rate.denominator === 1001 ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const duration = Math.max(1, ...markers.map((marker) => marker.end));
  const markerXml = markers
    .map(
      (marker) =>
        `<marker><name>${xmlText(`${marker.rows.length} OpenFrame comment(s)`)}</name><comment>${xmlText(markerNote(marker.rows))}</comment><in>${marker.start}</in><out>${marker.end}</out></marker>`
    )
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
