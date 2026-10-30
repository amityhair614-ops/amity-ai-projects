// 固定テスト素材 IMG_5953（67.83秒）: 手動編集（62.47秒）と比べる。v0.9.3 のAI編集（60.83秒）は、字幕に
// 「ね」「という」「そうなると」が6回出て、字幕の切れ目の一致は68%だった（tests/fixtures/img5953/README.md）
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture, planFixture, compare, subtitleStats } from './reference.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/img5953');
const { analysis, manual } = loadFixture(dir);
const { timeline } = planFixture(analysis, manual.targetSec);
const cmp = compare(manual, timeline, analysis);
const stats = subtitleStats(cmp.pages.map(p => p.text), cmp.pages.map(p => p.end - p.start));

test('IMG_5953: 完成の長さが手動編集（62.47秒）の ±1.5秒以内・話の途中の間も同じくらい', () => {
  assert.ok(Math.abs(cmp.outSec - manual.duration) <= 1.5, `${cmp.outSec.toFixed(2)}秒`);
  assert.ok(cmp.iou >= 0.9, `使った範囲の一致 ${(cmp.iou * 100).toFixed(1)}%`);
  const p = cmp.pauses, m = manual.pauses;
  assert.ok(Math.abs(p.median - m.median) <= 0.06 && Math.abs(p.p90 - m.p90) <= 0.06, JSON.stringify(p));
});

test('IMG_5953: 説明の文は削らない', () => {
  for (const s of cmp.spoken) assert.ok(s.cover >= 0.75, `「${s.text}」 ${(s.cover * 100).toFixed(0)}%`);
});

test('IMG_5953: 字幕は1行・短く（平均12文字以下）、不要な言葉（ね・という・そうなると）を出さない', () => {
  for (const p of cmp.pages) assert.ok(p.lines.length === 1 && p.text.length <= 15, p.text);
  assert.ok(stats.avgChars <= 12, `平均 ${stats.avgChars.toFixed(1)}文字`);
  assert.equal(stats.unneeded, 0, cmp.pages.map(p => p.text).join(' / '));
  assert.ok(stats.maxSec <= 4, `最長 ${stats.maxSec.toFixed(2)}秒`);
  const all = cmp.pages.map(p => p.text).join('');
  // 否定・用語・注意の言葉は省かない
  for (const w of ['ついていない', '仕方ない', 'しかたない', '必要があります', 'かなり難しい', 'レイヤー', 'セルフカット']) {
    if (!all.includes(w) && !(w === '仕方ない' && all.includes('しかたない')) && !(w === 'しかたない' && all.includes('仕方ない'))) assert.fail(`「${w}」がない`);
  }
});

test('IMG_5953: 字幕の切れ目が手動編集の切れ目（意味のまとまり）の8割以上と同じ', () => {
  assert.ok(cmp.breaks.recall >= 0.8, `${(cmp.breaks.recall * 100).toFixed(0)}% ${cmp.breaks.missed.join(' / ')}`);
});
