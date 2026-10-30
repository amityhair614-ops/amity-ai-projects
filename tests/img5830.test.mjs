// 固定テスト素材 IMG_5830（48.67秒）: アプリの解析結果から作った構成を、手動編集のお手本（40.93秒）と比べる。
// お手本との違いは node tests/reference.mjs で表にして見られる
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture, planFixture, compare } from './reference.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/img5830');
const { analysis, manual } = loadFixture(dir);
const { timeline } = planFixture(analysis);
const cmp = compare(manual, timeline, analysis);

test('IMG_5830: 完成の長さが 40〜42秒（お手本 40.93秒）', () => {
  assert.ok(cmp.outSec >= 40 && cmp.outSec <= 42, `${cmp.outSec.toFixed(2)}秒`);
  assert.ok(cmp.iou >= 0.9, `使った範囲の一致 ${(cmp.iou * 100).toFixed(1)}%`);
});

test('IMG_5830: お手本が削った言い直し（「それもある」・「つむじつむ」）と前後の無音を使わない', () => {
  for (const r of cmp.removed.filter(r => r.dur >= 0.5)) {
    // 最後の無音はフェードアウトに少し使う（お手本は話し終わりに重ねて黒くしている）
    const limit = r.srcEnd >= analysis.duration - 0.1 ? 0.8 : 0.25;
    assert.ok(r.usedSec <= limit, `${r.srcStart}〜${r.srcEnd} を ${r.usedSec.toFixed(2)}秒使った`);
  }
  for (const s of cmp.spoken.filter(s => s.retake)) assert.ok(s.cover <= 0.1, `言い直し「${s.text}」を使った（${(s.cover * 100).toFixed(0)}%）`);
});

test('IMG_5830: 必要な説明は削らない（言い直しでない文はすべて使う）', () => {
  for (const s of cmp.spoken.filter(s => !s.retake)) assert.ok(s.cover >= 0.85, `「${s.text}」 ${(s.cover * 100).toFixed(0)}%`);
});

test('IMG_5830: 字幕はすべて1行・15文字以内で、話すテンポで切り替わる', () => {
  assert.ok(cmp.pages.length >= 14, `${cmp.pages.length}枚（お手本 ${manual.subtitles.length}枚）`);
  for (const p of cmp.pages) {
    assert.equal(p.lines.length, 1, p.text);
    assert.ok(p.text.length <= 15, p.text);
    const d = p.end - p.start;
    assert.ok(d >= 0.5 && d <= 4, `${p.text} ${d.toFixed(2)}秒`);
  }
  // 字幕のない長い時間がない（話している所）
  for (let i = 1; i < cmp.pages.length; i++) assert.ok(cmp.pages[i].start - cmp.pages[i - 1].end < 1.2, `${cmp.pages[i - 1].text} → ${cmp.pages[i].text}`);
  assert.ok(cmp.pages[0].start < 0.5, '最初から字幕が出る');
});

test('IMG_5830: 字幕の意味が変わらない（否定を切り離さない・言い直しを出さない・用語の聞き間違いを直す）', () => {
  const all = cmp.pages.map(p => p.text).join('');
  for (const p of cmp.pages) {
    assert.ok(!/軽く$/.test(p.text) && !/^(?:しない|ない|なく)/.test(p.text), `否定が切り離された: ${p.text}`);
  }
  assert.ok(!all.includes('それもある') && !all.includes('つむじつむつ'), '言い直しの字幕');
  assert.ok(all.includes('すきバサミ') && !all.includes('きばさみ使'), '「すきばさみ」の文の区切り');
  for (const w of ['軽くしないように', '取り返しがつかない', '修正カットができない']) assert.ok(all.includes(w), w);
});

test('IMG_5830: 話の途中の間と字幕の切れ目が手動編集と同じくらい', () => {
  const p = cmp.pauses, m = manual.pauses;
  assert.ok(Math.abs(p.median - m.median) <= 0.06 && Math.abs(p.p90 - m.p90) <= 0.06 && p.max <= m.max + 0.05, JSON.stringify(p));
  assert.ok(cmp.breaks.recall >= 0.75, `${(cmp.breaks.recall * 100).toFixed(0)}% ${cmp.breaks.missed.join(' / ')}`);
});
