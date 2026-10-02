// Independent consumers: no imports from the serializers under test.
import { JSDOM } from 'jsdom';

export function parseMarkerXml(text: string) {
  const doc = new JSDOM(text, { contentType: 'application/xml' }).window.document;
  if (doc.doctype || doc.querySelector('parsererror') || doc.documentElement.tagName !== 'xmeml') {
    throw new Error('Invalid marker XML');
  }
  return {
    doc,
    markers: Array.from(doc.querySelectorAll('sequence > marker')).map((marker) => ({
      start: Number(marker.querySelector('in')!.textContent),
      end: Number(marker.querySelector('out')!.textContent),
      entries: JSON.parse(marker.querySelector('comment')!.textContent!),
    })),
  };
}

export function parseMarkerEdl(text: string) {
  const lines = text.trimEnd().split('\n');
  if (lines[0] !== 'TITLE: OpenFrame Comments' || !/^FCM: (NON-DROP|DROP) FRAME$/.test(lines[1])) {
    throw new Error('Invalid EDL header');
  }
  const events = [];
  for (let i = 2; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const event =
      /^(\d{3})\s+001\s+V\s+C\s+(\d{2}:\d{2}:\d{2}[:;]\d{2})\s+(\d{2}:\d{2}:\d{2}[:;]\d{2})\s+(\d{2}:\d{2}:\d{2}[:;]\d{2})\s+(\d{2}:\d{2}:\d{2}[:;]\d{2})$/.exec(
        lines[i]
      );
    const note = /^ \|C:ResolveColorBlue \|M:(.+) \|D:(\d+)$/.exec(lines[++i] ?? '');
    if (!event || !note) throw new Error('Invalid EDL event');
    events.push({
      timecode: event[4],
      out: event[5],
      duration: Number(note[2]),
      entries: JSON.parse(note[1]),
    });
  }
  return events;
}
