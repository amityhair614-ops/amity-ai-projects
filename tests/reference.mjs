// 固定テスト素材（tests/fixtures/*/）で、自動の構成を手動編集のお手本と比べる。
//   node tests/reference.mjs [素材のフォルダ…]   … 比較表を表示する（既定: tests/fixtures の全部）
// analysis.json: アプリが元の動画を解析した結果（音量・声の区間・文字起こし・動き。run.mjs --dump-analysis で保存）
// manual.json: 手動編集のお手本（残した範囲・削った範囲・字幕。時刻は元の動画の秒）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUnits, selectUnits, buildTimeline, extendEnding, setBreakTerms, fineSpeech, refineSubtitleTiming, normalizeText, FRAME_SEC, FPS } from '../js/plan.js';
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
  targetSec ??= 45;
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
export function compare(manual, timeline, analysis) {
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
    outSec, manualSec: manual.duration ?? manual.kept.reduce((s, k) => s + k.srcEnd - k.srcStart, 0),
    iou: both / (usedSec + keptSec - both), extraSec: usedSec - both, missingSec: keptSec - both,
    removed, spoken, pages,
    pauses: analysis ? pauseStats(analysis.rmsDb, analysis.speech.threshold, used) : null,
    breaks: breakRecall(manual.subtitles.map(x => x.text), pages.map(p => p.text)),
  };
}

// 完成動画の話の途中の間（声と声のすき間・1.5秒未満）。元の動画の音量 rmsDb のうち、使った範囲 ranges だけをつないで測る
// （手動編集の動画の音声を同じ方法で測った値が manual.pauses。tests/fixtures/*/README.md）
export function pauseStats(rmsDb, threshold, ranges) {
  const db = ranges.flatMap(r => Array.from(rmsDb.slice(Math.round(r.start / FRAME_SEC), Math.round(r.end / FRAME_SEC))));
  const fine = fineSpeech(db, threshold);
  const gaps = fine.slice(1).map((r, i) => r.start - fine[i].end).filter(g => g < 1.5).sort((a, b) => a - b);
  const q = p => gaps.length ? gaps[Math.min(gaps.length - 1, Math.round(p * (gaps.length - 1)))] : 0;
  return { n: gaps.length, median: q(0.5), p75: q(0.75), p90: q(0.9), max: gaps.at(-1) ?? 0 };
}

// 字幕の意味のまとまり: お手本の字幕の切れ目（ページの境目）のうち、自動の字幕でも切れ目になっている割合。
// 文字は文字起こしとお手本で少し違うので、2つの文字列を編集距離で対応させてから比べる（±1文字は同じ切れ目とみなす）
export function breakRecall(manualTexts, autoTexts) {
  const norm = t => normalizeText(t.normalize('NFKC'));
  const cuts = texts => { const out = []; let n = 0; for (const t of texts) { n += norm(t).length; out.push(n); } out.pop(); return out; };
  const A = manualTexts.map(norm).join(''), B = autoTexts.map(norm).join('');
  const n = A.length, m = B.length;
  const D = Array.from({ length: n + 1 }, (_, i) => { const r = new Uint16Array(m + 1); r[0] = i; return r; });
  for (let j = 0; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
  const map = new Array(n + 1).fill(0);
  for (let i = n, j = m; i > 0 || j > 0;) {
    map[i] = Math.max(map[i], j);
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)) { i--; j--; }
    else if (j > 0 && D[i][j] === D[i][j - 1] + 1) j--;
    else i--;
  }
  const ours = new Set(cuts(autoTexts));
  const theirs = cuts(manualTexts);
  const hit = theirs.filter(c => [-1, 0, 1].some(d => ours.has(map[c] + d)));
  return { recall: theirs.length ? hit.length / theirs.length : 1, missed: theirs.filter(c => !hit.includes(c)).map(c => A.slice(Math.max(0, c - 6), c) + '｜' + A.slice(c, c + 6)) };
}

// 字幕に出さなくても意味が伝わる言葉（つなぎ言葉・調子をとる「ね」・「という」・文の頭の「なので」など）が、字幕に出た回数
const UNNEEDED = [/(?:^|、)(?:えー+と?|えっと|ええと|あのー?|まあ|まぁ|うーん)/, /^(?:なので|ですので|それで|そうなると|じゃあ)/, /(?:[一-鿿々ァ-ヶー]|それ|これ)[がをはにでもと]ね(?=..)|分ね/, /[いな]という(?=[一-鿿々ァ-ヶ])/];
export function subtitleStats(texts, durs) {
  const lens = texts.map(t => normalizeText(t).length);
  return {
    n: texts.length,
    avgChars: lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length),
    over12: lens.filter(n => n > 12).length,
    avgSec: durs.reduce((a, b) => a + b, 0) / Math.max(1, durs.length),
    maxSec: Math.max(0, ...durs),
    unneeded: texts.reduce((a, t) => a + UNNEEDED.filter(re => re.test(t)).length, 0),
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
  const a = subtitleStats(cmp.pages.map(p => p.text), cmp.pages.map(p => p.end - p.start));
  const b = subtitleStats(manual.subtitles.map(x => x.text), manual.subtitles.map(x => x.outEnd - x.outStart));
  out.push(`字幕の平均: 自動 ${a.avgChars.toFixed(1)}文字・${f(a.avgSec)}秒（12文字より長い ${a.over12}枚・不要な言葉 ${a.unneeded}回） / お手本 ${b.avgChars.toFixed(1)}文字・${f(b.avgSec)}秒（12文字より長い ${b.over12}枚・不要な言葉 ${b.unneeded}回）`);
  out.push(`字幕の切れ目: お手本の切れ目のうち自動でも切れ目 ${(cmp.breaks.recall * 100).toFixed(0)}%${cmp.breaks.missed.length ? '（違う所: ' + cmp.breaks.missed.join('、') + '）' : ''}`);
  if (cmp.pauses) {
    const p = cmp.pauses, m = manual.pauses || {};
    out.push(`話の途中の間: 自動 中央 ${f(p.median)} / 75% ${f(p.p75)} / 90% ${f(p.p90)} / 最長 ${f(p.max)}秒` + (m.median != null ? `  お手本 中央 ${f(m.median)} / 75% ${f(m.p75)} / 90% ${f(m.p90)} / 最長 ${f(m.max)}秒` : ''));
  }
  for (const p of cmp.pages) out.push(`  ${f(p.start).padStart(6)}〜${f(p.end).padEnd(6)} ${p.lines.join(' / ')}`);
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const dirs = process.argv.length > 2 ? process.argv.slice(2) : fs.readdirSync(root).map(d => path.join(root, d)).filter(d => fs.existsSync(path.join(d, 'manual.json')));
  for (const dir of dirs) {
    const { analysis, manual } = loadFixture(dir);
    const { timeline } = planFixture(analysis, manual.targetSec);
    console.log(`===== ${path.basename(dir)} =====`);
    console.log(report(manual, compare(manual, timeline, analysis)));
  }
}
