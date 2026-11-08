// 完成した動画への修正指示（画面に依存しない計算だけ。Node でテストできる）。
//
// 指示は、見ていた完成動画の時刻（out）で入力するが、元の動画の時刻（src）に直して保存する。
// こうすると、カットで完成動画の長さが変わっても、ほかの字幕・修正の位置がずれない。
// 修正の種類:
//   subtitle: その時刻の字幕の文字を変える（text）
//   timing:   その時刻の字幕を shift 秒ずらす（負の値は早く）
//   cut:      at〜to の範囲を取り除く（その範囲の字幕の文字も消える）
//   gap:      at の近くの話の間を詰める（間が見つからなければ要確認）
//   note:     自由入力（parseInstruction で解釈できたときだけ、上のどれかにする。勝手には変えない）
//   words:    字幕で省く・残す言葉（動画全体。編集メモと同じ書き方 memo.js の parseMemo）

// 完成動画の時刻 → 元の動画の時刻（場面の番号とその場面の場面 id）
export function outToSrc(timeline, t) {
  for (const c of timeline) {
    let o = c.outStart;
    for (const p of c.pieces) {
      const d = p.frames / 30;
      if (t >= o - 1e-6 && t < o + d + 1e-6) return { src: +(p.srcStart + (t - o)).toFixed(3), unitId: c.id };
      o += d;
    }
  }
  return null;
}

// 元の動画の時刻 → 完成動画の時刻（使っていない所は null）
export function srcToOut(timeline, src) {
  for (const c of timeline) {
    let o = c.outStart;
    for (const p of c.pieces) {
      const d = p.frames / 30;
      if (src >= p.srcStart - 1e-6 && src <= p.srcStart + d + 1e-6) return +(o + src - p.srcStart).toFixed(3);
      o += d;
    }
  }
  return null;
}

const num = s => Number(String(s).replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
const SEC = '([0-9０-９]+(?:[.．][0-9０-９]+)?)';

// 自由入力の指示を読む。読み方が1通りに決まるときだけ { kind, at, to, text, shift } を返す。決まらなければ null
// 例: 「18秒の字幕を○○に変更」「25〜27秒の言い間違いを削除」「32秒の字幕を0.3秒早く表示」「40秒付近の不要な間を詰める」
export function parseInstruction(input) {
  const s = (input || '').trim().replace(/\s+/g, '');
  let m;
  if ((m = s.match(new RegExp(`^${SEC}秒(?:付近|あたり|頃)?の字幕を[「『"]?(.+?)[」』"]?に(?:変更|直す|修正|変える|して)`)))) {
    return { kind: 'subtitle', at: num(m[1]), text: m[2] };
  }
  if ((m = s.match(new RegExp(`^${SEC}秒(?:付近|あたり|頃)?の字幕を${SEC}秒(早く|遅く)`)))) {
    return { kind: 'timing', at: num(m[1]), shift: (m[3] === '早く' ? -1 : 1) * num(m[2]) };
  }
  if ((m = s.match(new RegExp(`^${SEC}(?:秒)?[〜~～\\-ー－から]+${SEC}秒(?:まで)?(?:の)?.*?(?:を)?(?:削除|カット|消す|消して|取り除く|切る|切って)`)))) {
    const a = num(m[1]), b = num(m[2]);
    return b > a ? { kind: 'cut', at: a, to: b } : null;
  }
  if ((m = s.match(new RegExp(`^${SEC}秒(?:付近|あたり|頃)?の.*?間を(?:詰める|詰めて|短く|カット|削除)`)))) {
    return { kind: 'gap', at: num(m[1]) };
  }
  return null;
}

// 指示を、見ていた完成動画の構成（timeline）で元の動画の時刻に直す。直せないときは理由を返す
export function resolveFix(fix, timeline) {
  // 字幕で省く・残す言葉（動画全体）: 時刻は使わない
  if (fix.kind === 'words') return { ...fix, status: fix.status };
  // 字幕の修正は、その時刻に出ている字幕で場所を決める（場面の最初の字幕は、前の場面の終わりに少し早く出ることがある）
  if (fix.kind === 'subtitle' || fix.kind === 'timing') {
    for (const c of timeline) for (const p of c.subtitles || []) {
      if (fix.at >= p.start - 1e-6 && fix.at <= p.end + 1e-6 && p.srcStart != null) {
        return { ...fix, srcAt: +((p.srcStart + p.srcEnd) / 2).toFixed(3), unitId: c.id, was: p.lines.join(''), status: fix.status };
      }
    }
    return { ...fix, status: 'check', note: `${fix.at}秒には字幕が出ていません（字幕が出ている時刻にしてください）` };
  }
  const a = outToSrc(timeline, fix.at);
  if (!a) return { ...fix, status: 'check', note: `${fix.at}秒は完成動画の範囲の外です` };
  const out = { ...fix, srcAt: a.src, unitId: a.unitId };
  if (fix.kind === 'cut') {
    const b = outToSrc(timeline, Math.max(fix.at, fix.to - 0.001));
    if (!b || !(fix.to > fix.at)) return { ...out, status: 'check', note: '終わりの時刻を確かめてください' };
    out.srcTo = b.src;
    // 範囲が場面をまたぐときは、完成動画の時刻のまま、場面ごとに分けて取り除く
    out.ranges = srcRanges(timeline, fix.at, fix.to);
  }
  return out;
}

// 完成動画の at〜to が使っている元の動画の範囲（場面をまたいでもよい）
export function srcRanges(timeline, at, to) {
  const out = [];
  for (const c of timeline) {
    let o = c.outStart;
    for (const p of c.pieces) {
      const d = p.frames / 30;
      const a = Math.max(at, o), b = Math.min(to, o + d);
      if (b - a > 1e-3) out.push({ start: +(p.srcStart + a - o).toFixed(3), end: +(p.srcStart + b - o).toFixed(3), unitId: c.id });
      o += d;
    }
  }
  return out;
}

// 範囲 r を pieces から取り除く（元の動画の時刻）
function subtract(pieces, r) {
  const out = [];
  for (const p of pieces) {
    if (r.end <= p.start || r.start >= p.end) { out.push(p); continue; }
    if (r.start - p.start >= 1 / 30) out.push({ ...p, end: r.start });
    if (p.end - r.end >= 1 / 30) out.push({ ...p, start: r.end });
  }
  return out;
}

// 適用する指示（status: 'ready'）を、構成の場面（clips: 元の動画の時刻の pieces・text・times を持つ）に反映した新しい場面を返す。
// 字幕の文字・時刻の指示は clip.pageEdits に入れ、字幕のページを作るときに使う（buildTimeline・timedPages）
export function applyFixes(clips, fixes) {
  const ready = (fixes || []).filter(f => f.status === 'applied' && f.srcAt != null);
  if (!ready.length) return clips;
  return clips.map(c0 => {
    let c = c0;
    const mine = ready.filter(f => (f.ranges ? f.ranges.some(r => r.unitId === c0.id) : f.unitId === c0.id));
    if (!mine.length) return c;
    c = { ...c, pieces: c.pieces.map(p => ({ ...p })), pageEdits: [...(c.pageEdits || [])] };
    for (const f of mine) {
      if (f.kind === 'subtitle' || f.kind === 'timing') c.pageEdits.push({ srcAt: f.srcAt, text: f.kind === 'subtitle' ? f.text : null, shift: f.kind === 'timing' ? f.shift : 0, id: f.id });
      if (f.kind === 'cut' || f.kind === 'gap') {
        const ranges = f.kind === 'cut' ? f.ranges.filter(r => r.unitId === c0.id) : [f.gapRange].filter(Boolean);
        for (const r of ranges) {
          c.pieces = subtract(c.pieces, r);
          // 取り除いた範囲で話した文字は、字幕からも消す（1文字ごとの時刻があるとき）。
          // 間を詰めるときは声のない所だけを取り除くので、字幕の文字は消さない（1文字ごとの時刻は少しずれることがあるため）
          if (f.kind === 'cut' && c.times && c.text && c.times.length === c.text.length) {
            const keep = c.times.map(t => !(t >= r.start - 0.05 && t < r.end - 0.05));
            c.text = [...c.text].filter((_, k) => keep[k]).join('');
            c.times = c.times.filter((_, k) => keep[k]);
          }
          if (c.fine) c.fine = subtract(c.fine, r);
        }
      }
    }
    return c;
  }).filter(c => c.pieces.length);
}

// 「不要な間を詰める」: at（元の動画の時刻）の前後0.8秒の中で一番長い話の間（細かい声の区間 fine のすき間・0.15秒以上）を、
// keep 秒だけ残して取り除く範囲。見つからなければ null
export function findGapRange(fine, srcAt, keep = 0.12) {
  let best = null;
  for (let i = 1; i < fine.length; i++) {
    const a = fine[i - 1].end, b = fine[i].start, g = b - a;
    if (g < 0.15 + keep || b < srcAt - 0.8 || a > srcAt + 0.8) continue;
    if (!best || g > best.end - best.start + keep) best = { start: +(a + keep / 2).toFixed(3), end: +(b - keep / 2).toFixed(3) };
  }
  return best;
}

// 指示の一覧に出す文
export function describeFix(f) {
  const t = v => `${(+v).toFixed(1)}秒`;
  if (f.kind === 'subtitle') return `${t(f.at)}の字幕を「${f.text}」に変更`;
  if (f.kind === 'timing') return `${t(f.at)}の字幕を${Math.abs(f.shift).toFixed(1)}秒${f.shift < 0 ? '早く' : '遅く'}表示`;
  if (f.kind === 'cut') return `${t(f.at)}〜${t(f.to)}をカット`;
  if (f.kind === 'gap') return `${t(f.at)}付近の不要な間を詰める`;
  if (f.kind === 'words') return [f.omit?.length ? `字幕で「${f.omit.join('」「')}」を省く` : '', f.keep?.length ? `字幕に「${f.keep.join('」「')}」を残す` : ''].filter(Boolean).join('・') + '（動画全体）';
  return `${t(f.at)}: ${f.note || ''}`;
}
