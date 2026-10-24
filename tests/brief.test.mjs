// 編集前の入力（動画の情報・希望時間・編集スタイル）の単体テスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_SEC, detectSpeech, buildUnits, selectUnits, buildTimeline } from '../js/plan.js';
import {
  normalizeBrief, extractTerms, splitItems, flowSteps, matchStrength, briefPlan, applyBrief, applyStyle,
  targetRange, fitReport, fmt, EMPTY_BRIEF,
} from '../js/brief.js';

function makeRms(duration, loud) {
  const arr = new Float32Array(Math.ceil(duration / FRAME_SEC)).fill(-60);
  for (const [s, e] of loud) for (let t = s; t < e; t += FRAME_SEC) arr[Math.floor(t / FRAME_SEC)] = -20;
  return arr;
}

// 5分の動画。12秒ごとに6秒話す。手元は 200〜230秒でよく動く
function fakeVideo(extra = {}) {
  const duration = 300;
  const loud = [], chunks = [];
  const lines = ['今日はボブの切り方を解説します', '最初に全体を濡らしておきます', '耳の後ろで分けていきます', 'ここは指一本分の厚さです',
    '毛先の重さを残すのが大事です', 'クシで真下にとかします', 'ハサミは横に入れます', '反対側も同じようにやります'];
  let i = 0;
  for (let s = 5; s < 290; s += 12, i++) {
    loud.push([s, s + 6]);
    chunks.push({ start: s, end: s + 6, text: extra[i] || lines[i % lines.length] });
  }
  const motion = { times: [], values: [], cx: [] };
  for (let t = 1; t < duration; t++) {
    motion.times.push(t);
    motion.values.push(t > 200 && t < 230 ? 10 : 1 + (t % 7) * 0.1);
    motion.cx.push(0.4);
  }
  const rmsDb = makeRms(duration, loud);
  return { duration, rmsDb, speech: detectSpeech(rmsDb), chunks, motion };
}

const total = sel => sel.reduce((s, u) => s + u.duration, 0);

function plan(v, brief) {
  const bp = briefPlan(brief);
  const units = buildUnits(v);
  const { must } = applyBrief(units, bp);
  applyStyle(units, bp.brief.style);
  const { target, max } = targetRange(bp.brief.targetSec);
  const sel = selectUnits(units, v.duration, target, max, { buckets: bp.buckets });
  return { bp, units, must, sel, fit: fitReport({ targetSec: bp.brief.targetSec, selected: sel, units, sourceDuration: v.duration }) };
}

test('入力なしでも、これまでどおり約60秒の構成になる', () => {
  const v = fakeVideo();
  const a = plan(v, {});
  const units = buildUnits(v);
  const b = selectUnits(units, v.duration);
  assert.deepEqual(a.sel.map(u => u.start), b.map(u => u.start), '入力なしの選び方は従来と同じ');
  assert.ok(a.fit.ok);
  assert.ok(total(a.sel) <= 60 && total(a.sel) >= 50, String(total(a.sel)));
});

test('入力値の正規化: 不正な値・範囲外は安全な値にする', () => {
  assert.deepEqual(normalizeBrief(null), EMPTY_BRIEF);
  assert.equal(normalizeBrief({ targetSec: 5 }).targetSec, 10);
  assert.equal(normalizeBrief({ targetSec: 'abc' }).targetSec, 60);
  assert.equal(normalizeBrief({ format: 'long' }).targetSec, 600);
  assert.equal(normalizeBrief({ format: 'long', targetSec: 99999 }).targetSec, 1800);
  assert.equal(normalizeBrief({ format: 'xxx', style: 'yyy' }).format, 'short');
  assert.equal(normalizeBrief({ style: 'tempo' }).style, 'tempo');
});

test('希望時間 30秒・45秒・60秒・自由入力（20秒）に合わせて長さが変わる', () => {
  const v = fakeVideo();
  for (const sec of [20, 30, 45, 60]) {
    const { sel, fit } = plan(v, { targetSec: sec });
    const t = total(sel);
    assert.ok(t <= sec + 1e-6, `${sec}: ${t}`);
    assert.ok(t >= sec - Math.max(3, sec * 0.1), `${sec}: ${t}`);
    assert.ok(fit.ok, fit.reason);
    for (let i = 1; i < sel.length; i++) assert.ok(sel[i].start > sel[i - 1].start, '元の動画の順番のまま');
  }
});

test('入力した文章から用語を取り出す（説明用の言葉は除く）', () => {
  const t = extractTerms('前下がりボブの切り方。45度で引き出して、襟足をセニングする動画です');
  for (const w of ['前下がり', 'ボブ', '45度', '襟足', 'セニング']) assert.ok(t.includes(w), w + ' / ' + t.join(','));
  assert.ok(!t.includes('動画'));
  assert.deepEqual(extractTerms(''), []);
  assert.deepEqual(splitItems('45度で引き出す説明\n・襟足をセニングするところ\n\n'), ['45度で引き出す説明', '襟足をセニングするところ']);
  assert.equal(flowSteps('冒頭、ブロッキング、カット、仕上がり'), 4);
  assert.equal(flowSteps('冒頭→説明→実践→仕上がり'), 4);
  assert.equal(flowSteps(''), 0);
});

test('伝えたいこと・内容の言葉を話している場面の点数が上がる', () => {
  const v = fakeVideo({ 10: '襟足は45度で引き出して切ります' });
  const base = buildUnits(v).find(u => u.text.includes('襟足'));
  const { units } = plan(v, { message: '襟足は45度で引き出すときれいに収まる' });
  const u = units.find(x => x.text.includes('襟足'));
  assert.ok(u.score > base.score, `${u.score} > ${base.score}`);
  assert.ok(u.reasons.some(r => r.startsWith('伝えたいこと')));
});

test('必ず残したい場面は、点数が低くても・目標時間を超えても残す。理由と予定時間を出す', () => {
  const v = fakeVideo({ 3: '霧吹きでしっかり湿らせます', 14: 'コームの角度を少し倒します' });
  const items = '霧吹きで湿らせる説明\nコームの角度';
  const { sel, must, fit } = plan(v, { targetSec: 10, mustKeep: items });
  assert.equal(must.length, 2);
  assert.ok(must.every(m => m.unit), '2つとも合う発言が見つかる');
  assert.ok(sel.some(u => u.text.includes('霧吹き')));
  assert.ok(sel.some(u => u.text.includes('コーム')));
  // 必ず残す2場面（各約6秒）で10秒を超える → 削らずに理由を表示
  assert.ok(total(sel) > 10);
  assert.equal(fit.ok, false);
  assert.match(fit.reason, /必ず残す場面/);
  assert.ok(fit.planned > 10);
});

test('必ず残したい項目に合う発言がないときは、無理に選ばない', () => {
  const v = fakeVideo();
  const { must, units } = plan(v, { mustKeep: 'パーマのロッドの巻き方' });
  assert.equal(must[0].unit, null);
  assert.ok(!units.some(u => u.mustKeep));
});

test('素材が足りないときは水増しせず、理由と実際の予定時間を出す', () => {
  const duration = 40;
  const rmsDb = makeRms(duration, [[2, 6], [10, 14]]);
  const v = { duration, rmsDb, speech: detectSpeech(rmsDb), chunks: null, motion: null };
  const { fit, sel } = plan(v, { targetSec: 60 });
  assert.equal(fit.ok, false);
  assert.match(fit.reason, /元の動画が40秒/);
  assert.ok(total(sel) < 20);
});

test('素材は十分あるのに短い場合は、場面の区切りが理由だと表示する（素材不足とは言わない）', () => {
  const units = [{ duration: 20, start: 0 }, { duration: 20, start: 30 }];
  const fit = fitReport({ targetSec: 30, selected: [units[0]], units, sourceDuration: 100 });
  assert.equal(fit.ok, false);
  assert.match(fit.reason, /場面の区切り/);
});

test('流れの段階数で、動画全体から順に選ぶ', () => {
  const v = fakeVideo();
  const { bp, sel } = plan(v, { flow: '冒頭、ブロッキング、バック、サイド、トップ、仕上がり' });
  assert.equal(bp.buckets, 6);
  // 6区間のうち、ほとんどの区間から1つ以上選ばれている
  const hit = new Set(sel.map(u => Math.floor(u.start / (v.duration / 6))));
  assert.ok(hit.size >= 5, [...hit].join(','));
});

test('文字起こし用の用語: 入力にある辞書外の言葉だけを渡す', () => {
  const bp = briefPlan({ title: '韓国風レイヤーカット', content: 'くびれミディアムを作ります', mustKeep: 'くびれの位置' });
  assert.ok(bp.asrTerms.includes('韓国風'), bp.asrTerms.join(','));
  assert.ok(bp.asrTerms.includes('ミディアム'));
  assert.ok(!bp.asrTerms.includes('レイヤー'), '辞書にある用語は除く');
  assert.ok(bp.asrTerms.length <= 30);
});

test('編集スタイル: テンポ重視はズームの間隔が短く、それでも 1.10 倍まで', () => {
  const clip = (s, e) => ({ pieces: [{ start: s, end: e }], text: '', motion: 0.8, cx: 0.5, box: [0.35, 0.65, 0.4, 0.6] });
  const clips = [];
  for (let s = 0; s < 60; s += 4) clips.push(clip(s, s + 3));
  const simple = buildTimeline(clips, { srcW: 1080, srcH: 1920, zoom: true, style: 'simple' }).filter(c => c.zoom);
  const tempo = buildTimeline(clips, { srcW: 1080, srcH: 1920, zoom: true, style: 'tempo' }).filter(c => c.zoom);
  assert.ok(tempo.length > simple.length, `${tempo.length} > ${simple.length}`);
  for (const c of [...simple, ...tempo]) assert.ok(c.zoom.z >= 1.03 && c.zoom.z <= 1.10, String(c.zoom.z));
  for (const c of simple) assert.ok(c.zoom.z <= 1.08);
});

test('テンポ重視は長い場面より短い場面を選びやすい', () => {
  const v = fakeVideo();
  const units = buildUnits(v);
  const before = units.map(u => u.score);
  applyStyle(units, 'tempo');
  units.forEach((u, i) => assert.ok(u.duration > 4 ? u.score < before[i] : u.score === before[i]));
});

test('表示用の時間', () => {
  assert.equal(fmt(45), '45秒');
  assert.equal(fmt(600), '10分');
  assert.equal(fmt(95), '1分35秒');
  assert.ok(matchStrength('セニング', '毛先をセニングします') === 1);
});
