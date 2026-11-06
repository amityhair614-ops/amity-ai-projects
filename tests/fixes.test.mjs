// 完成後の修正指示（js/fixes.js）: 完成動画の時刻で入力した指示を、元の動画の時刻に直して構成に反映する
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture, planFixture } from './reference.mjs';
import { buildTimeline, extendEnding, fineSpeech } from '../js/plan.js';
import { clampPieces } from '../js/sources.js';
import { parseInstruction, resolveFix, applyFixes, outToSrc, srcToOut, findGapRange, describeFix } from '../js/fixes.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/img1106');
const { analysis, manual } = loadFixture(dir);
const { sel } = planFixture(analysis, manual.targetSec);
const clips0 = extendEnding(sel, analysis.speech.voice, analysis.duration).map(u => ({ ...u, pieces: clampPieces(u.pieces, analysis.lay) }));
const build = fixes => buildTimeline(applyFixes(clips0, fixes), { subtitles: true });
const pagesOf = tl => tl.flatMap(c => c.subtitles || []);
const len = tl => { const c = tl[tl.length - 1]; return c.outStart + c.outDuration; };
const before = build([]);
const pageAt = (tl, text) => pagesOf(tl).find(p => p.lines.join('') === text);

test('自由入力の指示を読む（読み方が1通りのときだけ）', () => {
  assert.deepEqual(parseInstruction('18秒の字幕を「毛先に向かって」に変更'), { kind: 'subtitle', at: 18, text: '毛先に向かって' });
  assert.deepEqual(parseInstruction('25〜27秒の言い間違いを削除'), { kind: 'cut', at: 25, to: 27 });
  assert.deepEqual(parseInstruction('32秒の字幕を0.3秒早く表示'), { kind: 'timing', at: 32, shift: -0.3 });
  assert.deepEqual(parseInstruction('40秒付近の不要な間を詰める'), { kind: 'gap', at: 40 });
  assert.equal(parseInstruction('なんとなくテンポをよくして'), null, '読めない指示は勝手に変えない');
  assert.equal(parseInstruction('27〜25秒を削除'), null);
});

test('時刻の変換: 完成動画 ⇔ 元の動画', () => {
  const p = pageAt(before, 'やってしまうと');
  const a = outToSrc(before, p.start + 0.2);
  assert.ok(a && Math.abs(srcToOut(before, a.src) - (p.start + 0.2)) < 1e-3);
});

test('字幕の文字・時刻の修正: その字幕だけが変わる', () => {
  const p = pageAt(before, 'やってしまうと');
  const f1 = { id: 1, kind: 'subtitle', at: p.start + 0.1, text: 'やってしまうと必ず', status: 'applied' };
  const f2 = { id: 2, kind: 'timing', at: pageAt(before, '取り返しがつかないです').start + 0.3, shift: -0.2, status: 'applied' };
  const tl = build([resolveFix(f1, before), resolveFix(f2, before)]);
  assert.ok(pageAt(tl, 'やってしまうと必ず'), '文字が変わる');
  assert.ok(Math.abs(pageAt(tl, '取り返しがつかないです').start - (pageAt(before, '取り返しがつかないです').start - 0.2)) < 0.05, '0.2秒早く');
  assert.equal(pagesOf(tl).length, pagesOf(before).length);
  assert.ok(Math.abs(len(tl) - len(before)) < 1e-6, '長さは変わらない');
});

test('範囲のカット: 完成動画が短くなり、後ろの字幕もずれて追従する（話した文字の時刻と合ったまま）', () => {
  const p = pageAt(before, '下手すれば');
  const later = pageAt(before, '根元付近にすきバサミを') && pagesOf(before).filter(x => x.lines.join('') === '根元付近にすきバサミを').at(-1);
  const f = resolveFix({ id: 3, kind: 'cut', at: p.start, to: p.end, status: 'applied' }, before);
  const tl = build([f]);
  const cutLen = len(before) - len(tl);
  assert.ok(cutLen > 0.4 && cutLen <= p.end - p.start + 0.05, `${cutLen.toFixed(2)}秒短く`);
  assert.ok(!pagesOf(tl).some(x => x.lines.join('').includes('下手すれば')), 'カットした所の字幕は消える');
  const later2 = pagesOf(tl).filter(x => x.lines.join('') === '根元付近にすきバサミを').at(-1);
  assert.ok(Math.abs((later.start - later2.start) - cutLen) < 0.05, '後ろの字幕はカットした長さだけ早くなる');
});

test('不要な間を詰める: 近くの話の間を見つけて短くする。見つからなければ範囲なし', () => {
  const fine = [{ start: 10, end: 11 }, { start: 11.6, end: 12.4 }, { start: 12.5, end: 13 }];
  assert.deepEqual(findGapRange(fine, 11.3), { start: 11.06, end: 11.54 });
  assert.equal(findGapRange(fine, 12.45), null, '0.1秒の間は詰めない');
  assert.equal(describeFix({ kind: 'gap', at: 40 }), '40.0秒付近の不要な間を詰める');
});
