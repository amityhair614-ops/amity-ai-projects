// 固定テスト素材 IMG_5980（64.97秒）: 手動編集（56.03秒）と比べる。v0.9.4 のAI編集（58.63秒）は、
// 文字起こしAIが「特に蒸す」と聞いた言いかけ（「特に、むす…」→「ギリギリむすべる…」）を残し、字幕の10文字以内は38%だった
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture, planFixture, compare, subtitleStats } from './reference.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/img5980');
const { analysis, manual } = loadFixture(dir);
const { timeline } = planFixture(analysis, manual.targetSec);
const cmp = compare(manual, timeline, analysis);
const stats = subtitleStats(cmp.pages.map(p => p.text), cmp.pages.map(p => p.end - p.start));

test('IMG_5980: 音の繰り返しで見つけた言いかけ（文字起こしAIは別の字にした）を取り除き、長さは手動編集の ±1.5秒以内', () => {
  assert.ok(analysis.restarts.some(r => r.level === 'auto' && r.start > 38 && r.end < 40), JSON.stringify(analysis.restarts));
  for (const s of cmp.spoken.filter(s => s.retake)) assert.ok(s.cover <= 0.1, `言いかけ「${s.text}」を使った（${(s.cover * 100).toFixed(0)}%）`);
  assert.ok(!cmp.pages.some(p => p.text.includes('蒸す')), '言いかけの字幕');
  assert.ok(Math.abs(cmp.outSec - manual.duration) <= 1.5, `${cmp.outSec.toFixed(2)}秒`);
});

test('IMG_5980: 説明の文は削らない', () => {
  for (const s of cmp.spoken.filter(s => !s.retake)) assert.ok(s.cover >= 0.7, `「${s.text}」 ${(s.cover * 100).toFixed(0)}%`);
});

test('IMG_5980: 字幕は1行・平均10文字前後（12文字を超えるのは1割まで・最大15文字）・不要な言葉を出さない・否定と用語を残す', () => {
  for (const p of cmp.pages) assert.ok(p.lines.length === 1 && p.text.length <= 15, p.text);
  assert.ok(stats.avgChars <= 10.5, `平均 ${stats.avgChars.toFixed(1)}文字`);
  assert.ok(stats.over12 <= Math.ceil(cmp.pages.length * 0.1), `12文字を超える字幕 ${stats.over12}枚`);
  // 不自然な日本語にしない（話し言葉の「〜するです」は「〜する」に）・表記をそろえる
  for (const p of cmp.pages) assert.ok(!/[うくすつぬむるぐぶ]です$/.test(p.text) && !p.text.includes('下さい'), p.text);
  assert.equal(stats.unneeded, 0, cmp.pages.map(p => p.text).join(' / '));
  const all = cmp.pages.map(p => p.text).join('');
  for (const w of ['結べなくなります', '軽くしないです', '生え際', 'セルフで']) assert.ok(all.includes(w), w);
  // 単語の途中で切らない
  for (const p of cmp.pages) assert.ok(!/^(?:辺り|際|返し|てください|ください)/.test(p.text), p.text);
});

test('IMG_5980: 字幕AIの聞き取りを音声で確かめた結果（v0.9.7）: 聞き間違い・文の終わりの聞き落としを直し、言いかけを取り除いた後の音声に合わせる', () => {
  const all = cmp.pages.map(p => p.text).join('');
  // 「なった方を」→「なったボブを」（入力したタイトルの「ボブ」が音声に合う）・文の終わり（「結べなく」「やっていき」）を音声から補う
  for (const w of ['ギリギリ結べるように', 'なったボブを', 'やればやるほど', '結べなくなります', 'やっていきましょう']) assert.ok(all.includes(w), w);
  assert.ok(!all.includes('なった方を'), 'なった方を');
  assert.ok(!cmp.pages.some(p => /(?:結べなく|やっていき)$/.test(p.text)), '文の終わりが切れた字幕');
  // 直した所は analysis.json に記録している（音声の点数つき）
  const fixes = analysis.verify.fixes.map(f => `${f.from}→${f.to}`);
  for (const f of ['→なります', '方→ボブ', '→ましょう']) assert.ok(fixes.includes(f), f);
});

