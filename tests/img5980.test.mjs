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

test('IMG_5980: 字幕は1行・8割以上が10文字以内・不要な言葉を出さない・否定と用語を残す', () => {
  for (const p of cmp.pages) assert.ok(p.lines.length === 1 && p.text.length <= 14, p.text);
  assert.ok(stats.within10 >= 0.8, `10文字以内 ${(stats.within10 * 100).toFixed(0)}%`);
  assert.equal(stats.unneeded, 0, cmp.pages.map(p => p.text).join(' / '));
  const all = cmp.pages.map(p => p.text).join('');
  for (const w of ['結べなくなります', '軽くしないです', '生え際', 'セルフで']) assert.ok(all.includes(w), w);
  // 単語の途中で切らない
  for (const p of cmp.pages) assert.ok(!/^(?:辺り|際|返し|てください|ください)/.test(p.text), p.text);
});
