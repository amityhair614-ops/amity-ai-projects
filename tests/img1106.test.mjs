// 固定テスト素材 IMG_1106（3本の動画をつないだ手動編集。tests/fixtures/img1106）: 1本ずつ解析した結果をつないでも、
// 発言を消さない・素材の境界をまたがない・字幕の言葉を勝手に変えない
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture, planFixture, compare } from './reference.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/img1106');
const { analysis, manual } = loadFixture(dir);
const { timeline } = planFixture(analysis, manual.targetSec);
const cmp = compare(manual, timeline, analysis);
const texts = cmp.pages.map(p => p.text);
const all = texts.join('');

test('IMG_1106: どの発言も消さない（手動編集は発言を1つも削っていない）・場面は1本の動画の中だけ', () => {
  for (const s of cmp.spoken) assert.ok(s.cover >= 0.7, `「${s.text}」 ${(s.cover * 100).toFixed(0)}%`);
  for (const c of timeline) for (const p of c.pieces) {
    const a = p.srcStart, b = p.srcStart + p.frames / 30;
    assert.ok(analysis.lay.some(s => a >= s.offset - 1e-6 && b <= s.end + 1e-6), `${a.toFixed(2)}-${b.toFixed(2)} が動画の境界をまたぐ`);
  }
  assert.ok(cmp.iou >= 0.88, `${(cmp.iou * 100).toFixed(0)}%`);
});

test('IMG_1106: 3本目の最初の文を落とさない・言っていない用語を入れない・「際」を「サイン」にしない', () => {
  assert.ok(all.includes('たくさん起こってしまいます'), all);
  assert.ok(!/もみあげ|サイン|スギバサミ|すぎばさみ/.test(all), all);
  assert.ok(!texts.some(t => t.startsWith('セルフカットです')), texts.join(' / '));
  assert.ok(texts.includes('セルフカットで'), texts.join(' / '));
  assert.ok(all.includes('する際'), all);
  assert.ok(all.includes('それを守ってください'), '文の途中の「それを」は省かない');
});

test('IMG_1106: 字幕は1行・15文字以内', () => {
  for (const p of cmp.pages) {
    assert.equal(p.lines.length, 1, p.text);
    assert.ok(p.text.length <= 15, p.text);
  }
});
