/**
 * MediaRecorder hands us WebM/Opus (MP4/AAC on Safari). Browsers and desktop
 * players read both; editing suites read neither. DaVinci Resolve, Premiere and
 * Final Cut all refuse the container outright, so a voice note downloaded
 * byte-for-byte is useless to the editor it was recorded for.
 *
 * The browser already decodes these formats in order to play them, so the whole
 * conversion costs us is a RIFF header: decode to PCM through the Web Audio API,
 * then write the samples back out as a WAV. Nothing is transcoded server side
 * and the stored object stays the small Opus file, which is why this runs at
 * download time rather than at record time.
 */

const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const PCM_FORMAT_TAG = 1;

/**
 * Decoding holds the float PCM and the encoded copy in memory at once, roughly
 * three times the size of the WAV. A 10MB Opus upload is over half an hour of
 * speech, so cap the output rather than let a long recording take the tab down.
 */
export const MAX_WAV_OUTPUT_BYTES = 400 * 1024 * 1024;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function wavByteLength(frameCount: number, channelCount: number): number {
  return WAV_HEADER_BYTES + frameCount * channelCount * BYTES_PER_SAMPLE;
}

/**
 * Interleaved 16-bit PCM in a RIFF container: the one audio format every NLE on
 * the market imports without an argument. `channels` holds one Float32Array of
 * samples per channel, all the same length.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const channelCount = channels.length;
  if (channelCount === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('encodeWav needs at least one channel and a positive sample rate');
  }

  const frameCount = channels[0].length;
  const blockAlign = channelCount * BYTES_PER_SAMPLE;
  const dataBytes = frameCount * blockAlign;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  // Everything after this field, i.e. the file minus the 8-byte RIFF preamble.
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk payload size for PCM
  view.setUint16(20, PCM_FORMAT_TAG, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      // Decoded samples can overshoot ±1. Scaled unclamped they wrap to the
      // opposite rail, and a loud passage comes out as a burst of noise.
      const sample = Math.max(-1, Math.min(1, channels[channel][frame] ?? 0));
      // The negative rail reaches one step further than the positive one, so the
      // two directions take different scale factors to stay symmetric.
      view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
      offset += BYTES_PER_SAMPLE;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

type OfflineAudioContextConstructor = new (
  channels: number,
  length: number,
  sampleRate: number
) => OfflineAudioContext;

function getOfflineAudioContext(): OfflineAudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    OfflineAudioContext?: OfflineAudioContextConstructor;
    webkitOfflineAudioContext?: OfflineAudioContextConstructor;
  };
  return scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext ?? null;
}

/**
 * Decodes any audio blob the browser can play and returns it as a WAV, or null
 * when this browser cannot decode that format (older Safari has no WebM/Opus
 * decoder) or the result would be too large to hold. Callers fall back to the
 * original file, so a failure costs the download nothing but the extension.
 */
export async function convertAudioBlobToWav(blob: Blob): Promise<Blob | null> {
  const OfflineCtx = getOfflineAudioContext();
  if (!OfflineCtx) return null;

  try {
    // decodeAudioData resamples to the context's rate, and 48 kHz is what both
    // Opus and AAC recordings already run at, so this decodes them untouched.
    // We read the rate back off the result anyway in case a browser ignores it.
    const context = new OfflineCtx(1, 1, 48000);
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (!decoded || decoded.length === 0) return null;
    if (wavByteLength(decoded.length, decoded.numberOfChannels) > MAX_WAV_OUTPUT_BYTES) return null;

    const channels: Float32Array[] = [];
    for (let i = 0; i < decoded.numberOfChannels; i++) channels.push(decoded.getChannelData(i));
    return encodeWav(channels, decoded.sampleRate);
  } catch {
    return null;
  }
}
