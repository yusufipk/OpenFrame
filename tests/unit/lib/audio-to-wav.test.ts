// The assertions parse the encoded bytes back out of the RIFF header, because
// the failure mode that matters is a file an editor opens and plays wrong:
// half speed, one channel, or a burst of noise where a loud passage was.

import { describe, expect, it } from 'vitest';
import { encodeWav, wavByteLength, MAX_WAV_OUTPUT_BYTES } from '@/lib/audio-to-wav';

const HEADER_BYTES = 44;

async function viewOf(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

function ascii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/** Reads back the interleaved samples as the signed 16-bit values on disk. */
function samples(view: DataView): number[] {
  const out: number[] = [];
  for (let offset = HEADER_BYTES; offset < view.byteLength; offset += 2) {
    out.push(view.getInt16(offset, true));
  }
  return out;
}

describe('encodeWav', () => {
  it('writes a RIFF/WAVE header describing the audio it was given', async () => {
    const view = await viewOf(encodeWav([new Float32Array(480), new Float32Array(480)], 48000));

    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16); // PCM fmt payload
    expect(view.getUint16(20, true)).toBe(1); // format tag: PCM
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(48000); // sample rate
    expect(view.getUint32(28, true)).toBe(48000 * 2 * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(4); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(ascii(view, 36, 4)).toBe('data');
  });

  it('declares sizes that match the bytes actually written', async () => {
    const blob = encodeWav([new Float32Array(100), new Float32Array(100)], 44100);
    const view = await viewOf(blob);

    const dataBytes = 100 * 2 * 2;
    expect(blob.size).toBe(HEADER_BYTES + dataBytes);
    expect(view.getUint32(4, true)).toBe(blob.size - 8);
    expect(view.getUint32(40, true)).toBe(dataBytes);
    expect(wavByteLength(100, 2)).toBe(blob.size);
  });

  it('interleaves the channels frame by frame', async () => {
    const left = Float32Array.from([1, 1, 1]);
    const right = Float32Array.from([-1, -1, -1]);

    const view = await viewOf(encodeWav([left, right], 48000));

    // L R L R L R, not LLL RRR: a planar layout plays as a channel of speech
    // followed by a channel of silence.
    expect(samples(view)).toEqual([32767, -32768, 32767, -32768, 32767, -32768]);
  });

  it('clamps samples that overshoot the float range instead of wrapping them', async () => {
    // Decoders routinely hand back values slightly outside ±1. Scaled unclamped
    // these wrap to the opposite rail and the clip crackles.
    const view = await viewOf(encodeWav([Float32Array.from([1.4, -1.4, 0])], 48000));

    expect(samples(view)).toEqual([32767, -32768, 0]);
  });

  it('keeps a mono recording mono', async () => {
    const blob = encodeWav([new Float32Array(240)], 48000);
    const view = await viewOf(blob);

    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(32, true)).toBe(2); // block align: one 16-bit sample
    expect(blob.size).toBe(HEADER_BYTES + 240 * 2);
  });

  it('encodes an empty recording as a valid, empty WAV', async () => {
    const blob = encodeWav([new Float32Array(0)], 48000);
    const view = await viewOf(blob);

    expect(blob.size).toBe(HEADER_BYTES);
    expect(view.getUint32(40, true)).toBe(0);
  });

  it('rejects input it cannot describe in the header', () => {
    expect(() => encodeWav([], 48000)).toThrow();
    expect(() => encodeWav([new Float32Array(10)], 0)).toThrow();
  });
});

describe('wavByteLength', () => {
  it('puts the output cap beyond any plausible voice note', () => {
    // The cap sits around 35 minutes of 48 kHz stereo. A 10MB Opus upload can
    // just about exceed that, which is the case it exists for; an hour-long
    // voice note is not a thing anyone records into a review comment.
    expect(wavByteLength(48000 * 60 * 10, 2)).toBeLessThan(MAX_WAV_OUTPUT_BYTES);
    expect(wavByteLength(48000 * 60 * 45, 2)).toBeGreaterThan(MAX_WAV_OUTPUT_BYTES);
  });
});
