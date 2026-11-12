// 自動の字幕（ページ）を、正解の文（手動編集の字幕など）と比べる。元の動画は使わない（解析の結果だけ）。
//   node --import ./tests/setup-morph.mjs tools/analysis/subeval.mjs analysis.json truth.json [--srcs=s2,s3,...] [--pace=manual] [--target=70] [--v2] [--list]
// truth.json: [{ src, start, end, text }]（src は素材の名前。--srcs の順に、つないだ動画の1本目・2本目…）。
//   話した内容そのものなので、リポジトリには入れない（README を参照）
// 出すもの（構成で選んだ場面の字幕だけ。選ばなかった文は「場面ごと外した文」として別に数える）:
//   - 字幕の抜け: 正解の文の読みのうち、字幕に出なかった割合が 6割以上（抜け）・2割以上（一部抜け）
//   - 聞き間違い: 読みの置換・余分（字幕にあって正解にない文字）
//   - 表示のタイミング: その文の最初のページの表示の始まりと、声の出始め（細かい声の区間）の差
//   - 1文あたりのページ数
import fs from 'node:fs';
import { buildTimeline, fineSpeech, setSubtitleMode, normalizeText } from '../../js/plan.js';
import { planCuts } from './lib.mjs';

const args = process.argv.slice(2);
const opt = name => (args.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1];
const [dumpPath, truthPath] = args.filter(a => !a.startsWith('--'));
const A = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const truth = JSON.parse(fs.readFileSync(truthPath, 'utf8'));
const srcs = (opt('srcs') || '').split(',').filter(Boolean);
const v2 = args.includes('--v2'), pace = opt('pace') || (v2 ? 'manual' : 'natural'), targetSec = +(opt('target') || 70);
setSubtitleMode(v2 ? 'sentence' : null);

// 比べる文字: 句読点・つなぎ言葉を除き、カタカナはひらがなにそろえる（漢字とかなの書き方の違いは誤りに数える。読みで比べるときは
// Python の score.py を使う）
const reading = t => normalizeText(t).normalize('NFKC').replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const ops = (a, b) => {
  const n = a.length, m = b.length, d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] !== b[j - 1]));
  let i = n, j = m, sub = 0, del = 0, ins = 0;
  while (i || j) {
    if (i && j && d[i][j] === d[i - 1][j - 1] + (a[i - 1] !== b[j - 1])) { sub += a[i - 1] !== b[j - 1]; i--; j--; }
    else if (i && d[i][j] === d[i - 1][j] + 1) { del++; i--; }
    else { ins++; j--; }
  }
  return { sub, del, ins };
};

const { sel } = planCuts(A, { pace, targetSec, v2 });
const timeline = buildTimeline(sel, { subtitles: true });
const pages = [];
for (const c of timeline) for (const p of c.subtitles || []) {
  if (p.cont && pages.length) { pages[pages.length - 1].end = p.end; continue; }
  pages.push({ ...p, text: p.lines.join('') });
}
const used = timeline.flatMap(c => c.pieces.map(p => ({ start: p.srcStart, end: p.srcStart + p.frames / 30 })));
const fine = fineSpeech(A.rmsDb, A.speech.threshold);
const off = k => (A.lay ? A.lay[k].offset : 0);
const rows = [];
truth.forEach((T, n) => {
  const k = Math.max(0, srcs.indexOf(T.src)), a = off(k) + T.start, b = off(k) + T.end;
  const prev = truth[n - 1]?.src === T.src ? off(k) + truth[n - 1].end : -Infinity, next = truth[n + 1]?.src === T.src ? off(k) + truth[n + 1].start : Infinity;
  const lo = Math.max((prev + a) / 2, a - 0.6), hi = Math.min((b + next) / 2, b + 0.6);
  const kept = used.reduce((s, r) => s + Math.max(0, Math.min(r.end, b) - Math.max(r.start, a)), 0) / Math.max(0.01, b - a);
  // その文の範囲にあるページ（ページの真ん中が範囲の中）
  const ps = pages.filter(p => p.srcStart != null && (p.srcStart + p.srcEnd) / 2 >= lo && (p.srcStart + p.srcEnd) / 2 < hi);
  const R = reading(T.text), H = reading(ps.map(p => p.text).join(''));
  const e = ops([...R], [...H]);
  const onset = fine.find(f => f.end > a - 0.15 && f.start < b)?.start ?? a;
  // 表示の始まり（元の動画の時刻。字幕は最初の文字の0.1秒前に出す）と、声の出始めの差
  const dt = ps.length ? +(ps[0].srcStart - 0.1 - Math.max(onset, a - 0.15)).toFixed(2) : null;
  rows.push({ id: T.id || `T${n + 1}`, text: T.text, shown: ps.map(p => p.lines.join('／')).join(' | '), kept: +kept.toFixed(2), pages: ps.length, ...e, n: R.length, dt });
});
const inCut = rows.filter(r => r.kept >= 0.5);
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const lost = inCut.filter(r => r.del >= 0.6 * r.n), part = inCut.filter(r => r.del < 0.6 * r.n && r.del >= 0.2 * r.n);
const dts = inCut.map(r => r.dt).filter(x => x != null).map(Math.abs).sort((x, y) => x - y);
console.log(JSON.stringify({
  v2, sentences: truth.length, inCut: inCut.length, droppedByCut: truth.length - inCut.length, pages: pages.length,
  missing: { lost: lost.length, partial: part.length, delChars: sum(inCut, r => r.del), chars: sum(inCut, r => r.n) },
  misheard: { sub: sum(inCut, r => r.sub), extra: sum(inCut, r => r.ins) },
  timing: { median: dts[dts.length >> 1] ?? null, over03: dts.filter(x => x > 0.3).length, max: dts[dts.length - 1] ?? null },
  pagesPerSentence: +(sum(inCut, r => r.pages) / Math.max(1, inCut.length)).toFixed(2),
}));
if (args.includes('--list')) for (const r of rows) console.log(`${r.id} ${r.kept < 0.5 ? '[場面ごと外した] ' : ''}置換${r.sub} 抜け${r.del} 余分${r.ins} ずれ${r.dt}秒 ${r.pages}枚 「${r.text}」→「${r.shown}」`);
