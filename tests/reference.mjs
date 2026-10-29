// 固定テスト素材（tests/fixtures/*/）で、自動の構成を手動編集のお手本と比べる。
//   node tests/reference.mjs [素材のフォルダ]   … 比較表を表示する（既定: tests/fixtures/img5830）
// analysis.json: アプリが元の動画を解析した結果（音量・声の区間・文字起こし・動き。run.mjs --dump-analysis で保存）
// manual.json: 手動編集のお手本（残した範囲・削った範囲・字幕。時刻は元の動画の秒）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUnits, selectUnits, buildTimeline, extendEnding, setBreakTerms, fineSpeech, refineSubtitleTiming, FPS } from '../js/plan.js';
import { tokensToChunks, fixTerms } from '../js/asrtext.js';
import { targetRange } from '../js/brief.js';

export function loadFixture(dir) {
  const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  return { analysis: read('analysis.json'), manual: read('manual.json') };
}

// 保存した文字起こしの1文字ごとの結果から、アプリと同じ手順で文を作り直す（文の分け方・用語の直しも確かめるため）
export function rebuildChunks(analysis) {
  const fine = fineSpeech(analysis.rmsDb, analysis.speech.threshold);
  const raw = analysis.chunks.map(c => ({ start: c.start, end: c.end, tokens: c.tokens }));
  return refineSubtitleTiming(tokensToChunks(raw, fine).map(c => fixTerms(c, [], [])), fine);
}

// アプリの makePlan と書き出しのタイムラインを、入力なし（目標 targetSec）で作る
export function planFixture(analysis, targetSec = 45) {
  const { duration, rmsDb, speech, motion } = analysis;
  const chunks = rebuildChunks(analysis);
  setBreakTerms([]);
  const units = buildUnits({ duration, rmsDb, speech, chunks, motion });
  const { target, max } = targetRange(targetSec);
  const sel = selectUnits(units, duration, target, max);
  const timeline = buildTimeline(extendEnding(sel, speech.voice, duration), { subtitles: true });
  return { chunks, units, sel, timeline };
}

const overlap = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));
const sumOverlap = (ranges, a, b) => ranges.reduce((s, r) => s + overlap(r.start, r.end, a, b), 0);

// 自動の構成とお手本の違い
export function compare(manual, timeline) {
  const used = timeline.flatMap(c => c.pieces.map(p => ({ start: p.srcStart, end: p.srcStart + p.frames / FPS })));
  const kept = manual.kept.map(k => ({ start: k.srcStart, end: k.srcEnd }));
  const outSec = timeline.reduce((s, c) => s + c.outDuration, 0);
  const usedSec = used.reduce((s, r) => s + r.end - r.start, 0);
  const keptSec = kept.reduce((s, r) => s + r.end - r.start, 0);
  const both = used.reduce((s, r) => s + sumOverlap(kept, r.start, r.end), 0);
  // お手本が削った範囲のうち、自動の構成でも使ってしまった長さ（言い直し・間・前後の無音）
  const removed = manual.removed.map(r => ({ ...r, usedSec: sumOverlap(used, r.srcStart, r.srcEnd) }));
  // お手本が残した文（言い直しでない文）のうち、自動の構成で使った割合
  const spoken = manual.spoken.map(s => ({ ...s, cover: sumOverlap(used, s.start, s.end) / (s.end - s.start) }));
  const pages = timeline.flatMap(c => c.subtitles.map(p => ({ start: p.start, end: p.end, lines: p.lines, text: p.lines.join('') })));
  return {
    outSec, manualSec: manual.kept.reduce((s, k) => s + k.srcEnd - k.srcStart, 0),
    iou: both / (usedSec + keptSec - both), extraSec: usedSec - both, missingSec: keptSec - both,
    removed, spoken, pages,
  };
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export function report(manual, cmp) {
  const f = x => x.toFixed(2);
  const out = [];
  out.push(`長さ: 自動 ${f(cmp.outSec)}秒 / お手本 ${f(cmp.manualSec)}秒（差 ${f(cmp.outSec - cmp.manualSec)}秒）`);
  out.push(`使った範囲の一致（IoU）: ${(cmp.iou * 100).toFixed(1)}%  余分に使った ${f(cmp.extraSec)}秒 / 足りない ${f(cmp.missingSec)}秒`);
  out.push('お手本が削った範囲（元の動画の秒）: 自動でも使った長さ');
  for (const r of cmp.removed) out.push(`  ${f(r.srcStart)}〜${f(r.srcEnd)}（${f(r.dur)}秒）→ ${f(r.usedSec)}秒 使用${r.usedSec > 0.1 ? '  ×' : ''}`);
  out.push('話した文: 使った割合');
  for (const s of cmp.spoken) out.push(`  ${s.retake ? '[言い直し] ' : ''}「${s.text}」 ${(s.cover * 100).toFixed(0)}%${(s.retake ? s.cover > 0.2 : s.cover < 0.9) ? '  ×' : ''}`);
  const lens = cmp.pages.map(p => p.text.length), durs = cmp.pages.map(p => p.end - p.start);
  const mLens = manual.subtitles.map(s => s.chars), mDurs = manual.subtitles.map(s => s.outEnd - s.outStart);
  out.push(`字幕: 自動 ${cmp.pages.length}枚（2行 ${cmp.pages.filter(p => p.lines.length > 1).length}枚・文字数 中央 ${median(lens)} 最大 ${Math.max(...lens)}・表示 中央 ${f(median(durs))}秒 最大 ${f(Math.max(...durs))}秒）`);
  out.push(`      お手本 ${manual.subtitles.length}枚（すべて1行・文字数 中央 ${median(mLens)} 最大 ${Math.max(...mLens)}・表示 中央 ${f(median(mDurs))}秒 最大 ${f(Math.max(...mDurs))}秒）`);
  for (const p of cmp.pages) out.push(`  ${f(p.start).padStart(6)}〜${f(p.end).padEnd(6)} ${p.lines.join(' / ')}`);
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/img5830');
  const { analysis, manual } = loadFixture(dir);
  const { timeline } = planFixture(analysis);
  console.log(report(manual, compare(manual, timeline)));
}
