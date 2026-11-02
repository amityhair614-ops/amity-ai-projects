// 複数の動画を1本にする時刻の計算（js/sources.js）と、BGMの重ね方（js/audiomix.js の mixBgm）のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { layout, totalDuration, sourceAt, concatFrames, concatPcm, concatMotion, clampPieces, localPiece, checkCompatible, move, GAP, MAX_SOURCES } from '../js/sources.js';
import { mixBgm, BGM } from '../js/audiomix.js';

const lay = layout([{ duration: 29.03 }, { duration: 16 }, { duration: 12.18 }]);

test('複数の動画: 間に無音をはさんで1本に並べ、時刻を動画ごとに戻せる', () => {
  assert.equal(MAX_SOURCES, 3);
  assert.deepEqual(lay.map(s => +s.offset.toFixed(2)), [0, 29.03 + GAP, 29.03 + 16 + 2 * GAP]);
  assert.ok(Math.abs(totalDuration(lay) - (29.03 + 16 + 12.18 + 2 * GAP)) < 1e-9);
  assert.equal(sourceAt(lay, 10).index, 0);
  assert.equal(sourceAt(lay, 31).index, 1);
  assert.equal(sourceAt(lay, 29.3).index, 0); // 間の無音は近い方
  const lp = localPiece(lay, { srcStart: 30.13, frames: 30 });
  assert.equal(lp.source, 1);
  assert.ok(Math.abs(lp.piece.srcStart - 0.1) < 1e-9);
});

test('複数の動画: 音量・文字起こし用の音声・手元の動きを、時刻をずらしてつなぐ', () => {
  const two = layout([{ duration: 1 }, { duration: 1 }]);
  const r = concatFrames([new Float32Array(20).fill(-20), new Float32Array(20).fill(-30)], two, 0.05, -90);
  assert.equal(r[0], -20);
  assert.equal(r[Math.round(1.5 / 0.05)], -90); // 間の無音
  assert.equal(r[Math.round(2.2 / 0.05)], -30);
  const pcm = concatPcm([new Float32Array(16000).fill(0.1), new Float32Array(16000).fill(0.2)], two, 16000);
  assert.equal(pcm[100], Math.fround(0.1));
  assert.equal(pcm[Math.round(1.5 * 16000)], 0);
  assert.equal(pcm[Math.round(2.5 * 16000)], Math.fround(0.2));
  const m = concatMotion([{ times: [0.5], values: [1], cx: [0.5], cy: [0.5], box: [null] }, { times: [0.5], values: [2], cx: [0.4], cy: [0.4], box: [null] }], two);
  assert.deepEqual(m.times, [0.5, 2.5]);
});

test('複数の動画: 場面の使う範囲は、それぞれの動画の中に収める（間の無音・となりの動画にはみ出さない）', () => {
  const p = clampPieces([{ start: 28.5, end: 29.6 }, { start: 29.7, end: 30.4 }, { start: 29.9, end: 29.95 }], lay);
  assert.deepEqual(p.map(x => [+x.start.toFixed(2), +x.end.toFixed(2)]), [[28.5, 29.03], [30.03, 30.4]]);
});

test('複数の動画: 向き・比率が違う動画はまとめない・並べ替え', () => {
  assert.equal(checkCompatible([{ width: 1080, height: 1920 }, { width: 2160, height: 3840 }]), null);
  assert.ok(checkCompatible([{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]));
  assert.ok(checkCompatible([{ width: 1080, height: 1920 }, { width: 1080, height: 1440 }]));
  assert.ok(checkCompatible([{ width: 1, height: 2 }, { width: 1, height: 2 }, { width: 1, height: 2 }, { width: 1, height: 2 }]));
  assert.deepEqual(move(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(move(['a', 'b'], 0, -1), ['a', 'b']);
});

test('BGM: 初期は2%・話している間は半分・冒頭と最後はフェード・0%なら何もしない', () => {
  assert.equal(BGM.volume, 0.02);
  const sr = 1000, len = 4000;
  const music = [new Float32Array(len).fill(1), new Float32Array(len).fill(1)];
  // 前半2秒は無音、後半2秒は話し声（大きな音）
  const voice = new Float32Array(len);
  for (let i = 2000; i < len; i++) voice[i] = 0.3 * Math.sin(i);
  const data = [voice.slice()];
  mixBgm(data, sr, music, 0, 100, { volume: 0.02 });
  const added = i => data[0][i] - voice[i];
  assert.ok(added(100) > 0 && added(100) < added(1600), '冒頭はフェードイン');
  assert.ok(Math.abs(added(1600) - 0.02) < 0.002, `無音の所は2%: ${added(1600)}`);
  assert.ok(Math.abs(added(3900) - 0.01) < 0.002, `話している所は半分: ${added(3900)}`);
  const end = [new Float32Array(len)];
  mixBgm(end, sr, music, 96, 100, { volume: 0.02 });
  assert.ok(end[0][3990] < end[0][100], '最後はフェードアウト');
  const none = [new Float32Array(10)];
  mixBgm(none, sr, [new Float32Array(10).fill(1), new Float32Array(10).fill(1)], 5, 100, { volume: 0 });
  assert.ok(none[0].every(v => v === 0));
});
