// An independent reader for stored (uncompressed) ZIP archives: it walks the central
// directory from the end record, as an unzip tool does, and holds each local header to
// the same method, flags, sizes and CRC. No imports from the writer under test.

export interface ZipReadEntry {
  name: string;
  crc: number;
  flags: number;
  data: Uint8Array;
}

export function readStoredZip(bytes: Uint8Array): ZipReadEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = bytes.length - 22;
  if (view.getUint32(endAt, true) !== 0x06054b50) throw new Error('No end of central directory');
  const count = view.getUint16(endAt + 10, true);
  if (view.getUint16(endAt + 8, true) !== count) throw new Error('Entry counts disagree');
  const centralSize = view.getUint32(endAt + 12, true);
  const centralAt = view.getUint32(endAt + 16, true);
  if (centralAt + centralSize !== endAt) throw new Error('Central directory size is wrong');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: ZipReadEntry[] = [];
  let at = centralAt;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('Bad central header');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    if (method !== 0) throw new Error('Entry is compressed');
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    if (compressed !== size) throw new Error('A stored entry has two sizes');
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    if (view.getUint32(localAt, true) !== 0x04034b50) throw new Error('Bad local header');
    if (view.getUint16(localAt + 6, true) !== flags) throw new Error('Flags disagree');
    if (view.getUint16(localAt + 8, true) !== method) throw new Error('Methods disagree');
    if (view.getUint32(localAt + 14, true) !== crc) throw new Error('CRC mismatch');
    if (view.getUint32(localAt + 18, true) !== compressed) throw new Error('Sizes disagree');
    if (view.getUint32(localAt + 22, true) !== size) throw new Error('Sizes disagree');
    const localName = view.getUint16(localAt + 26, true);
    const localExtra = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + localName + localExtra;
    entries.push({ name, crc, flags, data: bytes.slice(dataAt, dataAt + compressed) });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}
