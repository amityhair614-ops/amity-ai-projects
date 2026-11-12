// 改善版（v2・テスト環境だけ）の部品: 短い窓・声のある空きの読み直し・場面の間の声を残す・1文ずつの字幕・言葉の置き換え
import test from 'node:test';
import assert from 'node:assert/strict';
import { shortAsrWindows, voiceGapWindows, bridgeSelected, mergeAsrPasses, setSubtitleMode, subtitlePages, FRAME_SEC } from '../js/plan.js';
import { parseInstruction, replaceWithTimes, applyFixes } from '../js/fixes.js';
import { cleanForDisplay, setAsSpoken } from '../js/captions.js';

// 音量（50ms ごと）: 声 [a, b) の並び。ほかは静か（-60dB）
const level = (sec, voiced) => {
  const n = Math.round(sec / FRAME_SEC), r = new Float32Array(n).fill(-60);
  for (const [a, b] of voiced) for (let i = Math.round(a / FRAME_SEC); i < Math.round(b / FRAME_SEC); i++) r[i] = -20;
  return r;
};

test('v2 短い窓: 0.3秒以上の間で区切り、8秒を超えない。言葉の途中の短い間（0.2秒）では区切らない', () => {
  const rms = level(30, [[1, 3], [3.2, 5], [5.6, 8], [9, 19], [20, 22]]);
  const ws = shortAsrWindows(rms, { srcSec: 30 });
  assert.ok(ws.every(w => w.end - w.start <= 8 + 1e-6), JSON.stringify(ws));
  assert.ok(!ws.some(w => Math.abs(w.end - 3) < 0.06 || Math.abs(w.start - 3.2) < 0.06), '0.2秒の間では区切らない');
  assert.ok(ws.some(w => Math.abs(w.start - 5.6) < 0.06), '0.6秒の間では区切る');
  // 10秒続く声は、8秒以内に分ける（静かな所がなくても）
  assert.ok(ws.filter(w => w.start >= 8.9 && w.end <= 19.1).length >= 2);
  // となりの窓と読む範囲が重ならない
  for (let i = 1; i < ws.length; i++) assert.ok(ws[i].start - ws[i].padStart >= ws[i - 1].end + ws[i - 1].padEnd - 1e-6);
  assert.ok(ws.every(w => w.pass === 'A' && w.short));
});

test('v2 声のある空き: 文字と文字の間が1.2秒以上あいていて声があれば、その声だけを読み直す', () => {
  const fine = [{ start: 0.8, end: 2.7 }, { start: 2.9, end: 5.1 }, { start: 5.2, end: 7.2 }, { start: 7.3, end: 9 }];
  const tk = (a, b) => Array.from({ length: Math.round((b - a) / 0.15) + 1 }, (_, i) => ({ s: 'あ', t: +(a + i * 0.15).toFixed(2) }));
  const merged = [{ tokens: [...tk(0.8, 2.66), ...tk(7.28, 9)] }];
  const ws = voiceGapWindows(fine, merged);
  assert.equal(ws.length, 1);
  assert.ok(ws[0].start > 2.66 && ws[0].end < 7.28 && ws[0].lo > 2.66 && ws[0].hi < 7.28, JSON.stringify(ws));
  assert.ok(ws[0].gapFill && ws[0].pass === 'B');
});

test('v2 読み直した文字は、照らし合わせずに空きへ入れる（順番が入れかわらない）', () => {
  const windows = [
    { start: 0.5, end: 3, pass: 'A', short: true }, { start: 7, end: 9, pass: 'A', short: true },
    { start: 0.5, end: 9, pass: 'C' }, { start: 2.9, end: 7.1, lo: 2.8, hi: 7.2, pass: 'B', gapFill: true },
  ];
  const tk = (s, t0) => [...s].map((c, i) => ({ s: c, t: +(t0 + i * 0.15).toFixed(2) }));
  const results = [[{ tokens: tk('ブロック分けします', 0.8) }], [{ tokens: tk('この線から', 7.3) }], [{ tokens: tk('この線から', 7.3) }], [{ tokens: tk('線取ります', 5.5) }]];
  const text = mergeAsrPasses(windows, results).map(c => c.text).join('');
  assert.equal(text, 'ブロック分けします線取りますこの線から');
});

test('v2 場面の間に声があるとき・短い間のときは、間も残す（話している途中で切らない）', () => {
  const units = [
    { id: 'u1', kind: 'speech', start: 0, end: 9.2, pieces: [{ start: 0, end: 9.2 }] },
    { id: 'u2', kind: 'speech', start: 9.4, end: 12, pieces: [{ start: 9.4, end: 12 }] },
    { id: 'u3', kind: 'speech', start: 13.5, end: 15, pieces: [{ start: 13.5, end: 15 }] },
  ];
  const fine = [{ start: 8, end: 9.35 }, { start: 9.4, end: 11.9 }, { start: 13.5, end: 15 }];
  const out = bridgeSelected(units, units, fine, { duration: 20 });
  assert.equal(out[0].pieces[0].end, 9.4, '9.2〜9.4 の声を残す');
  assert.equal(out[1].pieces[0].end, 12, '1.5秒の静かな間は残さない');
  // 間に外した場面（言い直し）があるときはつながない
  const mid = { id: 'x', kind: 'speech', start: 9.25, end: 9.35, pieces: [{ start: 9.25, end: 9.35 }] };
  assert.equal(bridgeSelected([units[0], units[1]], [...units, mid], fine, { duration: 20 })[0].pieces[0].end, 9.2);
});

test('v2 字幕: 1文を1枚（2行まで）。話した言葉（「このように」「それから」）を省かない', () => {
  try {
    setSubtitleMode('sentence');
    const p = subtitlePages('軽くするのであればこのように軽くしてみてください', 3, 15, 2);
    assert.ok(p.length <= 2, JSON.stringify(p));
    assert.ok(p.every(x => x.lines.length <= 2 && x.lines.every(l => l.length <= 15)), JSON.stringify(p));
    assert.ok(p.map(x => x.lines.join('')).join('').includes('このように'));
    const one = subtitlePages('後ろをセンターで真っ二つに分けて前に持っていきます', 3, 15, 2);
    assert.equal(one.length, 1, JSON.stringify(one));
    assert.ok(cleanForDisplay('それから真ん中に一度だけ軽くしておきます').text.startsWith('それから'));
    assert.equal(cleanForDisplay('ボリューム感がドンとね落ちていきます').text, 'ボリューム感がドンと落ちていきます', '調子をとる「ね」は省く');
  } finally { setSubtitleMode(null); }
  // 今までの方式（公開ページ）は変わらない
  assert.ok(!cleanForDisplay('残したい長さにこのように留めておきます').text.includes('このように'));
  setAsSpoken(true);
  assert.ok(cleanForDisplay('残したい長さにこのように留めておきます').text.includes('このように'));
  setAsSpoken(false);
});

test('v2 言葉の置き換え: 「「A」を「B」に直す」で動画全体の字幕を直す（1文字ごとの時刻も合わせる）', () => {
  assert.deepEqual(parseInstruction('「セルフカト」を「セルフカット」に直す', { replace: true }), { kind: 'replace', from: 'セルフカト', to: 'セルフカット' });
  assert.deepEqual(parseInstruction('セルフカト→セルフカット', { replace: true }), { kind: 'replace', from: 'セルフカト', to: 'セルフカット' });
  assert.equal(parseInstruction('セルフカト→セルフカット'), null, '今までの方式では読まない');
  const r = replaceWithTimes('セルフカトで', [1, 1.1, 1.2, 1.3, 1.4, 1.5], 'セルフカト', 'セルフカット');
  assert.equal(r.text, 'セルフカットで');
  assert.equal(r.times.length, r.text.length);
  assert.ok(r.times.every((t, i) => i === 0 || t >= r.times[i - 1]));
  const clips = applyFixes([{ id: 'u1', text: 'セルフカトで切る', times: [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7], pieces: [{ start: 0, end: 2 }] }], [{ kind: 'replace', from: 'セルフカト', to: 'セルフカット', status: 'applied' }]);
  assert.equal(clips[0].text, 'セルフカットで切る');
});
