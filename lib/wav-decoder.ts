export interface DecodedPcmWav {
  channels: number;
  sampleRate: number;
  frames: number;
  channelData: Float32Array[];
}

function readFourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

/** Decode uncompressed PCM WAV files for browsers with incomplete 8-bit support. */
export function decodePcmWav(arrayBuffer: ArrayBuffer): DecodedPcmWav | null {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength < 12 || readFourCc(bytes, 0) !== "RIFF" || readFourCc(bytes, 8) !== "WAVE") return null;

  const view = new DataView(arrayBuffer);
  let offset = 12;
  let format: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let dataStart: number | null = null;
  let dataLength = 0;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readFourCc(bytes, offset);
    const chunkLength = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > bytes.byteLength) return null;

    if (chunkId === "fmt " && chunkLength >= 16) {
      format = view.getUint16(chunkStart, true);
      channels = view.getUint16(chunkStart + 2, true);
      sampleRate = view.getUint32(chunkStart + 4, true);
      bitsPerSample = view.getUint16(chunkStart + 14, true);

      // WAVE_FORMAT_EXTENSIBLE stores the PCM format in its sub-format GUID.
      if (format === 0xfffe && chunkLength >= 40) {
        const subFormat = view.getUint16(chunkStart + 24, true);
        format = subFormat;
      }
    } else if (chunkId === "data" && dataStart === null) {
      dataStart = chunkStart;
      dataLength = chunkLength;
    }

    offset = chunkEnd + (chunkLength & 1);
  }

  if (
    format !== 1
    || !channels
    || channels < 1
    || channels > 32
    || !sampleRate
    || sampleRate < 3000
    || sampleRate > 384000
    || !bitsPerSample
    || ![8, 16, 24, 32].includes(bitsPerSample)
    || dataStart === null
  ) return null;

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const frames = Math.floor(dataLength / blockAlign);
  if (frames < 1) return null;

  const channelData = Array.from({ length: channels }, () => new Float32Array(frames));
  let cursor = dataStart;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      let sample: number;
      if (bitsPerSample === 8) {
        sample = (view.getUint8(cursor) - 128) / 128;
      } else if (bitsPerSample === 16) {
        sample = view.getInt16(cursor, true) / 32768;
      } else if (bitsPerSample === 24) {
        let value = view.getUint8(cursor)
          | (view.getUint8(cursor + 1) << 8)
          | (view.getUint8(cursor + 2) << 16);
        if (value & 0x800000) value |= 0xff000000;
        sample = value / 8388608;
      } else {
        sample = view.getInt32(cursor, true) / 2147483648;
      }
      channelData[channel][frame] = Math.max(-1, Math.min(1, sample));
      cursor += bytesPerSample;
    }
  }

  return { channels, sampleRate, frames, channelData };
}
