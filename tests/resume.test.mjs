// 途中から再開するための計算のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { FPS, buildTimeline } from '../js/plan.js';
import { planSegments, renderBytes, spaceCheck, describeJob, jobPercent, jobIdFor, sameSource, MB } from '../js/resume.js';

const tl = buildTimeline([
  { pieces: [{ start: 0, end: 3 }, { start: 4, end: 6 }], text: '' },     // 3秒 + 2秒
  { pieces: [{ start: 10, end: 30 }], text: '' },                       // 20秒（1区間に収まらない）
  { pieces: [{ start: 40, end: 41 }], text: '' },                       // 1秒
]);

test('書き出しの区間: すべてのコマをちょうど1回ずつ、順番どおりに含む', () => {
  const segs = planSegments(tl, 8);
  const total = tl.reduce((s, c) => s + c.pieces.reduce((a, p) => a + p.frames, 0), 0);
  assert.equal(segs.reduce((s, x) => s + x.frames, 0), total);
  let out = 0;
  for (const seg of segs) {
    assert.ok(Math.abs(seg.outStart - out / FPS) < 1e-9, '区間の開始時刻');
    assert.ok(seg.frames <= 8 * FPS);
    for (const s of seg.slices) {
      const piece = tl[s.c].pieces[s.p];
      // スライスの出力時刻が、区間の中で連続している
      assert.ok(Math.abs(piece.outStart + s.f0 / FPS - out / FPS) < 1e-9);
      assert.ok(s.f0 >= 0 && s.f1 <= piece.frames && s.f1 > s.f0);
      out += s.f1 - s.f0;
    }
  }
  segs.forEach((s, i) => assert.equal(s.index, i));
});

test('書き出しの区間: 1区間に収まるピースは途中で分けない', () => {
  const segs = planSegments(tl, 8);
  // 3秒と2秒のピースは同じ区間、20秒のピースは 8秒ずつに分かれる
  assert.deepEqual(segs[0].slices.map(s => [s.c, s.p, s.f0, s.f1]), [[0, 0, 0, 90], [0, 1, 0, 60], [1, 0, 0, 90]]);
  const split = segs.flatMap(s => s.slices).filter(s => s.c === 1);
  assert.ok(split.length >= 3, '長いピースはコマの位置で分ける');
  // 1秒のピースは、区間に空きがあれば同じ区間に入る
  assert.equal(segs.at(-1).slices.at(-1).c, 2);
  // 区間に分けない（端末が区間をつなげない場合）
  assert.equal(planSegments(tl, Infinity).length, 1);
});

test('10分の動画も区間に分けられる（1区間は数秒・約75区間）', () => {
  const long = buildTimeline(Array.from({ length: 120 }, (_, i) => ({ pieces: [{ start: i * 10, end: i * 10 + 5 }], text: '' })));
  const segs = planSegments(long);
  assert.equal(segs.reduce((s, x) => s + x.frames, 0), 600 * FPS);
  assert.ok(segs.length >= 75 && segs.length <= 120, 'segments=' + segs.length);
});

test('必要な保存容量と、空き容量の確認', () => {
  const r = renderBytes(60);
  assert.ok(r.output > 145 * MB && r.output < 165 * MB, '1分 約150MB（20Mbps）');
  assert.ok(r.total > 2 * r.output, '区間と完成ファイルの両方');
  assert.equal(spaceCheck({ usage: 100 * MB, quota: 200 * MB }, 150 * MB).ok, false);
  assert.equal(spaceCheck({ usage: 100 * MB, quota: 1000 * MB }, 150 * MB).ok, true);
  const unknown = spaceCheck({ usage: null, quota: null }, 150 * MB);
  assert.equal(unknown.ok, true);
  assert.equal(unknown.known, false);
});

test('保存した作業の状態の表示と進み具合', () => {
  const job = {
    stage: 'render', useAsr: true, duration: 60,
    analysis: { audio: { rmsDb: [] }, asr: { done: true }, motion: { done: true } },
    render: { segments: [{ frames: 240 }, { frames: 240 }, { frames: 120 }], done: [true, false, false] },
  };
  const d = describeJob(job);
  assert.ok(d.lines.some(l => l.includes('1/3区間')));
  assert.equal(jobPercent(job), Math.round(30 + 60 * 240 / 600));
  assert.equal(jobPercent({ ...job, stage: 'done' }), 100);
  const partial = { stage: 'analyze', useAsr: false, duration: 100, analysis: { audio: {}, motion: { partial: { nextT: 50 } } } };
  assert.ok(describeJob(partial).lines.some(l => l.includes('50%まで保存済み')));
});

test('動画の見分け: 選び直したときは大きさと長さで確かめる', () => {
  const f = { name: 'IMG_0001.MOV', size: 123456, lastModified: 1 };
  assert.equal(jobIdFor(f), jobIdFor({ ...f, lastModified: 2 }));
  assert.notEqual(jobIdFor(f), jobIdFor({ ...f, size: 1 }));
  const job = { file: { name: 'IMG_0001.MOV', size: 123456 }, duration: 62.1 };
  assert.ok(sameSource(job, { name: 'IMG_0001 2.MOV', size: 123456 }, 62.12));
  assert.ok(!sameSource(job, { name: 'IMG_0001.MOV', size: 123457 }, 62.1));
  assert.ok(!sameSource(job, { name: 'IMG_0001.MOV', size: 123456 }, 30));
});
