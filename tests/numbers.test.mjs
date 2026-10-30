// 字幕の数の表示（算用数字にそろえる・数の並び・聞き間違いの可能性）と、読み取れる表示時間のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatNumbers, kanjiNumber, displayText, cleanForDisplay } from '../js/captions.js';
import { numberDoubts, tokensToChunks } from '../js/asrtext.js';
import { subtitlePages, READ_SEC } from '../js/plan.js';

test('数: 回数・長さ・時間・割合は算用数字に（「一回」→「1回」、「三センチ」→「3cm」）', () => {
  const f = s => formatNumbers(s).text;
  assert.equal(f('一回'), '1回');
  assert.equal(f('三センチ切る'), '3cm切る');
  assert.equal(f('十五分おく'), '15分おく');
  assert.equal(f('四十五度で引き出す'), '45度で引き出す');
  assert.equal(f('毛先を五ミリ'), '毛先を5mm');
  assert.equal(f('二割ぐらい'), '2割ぐらい');
  assert.equal(f('一から三度ぐらい'), '1〜3度ぐらい');
  assert.equal(f('二三回入れる'), '2〜3回入れる');
  assert.equal(kanjiNumber('百二十三'), 123);
  assert.equal(kanjiNumber('二十'), 20);
});

test('数: 慣用の言い方と、数ではない漢字は変えない', () => {
  const f = s => formatNumbers(s).text;
  for (const s of ['もう一度切る', '一度ずつ入れていく', '十分です', '二度と切らない', '一緒に', '統一回', '半年以上', '一応']) assert.equal(f(s), s, s);
});

test('数: 続けて数えた所は読点で区切り、同じ数をくり返した所で文を分ける（「1回、2回、3回、4回」「4回は」）', () => {
  const r = formatNumbers('一回二回三回四回四回はね多いかもしれないですが');
  assert.equal(r.text, '1回、2回、3回、4回。4回はね多いかもしれないですが');
  // 字幕のページは「。」で分かれ、数と数える言葉の途中では分かれない
  const pages = subtitlePages(cleanForDisplay('一回二回三回四回四回はね多いかもしれないですが').text, 6).map(p => p.lines.join(''));
  assert.equal(pages[0].replace(/。$/, ''), '1回、2回、3回、4回');
  assert.ok(pages.some(p => p.startsWith('4回は')), pages.join(' / '));
  assert.ok(!pages.some(p => /^[回、]|[0-9]$/.test(p) || /か$/.test(p)), pages.join(' / '));
  // 表示用の字幕: ページの終わりの句読点・調子をとる「ね」は出さない
  assert.equal(displayText('1回、2回、3回、4回。').text, '1回、2回、3回、4回');
  assert.equal(displayText('百二十三度ぐらいね').text, '123度ぐらい');
});

test('数: 数と数える言葉の間に間があっても、文を分けない（「いっ…かい」）', () => {
  const tok = (s, t0, step = 0.15) => [...s].map((c, i) => ({ t: +(t0 + i * step).toFixed(2), s: c, p: 0.9 }));
  const raw = [{ start: 0, end: 5, tokens: [...tok('入れていきます', 0), ...tok('一', 1.4), ...tok('回二回三回', 2.3)] }];
  const fine = [{ start: 0, end: 1.2 }, { start: 1.35, end: 1.5 }, { start: 2.25, end: 3.2 }];
  const chunks = tokensToChunks(raw, fine);
  assert.ok(chunks.some(c => c.text.includes('一回二回')), chunks.map(c => c.text).join(' / '));
});

test('数: 前後の数とかけ離れた数（「1〜4回」の後の「123度」）は要確認にする（直さない）', () => {
  const d = numberDoubts([{ start: 40, text: '一回二回三回四回四回はね多いかもしれないですが' }, { start: 45, text: '百二十三度ぐらいね入れていく' }]);
  assert.equal(d[0].length, 0);
  assert.ok(/123度/.test(d[1][0]) && /1〜4/.test(d[1][0]));
  // 前後に数がない・前後も大きい数なら知らせない
  assert.equal(numberDoubts([{ start: 0, text: '百二十度で引き出す' }])[0].length, 0);
  assert.equal(numberDoubts([{ start: 0, text: '百度' }, { start: 3, text: '九十度' }])[0].length, 0);
});

test('字幕: 読み取れる表示時間の目安（短い字幕でも0.8秒以上・文字数に合わせて長く）', () => {
  assert.ok(READ_SEC.min >= 0.8 && READ_SEC.shift <= 0.3);
});
