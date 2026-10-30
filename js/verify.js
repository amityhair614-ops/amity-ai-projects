// 字幕AI（ReazonSpeech）の聞き取りを、音声と照らし合わせて確かめる（聞き間違い・聞き落としの直し）。
// ブラウザAPIを使わないので Node でテストできる（モデルの呼び出しは model として外から渡す）。
//
// 考え方: 字幕AIのモデルは「この音声から、この文字の並びが出てくる確からしさ」を計算できる（RNN-T の強制アライメント）。
// 直す候補（別の読み方の結果・入力したタイトルや説明の言葉・聞き落としやすい文の終わり）を、元の文字起こしと同じ音声で比べ、
// 音声に合っている方を選ぶ。入力した言葉だけを根拠に、話していない言葉へ置き換えることはしない（音声で確かめられた時だけ直す）。
//
// 比べ方: 候補の確からしさ − 元の確からしさ（自然対数）から、モデルが文字の並びだけで覚えている「よく出る言葉の偏り」
// （内部の言語モデル。音声を0にしたときの確からしさ）の半分を差し引く（「部分」のようによく出る漢字が、
// 「ボブ」のような言葉より有利になりすぎないように）。
//
// 固定テスト素材4本で測った値（score。0より大きいほど候補の方が音声に合う。窓の切り方で ±1 ほど変わる）:
//   正しい直し: 部分→ボブ −3.2、方→ボブ +2.2、結べなく→結べなくなります +2.2〜+4.8、やっていき→やっていきましょう +5.2、
//               3通りの合わせ間違い（うまくいきうません／まく）→うまくカバー（音声だけの差 +27・+36）
//   話していない言葉: 部分→髪 −14.8、つかない→切らない −9.5、中の方→中のボブ −12.1、生え際→毛先 −31、
//               しないです→しないですね −4.8、長さ同じ→長さが同じ −7.5、美容室行って→美容室に行って −6.0
//   音声だけでは決めきれない: つかない→すかない −2.5〜−3.3（美容の用語のときは直さずに「要確認」）
// 入力した言葉（タイトル・説明・用語）は「話題に出る言葉」なので少しの差（−4.5まで）なら選ぶ。美容の用語は −3 まで。
// それ以外の直しは、音声の方がはっきり合っているときだけ選ぶ
export const VERIFY = {
  band: 8, // 元の文字の時刻から前後何コマ（0.04秒）までを、その文字を話している範囲とみなすか
  ilm: 0.5,
  termMin: -4.5, // 入力した言葉への直し: これより下なら直さない（入力した言葉は話に出てきやすいので、その分を足して比べる）
  domainMin: -3, // 美容の用語（入力していない言葉）への直し
  termSure: -1.5, // これより下で直したときは「要確認」
  termAcMin: -10, // 偏りを差し引く前の差がこれより大きく負なら、音声に合っていないとみなす
  passMin: 3, // 別の読み方の結果への直し（偏りを差し引かない、音声だけの差）
  passEdgeMin: 6,
  endMin: 1.5, // 文の終わりの聞き落とし（「結べなく」→「結べなくなります」）
  endAcMin: 0,
  endSure: 2.5,
  firstMin: Math.log(4e-4), // 入力した言葉の最初の文字が、その位置で出てくる確からしさの下限（候補を絞る）
  domainFirstMin: Math.log(5e-3), // 美容の用語（入力していない言葉）のとき
  pad: 0.3,
  lock: 3, // 長さで分けたまとまりの端の、直さない文字の数
};
export const FRAME = 0.04;
import { moraCount } from './plan.js';

const NEG_INF = -Infinity;
const logAdd = (a, b) => (a === NEG_INF ? b : b === NEG_INF ? a : a > b ? a + Math.log1p(Math.exp(b - a)) : b + Math.log1p(Math.exp(a - b)));

// 行（文字をいくつ出した後か）ごとの、各コマの「何も出さない」「次の文字を出す」の確からしさを求める。
// rows: [{ ctx: [前の前の文字, 前の文字], lo, hi, next: 次に出す文字の番号（なければ -1）, watch: [見ておく文字] }]
// 返り値: 各行に blank・emit（Float64Array。lo からの位置）・watch（見ておく文字ごとの、コマの中での最大の確からしさ）
async function rowProbs(model, eo, D, rows, batch = 256) {
  const keys = [...new Set(rows.map(r => r.ctx.join(',')))];
  const decOut = await model.decoder(keys.map(k => k.split(',').map(Number)));
  const decAt = new Map(keys.map((k, i) => [k, i]));
  const items = [];
  rows.forEach((r, ri) => {
    r.blank = new Float64Array(r.hi - r.lo + 1).fill(NEG_INF);
    r.emit = new Float64Array(r.hi - r.lo + 1).fill(NEG_INF);
    r.watchMax = new Map((r.watch || []).map(w => [w, NEG_INF]));
    for (let t = r.lo; t <= r.hi; t++) items.push([ri, t]);
  });
  for (let s = 0; s < items.length; s += batch) {
    const part = items.slice(s, s + batch), n = part.length;
    const e = new Float32Array(n * D), d = new Float32Array(n * D);
    part.forEach(([ri, t], k) => {
      e.set(eo.subarray(t * D, (t + 1) * D), k * D);
      const di = decAt.get(rows[ri].ctx.join(','));
      d.set(decOut.subarray(di * D, (di + 1) * D), k * D);
    });
    const logit = await model.joiner(e, d, n);
    const V = logit.length / n;
    part.forEach(([ri, t], k) => {
      const r = rows[ri], o = k * V;
      let max = NEG_INF;
      for (let v = 0; v < V; v++) if (logit[o + v] > max) max = logit[o + v];
      let sum = 0;
      for (let v = 0; v < V; v++) sum += Math.exp(logit[o + v] - max);
      const z = max + Math.log(sum);
      r.blank[t - r.lo] = logit[o] - z;
      if (r.next >= 0) r.emit[t - r.lo] = logit[o + r.next] - z;
      // 見ておく文字: 「何も出さない」を除いた中での確からしさ
      if (r.watchMax.size) {
        const zn = z + Math.log(Math.max(1e-30, 1 - Math.exp(logit[o] - z)));
        for (const w of r.watchMax.keys()) r.watchMax.set(w, Math.max(r.watchMax.get(w), logit[o + w] - zn));
      }
    });
  }
  return rows;
}

// 音声を0にしたときの、文字の並びだけの確からしさ（内部の言語モデル）。pairs: [[前の前, 前], 出す文字] ごとの値
async function ilmEach(model, D, pairs, batch = 256) {
  const out = [];
  for (let s = 0; s < pairs.length; s += batch) {
    const part = pairs.slice(s, s + batch);
    const dec = await model.decoder(part.map(p => p[0]));
    const logit = await model.joiner(new Float32Array(part.length * D), dec, part.length);
    const V = logit.length / part.length;
    part.forEach(([, y], k) => {
      const o = k * V;
      let max = NEG_INF;
      for (let v = 1; v < V; v++) if (logit[o + v] > max) max = logit[o + v];
      let sum = 0;
      for (let v = 1; v < V; v++) sum += Math.exp(logit[o + v] - max);
      out.push(logit[o + y] - max - Math.log(sum));
    });
  }
  return out;
}

// 文字の並び ids（frames: 各文字の時刻のコマ）の行の範囲（その行にいてよいコマ）
function band(frames, u, T, B) {
  const U = frames.length;
  const lo = u === 0 ? 0 : Math.max(0, frames[u - 1] - B);
  const hi = u === U ? T - 1 : Math.min(T - 1, frames[u] + B);
  return [lo, Math.max(lo, hi)];
}
const ctxOf = (ids, u) => [u >= 2 ? ids[u - 2] : 0, u >= 1 ? ids[u - 1] : 0];

// 前向きの計算（行 from から to まで）。alpha0: 行 from − 1 の値（なければ最初の行から）
function forward(rows, prev) {
  const out = [];
  for (const r of rows) {
    const a = new Float64Array(r.hi - r.lo + 1).fill(NEG_INF);
    for (let t = r.lo; t <= r.hi; t++) {
      let v = NEG_INF;
      if (!prev && t === 0) v = 0;
      if (t > r.lo) v = logAdd(v, a[t - 1 - r.lo] + r.blank[t - 1 - r.lo]);
      if (prev && t >= prev.lo && t <= prev.hi) v = logAdd(v, prev.a[t - prev.lo] + prev.emit[t - prev.lo]);
      a[t - r.lo] = v;
    }
    prev = { lo: r.lo, hi: r.hi, a, emit: r.emit };
    out.push(prev);
  }
  return out;
}

// 元の文字起こし（ids・frames）の確からしさを計算し、直す候補を比べる準備をする。
// watch: 入力した言葉の最初の文字（どの位置で出てきそうかを調べる）
export async function baseLattice(model, eo, T, D, ids, frames, { B = VERIFY.band, watch = [] } = {}) {
  const U = ids.length;
  const rows = [];
  for (let u = 0; u <= U; u++) {
    const [lo, hi] = band(frames, u, T, B);
    rows.push({ ctx: ctxOf(ids, u), lo, hi, next: u < U ? ids[u] : -1, watch });
  }
  await rowProbs(model, eo, D, rows);
  const alpha = forward(rows, null);
  // 後ろ向き（行 u のコマ t から最後まで）
  const beta = [];
  for (let u = U; u >= 0; u--) {
    const r = rows[u], b = new Float64Array(r.hi - r.lo + 1).fill(NEG_INF), nx = beta[u + 1];
    for (let t = r.hi; t >= r.lo; t--) {
      let v = u === U && t === T - 1 ? r.blank[t - r.lo] : NEG_INF;
      if (t < r.hi) v = logAdd(v, r.blank[t - r.lo] + b[t + 1 - r.lo]);
      if (nx && t >= nx.lo && t <= nx.hi) v = logAdd(v, r.emit[t - r.lo] + nx.b[t - nx.lo]);
      b[t - r.lo] = v;
    }
    beta[u] = { lo: r.lo, hi: r.hi, b };
  }
  const last = alpha[U];
  const ll = T - 1 >= last.lo && T - 1 <= last.hi ? last.a[T - 1 - last.lo] + rows[U].blank[T - 1 - rows[U].lo] : NEG_INF;
  return { model, eo, T, D, B, ids, frames, rows, alpha, beta, ll };
}

// 直す候補 edit（元の i〜j 番目の文字を ids に置き換える。frames は新しい文字の時刻のコマ）の点数。
// 0より大きいほど候補の方が音声に合う（内部の言語モデルの偏りを差し引いた値）
export async function scoreEdit(L, edit, opt) {
  return (await scoreEdits(L, [edit], opt))[0];
}

// 多くの候補を、まとめて計算する（モデルを呼ぶ回数を減らす）
export async function scoreEdits(L, edits, { ilm = VERIFY.ilm } = {}) {
  const { model, eo, T, D, B, ids, frames } = L;
  const jobs = edits.map(edit => {
    const { i, j } = edit;
    const h = [...ids.slice(0, i), ...edit.ids, ...ids.slice(j)];
    const hf = [...frames.slice(0, i), ...edit.frames, ...frames.slice(j)];
    const Uh = h.length, R = Math.min(i + edit.ids.length + 1, Uh);
    const rows = [];
    for (let u = i; u <= R; u++) {
      const [lo, hi] = band(hf, u, T, B);
      rows.push({ ctx: ctxOf(h, u), lo, hi, next: u < Uh ? h[u] : -1 });
    }
    const pairsH = [], pairs0 = [];
    for (let u = i; u < Math.min(R + 1, Uh); u++) pairsH.push([ctxOf(h, u), h[u]]);
    for (let u = i; u < Math.min(j + 2, ids.length); u++) pairs0.push([ctxOf(ids, u), ids[u]]);
    return { i, j, Uh, R, rows, pairsH, pairs0 };
  });
  await rowProbs(model, eo, D, jobs.flatMap(x => x.rows));
  // 内部の言語モデル: 変わった所（新しい文字と、その後の2文字）だけを比べる。同じ組は1回だけ計算する
  const key = ([c, y]) => `${c[0]},${c[1]},${y}`;
  const uniq = new Map();
  for (const x of jobs) for (const p of [...x.pairsH, ...x.pairs0]) uniq.set(key(p), p);
  const lp = await ilmEach(model, D, [...uniq.values()]);
  const at = new Map([...uniq.keys()].map((k, n) => [k, lp[n]]));
  return jobs.map(({ i, j, Uh, R, rows, pairsH, pairs0 }) => {
    const prev = i > 0 ? { ...L.alpha[i - 1], emit: L.rows[i - 1].emit } : null;
    const a = forward(rows, prev);
    let ll = NEG_INF;
    const lastA = a[a.length - 1], lastR = rows[rows.length - 1];
    if (R === Uh) {
      if (T - 1 >= lastA.lo && T - 1 <= lastA.hi) ll = lastA.a[T - 1 - lastA.lo] + lastR.blank[T - 1 - lastR.lo];
    } else {
      const nb = L.beta[j + 2];
      for (let t = Math.max(lastA.lo, nb.lo); t <= Math.min(lastA.hi, nb.hi); t++) ll = logAdd(ll, lastA.a[t - lastA.lo] + lastR.emit[t - lastR.lo] + nb.b[t - nb.lo]);
    }
    const sum = ps => ps.reduce((s, p) => s + at.get(key(p)), 0);
    const dIlm = sum(pairsH) - sum(pairs0);
    const ac = ll - L.ll;
    return { ac, ilm: dIlm, score: ac - ilm * dIlm };
  });
}

// ---------- 直す候補を作る ----------

const NEG_RE = /ない|なかっ|ません|ず$/;
const toHira = t => t.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const isPunct = s => /^[、。，．,.！？!?\s]*$/.test(s);
const KANJI = /^[一-鿿々]$/, KATA = /^[ァ-ヶー]$/;
// 位置 k が、漢字どうし・カタカナどうしの間（言葉の途中）か
const inWord = (chars, k) => k > 0 && k < chars.length && ((KANJI.test(chars[k - 1]) && KANJI.test(chars[k])) || (KATA.test(chars[k - 1]) && KATA.test(chars[k])));

// 文字の並び a・b の違う所（[a の i, j), [b の k, l)）。編集距離で照らし合わせる
export function diffRegions(a, b) {
  const n = a.length, m = b.length;
  const Dm = Array.from({ length: n + 1 }, (_, i) => Int32Array.from({ length: m + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) Dm[i][j] = Math.min(Dm[i - 1][j] + 1, Dm[i][j - 1] + 1, Dm[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && Dm[i][j] === Dm[i - 1][j - 1]) { ops.push(['=', --i, --j]); continue; }
    if (i > 0 && j > 0 && Dm[i][j] === Dm[i - 1][j - 1] + 1) { ops.push(['~', --i, --j]); continue; }
    if (j > 0 && Dm[i][j] === Dm[i][j - 1] + 1) { ops.push(['+', i, --j]); continue; }
    ops.push(['-', --i, j]);
  }
  ops.reverse();
  const out = [];
  let cur = null;
  for (const [op, x, y] of ops) {
    if (op === '=') { if (cur) out.push(cur); cur = null; continue; }
    if (!cur) cur = { i: x, j: x, k: y, l: y };
    if (op === '~') { cur.j = x + 1; cur.l = y + 1; }
    else if (op === '-') cur.j = x + 1;
    else cur.l = y + 1;
  }
  if (cur) out.push(cur);
  return out;
}

// a・b の両方の文字を順番どおりに含む、一番短い並び
function supersequence(a, b) {
  const n = a.length, m = b.length, L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = toHira(a[i]) === toHira(b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && toHira(a[i]) === toHira(b[j])) { out.push(a[i]); i++; j++; }
    else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) out.push(a[i++]);
    else out.push(b[j++]);
  }
  return out;
}

// 文の終わりの、聞き落としやすい続き（話し言葉の文の終わりの形。どの動画でも同じ）
export function endingCandidates(text) {
  const t = text.replace(/[、。\s]+$/, '');
  if (/ませ$/.test(t)) return ['ん'];
  if (/まし$/.test(t)) return ['た', 'ょう'];
  if (/なく$/.test(t)) return ['なります', 'なる', 'なって', 'なりません', 'ないです'];
  if (/[^っ]く$/.test(t)) return ['します', 'する', 'なります', 'なる', 'しない', 'しません'];
  if (/(?:[てで]いき|でき|[きしちにびみりぎ])$/.test(t) && !/(?:とき|好き|向き|付き|辺り|周り|通り)$/.test(t)) return ['ます', 'ました', 'ましょう', 'ません', 'たい'];
  return [];
}

// 入力した文章（タイトル・説明・用語）から、話の中に出てきそうな言葉を取り出す（カタカナ語・漢字の言葉・ひらがなの言葉）
export function briefWords(texts = [], terms = []) {
  const out = new Set();
  for (const t of texts) {
    const s = (t || '').normalize('NFKC');
    for (const m of s.matchAll(/[ァ-ヶー]{2,10}/g)) out.add(m[0]);
    for (const m of s.matchAll(/[一-鿿々]{2,6}/g)) out.add(m[0]);
    // ひらがなの言葉は、漢字の送りがな（「重くなった」の「くなった」）でないものだけ
    for (const m of s.matchAll(/[ぁ-ゖ]{4,10}/g)) if (!/[一-鿿々]/.test(s[m.index - 1] || '')) out.add(m[0]);
  }
  for (const t of terms) if (t && t.length >= 2) out.add(t);
  return [...out].filter(w => w.length >= 2);
}

// 1つのまとまり（声の区切り）の文字（base: { s, t }）に対する、直す候補。
// passes: 別の読み方の結果（{ s, t } の並び）。words: 入力した言葉。firstProb(u, ch): u 番目の位置で文字 ch が出てくる確からしさ（対数）
export function proposeEdits(base, { passes = [], words = [], firstProb = null, segEnd = Infinity, lockHead = 0, lockTail = 0 } = {}) {
  const edits = [];
  const text = base.map(k => k.s);
  const seen = new Set();
  const add = e => {
    const key = `${e.i},${e.j},${e.to.join('')}`;
    if (seen.has(key) || (e.i === e.j && !e.to.length)) return;
    if (text.slice(e.i, e.j).join('') === e.to.join('')) return;
    if (e.i < lockHead || Math.max(e.j, e.i + 1) > base.length - lockTail) return;
    seen.add(key);
    edits.push(e);
  };
  // 1. 別の読み方の結果（3通りを合わせたときに、言い直しの所などで文字がまざることがある）
  for (const p of passes) {
    // 書き方だけの違い（ギリギリ・ぎりぎり）は同じ文字とみなして照らし合わせる
    for (const d of diffRegions(text.map(toHira), p.map(k => toHira(k.s)))) {
      if (d.j - d.i > 14 || d.l - d.k > 14) continue;
      // まとまりの頭・終わりの文字を消すだけの直しはしない（音声の端は聞き取りにくく、話した言葉を消してしまうことがある）
      if (d.k === d.l && (d.i === 0 || d.j === text.length)) continue;
      const edge = (d.i === 0 || d.j === text.length) && d.l - d.k < d.j - d.i;
      add({ kind: 'pass', i: d.i, j: d.j, to: p.slice(d.k, d.l).map(k => k.s), times: p.slice(d.k, d.l).map(k => k.t), edge });
      // 両方の文字を残した並び（「ボをね」と「ボブを」→「ボブをね」。片方が落とした文字を足すだけの直し）
      const both = supersequence(text.slice(d.i, d.j), p.slice(d.k, d.l).map(k => k.s));
      if (both.length > d.j - d.i && both.length < d.j - d.i + d.l - d.k) add({ kind: 'pass', i: d.i, j: d.j, to: both, edge: false });
    }
  }
  // 2. 入力した言葉（話の中に出てきそうな言葉）: その位置で最初の文字が出てきそうなときだけ
  if (firstProb) {
    for (const item of words) {
      const w = typeof item === 'string' ? item : item.w, domain = typeof item === 'string' ? false : !!item.domain;
      const chars = [...w];
      if (chars.length > 8 || text.join('').includes(w)) continue;
      for (let u = 0; u < base.length; u++) {
        const fp = firstProb(u, chars[0]);
        if (fp < (domain ? VERIFY.domainFirstMin : VERIFY.firstMin)) continue;
        for (let n = Math.max(1, chars.length - 1); n <= chars.length + 1 && u + n <= base.length; n++) {
          const from = text.slice(u, u + n).join('');
          // 置き換える所を話した長さが、言葉の長さ（拍の数）とかけ離れていない
          const dur = (base[u + n]?.t ?? base[u + n - 1].t + 0.12) - base[u].t, need = 0.12 * moraCount(w);
          if (Math.abs(dur - need) > Math.max(0.3, 0.5 * need)) continue;
          if (isPunct(from) || /^[ぁ-ゖ]$/.test(from)) continue; // 助詞1文字（「を」「ね」）を言葉に置き換えない
          // 否定の言葉を消したり足したりしない（後ろの文字も含めて見る。「つきませ｜ん」）
          const tail = text.slice(u + n, u + n + 3).join('');
          if (NEG_RE.test(from + tail) !== NEG_RE.test(w + tail)) continue;
          // 漢字・カタカナの言葉の途中で区切らない（「部分」の「部」だけを置き換えない）
          if (inWord(text, u) || inWord(text, u + n)) continue;
          add({ kind: 'term', i: u, j: u + n, to: chars, word: w, domain, fp, extend: w.startsWith(from) || w.endsWith(from) });
        }
      }
    }
  }
  // 3. 文の終わりの聞き落とし（次の文字まで間があく所・まとまりの最後）
  for (let u = 0; u < base.length; u++) {
    const gap = (u + 1 < base.length ? base[u + 1].t : segEnd) - base[u].t;
    if (gap < 0.35) continue;
    const before = text.slice(Math.max(0, u - 5), u + 1).join('');
    const after = text.slice(u + 1, u + 6).join('');
    for (const e of endingCandidates(before)) if (!after.startsWith(e)) add({ kind: 'end', i: u + 1, j: u + 1, to: [...e], prefix: before });
  }
  return edits;
}

// 候補の点数から、使う直しを選ぶ（重ならないように、点数の高い順）。
// 返り値: [{ ...edit, score, check, note }]（check: 要確認。note: 理由）
export function chooseEdits(scored, opt = VERIFY) {
  const pass = e => {
    if (e.score == null || !Number.isFinite(e.score)) return false;
    // 別の読み方の結果: 文の頭・終わりの文字を消す直しは、音声の端の影響を受けやすいので、もっとはっきりした差のときだけ
    if (e.kind === 'pass') return e.ac >= (e.edge ? opt.passEdgeMin : opt.passMin);
    if (e.kind === 'end') return e.score >= opt.endMin && e.ac >= opt.endAcMin;
    // 元の言葉に文字を足すだけの直し（「方」→「方法」）は、足した文字の音が聞こえるときだけ（文の終わりの補いと同じ）
    if (e.extend) return e.ac >= opt.endAcMin && e.score >= opt.endMin;
    return e.score >= (e.domain ? opt.domainMin : opt.termMin) && e.ac >= opt.termAcMin;
  };
  const ok = scored.filter(pass);
  // 同じ所の候補どうしは、音声の点数に「話に出てきやすさ」（入力した言葉・美容の用語）を足して比べる
  const prior = e => (e.kind === 'term' && !e.extend ? -(e.domain ? opt.domainMin : opt.termMin) : 0);
  ok.forEach(e => { e.rank = e.score + prior(e); });
  ok.sort((a, b) => b.rank - a.rank);
  const used = [];
  for (const e of ok) {
    const lo = e.i, hi = Math.max(e.j, e.i + 1);
    // 重なる・となり合う直しは1つだけ（「ボ→ボブ」と「をね→ブをね」を両方使うと「ボブブをね」になる）
    if (used.some(x => lo <= Math.max(x.j, x.i + 1) && x.i <= hi)) continue;
    // 同じ所の、次に良い候補との差（文の終わりで「なります」と「なりません」のように意味が逆になる候補が近いときは要確認）
    const rivals = scored.filter(x => x !== e && x.i < hi && lo < Math.max(x.j, x.i + 1) && Number.isFinite(x.score));
    const runner = rivals.reduce((m, x) => Math.max(m, x.score), -Infinity);
    const flip = rivals.some(x => x.score > e.score - 2 && NEG_RE.test(x.to.join('')) !== NEG_RE.test(e.to.join('')));
    let check = false, note = '';
    if (e.kind === 'term') { check = e.score < opt.termSure; note = check ? '入力した言葉に直しました（音声との一致が低め）' : ''; }
    if (e.kind === 'end') { check = e.score < opt.endSure || flip; note = check ? '文の終わりを音声から補いました' : ''; }
    if (flip) note = '文の終わりが否定か肯定か、音声だけでははっきりしません';
    used.push({ ...e, check, note, margin: runner });
  }
  used.sort((a, b) => a.i - b.i);
  // 美容の用語で、直すほどではないが音声とかなり合う候補（入力した言葉なら直す差）は、直さずに「要確認」として知らせる
  const near = scored.filter(e => e.kind === 'term' && e.domain && !e.extend && Number.isFinite(e.score)
    && e.score >= opt.termMin && e.score < opt.domainMin && e.ac >= opt.termAcMin).sort((a, b) => b.score - a.score);
  const suggest = [];
  for (const e of near) {
    const lo = e.i, hi = e.j;
    if ([...used, ...suggest].some(x => lo <= Math.max(x.j, x.i + 1) && x.i <= hi)) continue;
    suggest.push(e);
  }
  return Object.assign(used, { suggest });
}

// 選んだ直しを文字の並びに当てはめる。新しい文字の時刻は、置き換えた範囲（なければ前後の文字の間）に並べる。
// 返り値: { tokens, fixes: [{ from, to, t0, t1, kind, check, note, score }] }
export function applyEdits(base, chosen, segEnd = Infinity) {
  const out = [];
  const fixes = [];
  let pos = 0;
  for (const e of chosen) {
    while (pos < e.i) out.push(base[pos++]);
    const from = base.slice(e.i, e.j);
    const prevT = out.length ? out[out.length - 1].t : (base[0]?.t ?? 0) - 0.2;
    const nextT = e.j < base.length ? base[e.j].t : Math.min(segEnd, prevT + 0.15 * (e.to.length + 1));
    const t0 = from.length ? from[0].t : prevT + (nextT - prevT) / (e.to.length + 1);
    const t1 = from.length ? from[from.length - 1].t : prevT + ((nextT - prevT) * e.to.length) / (e.to.length + 1);
    const times = e.times && e.times.length === e.to.length ? e.times
      : e.to.map((_, k) => +(t0 + ((t1 - t0) * k) / Math.max(1, e.to.length - 1)).toFixed(3));
    const fix = { from: from.map(k => k.s).join(''), to: e.to.join(''), t0: times[0], t1: times[times.length - 1], kind: e.kind, check: !!e.check, note: e.note || '', score: +e.score.toFixed(2), ac: +(e.ac ?? 0).toFixed(2) };
    fixes.push(fix);
    e.to.forEach((s, k) => out.push({ t: times[k], s, p: 1, v: fixes.length - 1 }));
    pos = e.j;
  }
  while (pos < base.length) out.push(base[pos++]);
  // 時刻を文字の順にそろえる
  for (let k = 1; k < out.length; k++) if (out[k].t < out[k - 1].t) out[k] = { ...out[k], t: out[k - 1].t };
  return { tokens: out, fixes };
}

// 1つのまとまりを確かめる。seg: { start, end, tokens（元の動画の時刻）, passes: [tokens…] }、eo: エンコーダーの出力（T×D）、
// offset: eo の最初のコマの時刻。symbols: 文字の一覧（番号 → 文字）
export async function verifySegment(model, eo, T, D, offset, seg, symbols, { words = [] } = {}) {
  const id = new Map(symbols.map((s, i) => [s, i]).filter(([s]) => s));
  const toFrame = t => Math.max(0, Math.min(T - 1, Math.round((t - offset) / FRAME)));
  const base = seg.tokens.filter(k => id.has(k.s));
  if (!base.length) return { tokens: seg.tokens, fixes: [], tried: 0 };
  const ids = base.map(k => id.get(k.s)), frames = base.map(k => toFrame(k.t));
  const watchIds = [...new Set(words.map(w => id.get([...(w.w || w)][0])).filter(x => x != null))];
  const L = await baseLattice(model, eo, T, D, ids, frames, { watch: watchIds });
  if (!Number.isFinite(L.ll)) return { tokens: seg.tokens, fixes: [], tried: 0 };
  const firstProb = (u, ch) => {
    const w = id.get(ch);
    if (w == null) return -Infinity;
    // u 番目の文字を出す前の行（u）の、その文字の時刻のあたりのコマ
    return L.rows[u].watchMax.get(w) ?? -Infinity;
  };
  const edits = proposeEdits(base, { passes: seg.passes || [], words, firstProb, segEnd: seg.end, lockHead: seg.lockHead || 0, lockTail: seg.lockTail || 0 });
  const ready = [];
  for (const e of edits) {
    if (!e.to.every(s => id.has(s))) continue;
    const prevF = e.i > 0 ? frames[e.i - 1] : 0, nextF = e.j < frames.length ? frames[e.j] : T - 1;
    const f0 = e.j > e.i ? frames[e.i] : prevF, f1 = e.j > e.i ? frames[e.j - 1] : Math.min(nextF, prevF + 4 * e.to.length);
    const ef = e.times && e.times.length === e.to.length ? e.times.map(toFrame)
      : e.to.map((_, k) => Math.round(f0 + ((f1 - f0) * (k + (e.j > e.i ? 0 : 1))) / Math.max(1, e.to.length - (e.j > e.i ? 1 : 0))));
    for (let k = 1; k < ef.length; k++) if (ef[k] < ef[k - 1]) ef[k] = ef[k - 1];
    ready.push({ e, edit: { i: e.i, j: e.j, ids: e.to.map(s => id.get(s)), frames: ef } });
  }
  const scored = [];
  for (let s = 0; s < ready.length; s += 24) {
    const part = ready.slice(s, s + 24);
    const rs = await scoreEdits(L, part.map(x => x.edit));
    part.forEach((x, k) => scored.push({ ...x.e, ...rs[k] }));
  }
  const chosen = chooseEdits(scored);
  const res = applyEdits(base, chosen, seg.end);
  const suggest = chosen.suggest.map(e => ({ from: base.slice(e.i, e.j).map(k => k.s).join(''), to: e.to.join(''), t0: base[e.i].t, score: +e.score.toFixed(2) }));
  return { ...res, suggest, tried: scored.length, scored };
}

// ---------- アプリでの使い方 ----------

// 美容の用語（入力していなくても、髪の話でよく出る言葉）。「すく」（梳く・髪の量を減らす）は形を変えて使うので、よく出る形も入れる
// （「すいて」「すきます」は「ついて」「つきます」とまぎらわしく、普通の言葉を書き換えてしまうので入れない。否定の形だけ）
const HAIR_VERB_FORMS = ['すかない'];
export function domainWords(terms = []) {
  return [...new Set([...terms.map(t => t.term), ...HAIR_VERB_FORMS])].filter(w => w && w.length >= 2).map(w => ({ w, domain: true }));
}

const PARTICLE_HEAD = 'をがはにでとものねよへやかしけ';
// 確かめる単位: 3通りを合わせた文字（tokens）を、はっきりした間（0.6秒以上）で分けたまとまり。言葉の途中では分けない
// （文に分けた後だと、聞き取りが乱れた所で文の切れ目がずれることがあるため）。長いまとまりは一番長い間で分ける。
// 音声はまとまりの前後を少し含める（となりのまとまりの声は含めない）。passes: 3通りの読み方の文字（{ A, B, C }）
export function verifyUnits(tokens, fine = [], passes = null, { gap = 0.6, maxSec = 15, pad = VERIFY.pad } = {}) {
  const pauseAt = (a, b) => {
    let sum = 0;
    for (let i = 1; i < fine.length; i++) {
      const g0 = Math.max(a, fine[i - 1].end), g1 = Math.min(b, fine[i].start);
      if (g1 > g0) sum += g1 - g0;
    }
    return fine.length ? sum : Math.max(0, b - a - 0.35);
  };
  const split = ks => {
    if (ks.length < 2 || ks[ks.length - 1].t - ks[0].t <= maxSec) return [ks];
    // 分ける所: 間が0.25秒以上あり、次の文字が助詞（「を」「が」…）でなく、言葉の途中でない所のうち、間が一番長い所
    let best = -1, bp = 0.25;
    const chars = ks.map(k => k.s);
    for (let i = 1; i < ks.length; i++) {
      // 漢字の後のひらがな（送りがな・「下手｜すれば」）の前でも分けない
      if (PARTICLE_HEAD.includes(ks[i].s) || inWord(chars, i) || (KANJI.test(chars[i - 1]) && /^[ぁ-ゖ]$/.test(chars[i]))) continue;
      const p = pauseAt(ks[i - 1].t, ks[i].t);
      if (p >= bp) { bp = p; best = i; }
    }
    if (best < 0) return [ks];
    return [...split(ks.slice(0, best)), ...split(ks.slice(best))];
  };
  const groups = [];
  let cur = [];
  for (const k of tokens) {
    if (cur.length && pauseAt(cur[cur.length - 1].t, k.t) >= gap) { groups.push(cur); cur = []; }
    cur.push(k);
  }
  if (cur.length) groups.push(cur);
  // 長さで分けた所（間が短い所）は、となりの声が窓の端にかかるので、端の文字は直さない（lockHead・lockTail）
  const units = groups.flatMap(g => split(g).map((ks, n, all) => ({ ks, forcedHead: n > 0, forcedTail: n + 1 < all.length })));
  return units.map(({ ks, forcedHead, forcedTail }, n) => {
    const prev = units[n - 1]?.ks, next = units[n + 1]?.ks;
    const t0 = ks[0].t, t1 = ks[ks.length - 1].t;
    const start = Math.max(0, prev ? Math.max(t0 - 0.5, (prev[prev.length - 1].t + t0) / 2) : t0 - 0.5);
    const end = next ? Math.min(t1 + 0.6, (t1 + next[0].t) / 2) : t1 + 0.6;
    const inside = k => k.t >= start && k.t < end;
    return {
      start, end, lockHead: forcedHead ? VERIFY.lock : 0, lockTail: forcedTail ? VERIFY.lock : 0,
      tokens: ks.map(({ t, s, p }) => ({ t, s, p })),
      passes: passes ? Object.values(passes).map(P => P.filter(inside).map(({ t, s, p }) => ({ t, s, p }))) : [],
    };
  });
}

// 確かめた結果（units と同じ順の { tokens, fixes }）を、文字起こしの文字の並び（1つのまとまり）にする
export function verifiedRaw(results) {
  const tokens = results.flatMap(r => r.tokens);
  const fixes = results.flatMap(r => r.fixes || []);
  const suggest = results.flatMap(r => r.suggest || []);
  if (!tokens.length) return [];
  const text = tokens.map(k => k.s).join('');
  return Object.assign([{ start: tokens[0].t, end: tokens[tokens.length - 1].t, text, raw: text, timed: true, tokens }], { fixes, suggest });
}

// 文（chunk）に、音声で確かめて直した所を記録する（fixed: { from, to, at, len, check, kind: 'audio' }）。
// 要確認のものは doubts にも入れる（書き出しの前に「要確認」として表示する）
// suggest: 直さなかったが、聞き間違いの可能性がある所（c.suggest に入れ、要確認として知らせる）
export function attachAudioFixes(chunks, fixes = [], suggest = []) {
  return chunks.map(c => {
    const near = f => f.t0 >= c.start - 0.35 && f.t0 <= c.end + 0.35;
    const mine = fixes.filter(f => near(f) && (c.text || '').includes(f.to));
    const sg = suggest.filter(f => near(f) && (c.text || '').includes(f.from));
    if (sg.length) c = { ...c, suggest: [...(c.suggest || []), ...sg.map(({ from, to }) => ({ from, to }))] };
    if (!mine.length) return c;
    const fixed = [...(c.fixed || [])], doubts = [...(c.doubts || [])];
    for (const f of mine) {
      const at = c.text.indexOf(f.to);
      fixed.push({ from: f.from, to: f.to, at, len: f.to.length, check: f.check, kind: 'audio', how: f.kind });
      if (f.check) doubts.push(`「${f.from || '（なし）'}」→「${f.to}」と音声から直しました。${f.note || '音声との一致が低めです'}（要確認）`);
    }
    return { ...c, fixed, ...(doubts.length ? { doubts: [...new Set(doubts)] } : {}) };
  });
}
