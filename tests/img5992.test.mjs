// 固定テスト素材 IMG_5992（57.90秒・言い間違いがほとんどない動画）: 数の字幕・聞き取りの確かめ・読み取れる表示時間を、
// 手動編集のお手本（55.67秒）と比べる。言い直しの削除の確かめは、言い直しのある素材（IMG_5830・bob・IMG_5980）で行う
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture, planFixture, compare } from './reference.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/img5992');
const { analysis, manual } = loadFixture(dir);
const { timeline } = planFixture(analysis, manual.targetSec);
const cmp = compare(manual, timeline, analysis);
const texts = cmp.pages.map(p => p.text);

test('IMG_5992: 長さは手動編集の ±1.5秒以内・必要な説明は削らない', () => {
  assert.ok(Math.abs(cmp.outSec - manual.duration) <= 1.5, `${cmp.outSec.toFixed(2)}秒`);
  for (const s of cmp.spoken) assert.ok(s.cover >= 0.85, `「${s.text}」 ${(s.cover * 100).toFixed(0)}%`);
});

test('IMG_5992: 数は算用数字で、数えた所は「1回、2回、3回、4回」・くり返した「4回は」で切り替わる', () => {
  assert.ok(texts.includes('1回、2回、3回、4回'), texts.join(' / '));
  assert.ok(texts.some(t => t.startsWith('4回は多いかもしれない')), texts.join(' / '));
  // 漢字の数・数え方の途中での切れ目・「ー」に見える「一」が残っていない
  assert.ok(!texts.some(t => /[二三四五六七八九十百][回度]|一回|^回|[0-9]$|ます一$|ますー$/.test(t)), texts.join(' / '));
  assert.ok(texts.includes('一度ずつ入れていきます'), '慣用の「一度ずつ」は漢字のまま');
  // 「123度」（手動編集は「1〜3度」）は音声だけでは直せないので、直さずに要確認
  const c = analysis.chunks.find(x => x.text.includes('百二十三度'));
  assert.ok(c?.doubts?.some(d => /123度/.test(d)), '数の聞き間違いの要確認');
});

test('IMG_5992: 字幕AIの聞き取りを音声で確かめた結果（「ベタ」→「ベター」・「持先」→「毛先」・「ましょ小」→「ましょう」）', () => {
  const all = texts.join('');
  for (const w of ['ベターなのか', '毛先に向かって', 'やっていきましょう', '入れていきます']) assert.ok(all.includes(w), w);
  assert.ok(!all.includes('ベタな') && !all.includes('持先') && !all.includes('ましょ小') && !all.includes('いきでは'));
});

test('IMG_5992: 字幕は1行・短い意味のまとまりで、どの字幕も読み取れる時間（0.8秒以上）出る', () => {
  for (const p of cmp.pages) {
    assert.equal(p.lines.length, 1, p.text);
    assert.ok(p.text.length <= 15, p.text);
    assert.ok(p.end - p.start >= 0.79, `${p.text} ${(p.end - p.start).toFixed(2)}秒`);
  }
  assert.ok(!texts.some(t => /か$/.test(t) && !/のか$/.test(t)), '「か／もしれない」で切らない');
  assert.ok(cmp.breaks.recall >= 0.85, `${(cmp.breaks.recall * 100).toFixed(0)}%`);
});
