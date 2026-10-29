// 文字起こし結果（1文字ごとの時刻つき）から、字幕の文・用語の直し・確認が必要な箇所・原稿との照合を作る。
// ブラウザAPIを使わないので Node でテストできる
import { BEAUTY_TERMS, moraCount } from './plan.js';

const PUNCT = /[、。，．,.！？!?\s「」『』（）()…・]/;
const toKata = t => t.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
const toHira = t => t.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

// 文の終わりらしい語尾。はっきりした語尾（ます・です…）は短い間でも、そうでない語尾（ない・いく…）は少し長い間で文を分ける
const SENTENCE_END_RE = /(?:ます|ました|ません|です|でした|ください|下さい|しょう|ましょう|よね|ですね|ですよ)$/;
const WEAK_END_RE = /(?:ない|なる|いく|ある|いる|した|った|んだ|よ|ね)$/;
const isKana = c => /[\u30a0-\u30ff]/.test(c || '');
// 読点を入れやすい語尾（「〜て」「〜ので」「〜は」など）
const COMMA_AFTER_RE = /(?:て|で|ので|から|けど|けれど|が|と|は|も|たり|し)$/;
// この文字から始まるなら、前の文の続き（「ますが」「ないと」「ないで」）。弱い語尾のあとは続きの言葉が多い
const CONTINUE_HEAD_RE = /^[がけかよねのとしなわ]/;
const WEAK_CONTINUE_RE = /^[がけかよねのとしなわでもた]/;
const NO_COMMA_BEFORE = 'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮーンん';

// 時刻 a〜b の間にある無音（声の区間 fine のすき間）の長さ
function pauseBetween(fine, a, b) {
  let sum = 0;
  for (let i = 1; i < fine.length; i++) {
    const g0 = Math.max(a, fine[i - 1].end), g1 = Math.min(b, fine[i].start);
    if (g1 > g0) sum += g1 - g0;
  }
  return sum;
}

// 文字起こしの区間ごとの結果（tokens: { t: 元の動画の時刻, s: 文字, p: 確からしさ }）を、
// 声の切れ目（fine: 細かい発話区間）で文に分ける。句読点は声の間から入れる（モデルは句読点を出さない）。
// 返り値の各文: { start, end, text, raw, timed, tokens, times }（times は text の1文字ごとの時刻）
// 用語の読み（ひらがな・4文字以上。文の区切りの直しに使う）
const TERM_READINGS = [...new Set([...BEAUTY_TERMS, { reading: 'スキバサミ' }].flatMap(t => [t.reading, ...(t.variants || [])])
  .filter(r => r && /^[ぁ-ゖァ-ヶー]+$/.test(r)).map(toHira).filter(r => r.length >= 4))];
const SENTENCE_HEADS = ['あとは', 'それは', 'それを', 'そうなら', 'そして', 'でも', 'なので', 'だから', 'まずは', 'ただ', 'となれば', 'こうなって'];

export function tokensToChunks(raw, fine = []) {
  const tokens = [];
  for (const c of raw) {
    const last = tokens.length ? tokens[tokens.length - 1].t : -Infinity;
    for (const k of c.tokens || []) if (k.t > last + 0.01) tokens.push(k); // 区間の重なりで同じ文字が2回出ないように
  }
  // 1. 声の間で文に分ける
  const groups = [];
  let cur = [];
  const flush = () => { if (cur.length) groups.push(cur); cur = []; };
  for (const [ti, k] of tokens.entries()) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const pause = fine.length ? pauseBetween(fine, prev.t, k.t) : Math.max(0, k.t - prev.t - 0.35);
      const sofar = cur.map(x => x.s).join('');
      // 文を分ける: 長い間 / 文の終わりらしい語尾（次が「が」「と」などの続きの言葉でない）のあとの間 / 長くなった文の間
      // 「〜ない｜ように」「〜する｜ような」は、間があっても同じ文の続き
      const ahead = tokens.slice(ti, ti + 3).map(x => x.s).join('');
      const yoCont = /^よう[にな]/.test(ahead);
      const cont = CONTINUE_HEAD_RE.test(k.s), weakCont = WEAK_CONTINUE_RE.test(k.s) || yoCont;
      const inWord = isKana(sofar[sofar.length - 1]) && isKana(k.s[0]); // カタカナ語の途中（「ヘ／アカッター」）では分けない
      const brk = pause >= 0.55 || (!cont && SENTENCE_END_RE.test(sofar) && pause >= 0.12) || (!weakCont && WEAK_END_RE.test(sofar) && pause >= 0.3)
        || (sofar.length >= 40 && pause >= 0.3) || k.t - prev.t > 2.5;
      if (brk && !(inWord && pause < 0.8) && !(yoCont && pause < 0.55)) flush();
      // 読点: 「〜て」「〜ので」などのあとの、はっきりした間 / 長い間 / 同じ言葉で言い直した所（「このような、このような」）。
      // 「トップ」の「ッ」のような言葉の中の無音・1〜2文字の言葉（「で、も」）のあとには入れない
      else {
        const clause = sofar.split('、').pop();
        const restart = clause.length >= 2 && clause.startsWith(k.s + (tokens[tokens.indexOf(k) + 1]?.s || ''));
        if (!NO_COMMA_BEFORE.includes(k.s[0]) && !inWord && clause.length >= 3
          && ((pause >= 0.35 && COMMA_AFTER_RE.test(sofar)) || pause >= 0.45 || (pause >= 0.25 && restart))) { cur.push({ ...k, comma: true }); continue; }
      }
    }
    cur.push({ ...k });
  }
  flush();
  // 文の始まりによく使う言葉（「あとは」「それは」）の途中で文が分かれた（「…しまいあ｜とは…」）ときは、言葉の前で分ける
  for (let g = 0; g + 1 < groups.length; g++) {
    const a = groups[g], b = groups[g + 1];
    const tail = a.slice(-3).map(k => k.s).join(''), head = b.slice(0, 4).map(k => k.s).join('');
    for (const w of SENTENCE_HEADS) {
      const n = [...Array(w.length).keys()].slice(1).find(n => n < a.length && tail.endsWith(w.slice(0, n)) && head.startsWith(w.slice(n)));
      if (n) { b.unshift(...a.splice(a.length - n, n)); break; }
    }
  }
  // 用語の途中で文が分かれた（「セルフカットです｜きばさみ」= 「セルフカットで｜すきばさみ」）: 前の文の終わりの
  // 1〜2文字と次の文の頭で用語の読みになるときは、その文字を次の文に移し、間が短ければ1つの文にする
  for (let g = 0; g + 1 < groups.length; g++) {
    const a = groups[g], b = groups[g + 1];
    const head = toHira(b.slice(0, 8).map(k => k.s).join(''));
    if (TERM_READINGS.some(r => head.startsWith(r))) continue;
    const n = [1, 2].find(n => n < a.length && TERM_READINGS.some(r => toHira(a.slice(-n).map(k => k.s).join('') + head).startsWith(r)));
    if (!n) continue;
    b.unshift(...a.splice(a.length - n, n));
    if (b[0].t - a[a.length - 1].t < 0.8) { groups.splice(g, 2, [...a, ...b]); g--; }
  }
  // 2. 間なく続けて話した長い文は、はっきりした文の終わり（〜ます。〜です。）で分ける
  const split = [];
  for (const g of groups) {
    let start = 0;
    for (let i = 1; i < g.length; i++) {
      const before = g.slice(start, i).map(x => x.s).join('');
      // 「です｜きばさみ」のように、区切ると用語（すきばさみ）の途中になる所では分けない
      const after = toHira(g.slice(i, i + 8).map(x => x.s).join(''));
      const inTerm = !TERM_READINGS.some(r => after.startsWith(r)) && [1, 2].some(n => TERM_READINGS.some(r => toHira(before.slice(-n) + after).startsWith(r)));
      if (before.length >= 4 && g.length - i >= 4 && SENTENCE_END_RE.test(before) && !CONTINUE_HEAD_RE.test(g[i].s) && !inTerm) {
        split.push(g.slice(start, i));
        start = i;
      }
    }
    split.push(g.slice(start));
  }
  return split.filter(g => g.length).map(g => {
    let text = '';
    const times = [];
    g.forEach((k, i) => {
      if (k.comma && i > 0) { text += '、'; times.push(times[times.length - 1] ?? k.t); }
      text += k.s;
      for (let j = 0; j < k.s.length; j++) times.push(k.t);
    });
    const t0 = g[0].t, t1 = g[g.length - 1].t;
    // 文字の時刻は「その文字を話している途中」なので、声の区間の端まで広げる
    const v0 = fine.find(r => r.start <= t0 + 0.05 && r.end >= t0 - 0.05);
    const v1 = fine.find(r => r.start <= t1 + 0.05 && r.end >= t1 - 0.05);
    const start = Math.max(0, v0 ? Math.max(v0.start, t0 - 0.6) : t0 - 0.15);
    const end = v1 ? Math.min(v1.end, t1 + 0.8) : t1 + 0.35;
    return { start, end: Math.max(end, start + 0.2), text, raw: text, timed: true, tokens: g.map(k => ({ t: k.t, s: k.s, p: k.p })), times };
  });
}

// ---------- 用語の直し ----------

// 用語の一覧から、文字起こしの書き方 → 正しい書き方 の置き換えを作る。
// 読みが同じもの（はさみ → ハサミ、すきばさみ → すきバサミ）は確実に同じ言葉なので自動で直す
const EXTRA_TERMS = [
  { term: 'ハサミ', reading: 'ハサミ' },
  { term: 'すきバサミ', reading: 'スキバサミ' },
  { term: '100均', variants: ['百均', 'ひゃっきん', 'ヒャッキン'] },
];

// 髪の話でよく聞き間違える同じ読みの漢字（「髪が痛む」ではなく「傷む」）。直した所には確認の印をつける
const HAIR_HOMOPHONES = [['痛んで', '傷んで'], ['痛んだ', '傷んだ'], ['痛みの', '傷みの'], ['痛みが', '傷みが'], ['痛みや', '傷みや'], ['痛ま', '傷ま'], ['痛み', '傷み']];

function replacements(userTerms = []) {
  const reps = [];
  const add = (from, to, kind) => { if (from && from !== to && from.length >= 2) reps.push({ from, to, kind }); };
  for (const [from, to] of HAIR_HOMOPHONES) add(from, to, 'homophone');
  for (const { term, reading, variants } of [...BEAUTY_TERMS, ...EXTRA_TERMS]) {
    // ひらがなで書かれた読み（3文字以上。短いものは普通の言葉と区別できないので直さない）
    const r = reading || (/^[゠-ヿ]+$/.test(term) ? term : null);
    if (r && r.length >= 3) { add(toHira(r), term, 'reading'); add(toKata(r), term, 'reading'); }
    for (const v of variants || []) if (toKata(v) === toKata(r || '') || /^[0-9百]/.test(term)) add(v, term, 'reading');
  }
  for (const w of userTerms) {
    if (/^[゠-ヿー]+$/.test(w) && w.length >= 3) add(toHira(w), w, 'reading');
  }
  return reps.sort((a, b) => b.from.length - a.from.length);
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

// 文字起こしの文 chunk（text・times）の用語を直す。
// - 読みが同じ書き方 → 自動で直す
// - 入力されたアイテム名・用語（カタカナ）と1〜2文字だけ違うカタカナ語 → 直して「確認が必要」の印をつける
// 返り値: 直した chunk（fixed: 直した箇所 [{ from, to, at, len, check }]）
// phrases: 入力したタイトル・説明に出てくるひらがなの言葉（5文字以上。「すかないで」など）。
// 文字起こしの中に、最初の1文字だけが違う同じ長さの言葉（「つかないで」）があれば、聞き間違いとして直して印をつける
export function fixTerms(chunk, userTerms = [], phrases = []) {
  let text = chunk.text, times = chunk.times ? [...chunk.times] : null;
  const fixed = [];
  const replaceAt = (at, len, to, rec) => {
    if (times) {
      const t0 = times[at] ?? times[times.length - 1] ?? 0, t1 = times[at + len - 1] ?? t0;
      times.splice(at, len, ...Array.from({ length: to.length }, (_, i) => t0 + ((t1 - t0) * i) / Math.max(1, to.length - 1)));
    }
    text = text.slice(0, at) + to + text.slice(at + len);
    fixed.push({ ...rec, at, len: to.length });
  };
  for (const r of replacements(userTerms)) {
    for (let at = text.indexOf(r.from); at >= 0; at = text.indexOf(r.from, at + r.to.length)) {
      // より長い言葉の一部（「ハサミ」の中の…）や、すでに正しい用語の一部は直さない
      if (text.startsWith(r.to, at) || text.slice(Math.max(0, at - r.to.length), at + r.from.length).includes(r.to)) continue;
      replaceAt(at, r.from.length, r.to, { from: r.from, to: r.to, check: r.kind === 'homophone' });
    }
  }
  // 入力された用語（カタカナ・4文字以上）に近いカタカナ語（英字が混ざった「Aカッター」なども含む）
  for (const w of userTerms.filter(x => /^[゠-ヿー]{4,}$/.test(x))) {
    for (const m of [...text.matchAll(/[A-Za-z゠-ヿー]{3,}/g)].reverse()) {
      const word = m[0];
      if (word === w || word.includes(w)) continue;
      const kana = word.replace(/[A-Za-z]/g, 'エ');
      const dist = editDistance(kana, w);
      const suffix = (() => { let n = 0; while (n < Math.min(kana.length, w.length) && kana[kana.length - 1 - n] === w[w.length - 1 - n]) n++; return n; })();
      if (Math.abs(word.length - w.length) <= 1 && (dist <= 1 || (dist <= 2 && w.length >= 6 && suffix >= 4))) {
        replaceAt(m.index, word.length, w, { from: word, to: w, check: true });
      }
    }
  }
  // 入力された用語（漢字を含む5文字以上）と、漢字の所だけが違う同じ長さの言葉（同じ読みの別の漢字の聞き間違い。
  // 「トップの根元布巾」→「トップの根元付近」）。2文字の熟語がまるごと入れ替わったときだけ直す（「前上がり」と
  // 「前下がり」のように1文字だけ違う言葉は、別の意味の言葉のことがあるので直さない）
  const isKanji = ch => /[\u4e00-\u9fff々]/.test(ch);
  for (const w of userTerms.filter(x => x.length >= 5 && [...x].some(isKanji))) {
    if (text.includes(w)) continue;
    for (let at = 0; at + w.length <= text.length; at++) {
      const seg = text.slice(at, at + w.length);
      const diffs = [];
      for (let k = 0; k < w.length; k++) if (seg[k] !== w[k]) diffs.push(k);
      const ok = diffs.length === 2 && diffs[1] === diffs[0] + 1 && w.length >= 6 && diffs.every(k => isKanji(seg[k]) && isKanji(w[k]));
      if (ok) {
        replaceAt(at, w.length, w, { from: seg, to: w, check: true });
        break;
      }
    }
  }
  for (const ph of phrases) {
    if (ph.length < 5 || text.includes(ph)) continue;
    for (let at = 0; at + ph.length <= text.length; at++) {
      const w = text.slice(at, at + ph.length);
      if (w[0] !== ph[0] && w.slice(1) === ph.slice(1) && /^[\u3041-\u3096]$/.test(w[0])) {
        replaceAt(at, ph.length, ph, { from: w, to: ph, check: true });
        at += ph.length - 1;
      }
    }
  }
  return { ...chunk, text, times, fixed: [...(chunk.fixed || []), ...fixed] };
}

// 文の終わりが言葉の途中で終わっている（「…は軽く」「…軽くし」「…でき」）。字幕AIが「しない」「します」などを
// 聞き落とした可能性があり、否定の「ない」を落とすと意味が逆になるため、確認が必要な字幕として知らせる
const CUT_ENDING_RE = /(?:[^っ]く|[^ーっ]し|でき|ませ|[^よいくずるたうすつぬむふ]な|[をがは])$/;
export function cutEnding(text) {
  const t = (text || '').replace(/[、。\s]+$/, '');
  return t.length >= 4 && CUT_ENDING_RE.test(t);
}

// 入力した文章から、ひらがなの言葉（5文字以上）を取り出す（聞き間違いを直す手がかり）
export function kanaPhrases(...texts) {
  const out = new Set();
  for (const t of texts) for (const m of (t || '').normalize('NFKC').matchAll(/[\u3041-\u3096ー]{5,12}/g)) out.add(m[0]);
  return [...out];
}

// 確認が必要な箇所（文字起こしの確からしさが低い文字・入力された用語に直した所）。text の文字位置の範囲 [from, to)
export function checkRanges(chunk, threshold = 0.4) {
  const ranges = [];
  if (chunk.tokens && chunk.times) {
    // 確からしさは文字ごと。text には読点が入っているので、時刻で文字を対応させる
    let ti = 0;
    for (let i = 0; i < chunk.text.length && ti < chunk.tokens.length; i++) {
      if (PUNCT.test(chunk.text[i])) continue;
      const k = chunk.tokens[ti++];
      if (k && k.p < threshold) ranges.push([i, i + 1]);
    }
  }
  for (const f of chunk.fixed || []) if (f.check) ranges.push([f.at, f.at + f.len]);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

// ---------- 原稿との照合 ----------

const norm = c => toHira(c.normalize('NFKC')).toLowerCase();

// 文字起こしの文の、1文字ごとの時刻（時刻がない文は読みの長さで割り振る）
function charTimes(c) {
  const chars = [...c.text];
  if (c.times && c.times.length === chars.length) return chars.map((s, i) => ({ s, t: c.times[i] }));
  const a = c.subStart ?? c.start, b = c.subEnd ?? c.end;
  const total = moraCount(c.text) || 1;
  let acc = 0;
  return chars.map(s => {
    const t = a + ((b - a) * acc) / total;
    acc += moraCount(s);
    return { s, t };
  });
}

// 原稿 script を文字起こし（chunks）に照らし合わせ、原稿の1文字ごとに「話した時刻」をつける。
// 文字単位の編集距離で並べる（言い直し・原稿にない発言は文字起こし側だけにある文字として飛ばす）。
// 返り値: { chars: [{ c: 原稿の文字, t: 時刻 | null, punct }], matched: 一致した文字の割合 }
export function alignScript(script, chunks) {
  const asr = [];
  for (const c of chunks) for (const x of charTimes(c)) if (!PUNCT.test(x.s)) asr.push({ c: norm(x.s), t: x.t });
  const chars = [...(script || '').normalize('NFKC')].map(c => ({ c, t: null, punct: PUNCT.test(c) || c === '\n' }));
  const B = chars.filter(x => !x.punct);
  const n = asr.length, m = B.length;
  if (!n || !m) return { chars, matched: 0 };
  // 帯の中だけで計算する（長い動画でもメモリを使いすぎない）。帯の幅は長さの差＋余裕
  const W = Math.max(200, Math.abs(n - m) + 150);
  const INF = 1e9;
  const cols = 2 * W + 1;
  const dirs = new Uint8Array((n + 1) * cols); // 0: 斜め 1: 上（文字起こしだけ）2: 左（原稿だけ）
  let prev = new Float64Array(cols).fill(INF), cur = new Float64Array(cols).fill(INF);
  const center = i => Math.round((i * m) / n);
  const idx = (i, j) => j - center(i) + W;
  // 文字起こしの前後（原稿の前・後に話したこと）は、ただで飛ばせる。原稿の文字を飛ばすのは1文字ずつ数える
  for (let j = 0; j <= m; j++) { const k = idx(0, j); if (k >= 0 && k < cols) { prev[k] = j; dirs[k] = 2; } }
  for (let i = 1; i <= n; i++) {
    cur.fill(INF);
    const ci = center(i), cp = center(i - 1);
    for (let k = 0; k < cols; k++) {
      const j = ci - W + k;
      if (j < 0 || j > m) continue;
      let best = INF, d = 0;
      // 斜め（一致・置き換え）
      const kd = j - 1 - cp + W;
      if (j >= 1 && kd >= 0 && kd < cols && prev[kd] < INF) { const v = prev[kd] + (asr[i - 1].c === norm(B[j - 1].c) ? 0 : 1); if (v < best) { best = v; d = 0; } }
      // 上（文字起こしの文字を飛ばす: 言い直し・原稿にない話）
      const ku = j - cp + W;
      if (ku >= 0 && ku < cols && prev[ku] < INF) { const v = prev[ku] + (j === 0 || j === m ? 0 : 1); if (v < best) { best = v; d = 1; } }
      // 左（原稿の文字を飛ばす: 話さなかった・聞き取れなかった）
      if (k > 0 && cur[k - 1] < INF) { const v = cur[k - 1] + 1; if (v < best) { best = v; d = 2; } }
      cur[k] = best;
      dirs[i * cols + k] = d;
    }
    [prev, cur] = [cur, prev];
  }
  // 最後は原稿の終わり（j = m）から戻る
  let i = n, j = m, hits = 0;
  if (idx(n, m) < 0 || idx(n, m) >= cols) return { chars, matched: 0 };
  while (i > 0 && j > 0) {
    const k = idx(i, j);
    if (k < 0 || k >= cols) break;
    const d = dirs[i * cols + k];
    if (d === 0) { B[j - 1].t = asr[i - 1].t; if (asr[i - 1].c === norm(B[j - 1].c)) { hits++; B[j - 1].hit = true; } i--; j--; }
    else if (d === 1) i--;
    else j--;
  }
  // 時刻のない原稿の文字（聞き取れなかった所）は、前後の文字の時刻の間に入れる
  for (let a = 0; a < B.length; a++) {
    if (B[a].t != null) continue;
    let b = a;
    while (b < B.length && B[b].t == null) b++;
    const t0 = a > 0 ? B[a - 1].t : null, t1 = b < B.length ? B[b].t : null;
    for (let k = a; k < b; k++) B[k].t = t0 != null && t1 != null ? t0 + ((t1 - t0) * (k - a + 1)) / (b - a + 1) : (t0 ?? t1);
    a = b;
  }
  // 句読点は直前の文字の時刻
  let last = null;
  for (const x of chars) { if (x.punct) x.t = last; else last = x.t; }
  return { chars, matched: hits / m };
}

// 原稿を句（読点・句点・改行で区切る）ごとに場面へ割り当て、場面ごとの字幕の文字を作る。
// 句の文字の半分以上を話している場面に、その句をまるごと入れる（言葉の途中で場面をまたがない）。
// どの場面にも入らない句（取り除いた部分で話した・話さなかった）は使わない。返り値: Map(場面 → 文字)
const LAG = 0.15; // 文字の時刻は声より少し早めに出るので、その分を足して比べる
export function assignScript(aligned, units) {
  const out = new Map();
  if (!aligned) return out;
  const cs = aligned.chars;
  const phrases = [];
  let cur = null;
  for (const x of cs) {
    if (x.punct) {
      if (cur) { cur.tail += x.c === '\n' ? '。' : x.c; if (/[、。！？!?\n]/.test(x.c)) { phrases.push(cur); cur = null; } }
      continue;
    }
    if (!cur) cur = { text: '', times: [], tail: '' };
    cur.text += x.c;
    cur.times.push(x.t);
  }
  if (cur) phrases.push(cur);
  const inUnit = (u, t) => t != null && t + LAG >= (u.voiceStart ?? u.start) - 0.2 && t + LAG <= (u.voiceEnd ?? u.end) + 0.2
    && (u.pieces || [{ start: u.start, end: u.end }]).some(p => t + LAG >= p.start - 0.2 && t + LAG <= p.end + 0.2);
  const parts = new Map();
  for (const ph of phrases) {
    let best = null, bestN = 0;
    for (const u of units) {
      const n = ph.times.filter(t => inUnit(u, t)).length;
      if (n > bestN) { bestN = n; best = u; }
    }
    if (!best || bestN < ph.times.length / 2) continue;
    if (!parts.has(best)) parts.set(best, []);
    parts.get(best).push(ph);
  }
  // 返り値: Map(場面 → { text, times })。times は text の1文字ごとの時刻（句読点は直前の文字の時刻）
  for (const [u, list] of parts) {
    let text = '';
    const times = [];
    list.forEach((ph, i) => {
      text += ph.text;
      times.push(...ph.times);
      const tail = i < list.length - 1 ? ph.tail.replace(/\s/g, '').slice(-1) : '';
      if (tail) { text += tail; times.push(ph.times[ph.times.length - 1]); }
    });
    out.set(u, { text, times: times.map(t => t ?? times.find(x => x != null) ?? 0) });
  }
  return out;
}

// 1つの場面だけの原稿の文字（ほかの場面がない場合の簡易版）
export function scriptTextFor(aligned, u) {
  return assignScript(aligned, [u]).get(u)?.text ?? '';
}
