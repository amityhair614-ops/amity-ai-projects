// 自動カットの自然さ（第1段階）のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_SEC, FPS, detectSpeech, shapePieces, PACES, buildUnits, selectUnits, buildTimeline, linkSentences,
} from '../js/plan.js';
import { AudioStitcher, crossfade, XFADE_SEC } from '../js/audiomix.js';

const N = sec => Math.round(sec / FRAME_SEC);

// 区間ごとの音量（dB）を指定して作る。[start, end, db]
function rms(duration, spans, floor = -60) {
  const a = new Float32Array(N(duration)).fill(floor);
  for (const [s, e, db] of spans) for (let i = N(s); i < N(e); i++) a[i] = db;
  return a;
}

test('声の出始め・消えていく語尾まで話している区間に含める', () => {
  // 1.0〜2.0 秒がはっきりした声、その前後 0.15 秒・0.3 秒は小さな音（出始めの子音・弱い語尾）
  const r = rms(10, [[0.85, 1.0, -42], [1.0, 2.0, -20], [2.0, 2.3, -44], [6, 7, -20]]);
  const { voice, regions } = detectSpeech(r);
  assert.equal(voice.length, 2);
  assert.ok(Math.abs(voice[0].start - 0.85) < 0.06, 'start=' + voice[0].start);
  assert.ok(Math.abs(voice[0].end - 2.3) < 0.06, 'end=' + voice[0].end);
  // 小さな音は 0.45 秒までしか広げない（部屋の雑音が大きいときに無音を声と見なさない）
  const r2 = rms(10, [[1, 2, -20], [2, 5, -50]]);
  assert.ok(detectSpeech(r2).voice[0].end <= 2.5);
  assert.ok(regions[0].start < voice[0].start && regions[0].end > voice[0].end, '余白つきの区間');
});

test('ハサミのような短い音がとびとびに続くだけの区間は、話している区間にしない', () => {
  const spans = [[1, 3, -20]];
  for (let t = 5; t < 9; t += 0.25) spans.push([t, t + 0.05, -18]); // 0.25秒おきに 50ms の大きな音
  const { voice, sounds } = detectSpeech(rms(12, spans));
  assert.equal(voice.length, 1);
  assert.equal(sounds.length, 1);
  assert.ok(sounds[0].start >= 4.9 && sounds[0].end <= 9.1);
});

test('間の整理: 文の中の短い間は残し、長い間は自然な長さまで縮める', () => {
  const P = PACES.natural;
  const segs = [{ start: 1, end: 2 }, { start: 2.3, end: 3 }, { start: 5, end: 6 }];
  const pieces = shapePieces(segs, 0, 10, P);
  assert.equal(pieces.length, 2, '0.3秒の間はそのまま、2秒の間で分ける');
  assert.ok(Math.abs(pieces[0].start - (1 - P.lead)) < 1e-9, '話し始めの前に余白');
  assert.equal(pieces[1].end, 6 + P.tail, '話し終わりの後に余白（語尾を切らない）');
  const kept = (pieces[0].end - 3) + (5 - pieces[1].start);
  assert.ok(kept >= P.minGap - 1e-9 && kept <= P.maxGap + 1e-9, '縮めた間 ' + kept);
  assert.ok(pieces[0].end - 3 > 5 - pieces[1].start, '語尾の後を多めに残す');
  // 前後の声に食い込まない
  const tight = shapePieces([{ start: 1, end: 2 }], 0.95, 2.1, P);
  assert.deepEqual(tight, [{ start: 0.95, end: 2.1 }]);
  // テンポ重視は間が短い
  const t = shapePieces(segs, 0, 10, PACES.tempo);
  assert.ok((t[0].end - 3) + (5 - t[1].start) < kept);
});

test('すべての無音をなくさない: 文と文の間は約0.5秒残る', () => {
  const r = rms(20, [[1, 3, -20], [6, 8, -20], [8.6, 10, -20]]);
  const speech = detectSpeech(r);
  const chunks = [
    { start: 1, end: 3, text: '襟足は0度で引き出します。' },
    { start: 6, end: 8, text: '毛先をまっすぐ切ります。' },
    { start: 8.6, end: 10, text: '次はサイドです。' },
  ];
  const units = buildUnits({ duration: 20, rmsDb: r, speech, chunks, motion: null });
  const tl = buildTimeline(units);
  const gaps = [];
  for (let i = 1; i < tl.length; i++) {
    const a = tl[i - 1], b = tl[i];
    const voiceEnd = a.outStart + a.outDuration - (units[i - 1].end - speech.voice[i - 1].end);
    const voiceStart = b.outStart + (speech.voice[i].start - units[i].start);
    gaps.push(voiceStart - voiceEnd);
  }
  assert.ok(gaps[0] > 0.4 && gaps[0] < 0.6, '3秒の間 → ' + gaps[0]);
  // 元の動画で 0.6 秒しかない間は、ほとんど詰めない
  assert.ok(gaps[1] > 0.45 && gaps[1] <= 0.6, '0.6秒の間 → ' + gaps[1]);
});

test('Whisper の時刻が語尾より早く終わっても、声の区間ごと残す（語尾を切らない）', () => {
  const r = rms(10, [[1, 3.2, -20]]);
  const speech = detectSpeech(r);
  const units = buildUnits({ duration: 10, rmsDb: r, speech, chunks: [{ start: 1.1, end: 2.8, text: 'ここがガイドになります。' }], motion: null });
  const u = units.find(x => x.text);
  assert.ok(u.end >= 3.2 + 0.2, 'end=' + u.end);
  assert.ok(u.start <= 1 - 0.1, 'start=' + u.start);
});

test('続けて話した2つの文は、境目の静かな所で分ける', () => {
  // 1〜3秒と 3.15〜5 秒の間は 0.15 秒だけ小さくなる（同じ声の区間になる）
  const r = rms(10, [[1, 3, -20], [3, 3.15, -38], [3.15, 5, -20]]);
  const speech = detectSpeech(r);
  assert.equal(speech.voice.length, 1);
  const units = buildUnits({
    duration: 10, rmsDb: r, speech, motion: null,
    chunks: [{ start: 0.9, end: 3.0, text: 'パネルを引き出します。' }, { start: 3.1, end: 5.1, text: '毛先を切ります。' }],
  });
  const [a, b] = units.filter(u => u.text);
  assert.ok(Math.abs(a.end - 3.1) < 0.1, 'a.end=' + a.end);
  assert.ok(Math.abs(b.start - 3.1) < 0.1, 'b.start=' + b.start);
});

test('「なので」で始まる文は、前の文とまとめて残すか、まとめて外す', () => {
  const units = [
    { id: 'a', kind: 'speech', start: 0, end: 3, text: 'ここがガイドになります。' },
    { id: 'b', kind: 'speech', start: 3.5, end: 6, text: 'なので、ここは慎重に切ってください。' },
    { id: 'c', kind: 'speech', start: 7, end: 9, text: '次はサイドです。' },
  ];
  linkSentences(units);
  assert.equal(units[0].linkNext, 'b');
  assert.equal(units[1].linkNext, undefined);
  for (const u of units) { u.duration = u.end - u.start; u.score = 1; }
  units[1].score = 5; // 「なので…」の点数が一番高い
  const sel = selectUnits(units, 9, 5.5, 6, { buckets: 1 });
  assert.ok(!sel.includes(units[1]) || sel.includes(units[0]), '前の文なしで「なので」だけを残さない');
  const sel2 = selectUnits(units, 9, 5.5, 6.5, { buckets: 1 });
  assert.ok(sel2.includes(units[0]) && sel2.includes(units[1]));
  // 文が終わっていない（「〜て、」）ときも次の文とつなぐ
  const u2 = [
    { id: 'x', kind: 'speech', start: 0, end: 2, text: '指で挟んで、' },
    { id: 'y', kind: 'speech', start: 2.2, end: 4, text: 'まっすぐ切ります。' },
  ];
  linkSentences(u2);
  assert.equal(u2[0].linkNext, 'y');
});

test('タイムライン: 続けて選んだ場面の余白が重なっても、同じ部分を2回使わない', () => {
  const tl = buildTimeline([
    { pieces: [{ start: 1, end: 3.3 }], text: '' },
    { pieces: [{ start: 3.1, end: 5 }], text: '' },
    { pieces: [{ start: 8, end: 9 }], text: '' },
  ]);
  assert.equal(tl[1].pieces[0].srcStart, 3.3);
  assert.equal(tl[1].pieces[0].contiguous, true);
  assert.equal(tl[2].pieces[0].contiguous, false);
  const total = tl.reduce((s, c) => s + c.outDuration, 0);
  assert.ok(Math.abs(total - (4 + 1)) < 2 / FPS, 'total=' + total);
});

test('音声のつなぎ目: 途切れずに入れ替わり、長さは映像と同じ', () => {
  const sr = 1000;
  const mk = (v, n) => [new Float32Array(n).fill(v)];
  const st = new AudioStitcher();
  const extra = Math.round(XFADE_SEC * sr);
  const a = st.add(mk(0.5, 300 + extra), sr, { len: 300 });
  const b = st.add(mk(0.5, 200 + extra), sr, { len: 200, contiguous: false });
  const c = st.add(mk(0.5, 100 + extra), sr, { len: 100, contiguous: true, last: true });
  assert.deepEqual([a[0].length, b[0].length, c[0].length], [300, 200, 100]);
  assert.ok(a[0][0] < 0.05, '最初はフェードイン');
  // 等パワーのクロスフェード: 同じ大きさの雑音どうしなら、つなぎ目で大きく下がらない（0にならない）
  const min = Math.min(...b[0].slice(0, extra));
  assert.ok(min > 0.5 * 0.99, 'min=' + min);
  assert.ok(c[0][99] < 0.05, '最後はフェードアウト');
  // 直線のクロスフェード（元の動画で続いている所）は同じ音なら値が変わらない
  const cur = [new Float32Array(10).fill(0.3)], tail = [new Float32Array(10).fill(0.3)];
  crossfade(cur, tail, 10, false);
  assert.ok(cur[0].every(v => Math.abs(v - 0.3) < 1e-6));
});

test('前の版で保存した字幕の修正も、場面の始まりが少しずれた場面に当てはめる', async () => {
  const { applyEdits } = await import('../js/subedit.js');
  const units = [
    { kind: 'speech', start: 0.82, end: 3, text: 'カネルを引き出します', subStart: 1, subEnd: 3 },
    { kind: 'speech', start: 5.0, end: 7, text: '次はサイドです', subStart: 5.1, subEnd: 7 },
  ];
  const saved = { offset: 0, edits: { '1.00': { text: 'パネルを引き出します' }, '5.00': { text: '次はサイドです。' } } };
  assert.equal(applyEdits(units, saved), 2);
  assert.equal(units[0].text, 'パネルを引き出します');
  assert.equal(units[1].text, '次はサイドです。');
});

test('文字起こしがないときも、考えながら話す短い間（1.2秒未満）で文を分けて片方だけ残さない', () => {
  const r = rms(30, [[1, 3, -20], [3.9, 6, -20], [10, 12, -20], [20, 22, -20]]);
  const speech = detectSpeech(r);
  const units = buildUnits({ duration: 30, rmsDb: r, speech, chunks: null, motion: null });
  const [a, b, c] = units;
  assert.equal(a.linkNext, b.id, '0.9秒の間 → 同じ文の続き');
  assert.equal(b.linkNext, undefined, '4秒の間 → 別の文');
  assert.equal(c.linkNext, undefined);
  b.score = 10;
  const sel = selectUnits(units, 30, 4, 4.5, { buckets: 1 });
  assert.ok(!sel.includes(b) || sel.includes(a));
});

test('話していない作業場面は、目標の時間の40%まで（説明を削りすぎない）', () => {
  const units = [];
  for (let i = 0; i < 10; i++) units.push({ id: 'a' + i, kind: 'action', start: i * 10, end: i * 10 + 3, duration: 3, score: 5 });
  for (let i = 0; i < 10; i++) units.push({ id: 's' + i, kind: 'speech', start: i * 10 + 5, end: i * 10 + 8, duration: 3, score: 2, text: '説明します。' });
  units.sort((x, y) => x.start - y.start);
  const sel = selectUnits(units, 100, 30, 31, { buckets: 3 });
  const action = sel.filter(u => u.kind === 'action').reduce((s, u) => s + u.duration, 0);
  assert.ok(action <= 30 * 0.4 + 1e-9, 'action=' + action);
  assert.ok(sel.reduce((s, u) => s + u.duration, 0) >= 27);
});

test('言い直した後の発言は残しやすくする', () => {
  const r = rms(20, [[1, 3, -20], [4, 5, -20], [6, 8, -20], [10, 12, -20]]);
  const units = buildUnits({
    duration: 20, rmsDb: r, speech: detectSpeech(r), motion: null,
    chunks: [
      { start: 1, end: 3, text: '次にすきバサミで、' },
      { start: 4, end: 5, text: 'すみません、言い直します。' },
      { start: 6, end: 8, text: '次にすきバサミで毛量調整をしていきます。' },
      { start: 10, end: 12, text: '仕上がりです。' },
    ],
  });
  const redo = units.find(u => u.text.startsWith('次にすきバサミで毛量'));
  assert.ok(redo.redo && redo.reasons.includes('言い直した説明'));
  assert.ok(units[0].excluded && units[1].excluded);
});
