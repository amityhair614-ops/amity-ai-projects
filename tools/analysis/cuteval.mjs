// 自動の構成（カット）を、手動編集で残した範囲と比べる。元の動画は使わない（解析の結果だけ）。
//   node tools/analysis/cuteval.mjs analysis.json manual-kept.json [--pace=natural|tight|manual] [--target=70] [--v2] [--list]
// analysis.json: tests/e2e/run.mjs --dump-analysis で保存した解析の結果
// manual-kept.json: { kept: [{ start, end }] }（手動編集で残した範囲。つないだ時刻）。tools/analysis/README.md を参照
// 出すもの:
//   - 残した範囲の数（つながった範囲は1つと数える）・合計の長さ
//   - 切りすぎた声: 手動編集が残した範囲の中で、声（細かい声の区間）があるのに自動では削った所
//   - 残しすぎ: 手動編集が削った範囲（言い直し・「うん」・長い間）を、自動では残した所
//   - 細かいカット: 手動編集が残した範囲の中で、自動では削った短い間（0.3秒未満）
import fs from 'node:fs';
import { fineSpeech } from '../../js/plan.js';
import { planCuts } from './lib.mjs';

const args = process.argv.slice(2);
const opt = name => (args.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1];
const [dumpPath, manualPath] = args.filter(a => !a.startsWith('--'));
const A = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const M = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
const pace = opt('pace') || 'natural', targetSec = +(opt('target') || 70), v2 = args.includes('--v2');

const merge = rs => {
  const out = [];
  for (const r of rs.slice().sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 0.02) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
};
const inter = (as, bs) => {
  const out = [];
  for (const a of as) for (const b of bs) { const s = Math.max(a.start, b.start), e = Math.min(a.end, b.end); if (e > s) out.push({ start: s, end: e }); }
  return merge(out);
};
const minus = (as, bs) => {
  let cur = merge(as);
  for (const b of merge(bs)) cur = cur.flatMap(a => (b.end <= a.start || b.start >= a.end ? [a] : [...(b.start > a.start ? [{ start: a.start, end: b.start }] : []), ...(b.end < a.end ? [{ start: b.end, end: a.end }] : [])]));
  return cur;
};
const len = rs => rs.reduce((s, r) => s + r.end - r.start, 0);
const f2 = x => +x.toFixed(2);

const { sel } = planCuts(A, { pace, targetSec, v2 });
const ai = merge(sel.flatMap(u => u.pieces));
const man = merge(M.kept);
const fine = fineSpeech(A.rmsDb, A.speech.threshold);
// 切りすぎた声: 手動が残した ∩ 声 − 自動が残した
const lostVoice = minus(inter(man, fine), ai).filter(r => r.end - r.start >= 0.04);
// 残しすぎ: 自動が残した − 手動が残した（手動が削った所）。ただし、手動の範囲の端から0.15秒以内は余白の違いとして除く
const manPad = man.map(r => ({ start: r.start - 0.15, end: r.end + 0.15 }));
const extra = minus(ai, manPad).filter(r => r.end - r.start >= 0.1);
// 手動が残した範囲の中の、自動の切れ目（細かいカット）
const holes = minus(man, ai).filter(r => r.end - r.start > 0.02 && r.start > man[0].start && r.end < man[man.length - 1].end);
const small = holes.filter(r => r.end - r.start < 0.3);
const src = t => (A.lay ? A.lay.findIndex(l => t >= l.offset - 0.5 && t < l.end + 0.5) : 0);
const at = t => { const k = src(t); return `${k + 1}本目 ${(t - (A.lay ? A.lay[k].offset : 0)).toFixed(2)}`; };
const r = {
  pace, v2, ranges: ai.length, manualRanges: man.length, sec: f2(len(ai)), manualSec: f2(len(man)),
  lostVoice: { count: lostVoice.length, sec: f2(len(lostVoice)) },
  extra: { count: extra.length, sec: f2(len(extra)) },
  innerCuts: { count: holes.length, small: small.length, sec: f2(len(holes)) },
};
console.log(JSON.stringify(r));
if (args.includes('--list')) {
  for (const x of lostVoice) console.log(`  切りすぎた声 ${at(x.start)}〜${f2(x.end - x.start)}秒`);
  for (const x of extra) console.log(`  残しすぎ     ${at(x.start)}〜${f2(x.end - x.start)}秒`);
  for (const x of holes) console.log(`  内側のカット ${at(x.start)}〜${f2(x.end - x.start)}秒`);
}
