// 固定テスト素材 bob（v0.9.2 のルールを作るときに使っていない動画）: 同じルールで作った構成を、手動編集（46.14秒）と比べる。
// 元の撮影はなく、v0.9.0 のAI編集（48.87秒）を元の動画の代わりにしている（tests/fixtures/bob/README.md）
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture, planFixture, compare } from './reference.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/bob');
const { analysis, manual } = loadFixture(dir);
const { timeline } = planFixture(analysis);
const cmp = compare(manual, timeline, analysis);

test('bob: 完成の長さが手動編集（46.14秒）の ±1.5秒以内', () => {
  assert.ok(Math.abs(cmp.outSec - manual.duration) <= 1.5, `${cmp.outSec.toFixed(2)}秒`);
  assert.ok(cmp.iou >= 0.9, `使った範囲の一致 ${(cmp.iou * 100).toFixed(1)}%`);
});

test('bob: 話の途中の間が手動編集と同じくらい（詰めすぎ・残しすぎがない）', () => {
  const p = cmp.pauses, m = manual.pauses;
  assert.ok(Math.abs(p.median - m.median) <= 0.06 && Math.abs(p.p90 - m.p90) <= 0.06 && p.max <= m.max + 0.05, JSON.stringify(p));
});

test('bob: 必要な説明は削らない', () => {
  for (const s of cmp.spoken) assert.ok(s.cover >= 0.8, `「${s.text}」 ${(s.cover * 100).toFixed(0)}%`);
});

test('bob: 字幕は1行・15文字以内で、手動編集の字幕の切れ目（意味のまとまり）の8割以上で切れ目になる', () => {
  for (const p of cmp.pages) {
    assert.equal(p.lines.length, 1, p.text);
    assert.ok(p.text.length <= 15, p.text);
    assert.ok(!/軽く$/.test(p.text) && !/^(?:しない|ない|なく)/.test(p.text), `否定が切り離された: ${p.text}`);
  }
  assert.ok(cmp.breaks.recall >= 0.8, `${(cmp.breaks.recall * 100).toFixed(0)}% ${cmp.breaks.missed.join(' / ')}`);
});
