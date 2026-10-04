import { describe, expect, it } from 'vitest';
import { crc32, createStoredZip } from '@/lib/zip-store';
import { readStoredZip } from '../../helpers/zip-reader';

describe('createStoredZip', () => {
  it('computes the standard CRC-32', () => {
    // The check value every CRC-32 implementation publishes.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('round-trips names, UTF-8 and binary contents through the archive directory', () => {
    const files = [
      { name: 'manifest.json', data: new TextEncoder().encode('{"id":"x"}') },
      { name: 'yorum ğüş.txt', data: new TextEncoder().encode('Çok güzel 😀\n') },
      { name: 'empty', data: new Uint8Array() },
      { name: 'bytes.bin', data: new Uint8Array([0, 255, 80, 75, 3, 4]) },
    ];
    const entries = readStoredZip(createStoredZip(files));
    expect(entries.map((entry) => entry.name)).toEqual(files.map((file) => file.name));
    entries.forEach((entry, index) => {
      expect(Array.from(entry.data)).toEqual(Array.from(files[index].data));
      expect(entry.crc).toBe(crc32(files[index].data));
      // Bit 11 tells unzip tools the names are UTF-8, not a legacy code page.
      expect(entry.flags & 0x0800).toBe(0x0800);
    });
  });

  it('writes a fixed 1980-01-01 timestamp so the archive never changes between builds', () => {
    const zip = createStoredZip([{ name: 'a', data: new Uint8Array([1, 2, 3]) }]);
    // Local header: version 20, UTF-8 flag, stored, DOS time 00:00, DOS date 1980-01-01.
    expect(Array.from(zip.slice(0, 14))).toEqual([
      0x50, 0x4b, 0x03, 0x04, 20, 0, 0x00, 0x08, 0, 0, 0, 0, 0x21, 0x00,
    ]);
  });
});
