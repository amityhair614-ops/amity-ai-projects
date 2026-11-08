// 編集メモ（js/memo.js）: 読み方が1通りに決まる書き方だけを、字幕・カットに使う
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMemo, readMemos } from '../js/memo.js';
import { buildUnits, buildTimeline, setSubtitleWords } from '../js/plan.js';
import { loadFixture, planFixture, rebuildChunks } from './reference.mjs';

test('編集メモを読む: 言い間違い・残す・字幕で省く・用語。読めない文は反映せずに知らせる', () => {
  assert.equal(parseMemo('今回は言い間違いなし').retake, 'no');
  const a = parseMemo('2本目の15秒付近に言い間違いあり');
  assert.equal(a.retake, 'yes');
  assert.deepEqual(a.retakeAt, [{ source: 2, at: 15 }]);
  assert.deepEqual(parseMemo('15秒付近に言い間違いあり', { source: 3 }).retakeAt, [{ source: 3, at: 15 }]);
  assert.deepEqual(parseMemo('2本目の10秒付近は削除しないでほしい').keepAt, [{ source: 2, at: 10 }]);
  assert.deepEqual(parseMemo('「ボブを切る際」は残して').keepText, ['ボブを切る際']);
  assert.deepEqual(parseMemo('字幕では「かなり」を省いてほしい').omitWords, ['かなり']);
  assert.deepEqual(parseMemo('字幕に「でも」を残して').keepWords, ['でも']);
  assert.deepEqual(parseMemo('「すきバサミ」を正確に表示してほしい').terms, ['すきバサミ']);
  const u = parseMemo('ここは削除しないでほしい\nいい感じにして');
  assert.equal(u.unread.length, 2, '場所のわからない指示・あいまいな指示は反映しない');
});

test('編集メモの時刻を、つないだ時刻にする（1本ごとのメモ・全体のメモ）。画面の選択がメモより優先', () => {
  const lay = [{ offset: 0, duration: 11.2 }, { offset: 12.2, duration: 6.2 }, { offset: 19.4, duration: 10.2 }];
  const m = readMemos({ memo: '2本目の3秒付近は削除しないで', memos: [{ text: '' }, { text: '' }, { text: '5秒付近に言い間違いあり' }] }, lay);
  assert.deepEqual(m.keepTimes, [15.2]);
  assert.deepEqual(m.retakeTimes, [24.4]);
  assert.equal(readMemos({ memo: '2本目の15秒付近に言い間違いあり', retake: 'no' }, lay).retake, 'no');
  assert.equal(readMemos({ memo: '9本目の3秒に言い間違いあり' }, lay).retakeTimes.length, 0, '動画の範囲外の時刻は使わない');
});

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/img5980');
const { analysis } = loadFixture(dir);
const args = { duration: analysis.duration, rmsDb: analysis.rmsDb, speech: analysis.speech, chunks: rebuildChunks(analysis), motion: analysis.motion, restarts: analysis.restarts || [] };

test('「言い間違いなし」: 言い直し・くり返しとして発言を取り除かない（声のある発言は全部残す）', () => {
  const auto = buildUnits(args), none = buildUnits({ ...args, retakes: 'no' });
  const removed = us => us.filter(u => u.kind === 'speech' && (u.trimmed || (u.excluded && u.excluded !== 'つなぎ言葉のみ'))).length;
  assert.ok(removed(auto) > 0, '自動判定では言い直しを取り除く素材');
  assert.equal(removed(none), 0);
});

test('「〇秒付近に言い間違いあり」: 取り除ける範囲が見つかっていれば取り除き、なければ確認の印をつける。「削除しないで」は必ず残す', () => {
  const auto = buildUnits(args);
  const opt = auto.find(u => u.trimOption);
  const plain = auto.find(u => u.kind === 'speech' && !u.excluded && !u.trimmed && !u.trimOption && !u.candidate);
  const us = buildUnits({ ...args, retakeTimes: [opt ? (opt.start + opt.end) / 2 : -9, (plain.start + plain.end) / 2], keepTimes: [] });
  const p2 = us.find(u => u.start === plain.start);
  assert.ok(p2.memoRetake && /編集メモ/.test(p2.candidate) && !p2.trimmed, '範囲がわからない所は切らずに印をつける');
  if (opt) assert.ok(us.find(u => u.start === opt.start)?.trimmed, '取り除ける範囲があれば取り除く');
  const ex = auto.find(u => u.excluded && u.excluded !== 'つなぎ言葉のみ');
  if (ex) {
    const k = buildUnits({ ...args, keepTimes: [(ex.start + ex.end) / 2] }).find(u => u.start === ex.start);
    assert.ok(!k.excluded && k.mustKeep, '削除しないでと書いた発言は残す');
  }
});

test('編集メモで「字幕で省く」と書いた言葉は、字幕から省く（声は残す）', () => {
  const f = loadFixture(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/img1108'));
  const all = tl => tl.flatMap(c => c.subtitles.map(p => p.lines.join(''))).join('/');
  const before = planFixture(f.analysis, 55).timeline;
  assert.ok(all(before).includes('髪の毛は'));
  setSubtitleWords({ omit: ['髪の毛は'] });
  try {
    const after = planFixture(f.analysis, 55).timeline;
    assert.ok(!all(after).includes('髪の毛は'), all(after));
    assert.equal(after.reduce((s, c) => s + c.outDuration, 0), before.reduce((s, c) => s + c.outDuration, 0), '動画の長さ（声）は変わらない');
  } finally { setSubtitleWords({}); }
});
