// 話した内容から言い直し・くり返しを見つけるテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeContent, contentTerms } from '../js/content.js';

const C = (texts, gap = 1) => {
  let t = 0;
  return texts.map(text => { const c = { start: t, end: t + 2, text }; t += 2 + gap; return c; });
};

test('訂正の合図: 言い直す前の発言を外し、訂正の言葉も取り除く', () => {
  const r = analyzeContent(C(['ここを軽くします。', 'いや、ここじゃなくて、耳後ろを軽くします。']));
  assert.ok(r[0]?.drop, '言い直す前の発言を外す');
  assert.equal(r[1].trim.cut, 'いや、ここじゃなくて、'.length);
  assert.ok(r[1].trim.high);
  assert.ok(!r[1].drop, '正しい説明は残す');
});

test('文の途中の訂正: 訂正の前の部分を取り除く', () => {
  const t = 'ここを軽くします、いや、耳後ろを軽くします。';
  const r = analyzeContent(C([t]));
  assert.equal(t.slice(r[0].trim.cut), '耳後ろを軽くします。');
  assert.ok(r[0].trim.high, '述語が同じなので確か');
  const t2 = 'パネルを、じゃなくてスライスを取ります。';
  const r2 = analyzeContent(C([t2]));
  assert.equal(t2.slice(r2[0].trim.cut), 'スライスを取ります。');
});

test('同じ説明を続けて2回: 前の方を外す', () => {
  const r = analyzeContent(C(['パネルを45度に引き出してカットします。', 'パネルを45度に引き出してカットします。']));
  assert.ok(r[0]?.drop);
  assert.equal(r[1], null);
});

test('同じ用語でも別の技術の説明は外さない', () => {
  const r = analyzeContent(C([
    'サイドはパネルを45度に引き出してカットします。',
    'バックはパネルを45度に引き出してカットします。',
    'トップはパネルを90度に引き出してカットします。',
  ]));
  assert.deepEqual(r, [null, null, null]);
  const r2 = analyzeContent(C(['毛先を5ミリ切ります。', '毛先を1センチ切ります。']));
  assert.deepEqual(r2, [null, null]);
});

test('文の中のくり返し', () => {
  const t = 'このパネルを、このパネルを45度で引き出します。';
  const r = analyzeContent(C([t]));
  assert.equal(t.slice(r[0].trim.cut), 'このパネルを45度で引き出します。');
});

test('確かでないものは候補にする（外さない）', () => {
  // 訂正の言葉のあと、前の発言と共通の言葉がない
  const r = analyzeContent(C(['では始めましょう。', 'すみません、襟足から切ります。']));
  assert.ok(!r[0]?.drop);
  assert.ok(r[0]?.candidate);
  // 似ているが同じではない（くり返しかどうか確かでない）
  const r2 = analyzeContent(C(['毛先をまっすぐ切りそろえます。', '毛先をまっすぐ切りそろえていきます。']));
  assert.ok(!r2[0]?.drop || r2[0].drop.includes('くり返し'));
});

test('離れた所の似た説明は外さない（30秒より後）', () => {
  const r = analyzeContent(C(['パネルを45度に引き出してカットします。', 'パネルを45度に引き出してカットします。'], 40));
  assert.deepEqual(r, [null, null]);
});

test('言い直しの合図（従来どおり）', () => {
  const r = analyzeContent(C(['次にすきバサミで、', 'あ、すみません、言い直します。', '次にすきバサミで毛量調整をしていきます。']));
  assert.ok(r[0].drop && r[1].drop);
  assert.equal(r[2], null);
});

test('内容を表す言葉', () => {
  assert.deepEqual([...contentTerms('サイドはパネルを45度に引き出します')].sort(), ['45度', 'サイド', 'パネル', '引', '出'].sort());
});

test('文の一部を取り除く: 声の切れ目で切り、元に戻せる', async () => {
  const { FRAME_SEC, detectSpeech, buildUnits, untrimUnit, trimUnit } = await import('../js/plan.js');
  const N = s => Math.round(s / FRAME_SEC);
  const r = new Float32Array(N(20)).fill(-60);
  // 「いや、ここじゃなくて、」1.0〜2.2秒 → 0.25秒の間 → 「耳後ろを軽くします」2.45〜4.0秒
  for (const [a, b] of [[1.0, 2.2], [2.45, 4.0], [8, 9.5]]) for (let i = N(a); i < N(b); i++) r[i] = -20;
  const speech = detectSpeech(r);
  const fine = [{ start: 1.0, end: 2.2 }, { start: 2.45, end: 4.0 }];
  const chunks = [
    { start: 0, end: 0.5, text: '' },
    { start: 1.0, end: 4.0, text: 'いや、ここじゃなくて、耳後ろを軽くします。', fine, subStart: 1.0, subEnd: 4.0 },
    { start: 8, end: 9.5, text: '次はサイドです。' },
  ];
  const units = buildUnits({ duration: 20, rmsDb: r, speech, chunks, motion: null });
  const u = units.find(x => x.text.startsWith('耳後ろ'));
  assert.ok(u, JSON.stringify(units.map(x => x.text)));
  assert.ok(u.start >= 2.2 && u.start <= 2.45, 'start=' + u.start);
  assert.ok(u.subStart >= 2.45);
  assert.ok(u.trimmed && u.reasons.some(x => x.includes('取り除きました')));
  untrimUnit(u);
  assert.ok(u.start < 1.0 && u.text.startsWith('いや'));
  assert.ok(u.trimOption);
  trimUnit(u, u.trimOption);
  assert.ok(u.text.startsWith('耳後ろ'));
});

test('声の切れ目がなければ、文の途中では切らずに候補にする', async () => {
  const { FRAME_SEC, detectSpeech, buildUnits } = await import('../js/plan.js');
  const N = s => Math.round(s / FRAME_SEC);
  const r = new Float32Array(N(20)).fill(-60);
  for (let i = N(1); i < N(4); i++) r[i] = -20;
  const units = buildUnits({
    duration: 20, rmsDb: r, speech: detectSpeech(r), motion: null,
    chunks: [{ start: 1, end: 4, text: 'いや、ここじゃなくて、耳後ろを軽くします。', fine: [{ start: 1, end: 4 }] }],
  });
  const u = units.find(x => x.text);
  assert.ok(!u.trimmed);
  assert.ok(u.text.startsWith('いや'));
  assert.ok(u.candidate && u.candidate.includes('切っていません'));
});
