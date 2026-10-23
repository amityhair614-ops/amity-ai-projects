// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_SEC, detectSpeech, transcriptionWindows, detectRetakes, buildUnits, selectUnits,
  subtitlePages, wrapLines, cropRect, buildTimeline, keywordHits, FPS,
} from '../js/plan.js';

// 区間 [start,end] だけ音がある dB 配列を作る
function makeRms(duration, loud) {
  const arr = new Float32Array(Math.ceil(duration / FRAME_SEC)).fill(-60);
  for (const [s, e] of loud) for (let t = s; t < e; t += FRAME_SEC) arr[Math.floor(t / FRAME_SEC)] = -20;
  return arr;
}

test('無音を検出し、短い無音はつなげる', () => {
  const rms = makeRms(30, [[1, 3], [3.2, 5], [10, 12]]);
  const { regions } = detectSpeech(rms);
  assert.equal(regions.length, 2);
  assert.ok(Math.abs(regions[0].start - 0.9) < 0.06);
  assert.ok(Math.abs(regions[0].end - 5.1) < 0.06);
  assert.ok(Math.abs(regions[1].start - 9.9) < 0.06);
});

test('全部無音なら話し区間なし', () => {
  assert.equal(detectSpeech(new Float32Array(200).fill(-70)).regions.length, 0);
});

test('文字起こし用の区切りは28秒以内', () => {
  const w = transcriptionWindows([{ start: 0, end: 10 }, { start: 12, end: 25 }, { start: 26, end: 40 }]);
  assert.deepEqual(w, [{ start: 0, end: 25 }, { start: 26, end: 40 }]);
});

test('言い直しを検出する（似た発言・合図の言葉）', () => {
  const flags = detectRetakes([
    { start: 0, end: 3, text: 'まずはバックからブロッキングを' },
    { start: 3.5, end: 7, text: 'まずはバックからブロッキングをしていきます' },
    { start: 8, end: 10, text: '次はサイドを切ります' },
    { start: 11, end: 13, text: 'あ、間違えた、言い直します' },
    { start: 14, end: 17, text: '次はトップを45度で引き出します' },
  ]);
  assert.ok(flags[0]);
  assert.equal(flags[1], null);
  assert.ok(flags[2]);
  assert.ok(flags[3]);
  assert.equal(flags[4], null);
});

test('「もう一回」だけでは言い直しにしない', () => {
  const flags = detectRetakes([
    { start: 0, end: 3, text: 'もう一回ここを確認します' },
    { start: 5, end: 8, text: '毛先を少しすいていきます' },
  ]);
  assert.deepEqual(flags, [null, null]);
});

test('用語の検出', () => {
  assert.deepEqual(keywordHits('45度でパネルを引き出します').sort(), ['パネル', '引き出し', '角度(〇度)'].sort());
});

function fakeVideo() {
  const duration = 600;
  const loud = [];
  const chunks = [];
  const lines = ['今日はボブの切り方を解説します', '最初に全体を濡らしておきます', '耳の後ろで分けていきます', 'ここは指一本分の厚さです', '毛先の重さを残すのが大事です', 'クシで真下にとかします', 'ハサミは横に入れます', '反対側も同じようにやります'];
  for (let s = 5; s < 590; s += 12) {
    loud.push([s, s + 6]);
    chunks.push({ start: s, end: s + 6, text: s % 36 === 5 ? 'ここでブロッキングを分けます' : lines[Math.floor(s / 12) % lines.length] });
  }
  // 無音部分での誤認識
  chunks.push({ start: 595, end: 599, text: 'ご視聴ありがとうございました' });
  chunks.sort((a, b) => a.start - b.start);
  const motion = { times: [], values: [], cx: [] };
  for (let t = 1; t < duration; t++) {
    motion.times.push(t);
    motion.values.push((t > 200 && t < 230) ? 10 : 1 + (t % 7) * 0.1);
    motion.cx.push(0.3);
  }
  const rmsDb = makeRms(duration, loud);
  return { duration, rmsDb, speech: detectSpeech(rmsDb), chunks, motion };
}

test('約60秒以内に収まり、時系列順・冒頭と最後を含む', () => {
  const v = fakeVideo();
  const units = buildUnits(v);
  assert.ok(!units.some(u => u.text.includes('ご視聴')), '無音部分の誤認識は除外');
  assert.ok(units.some(u => u.kind === 'action' && u.start > 195 && u.end < 235), '動きの多い場面が候補になる');
  const sel = selectUnits(units, v.duration);
  const total = sel.reduce((s, u) => s + u.duration, 0);
  assert.ok(total <= 60 && total >= 45, 'total=' + total);
  for (let i = 1; i < sel.length; i++) assert.ok(sel[i].start >= sel[i - 1].start);
  assert.ok(sel.some(u => u.intro));
  assert.ok(sel.some(u => u.ending));
  assert.ok(sel.some(u => u.keywords.length));
});

test('文字起こしなしでも構成できる', () => {
  const v = fakeVideo();
  const units = buildUnits({ ...v, chunks: null });
  const sel = selectUnits(units, v.duration);
  const total = sel.reduce((s, u) => s + u.duration, 0);
  assert.ok(total > 40 && total <= 60);
});

test('字幕の折り返しとページ分け', () => {
  const lines = wrapLines('まずはバックからブロッキングをしていきます、ここが大事です', 13);
  assert.ok(lines.every(l => l.length <= 13));
  assert.ok(!lines.some(l => /^[、。]/.test(l)));
  const pages = subtitlePages('まずはバックからブロッキングをしていきます、ここが大事なポイントになります', 6);
  assert.ok(pages.length >= 2);
  assert.ok(Math.abs(pages[pages.length - 1].end - 6) < 1e-9);
  assert.ok(pages.every(p => p.lines.length <= 2));
});

test('9:16の切り抜き範囲', () => {
  const c = cropRect(1920, 1080, 0.5);
  assert.equal(c.height, 1080);
  assert.equal(c.width, 606);
  assert.equal(c.left, Math.round((1920 - 606) / 2));
  const left = cropRect(1920, 1080, 0.1);
  assert.ok(left.left > 0 && left.left < c.left);
  const p = cropRect(1080, 1920, 0.2);
  assert.deepEqual(p, { left: 0, top: 0, width: 1080, height: 1920 });
});

test('タイムラインと字幕の時刻', () => {
  const tl = buildTimeline([
    { pieces: [{ start: 10, end: 12 }, { start: 12.5, end: 13.5 }], text: 'こんにちは', cx: 0.5 },
    { pieces: [{ start: 30, end: 31 }], text: '', cx: 0.5 },
  ]);
  assert.equal(tl[0].pieces[0].frames, 2 * FPS);
  assert.equal(tl[0].pieces[1].outStart, 2);
  assert.equal(tl[1].outStart, 3);
  assert.equal(tl[0].subtitles[0].end, 3);
  assert.equal(tl[1].subtitles.length, 0);
});
