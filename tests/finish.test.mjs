// 手動編集のお手本に近づけるための処理（冒頭のテキスト・最後のフェード・内容を優先した場面選び・
// 1文字ごとの時刻からの文の区切り・用語の直し・原稿との照合）のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openingLines, openingText, openingPlan, openingAlpha, endFadeAlpha, END_FADE, END_HOLD, selectUnits, outputLength,
  extendEnding, wrapLines, setBreakTerms, buildTimeline, subtitlePages,
} from '../js/plan.js';
import { applyEndFade } from '../js/audiomix.js';
import { tokensToChunks, fixTerms, checkRanges, alignScript, scriptTextFor } from '../js/asrtext.js';
import { analyzeContent } from '../js/content.js';

test('冒頭のテキスト: タイトルから最大3行の案を作る（言葉の途中で改行しない）', () => {
  assert.deepEqual(openingLines('ハサミ・すきバサミ以外にもある'), ['ハサミ', 'すきバサミ', '以外にもある']);
  assert.deepEqual(openingLines('前下がりボブの切り方'), ['前下がり', 'ボブの切り方']);
  assert.ok(openingLines('とても長いタイトルの動画です、ブロッキングからセニングまで全部まとめて解説します').length <= 3);
  assert.deepEqual(openingLines(''), []);
  assert.deepEqual(openingText('ハサミ\nすきバサミ\n以外にもある\n4行目'), ['ハサミ', 'すきバサミ', '以外にもある']);
});

test('冒頭のテキスト: 標準は1秒（お手本は約0.7秒）、表示時間は0.6〜4秒で変えられる、すばやく出て消える', () => {
  const op = openingPlan(['ハサミ']);
  assert.ok(Math.abs(op.end - op.start - 1) < 1e-9);
  assert.ok(Math.abs(openingPlan(['ハサミ'], 3).end - openingPlan(['ハサミ'], 3).start - 3) < 1e-9);
  assert.ok(Math.abs(openingPlan(['ハサミ'], 10).end - openingPlan(['ハサミ'], 10).start - 4) < 1e-9, '長すぎる指定は4秒まで');
  assert.equal(openingAlpha(op, op.start), 0);
  assert.equal(openingAlpha(op, (op.start + op.end) / 2), 1);
  assert.ok(openingAlpha(op, op.start + 0.05) > 0 && openingAlpha(op, op.start + 0.05) < 1);
  assert.equal(openingAlpha(op, op.end + 0.01), 0);
  assert.equal(openingPlan([]), null);
  // 最初の場面で手元が上の方で動くときは、文字を下げる
  const low = openingPlan(['ハサミ'], 2, { inCrop: [0.2, 0.8, 0.1, 0.45], motion: 0.6 });
  assert.ok(low.y > op.y);
});

test('最後のフェード: 0.9秒でなめらかに黒くなり、最後の0.2秒は真っ黒・無音のまま終わる', () => {
  const total = 60, endAt = total - END_HOLD;
  assert.equal(endFadeAlpha(total - 2, total), 0);
  assert.equal(endFadeAlpha(endAt - END_FADE, total), 0);
  const mid = endFadeAlpha(endAt - END_FADE / 2, total);
  assert.ok(mid > 0.4 && mid < 0.6);
  assert.equal(endFadeAlpha(endAt, total), 1);
  assert.equal(endFadeAlpha(total - 0.1, total), 1, '黒い画面を保つ');
  assert.equal(endFadeAlpha(total - 1 / 30, total), 1, '最後のコマは完全に黒');
  const sr = 1000;
  const data = [new Float32Array(2000).fill(0.5)]; // 出力の 58〜60秒
  applyEndFade(data, sr, 58, total, END_FADE, END_HOLD);
  assert.equal(data[0][0], 0.5);
  assert.ok(data[0][700] > 0.49, 'フェードの前は変えない');
  const am = data[0][Math.round((endAt - END_FADE / 2 - 58) * sr)];
  assert.ok(am > 0.1 && am < 0.4, '音声も映像と同じ時間で小さくなる ' + am);
  assert.ok(data[0][Math.round((endAt - 58) * sr) + 5] < 1e-6, '黒い間は無音');
  assert.equal(data[0][1999], 0);
});

test('最後の場面は、次の声の手前まで少し延ばす（フェードが声にかからないように）', () => {
  const clips = [{ pieces: [{ start: 0, end: 5 }], end: 5 }];
  const out = extendEnding(clips, [{ start: 0.2, end: 4.8 }, { start: 5.3, end: 6 }], 10);
  assert.ok(Math.abs(out[0].pieces[0].end - 5.25) < 1e-9);
  const out2 = extendEnding(clips, [{ start: 0.2, end: 4.8 }], 10);
  assert.ok(out2[0].pieces[0].end > 5.3);
});

test('場面選び: 話している文は文ごとすべて残し、目標の範囲に収まるならそのまま', () => {
  const units = [];
  for (let i = 0; i < 10; i++) units.push({ id: 's' + i, kind: 'speech', start: i * 7, end: i * 7 + 6, duration: 6, score: 1, text: '説明します。', pieces: [{ start: i * 7, end: i * 7 + 6 }] });
  units[0].intro = true;
  const sel = selectUnits(units, 70, 60, 65);
  assert.equal(sel.length, 10, '60秒の目標に対して60秒の話 → すべて残す');
  assert.equal(outputLength(sel), 60);
});

test('場面選び: 目標を大きく超えるときだけ、点数の低い文を文ごと外す。外した後も下限は下回らない', () => {
  const units = [];
  for (let i = 0; i < 15; i++) units.push({ id: 's' + i, kind: 'speech', start: i * 7, end: i * 7 + 6, duration: 6, score: i % 3 ? 2 : 1, text: '説明します。', pieces: [{ start: i * 7, end: i * 7 + 6 }] });
  const sel = selectUnits(units, 105, 60, 65);
  const len = outputLength(sel);
  assert.ok(len >= 55 && len <= 67.5, 'len=' + len);
  // 外したのは点数の低い文
  for (const u of units.filter(u => !sel.includes(u))) assert.equal(u.score, 1);
});

test('場面選び: 上限を少し超えるだけなら、説明の文を外さない（内容を優先）', () => {
  const units = [];
  for (let i = 0; i < 11; i++) units.push({ id: 's' + i, kind: 'speech', start: i * 7, end: i * 7 + 6, duration: 6, score: 1, text: '説明します。', pieces: [{ start: i * 7, end: i * 7 + 6 }] });
  const sel = selectUnits(units, 80, 60, 65); // 66秒
  assert.equal(sel.length, 11);
});

test('完成の長さは、続けて選んだ場面の重なる余白を1回だけ数える', () => {
  assert.equal(outputLength([{ pieces: [{ start: 0, end: 3 }] }, { pieces: [{ start: 2.5, end: 5 }] }]), 5);
});

test('字幕の改行: 入力した用語・美容用語の途中で改行しない', () => {
  setBreakTerms(['ヘアカッター']);
  const lines = wrapLines('それは100均で売っているヘアカッターです', 13);
  assert.ok(!lines.some((l, i) => i > 0 && lines[i - 1].endsWith('ヘア')), JSON.stringify(lines));
  const lines2 = wrapLines('セルフカットでハサミやすきバサミ以外もあります', 13);
  assert.ok(!lines2.some((l, i) => i > 0 && lines2[i - 1].endsWith('すき')), JSON.stringify(lines2));
  setBreakTerms([]);
});

test('字幕はいつも画面の下・ズームは控えめ（1.03〜1.08倍）で寄る・引くを交互に', () => {
  const clip = (s, e, motion, box) => ({ pieces: [{ start: s, end: e }], text: '説明します', motion, cx: 0.5, box });
  const tl = buildTimeline([clip(0, 5, 0.1, null), clip(6, 11, 0.1, null), clip(30, 36, 0.1, null), clip(60, 66, 0.1, null)], { srcW: 2160, srcH: 3840, zoom: true });
  assert.ok(tl.every(c => c.subPos === 'bottom'));
  const z = tl.filter(c => c.zoom);
  assert.ok(z.length >= 1, '手元が動かない動画でも、長い説明の場面で控えめにズームする');
  assert.ok(z.every(c => c.zoom.z >= 1.03 && c.zoom.z <= 1.08));
  if (z.length > 1) assert.notEqual(z[0].zoom.dir, z[1].zoom.dir);
});

// ReazonSpeech の結果（1文字ごとの時刻）を、声の切れ目で文に分ける
function toks(str, t0, step = 0.12) {
  return [...str].map((s, i) => ({ t: +(t0 + i * step).toFixed(2), s, p: 0.95 }));
}

test('文字ごとの時刻と声の切れ目から、文に分けて句読点を入れる', () => {
  const a = toks('ここを軽くします', 1.0);
  const b = toks('次は耳後ろです', 3.0);
  const fine = [{ start: 0.9, end: 2.0 }, { start: 2.9, end: 3.9 }];
  const chunks = tokensToChunks([{ tokens: [...a, ...b] }], fine);
  assert.deepEqual(chunks.map(c => c.text), ['ここを軽くします', '次は耳後ろです']);
  assert.equal(chunks[0].times.length, chunks[0].text.length);
  assert.ok(chunks[0].start <= 1.0 && chunks[1].start >= 2.0);
  // 間なく続けて話した「〜ます」「〜です」でも分ける。「ますが」のように続く言葉では分けない
  const c = toks('切りますそれは大事です', 1.0);
  const fine2 = [{ start: 0.9, end: 2.5 }];
  assert.deepEqual(tokensToChunks([{ tokens: c }], fine2).map(x => x.text), ['切ります', 'それは大事です']);
  const d = toks('切りますが大事です', 1.0);
  assert.deepEqual(tokensToChunks([{ tokens: d }], fine2).map(x => x.text), ['切りますが大事です']);
});

test('用語の直し: 読みが同じ書き方は自動で直し、入力した用語に近いカタカナ語は直して確認の印をつける', () => {
  const c = { text: 'はさみすきばさみ以外にも百均のAカッター', times: [...Array(20).keys()].map(i => i * 0.1) };
  const f = fixTerms(c, ['ヘアカッター']);
  assert.equal(f.text, 'ハサミすきバサミ以外にも100均のヘアカッター');
  assert.equal(f.times.length, f.text.length);
  const r = checkRanges(f);
  assert.ok(r.some(([a, b]) => f.text.slice(a, b) === 'ヘアカッター'));
  assert.ok(!r.some(([a, b]) => f.text.slice(a, b) === 'ハサミ'), '読みが同じものは確認不要');
  // 普通の言葉は直さない
  assert.equal(fixTerms({ text: 'まるで違う' }, []).text, 'まるで違う');
});

test('確認が必要な箇所: 文字起こしの確からしさが低い文字', () => {
  const tokens = toks('今どきスタイル', 0).map((t, i) => ({ ...t, p: i === 1 ? 0.3 : 0.9 }));
  const r = checkRanges({ text: '今どきスタイル', tokens, times: tokens.map(t => t.t) });
  assert.deepEqual(r, [[1, 2]]);
});

test('原稿との照合: 原稿の文字に話した時刻をつけ、場面ごとの字幕を原稿から作る', () => {
  const script = 'ここを軽くします。\n次は、耳後ろです。';
  // 文字起こしは書き間違い（軽く→かるく）と、原稿にない言い直し（いやいや）を含む
  const chunks = [
    { start: 1, end: 2.5, text: 'ここをかるくします', times: [...'ここをかるくします'].map((_, i) => 1 + i * 0.15) },
    { start: 3, end: 3.6, text: 'いやいや', times: [3, 3.15, 3.3, 3.45] },
    { start: 4, end: 5.5, text: '次は耳後ろです', times: [...'次は耳後ろです'].map((_, i) => 4 + i * 0.2) },
  ];
  const al = alignScript(script, chunks);
  assert.ok(al.matched > 0.6, String(al.matched));
  const u1 = { start: 0.9, end: 2.6, voiceStart: 1, voiceEnd: 2.4, pieces: [{ start: 0.9, end: 2.6 }] };
  const u2 = { start: 2.9, end: 3.7, voiceStart: 3, voiceEnd: 3.6, pieces: [{ start: 2.9, end: 3.7 }] };
  const u3 = { start: 3.9, end: 5.6, voiceStart: 4, voiceEnd: 5.4, pieces: [{ start: 3.9, end: 5.6 }] };
  assert.equal(scriptTextFor(al, u1), 'ここを軽くします');
  assert.equal(scriptTextFor(al, u2), '', '原稿にない発言には原稿の文字をつけない');
  assert.equal(scriptTextFor(al, u3), '次は、耳後ろです');
});

test('同じ言い出しで話し直した所（「このようなヘアカッターこのようなアイテム」）を、言い直し前として取り除く', () => {
  const r = analyzeContent([{ start: 0, end: 5, text: 'このようなヘアカッターこのようなアイテム名前はヘアカッターです' }]);
  assert.ok(r[0]?.trim);
  assert.equal('このようなヘアカッターこのようなアイテム名前はヘアカッターです'.slice(r[0].trim.cut), 'このようなアイテム名前はヘアカッターです');
});

test('画質: 1080pの素材では、拡大になる（ぼやける）ズームはしない。4Kの素材ではズームする', () => {
  const clip = (s, e) => ({ pieces: [{ start: s, end: e }], text: '説明します', motion: 0.6, cx: 0.5, box: [0.4, 0.6, 0.4, 0.6] });
  const clips = [clip(0, 5), clip(6, 11), clip(30, 36), clip(60, 66)];
  assert.ok(buildTimeline(clips, { srcW: 1080, srcH: 1920, zoom: true }).every(c => !c.zoom));
  assert.ok(buildTimeline(clips, { srcW: 2160, srcH: 3840, zoom: true }).some(c => c.zoom));
});

test('字幕の区切り: 1行だけ・15文字以内で、言葉の途中（「まと／まり」「頭に／入れて」）・否定の前（「軽く／しない」）では分けない', () => {
  const pages = t => subtitlePages(t, t.length * 0.15).map(p => { assert.equal(p.lines.length, 1, '2行にしない'); return p.lines[0]; });
  const a = pages('アホ毛のようなピンピンした髪の毛がたくさんできてしまってまとまりつかないようになってしまいます');
  for (const x of a) assert.ok(x.length <= 15, x);
  assert.ok(a.some(x => x.startsWith('まとまり')) && !a.some(x => x.endsWith('まと')));
  assert.deepEqual(pages('それを頭に入れてセルフカットやってみてください'), ['それを頭に入れて', 'セルフカットやってみてください']);
  assert.equal(pages('セルフカットで伸びて重くなったボブを軽くしていく際にこの場所は絶対にすかないでください').at(-1), '絶対にすかないでください');
  // 「して／しまう」「て／ください」は分けない
  for (const x of pages('こうなってしまうと髪の毛が伸びないと修正カットができないです')) assert.ok(!x.startsWith('しま'), x);
  // 否定の言葉を前の言葉から離さない（前のページだけで意味が逆にならないように）
  for (const t of ['つむじやつむじ周りを軽くしないようにしておきましょう', '髪の毛が伸びないと修正カットができないんですよね']) {
    for (const x of pages(t)) assert.ok(!/^(?:しない|ない|できない)/.test(x) && !/軽く$/.test(x), x);
  }
});

test('入力した用語と漢字の所だけが違う言葉（同じ読みの聞き間違い）を直して、確認の印をつける', () => {
  const c = fixTerms({ start: 0, end: 3, text: 'トップの根元布巾、この場所を' }, ['トップの根元付近']);
  assert.equal(c.text, 'トップの根元付近、この場所を');
  assert.ok(c.fixed.some(f => f.from === 'トップの根元布巾' && f.check));
  // ひらがな・カタカナが違うときや、違う文字が多いときは直さない
  assert.equal(fixTerms({ start: 0, end: 3, text: 'トップの根本ふきん' }, ['トップの根元付近']).text, 'トップの根本ふきん');
  assert.equal(fixTerms({ start: 0, end: 3, text: '全体の毛先部分' }, ['トップの根元付近']).text, '全体の毛先部分');
  // 1文字だけ違う（別の意味の言葉かもしれない）ときは直さない
  assert.equal(fixTerms({ start: 0, end: 3, text: '前上がりのボブ' }, ['前下がりのボブ']).text, '前上がりのボブ');
});

test('文字起こしをしたのに文字にならなかった短い声（2秒未満）は、初めは使わず候補にする', () => {
  const units = [
    { id: 'a', kind: 'speech', start: 0, end: 4, duration: 4, pieces: [{ start: 0, end: 4 }], text: 'それはどこなのか', score: 2 },
    { id: 'b', kind: 'speech', start: 4.5, end: 5.8, duration: 1.3, pieces: [{ start: 4.5, end: 5.8 }], text: '', score: 0.4, optional: true },
    { id: 'c', kind: 'speech', start: 6, end: 9, duration: 3, pieces: [{ start: 6, end: 9 }], text: 'トップの根元付近です', score: 2 },
  ];
  const sel = selectUnits(units, 10, 7, 9).map(u => u.id);
  assert.deepEqual(sel, ['a', 'c']);
});

test('意味が変わるおそれのある聞き落とし: 2通りの聞き取りで否定・用語が違う、文の終わりが言葉の途中', async () => {
  const { hasNegation } = await import('../js/plan.js');
  const { cutEnding } = await import('../js/asrtext.js');
  assert.ok(hasNegation('根元付近は軽くしない') && hasNegation('カバーできません') && !hasNegation('カバーできます'));
  // 文の終わりが言葉の途中
  assert.ok(cutEnding('となればトップ表面の根元付近は軽く'));
  assert.ok(cutEnding('根元付近は軽くし'));
  for (const t of ['セルフカットやってみてください', '修正カットができない', 'この場所を軽くしてしまうと', 'それはどこなのか', 'うまくカバーできます']) assert.ok(!cutEnding(t), t);
});

test('字幕の区切り（実際の撮影音声の文）: 「でき」「アホ毛のような」を分けず、1つの字幕に2つの文を入れない', () => {
  const pages = t => subtitlePages(t, t.length * 0.15).map(p => p.lines.join('／'));
  const a = pages('この場所を軽くしてしまうとアホ毛のようなピンピンした髪の毛がたくさんできてしまってまとまりつかないようになってしまいます');
  assert.equal(a[0], 'この場所を軽くしてしまうと');
  for (const x of a) assert.ok(!/^(毛|き|の|ような)/.test(x) && x.length <= 15, x);
  // 「…軽くしない」で文が終わり「それを…」から次の文: 2つの文を1つの字幕にしない
  const b = pages('となればトップ表面の根元付近は軽くしないそれを頭に入れてセルフカットやってみてください');
  assert.ok(b.some(x => x.endsWith('軽くしない')) && b.some(x => x.startsWith('それを')), b.join(' | '));
  // 声の間（字幕AIの時刻のずれ）が言葉の途中にあっても、言葉の途中では分けない
  const p = subtitlePages('この場所を軽くしてしまうとアホ毛のようなピンピンした髪の毛がたくさんできてしまってまとまりつかないようになってしまいます', 8, 18, 2, i => (i % 3 === 0 ? 0.4 : 0));
  for (const x of p.flatMap(q => q.lines)) assert.ok(!/^(毛|き|の)/.test(x), x);
});

test('髪の話でよく聞き間違える同じ読みの漢字（痛んで→傷んで）を直し、確認の印をつける', () => {
  const c = fixTerms({ start: 0, end: 2, text: '痛んでも見えやすいです' });
  assert.equal(c.text, '傷んでも見えやすいです');
  assert.ok(c.fixed.some(f => f.check));
});

test('文の始まりの言葉（あとは）の途中で文が分かれたときは、言葉の前で分ける', () => {
  const tok = (s, t0, step = 0.12) => [...s].map((c, i) => ({ s: c, t: +(t0 + i * step).toFixed(2), p: 1 }));
  // 「しまいあ」のあとに0.6秒の間（字幕AIが「ます」を落とし、「あ」と「とは」の間で切れた）
  const raw = [{ start: 0, end: 5, tokens: [...tok('原因になってしまいあ', 0), ...tok('とはうまく切りづらい', 1.8)] }];
  const chunks = tokensToChunks(raw, [{ start: 0, end: 1.25 }, { start: 1.85, end: 3.1 }]);
  assert.deepEqual(chunks.map(c => c.text.replace(/[、。]/g, '')), ['原因になってしまい', 'あとはうまく切りづらい']);
});

test('字幕の区切り: 話し言葉の「〜てる」「〜てた」を分けない', () => {
  const lines = subtitlePages('それは100均に売ってるアイテムにあります', 2).flatMap(p => p.lines);
  assert.ok(!lines.some(l => l.startsWith('る')), lines.join('／'));
});

test('用語の途中で文を分けない（「セルフカットです｜きばさみ」は「セルフカットで すきばさみ」）', () => {
  const tok = (s, t0, step = 0.12) => [...s].map((c, i) => ({ s: c, t: +(t0 + i * step).toFixed(2), p: 1 }));
  const raw = [{ start: 0, end: 5, tokens: [...tok('セルフカットです', 0), ...tok('きばさみ使って髪を軽くします', 1.05)] }];
  const chunks = tokensToChunks(raw, [{ start: 0, end: 0.95 }, { start: 1.05, end: 3 }]).map(c => fixTerms(c));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text.replace(/[、。]/g, ''), 'セルフカットですきバサミ使って髪を軽くします');
});
