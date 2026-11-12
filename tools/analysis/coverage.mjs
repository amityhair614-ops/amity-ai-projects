// 正解のない素材で、2つの解析の結果（修正前・修正後）の文字起こしを比べる。元の動画は使わない（解析の結果だけ）。
//   node tools/analysis/coverage.mjs before.json after.json [--list]
// 出すもの（つないだ動画の1本ごと）:
//   - 文字数
//   - 文字にならなかった声: 0.8秒以上のはっきりした声（細かい声の区間を0.3秒未満の間でつないだもの）で、文字が1つもない所
//   - 声のある長い空き: 文字と文字の間が1.2秒以上あいていて、そこに声が0.8秒以上ある所（文を落とした可能性）
//   - 片方にしかない文字の並び（3文字以上）: 修正後で消えた言葉（悪化の候補）・増えた言葉。--list で時刻と文字を出す
//     （どちらが正しいかは、音声を聞いて確かめる）
import fs from 'node:fs';
import { fineSpeech } from '../../js/plan.js';

const args = process.argv.slice(2);
const [p0, p1] = args.filter(a => !a.startsWith('--'));
const load = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const B = load(p0), C = load(p1);
const lay = B.lay || [{ offset: 0, end: B.duration }];
const toks = A => A.chunks.flatMap(c => c.tokens || []).filter(k => !/^<.*>$/.test(k.s)).sort((a, b) => a.t - b.t);
const fine = fineSpeech(B.rmsDb, B.speech.threshold);
const blobs = [];
for (const f of fine) { const b = blobs[blobs.length - 1]; if (b && f.start - b.end < 0.3) { b.end = f.end; b.v += f.end - f.start; } else blobs.push({ start: f.start, end: f.end, v: f.end - f.start }); }
const voiceIn = (a, b) => fine.reduce((s, f) => s + Math.max(0, Math.min(f.end, b) - Math.max(f.start, a)), 0);
const stats = (ts, s) => {
  const inS = ts.filter(k => k.t >= s.offset - 0.2 && k.t < s.end + 0.2);
  const unread = blobs.filter(b => b.start >= s.offset && b.end <= s.end + 0.1 && b.end - b.start >= 0.8 && b.v >= 0.56 && !inS.some(k => k.t >= b.start - 0.15 && k.t <= b.end + 0.15));
  const edges = [s.offset, ...inS.map(k => k.t), s.end];
  const gaps = [];
  for (let i = 0; i + 1 < edges.length; i++) if (edges[i + 1] - edges[i] >= 1.2 && voiceIn(edges[i] + 0.2, edges[i + 1] - 0.05) >= 0.8) gaps.push({ start: edges[i], end: edges[i + 1] });
  return { chars: inS.length, unread, gaps, ts: inS };
};
// 文字の並びの照らし合わせ（編集距離）。片方にしかない3文字以上の並びを返す
const diff = (a, b) => {
  const n = a.length, m = b.length, D = Array.from({ length: n + 1 }, (_, i) => new Int32Array(m + 1).map((_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (a[i - 1].s === b[j - 1].s ? 0 : 1));
  const onlyA = [], onlyB = [];
  let i = n, j = m, ra = [], rb = [];
  const flush = () => { if (ra.length >= 3) onlyA.push(ra.reverse()); if (rb.length >= 3) onlyB.push(rb.reverse()); ra = []; rb = []; };
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (a[i - 1].s === b[j - 1].s ? 0 : 1)) { if (a[i - 1].s === b[j - 1].s) flush(); else { ra.push(a[i - 1]); rb.push(b[j - 1]); } i--; j--; }
    else if (i > 0 && D[i][j] === D[i - 1][j] + 1) { ra.push(a[--i]); }
    else { rb.push(b[--j]); }
  }
  flush();
  return { onlyA: onlyA.reverse(), onlyB: onlyB.reverse() };
};
const TB = toks(B), TC = toks(C);
const rows = [];
const fmt = (run, s) => `${(run[0].t - s.offset).toFixed(1)}秒「${run.map(k => k.s).join('')}」`;
lay.forEach((s, k) => {
  const b = stats(TB, s), c = stats(TC, s);
  const d = diff(b.ts, c.ts);
  rows.push({ src: k + 1, chars: [b.chars, c.chars], unread: [b.unread.length, c.unread.length], gaps: [b.gaps.length, c.gaps.length], lost: d.onlyA.length, gained: d.onlyB.length });
  if (args.includes('--list')) {
    for (const r of d.onlyA) console.log(`  ${k + 1}本目 修正前だけ ${fmt(r, s)}`);
    for (const r of d.onlyB) console.log(`  ${k + 1}本目 修正後だけ ${fmt(r, s)}`);
    for (const g of c.gaps) console.log(`  ${k + 1}本目 修正後の声のある空き ${(g.start - s.offset).toFixed(1)}〜${(g.end - s.offset).toFixed(1)}秒`);
  }
});
const sum = f => rows.reduce((a, r) => [a[0] + f(r)[0], a[1] + f(r)[1]], [0, 0]);
console.log(JSON.stringify({ sources: rows.length, chars: sum(r => r.chars), unread: sum(r => r.unread), voiceGaps: sum(r => r.gaps), runsOnlyBefore: rows.reduce((a, r) => a + r.lost, 0), runsOnlyAfter: rows.reduce((a, r) => a + r.gained, 0), perSource: rows }));
