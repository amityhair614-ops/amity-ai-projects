// 音の繰り返しで言いかけを見つける（acoustic.js）
import test from 'node:test';
import assert from 'node:assert/strict';
import { findRestarts, subsequenceDistance, logMel } from '../js/acoustic.js';

const SR = 16000;
// 周波数の違う音を並べた、声の代わりの音（音節の代わり）
function tones(freqs, dur = 0.15) {
  const out = new Float32Array(Math.round(freqs.length * dur * SR));
  freqs.forEach((f, k) => { for (let i = 0; i < dur * SR; i++) out[k * dur * SR + i] = 0.3 * Math.sin((2 * Math.PI * f * i) / SR) + 0.1 * Math.sin((2 * Math.PI * 2.7 * f * i) / SR); });
  return out;
}
function place(total, parts) {
  const pcm = new Float32Array(Math.round(total * SR));
  for (const [t, x] of parts) pcm.set(x, Math.round(t * SR));
  return pcm;
}

test('長い無音のあとの短い発言の終わりが、すぐ後の話し直しの中にあれば、言いかけとして見つける', () => {
  const a = tones([300, 500, 700, 900]);            // 言いかけ（0.6秒）
  const b = tones([400, 300, 500, 700, 900, 650, 450, 350, 800, 600, 300, 500]); // 話し直し（言いかけの音を含む）
  const pre = tones([350, 450, 550, 650]);
  const pcm = place(6, [[0.2, pre], [2.0, a], [2.9, b]]);
  const fine = [{ start: 0.2, end: 0.8 }, { start: 2.0, end: 2.6 }, { start: 2.9, end: 4.7 }];
  const r = findRestarts(pcm, fine);
  assert.equal(r.length, 1);
  assert.equal(r[0].level, 'auto');
  assert.ok(Math.abs(r[0].start - 2.0) < 1e-9 && Math.abs(r[0].next - 2.9) < 1e-9);
});

test('話し直しに同じ音がない・前に長い無音がない・長い発言は、言いかけにしない', () => {
  const a = tones([300, 500, 700, 900]);
  const other = tones([1200, 1500, 1800, 1100, 1300, 1700, 1250, 1450, 1650, 1900, 1150, 1550]);
  assert.equal(findRestarts(place(6, [[0.2, tones([350, 450])], [2.0, a], [2.9, other]]), [{ start: 0.2, end: 0.5 }, { start: 2.0, end: 2.6 }, { start: 2.9, end: 4.7 }]).length, 0);
  // 前の発言との間が短い（0.3秒）: 話の途中の間
  assert.equal(findRestarts(place(6, [[1.1, tones([350, 450, 550, 650])], [2.0, a], [2.9, tones([400, 300, 500, 700, 900, 650])]]), [{ start: 1.1, end: 1.7 }, { start: 2.0, end: 2.6 }, { start: 2.9, end: 3.8 }]).length, 0);
});

test('同じ音どうしの距離は小さく、違う音とは大きい', () => {
  const x = logMel(tones([300, 500, 700]), 0, 0.45);
  const y = logMel(tones([200, 300, 500, 700, 900]), 0, 0.75);
  const z = logMel(tones([1200, 1500, 1800, 1100, 1300]), 0, 0.75);
  assert.ok(subsequenceDistance(x, y) < subsequenceDistance(x, z));
});
