import assert from "node:assert/strict";
import test from "node:test";

import { decodePcmWav } from "./wav-decoder.ts";

function makePcmWav({ bits = 8, channels = 1, sampleRate = 11025, samples = [128, 160, 96] } = {}) {
  const bytesPerSample = bits / 8;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeText = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bits, true);
  writeText(36, "data");
  view.setUint32(40, dataLength, true);
  samples.forEach((sample, index) => {
    const offset = 44 + index * bytesPerSample;
    if (bits === 8) view.setUint8(offset, sample);
    else if (bits === 16) view.setInt16(offset, sample, true);
  });
  return buffer;
}

test("decodes the classic 8-bit PCM WAV layout", () => {
  const decoded = decodePcmWav(makePcmWav());
  assert.ok(decoded);
  assert.equal(decoded.channels, 1);
  assert.equal(decoded.sampleRate, 11025);
  assert.equal(decoded.frames, 3);
  assert.deepEqual([...decoded.channelData[0]].map((value) => Number(value.toFixed(3))), [0, 0.25, -0.25]);
});

test("decodes signed 16-bit PCM", () => {
  const decoded = decodePcmWav(makePcmWav({ bits: 16, samples: [-32768, 0, 32767] }));
  assert.ok(decoded);
  assert.deepEqual([...decoded.channelData[0]].map((value) => Number(value.toFixed(3))), [-1, 0, 1]);
});

test("rejects non-PCM input", () => {
  const bytes = new Uint8Array(makePcmWav());
  bytes[20] = 3;
  assert.equal(decodePcmWav(bytes.buffer), null);
  assert.equal(decodePcmWav(new ArrayBuffer(4)), null);
});
