// カットの強さ「テンポ重視」（pace: tight）: 話す前後の余白だけを詰め、声のある所（細かい声の区間）は切らない。
// 固定テスト素材9本で、「標準」が使った声のコマは、テンポ重視でもすべて使う
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture, planFixture } from './reference.mjs';
import { fineSpeech } from '../js/plan.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURES = ['bob', 'img5830', 'img5953', 'img5980', 'img5992', 'img6052', 'img6183', 'img6289', 'img1106'];

test('カットの強さ「テンポ重視」: どの素材でも短くなり、標準で使った声は1コマも切らない', () => {
  for (const fx of FIXTURES) {
    const { analysis, manual } = loadFixture(path.join(root, fx));
    const ranges = pace => planFixture(analysis, manual.targetSec, { pace }).timeline.flatMap(c => c.pieces.map(p => [p.srcStart, p.srcStart + p.frames / 30]));
    const N = ranges('natural'), T = ranges('tight');
    const len = U => U.reduce((s, [a, b]) => s + b - a, 0);
    assert.ok(len(T) < len(N), `${fx}: ${len(T).toFixed(2)} < ${len(N).toFixed(2)}`);
    const used = (U, t) => U.some(([a, b]) => a <= t && t <= b);
    for (const r of fineSpeech(analysis.rmsDb, analysis.speech.threshold)) {
      for (let t = r.start; t < r.end; t += 0.05) assert.ok(!used(N, t) || used(T, t), `${fx}: ${t.toFixed(2)}秒の声を切った`);
    }
  }
});
