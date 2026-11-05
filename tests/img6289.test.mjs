// 固定テスト素材 IMG_6289（48.83秒）: 手動編集のお手本（44.60秒）と比べる。字幕は「キリの良い所で止める」・声に合わせて切り替える
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture, planFixture, compare } from './reference.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/img6289');
const { analysis, manual } = loadFixture(dir);
const { timeline } = planFixture(analysis, manual.targetSec);
const cmp = compare(manual, timeline, analysis);
const texts = cmp.pages.map(p => p.text);
// 完成動画の時刻 → 元の動画の時刻
const toSrc = t => { for (const c of timeline) for (const p of c.pieces) if (t >= p.outStart - 1e-6 && t < p.outStart + p.frames / 30 + 1e-6) return p.srcStart + (t - p.outStart); return null; };

test('IMG_6289: 長さ・使った範囲は手動編集に近く、説明を削らない', () => {
  assert.ok(Math.abs(cmp.outSec - manual.duration) <= 1.0, `${cmp.outSec.toFixed(2)}秒`);
  assert.ok(cmp.iou >= 0.94, `${(cmp.iou * 100).toFixed(1)}%`);
  for (const s of cmp.spoken) assert.ok(s.cover >= 0.85, `「${s.text}」 ${(s.cover * 100).toFixed(0)}%`);
});

test('IMG_6289: 字幕はキリの良い所で止める（「軽くしていく際」で一度終わる・言葉の途中で切らない）', () => {
  for (const w of ['軽くしていく際', '今後伸ばしていくなら', 'とにかく落ち着かない', 'やっていきましょう']) assert.ok(texts.includes(w), `${w}: ${texts.join(' / ')}`);
  for (const t of texts) {
    assert.ok(t.length <= 15 && !/^[ぁ-ゖ]{1,2}$/.test(t), t);
    assert.ok(!/(?:今後伸|まと)$|^(?:ばし|まり)/.test(t), `言葉の途中: ${t}`);
  }
});

test('IMG_6289: 字幕に書かない言葉（あと・特に・もし・それが・それを・ね）は省き、省いた言葉の間は次の字幕を出さない', () => {
  const all = texts.join('');
  for (const w of ['あと伸び', '特に', 'もし', 'それが', 'それを', 'がね']) assert.ok(!all.includes(w), w);
  for (const w of ['横の生え際は', '生え際を軽くしてしまうと', '後ろ髪の中です']) assert.ok(texts.includes(w), w);
  // 「そうならないために」（字幕にしない。33.2〜35.2秒）を話している間は字幕を出さず、「伸ばしていく」（字幕AIの「伸」35.65秒）を
  // 話し始めた所から出す
  const p = cmp.pages.find(x => x.text.startsWith('伸ばしていくのであれば'));
  assert.ok(toSrc(p.start) >= 35.2 && toSrc(p.start) <= 35.7, `${toSrc(p.start).toFixed(2)}秒（手動編集 36.2秒）`);
});

test('IMG_6289: 文の途中の字幕の切り替えは、声に合わせる（遅れない）', () => {
  // 「軽くしていく際」は 4.0秒ごろ話し始める（手動編集の切り替え 3.97秒）
  const p = cmp.pages.find(x => x.text === '軽くしていく際');
  assert.ok(Math.abs(toSrc(p.start) - 3.97) <= 0.3, `${toSrc(p.start).toFixed(2)}秒`);
});
