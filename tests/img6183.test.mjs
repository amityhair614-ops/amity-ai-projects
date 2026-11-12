// 固定テスト素材 IMG_6183（61.67秒）: 手動編集のお手本（57.37秒）と比べる。字幕は「ポイントだけ」（意味が変わらない言葉は書かない）
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture, planFixture, compare } from './reference.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/img6183');
const { analysis, manual } = loadFixture(dir);
const { timeline, units } = planFixture(analysis, manual.targetSec);
const cmp = compare(manual, timeline, analysis);
const texts = cmp.pages.map(p => p.text);

test('IMG_6183: 長さは手動編集の ±1.5秒以内・説明は削らない', () => {
  assert.ok(Math.abs(cmp.outSec - manual.duration) <= 1.5, `${cmp.outSec.toFixed(2)}秒`);
  for (const s of cmp.spoken) assert.ok(s.cover >= 0.85, `「${s.text}」 ${(s.cover * 100).toFixed(0)}%`);
});

test('IMG_6183: 字幕に出ている言葉は音声も残す（短い言葉「次」を声の区間から落とさない）', () => {
  const u = units.find(x => x.text.startsWith('次左'));
  assert.ok(u.pieces[0].start <= 16.0, `「次」の声（16.0〜16.2秒）: ${u.pieces[0].start.toFixed(2)}秒から`);
});

test('IMG_6183: 字幕はポイントだけ（このように・それは・そうならないために・しかも は書かない。否定・条件は残す）', () => {
  const all = texts.join('');
  for (const w of ['このように', 'それは', 'そうならないために', 'しかも']) assert.ok(!all.includes(w), w);
  for (const w of ['左右何度も', '同じように切り進める', '目印をつけて', '残したい長さに', 'ガタガタになりにくいです', 'やっていきましょう']) assert.ok(all.includes(w), w);
  for (const p of cmp.pages) assert.ok(p.text.length <= 15 && p.lines.length === 1, p.text);
});
