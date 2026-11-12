// 文字起こしモデルに入れる音声の特徴量が、学習時と同じ計算（kaldi-native-fbank）と一致するか
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fbank, FB_BINS } from '../js/fbank.js';

test('kaldi-native-fbank と同じ値になる', () => {
  const ref = JSON.parse(readFileSync(new URL('./fixtures/fbank.json', import.meta.url)));
  const n = 8000;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / 16000) + 0.2 * Math.sin(2 * Math.PI * 1375 * i / 16000 + 0.5) + 0.05 * Math.sin(i * i * 0.00001);
    if (i < 800) x[i] *= i / 799;
  }
  const { frames, data } = fbank(x);
  assert.equal(frames, ref.frames);
  let worst = 0;
  for (const [k, row] of Object.entries(ref.rows)) {
    for (let b = 0; b < FB_BINS; b++) worst = Math.max(worst, Math.abs(data[Number(k) * FB_BINS + b] - row[b]));
  }
  assert.ok(worst < 0.01, 'worst=' + worst);
});
