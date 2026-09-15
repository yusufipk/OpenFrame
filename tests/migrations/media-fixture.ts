import { readFileSync } from 'node:fs';

export function legacyMedia(id: number): Buffer {
  // A valid MP4 free box gives every original object distinct bytes. Routing to
  // a different version must fail the hash check even though the clip is shared.
  const marker = Buffer.from(`legacy-object-${id}`);
  const box = Buffer.alloc(8 + marker.length);
  box.writeUInt32BE(box.length, 0);
  box.write('free', 4);
  marker.copy(box, 8);
  return Buffer.concat([readFileSync('tests/fixtures/sample.mp4'), box]);
}

export function legacyFilename(id: number): string {
  return `11111111-1111-4111-8111-${String(id).padStart(12, '0')}.mp4`;
}
