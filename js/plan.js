// 編集プランを作る純粋関数（ブラウザAPIを使わないので Node でテストできる）

export const FRAME_SEC = 0.05; // 音量を測る単位（50ms）
export const OUT_W = 1080;
export const OUT_H = 1920;
export const FPS = 30;

// カット解説でよく出る言葉。字幕にこれらが含まれる場面を優先して残す
export const KEYWORDS = [
  'カット', 'ブロッキング', 'ブロック', 'パネル', '引き出し', '角度', 'セクション', 'スライス',
  'ガイド', 'レイヤー', 'グラデーション', 'ワンレン', 'ボブ', 'ショート', '前髪', '襟足', 'えりあし',
  'もみあげ', 'サイド', 'トップ', 'バック', '毛先', '量感', 'すき', 'セニング', 'ハサミ', 'シザー',
  'チョップ', 'ポイントカット', 'スライド', '段', '重さ', '軽さ', '丸み', '前下がり', '後ろ下がり',
  '仕上がり', 'ドライ', 'ブロー', '乾かし', 'コツ', '大事', '重要', '注意', 'ビフォー', 'アフター',
];
const DEGREE_RE = /[0-9０-９]+\s*度/;

// 言い直しの合図になる言葉（「もう一回」はカット説明でも普通に使うので含めない）
// Whisper はひらがなや聞き間違いで書くことがある（例: いい直します、いいなをします）
const RETAKE_RE = /言い直|いい直|言いなお|いいなお|いいなをし|撮り直|とり直|間違えました|間違えた|ごめんなさい|失礼しました/;

// 文字起こしに先に与える「話題と用語」。Whisper はこれに引っぱられて専門用語を正しく書きやすくなる
export const ASR_PROMPT = '美容師のカット解説です。ブロッキング、スライス、パネル、0度、45度、90度、ガイド、毛先、前下がり、ボブ、レイヤー、グラデーション、セニング、量感、軽さ、重さ、丸み、シルエット、襟足、もみあげ、前髪、ドライ、ブロー。';

// 美容の専門用語の辞書。variants は Whisper がよく書き間違える形。
// ここから作るのは「修正案」だけで、実際に置き換えるかは音声で確かめてから決める（transcribe-worker.js）
// reading はカタカナの読み。書き間違いが読みと同じ（エリアシ → 襟足）なら、聞こえた音は同じなので文字の種類を整えるだけ
export const BEAUTY_TERMS = [
  { term: 'ショートボブ', variants: ['ショート部分', 'ショートボーブ', 'ショートボップ'] },
  { term: 'ショート', variants: ['ショット'] },
  { term: 'ボブ', variants: ['ボーブ', 'ボップ'] },
  { term: '前下がり', reading: 'マエサガリ', variants: ['前さがり', 'まえさがり', '前下り', '前坂'] },
  { term: '前上がり', reading: 'マエアガリ', variants: ['前さあがり', 'まえあがり'] },
  { term: 'グラデーション', variants: ['ブラデーション', 'グラデイション', 'クラデーション'] },
  { term: 'レイヤー', variants: ['レーヤー', 'レイア', 'レイヤ'] },
  { term: 'ブロッキング', variants: ['ブロッキン', 'ブロックキング', 'プロッキング'] },
  { term: 'セニング', variants: ['セーニング', 'センニング', 'せニング', 'セイニング'] },
  { term: '毛量調整', reading: 'モウリョウチョウセイ', variants: ['模様調整', '毛量調性', '猛量調整', '盲料調整', '猛料調整', 'もうりょう調整'] },
  { term: '毛量', reading: 'モウリョウ', variants: ['猛量', '盲料', '猛料', 'もうりょう'] },
  { term: '毛先', reading: 'ケサキ', variants: ['下先', '下さき', '傾作', '毛さき', 'けさき', '気先'] },
  { term: '襟足', reading: 'エリアシ', variants: ['エリアシ', 'えりあし', '襟脚', 'エリ足'] },
  { term: 'もみあげ', reading: 'モミアゲ', variants: ['模樣上', '模様上', 'もみ上げ', 'モミアゲ', '揉み上げ'] },
  { term: 'スライス', variants: ['スライズ', 'スライスト'] },
  { term: 'パネル', variants: ['ハネル', 'カネル', 'バネル'] },
  { term: 'ガイド', variants: ['ガイト'] },
  { term: 'サイドは', variants: ['再度は'] }, // 「再度」は普通の言葉なので「再度は」の形だけ
  { term: '量感', reading: 'リョウカン', variants: ['両感', '料感', '量勘', 'ローカー', '涼感'] },
  { term: 'シルエット', variants: ['シルエッド', 'シルエト'] },
  { term: 'すきバサミ', reading: 'スキバサミ', variants: ['スキーバサミ', 'すきばさみ', 'スキバサミ', '隙鋏', '好きバサミ'] },
  { term: 'チョップカット', variants: ['チョップカッと', 'チャップカット', 'チョップカッド', 'ちょっとカット'] },
  { term: '丸み', reading: 'マルミ', variants: ['マルミ', 'まるみ'] },
  { term: '軽さ', reading: 'カルサ', variants: ['カルサ'] },
  { term: '0度', variants: ['ゼロド', 'ゼロ度', '零度'] },
  { term: '45度', variants: ['45ド', '四十五度'] },
  { term: '90度', variants: ['90ド', '九十度'] },
];

const isKata = c => !!c && /[\u30a0-\u30ff]/.test(c);
const toKata = t => t.replace(/[\u3041-\u3096]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

// 文の中から、辞書の用語への修正案を作る。{ index, from, to } の配列（重なりは長いものを優先）
export function proposeCorrections(text) {
  const t = text || '';
  const found = [];
  for (const { term, variants } of BEAUTY_TERMS) {
    for (const v of variants) {
      let i = t.indexOf(v);
      while (i >= 0) {
        // カタカナの書き間違いは、より長いカタカナ語の一部（例: スライド の ライド）では使わない
        const inWord = isKata(v[0]) && isKata(t[i - 1]) || isKata(v[v.length - 1]) && isKata(t[i + v.length]);
        if (!inWord && !t.startsWith(term, i) && !t.slice(Math.max(0, i - term.length), i + v.length).includes(term)) {
          const reading = BEAUTY_TERMS.find(x => x.term === term).reading;
          found.push({ index: i, from: v, to: term, kind: reading && toKata(v) === reading ? 'reading' : 'variant' });
        }
        i = t.indexOf(v, i + 1);
      }
    }
  }
  // 辞書にない書き間違い: カタカナ語が用語と1〜2文字だけ違う場合（例: ブラデーション → グラデーション）
  const kataTerms = BEAUTY_TERMS.filter(x => [...toKata(x.term)].every(isKata));
  for (const m of t.matchAll(/[\u30a0-\u30ff]{3,}/g)) {
    for (const { term } of kataTerms) {
      const k = toKata(term);
      if (m[0] === k || m[0].includes(k)) continue;
      const limit = k.length >= 6 ? 2 : 1;
      if (Math.abs(m[0].length - k.length) <= limit && editDistance(m[0], k) <= limit) found.push({ index: m.index, from: m[0], to: term, kind: 'fuzzy' });
    }
  }
  found.sort((a, b) => a.index - b.index || b.from.length - a.from.length);
  const out = [];
  for (const f of found) {
    const last = out[out.length - 1];
    if (last && f.index < last.index + last.from.length) continue;
    out.push(f);
  }
  return out;
}

// 修正案を採用する基準（音声で確かめたときの、元の文に対する対数尤度の差の下限）
export const CORRECTION_MARGIN = { reading: 20, variant: 6, fuzzy: 3 };

export function applyCorrection(text, c) {
  return text.slice(0, c.index) + c.to + text.slice(c.index + c.from.length);
}

// 字幕から取り除くつなぎ言葉（文頭・読点の後のものだけ）。「Aと」は「えーと」の聞き間違い
const FILLER_HEAD_RE = /(^|[、。\s])(?:えーっと|えーと|えっと|ええと|Aと|あのー|あの、|えー|ええ、|まあ、|うーん)[、,\s]*/g;
// 助詞の直後に入る「えーと」（「全体を、えーと、四つに」→ Whisper は「全体をAと4つに」と書く）
const FILLER_MID_RE = /(?<=[をはにでがも])(?:、?\s*)(?:えーっと|えーと|えっと|Aと)(?:[、,\s]*)/g;

// 文字起こし結果を字幕向けに整える（つなぎ言葉の除去と、空白・句読点の整理だけ。言葉の置き換えはしない）
export function cleanSubtitle(text) {
  let t = (text || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i++) t = t.replace(FILLER_HEAD_RE, '$1');
  t = t.replace(FILLER_MID_RE, '');
  return t.replace(/^[、。\s]+/, '').replace(/、{2,}/g, '、').replace(/\s*([、。])\s*/g, '$1').trim();
}

// プロンプトの文がそのまま出てきたもの（無音部分などで起きる）
export function isPromptEcho(text) {
  const t = (text || '').replace(/\s/g, '');
  if (!t) return false;
  if (t.includes('美容師のカット解説です')) return true;
  const terms = t.split('、').filter(Boolean);
  return terms.length >= 5 && terms.filter(w => ASR_PROMPT.includes(w)).length / terms.length > 0.8;
}

// Whisper が無音部分で出しがちな定型文
const HALLUCINATION_RE = /ご視聴ありがとうございました|チャンネル登録|字幕は|お疲れ様でした$/;

const FILLER_RE = /(えーっと|えーと|えっと|えー+|あのー+|あの|うーん|うん|まあ|ま、)/g;

export function percentile(values, p) {
  const arr = Array.from(values).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const i = Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))));
  return arr[i];
}

// 音量（50msごとの dB）から話している区間を求める
export function detectSpeech(rmsDb, opts = {}) {
  const minGap = opts.minGap ?? 0.3;      // これより短い無音はつなげる
  const minLen = opts.minLen ?? 0.25;    // これより短い音は無視
  const pad = opts.pad ?? 0.1;           // 前後に残す余白
  const floor = percentile(rmsDb, 0.1);
  const peak = percentile(rmsDb, 0.95);
  const duration = rmsDb.length * FRAME_SEC;
  if (peak - floor < 6) return { floor, peak, threshold: peak + 1, regions: [] };
  const threshold = Math.max(floor + 8, floor + (peak - floor) * 0.35);

  const raw = [];
  let start = -1;
  for (let i = 0; i <= rmsDb.length; i++) {
    const on = i < rmsDb.length && rmsDb[i] > threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      raw.push({ start: start * FRAME_SEC, end: i * FRAME_SEC });
      start = -1;
    }
  }
  const merged = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < minGap) last.end = r.end;
    else merged.push({ ...r });
  }
  const regions = merged
    .filter(r => r.end - r.start >= minLen)
    .map(r => ({ start: Math.max(0, r.start - pad), end: Math.min(duration, r.end + pad) }));
  // 余白で重なったものをまとめる
  const out = [];
  for (const r of regions) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return { floor, peak, threshold, regions: out };
}

// 文字起こしに送る音声の区切り（無音部分は送らない）
export function transcriptionWindows(regions, maxLen = 28) {
  const windows = [];
  let cur = null;
  for (const r of regions) {
    if (cur && r.end - cur.start <= maxLen) cur.end = r.end;
    else {
      if (cur) windows.push(cur);
      cur = { start: r.start, end: r.end };
    }
  }
  if (cur) windows.push(cur);
  return windows;
}

export function normalizeText(text) {
  return (text || '')
    .replace(/[\s、。，．,.！？!?・「」『』（）()…~〜]+/g, '')
    .replace(FILLER_RE, '')
    .trim();
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, total = 0;
  for (const [g, n] of A) { inter += Math.min(n, B.get(g) || 0); total += n; }
  for (const n of B.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

export function keywordHits(text) {
  const t = text || '';
  const hits = KEYWORDS.filter(k => t.includes(k));
  if (DEGREE_RE.test(t)) hits.push('角度(〇度)');
  return hits;
}

// 言い直しの検出。後の発言を残し、前の発言を除外する
export function detectRetakes(chunks) {
  const flags = chunks.map(() => null);
  const norm = chunks.map(c => normalizeText(c.text));
  for (let i = 0; i < chunks.length; i++) {
    if (RETAKE_RE.test(chunks[i].text)) {
      flags[i] = '言い直しの合図';
      // 合図だけの短い発言なら、その直前の発言が言い直し前のもの。
      // 合図の前に内容がある（「…スライスで、すみません、言い直します」）なら、この発言自体が言い直し前
      const before = normalizeText(chunks[i].text.split(RETAKE_RE)[0].replace(/すみません|すいません|ごめんなさい/g, ''));
      if (before.length < 6 && i > 0 && chunks[i].start - chunks[i - 1].end < 10 && !flags[i - 1]) flags[i - 1] = '言い直し前の発言';
    }
  }
  for (let i = 0; i < chunks.length; i++) {
    if (flags[i]) continue;
    const a = norm[i];
    if (a.length < 4) continue;
    for (let j = i + 1; j < Math.min(chunks.length, i + 4); j++) {
      if (chunks[j].start - chunks[i].end > 12) break;
      const b = norm[j];
      const prefix = a.slice(0, Math.min(6, a.length));
      if (similarity(a, b) >= 0.55 || (prefix.length >= 5 && b.startsWith(prefix) && a.length <= b.length + 3)) {
        flags[i] = '言い直し（あとの発言を採用）';
        break;
      }
    }
  }
  return flags;
}

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

// 区間 [start,end] のうち話している部分だけを取り出す
function speechPieces(regions, start, end) {
  const out = [];
  for (const r of regions) {
    const s = Math.max(r.start, start), e = Math.min(r.end, end);
    if (e - s > 0.05) out.push({ start: s, end: e });
  }
  return out;
}

function piecesDuration(pieces) {
  return pieces.reduce((s, p) => s + (p.end - p.start), 0);
}

// 長い発話を、音量が一番小さいところで区切る
function splitLong(region, rmsDb, maxLen = 8, minLen = 4) {
  const out = [];
  let s = region.start;
  while (region.end - s > maxLen) {
    let best = s + maxLen, bestDb = Infinity;
    for (let t = s + minLen; t < s + maxLen; t += FRAME_SEC) {
      const db = rmsDb[Math.floor(t / FRAME_SEC)] ?? 0;
      if (db < bestDb) { bestDb = db; best = t; }
    }
    out.push({ start: s, end: best });
    s = best;
  }
  out.push({ start: s, end: region.end });
  return out;
}

// motion: { times, values, cx }（約1秒ごとの手元の動き量と、動きの横位置0〜1）
// 動き量を 0〜1 にそろえる。中央値（ふだんの揺れ）を 0、上位5%を 1 とする
export function motionLevels(motion) {
  const med = percentile(motion.values, 0.5);
  const hi = percentile(motion.values, 0.95);
  const span = Math.max(hi - med, 0.5);
  return motion.values.map(v => Math.min(1, Math.max(0, (v - med) / span)));
}

function motionOver(motion, levels, start, end) {
  if (!motion || !motion.times.length) return { level: 0, cx: 0.5, cy: 0.5, box: null };
  let sum = 0, n = 0;
  const cxs = [], cys = [], boxes = [];
  for (let i = 0; i < motion.times.length; i++) {
    const t = motion.times[i];
    if (t >= start - 0.5 && t <= end + 0.5) {
      sum += levels[i]; n++;
      if (levels[i] >= 0.3) {
        cxs.push(motion.cx[i]);
        if (motion.cy) cys.push(motion.cy[i]);
        if (motion.box && motion.box[i]) boxes.push(motion.box[i]);
      }
    }
  }
  // 動いている範囲は、各時点の範囲を少し広めに合わせたもの
  const box = boxes.length
    ? [percentile(boxes.map(b => b[0]), 0.2), percentile(boxes.map(b => b[1]), 0.8), percentile(boxes.map(b => b[2]), 0.2), percentile(boxes.map(b => b[3]), 0.8)]
    : null;
  return { level: n ? sum / n : 0, cx: cxs.length ? percentile(cxs, 0.5) : 0.5, cy: cys.length ? percentile(cys, 0.5) : 0.5, box };
}

// 候補となる場面（ユニット）を作り、点数をつける
export function buildUnits({ duration, rmsDb, speech, chunks, motion }) {
  const regions = speech.regions;
  const levels = motion ? motionLevels(motion) : [];
  const units = [];

  const covered = [];
  if (chunks && chunks.length) {
    const flags = detectRetakes(chunks);
    chunks.forEach((c, i) => {
      const pieces = speechPieces(regions, c.start, c.end);
      const speechDur = piecesDuration(pieces);
      const len = Math.max(0.01, c.end - c.start);
      const text = (c.text || '').trim();
      // 無音部分の誤認識（文ごとに割り当て直したものは、話している部分に合わせてあるので割合では判定しない）
      if ((!c.aligned && speechDur / len < 0.3) || (HALLUCINATION_RE.test(text) && speechDur / len < 0.6) || isPromptEcho(text)) return;
      covered.push({ start: c.start, end: c.end });
      if (!pieces.length) return;
      const u = { kind: 'speech', start: pieces[0].start, end: pieces[pieces.length - 1].end, pieces, text, subStart: c.subStart, subEnd: c.subEnd, fine: c.fine };
      if (flags[i]) u.excluded = flags[i];
      else if (!normalizeText(text)) u.excluded = 'つなぎ言葉のみ';
      units.push(u);
    });
  }
  // 文字起こしがない（または取りこぼした）発話
  for (const r of regions) {
    const restPieces = [];
    let cursor = r.start;
    const cov = covered.filter(c => overlap(c.start, c.end, r.start, r.end) > 0).sort((a, b) => a.start - b.start);
    for (const c of cov) {
      if (c.start - cursor > 0.4) restPieces.push({ start: cursor, end: Math.min(c.start, r.end) });
      cursor = Math.max(cursor, c.end);
    }
    if (r.end - cursor > 0.4) restPieces.push({ start: cursor, end: r.end });
    for (const p of restPieces) {
      for (const s of splitLong(p, rmsDb)) {
        units.push({ kind: 'speech', start: s.start, end: s.end, pieces: [s], text: '' });
      }
    }
  }

  // 話していないが手元がよく動いている場面（技術を見せる場面）
  if (motion && motion.times.length) {
    let span = null;
    const spans = [];
    for (let i = 0; i < motion.times.length; i++) {
      const t = motion.times[i];
      const talking = regions.some(r => t > r.start - 0.5 && t < r.end + 0.5);
      if (levels[i] >= 0.35 && !talking) {
        if (span && t - span.end <= 1.6) { span.end = t; span.idx.push(i); }
        else { if (span) spans.push(span); span = { start: t, end: t, idx: [i] }; }
      } else if (span && t - span.end > 1.6) { spans.push(span); span = null; }
    }
    if (span) spans.push(span);
    // 長い作業場面は3秒ずつに分け、それぞれを候補にする
    for (const sp of spans) {
      const s0 = Math.max(0, sp.start - 0.5);
      const s1 = Math.min(duration, sp.end + 0.5);
      for (let s = s0; s1 - s >= 1.5; s += 3) {
        const piece = { start: s, end: Math.min(s + 3, s1) };
        for (const r of regions) {
          if (overlap(r.start, r.end, piece.start, piece.end) > 0) {
            if (r.start <= piece.start) piece.start = r.end; else piece.end = r.start;
          }
        }
        if (piece.end - piece.start >= 1.5) {
          units.push({ kind: 'action', start: piece.start, end: piece.end, pieces: [piece], text: '' });
        }
      }
    }
  }

  units.sort((a, b) => a.start - b.start);

  // 点数づけ
  const firstSpeech = units.filter(u => u.kind === 'speech' && !u.excluded).slice(0, 2);
  const introLimit = Math.max(40, duration * 0.12);
  units.forEach((u, i) => {
    u.id = 'u' + i;
    u.duration = piecesDuration(u.pieces);
    const m = motionOver(motion, levels, u.start, u.end);
    u.cx = m.cx;
    u.cy = m.cy;
    u.box = m.box;
    u.motion = m.level;
    u.keywords = keywordHits(u.text);
    const reasons = [];
    let score = 1;
    if (motion) { score += 1.5 * m.level; if (m.level >= 0.35) reasons.push('手元の動きが多い'); }
    if (u.keywords.length) { score += 1.2 * Math.min(3, u.keywords.length); reasons.push('用語: ' + u.keywords.slice(0, 3).join('・')); }
    if (firstSpeech.includes(u) && u.start < introLimit) { score += 1.5; u.intro = true; reasons.push('冒頭の導入'); }
    if (u.end > duration * 0.92) { score += 2; u.ending = true; reasons.push('仕上がり（最後）'); }
    if (u.kind === 'speech' && !u.text) score += 0.3;
    if (u.kind === 'action') reasons.push('カット作業の場面');
    if (u.duration < 0.8) score -= 2;
    u.score = score;
    u.reasons = reasons;
  });
  return units;
}

// 目標の長さになるように場面を選ぶ。
// opts.buckets: 動画全体を何区間に分けて、それぞれから選ぶか（入力した流れの段階数）
// 必ず残す場面（u.mustKeep）は、上限を超えても残す（重要な説明を時間のために削らない）
export function selectUnits(units, duration, target = 58, max = 60, opts = {}) {
  const cands = units.filter(u => !u.excluded && u.duration >= 0.5);
  const chosen = new Set();
  let total = 0;
  const add = u => { if (!chosen.has(u) && total + u.duration <= max) { chosen.add(u); total += u.duration; } };

  for (const u of cands) if (u.mustKeep && !chosen.has(u)) { chosen.add(u); total += u.duration; }
  // 冒頭と最後
  const intro = cands.filter(u => u.intro).sort((a, b) => b.score - a.score)[0];
  const ending = cands.filter(u => u.ending).sort((a, b) => b.score - a.score)[0];
  if (intro) add(intro);
  if (ending) add(ending);
  // 動画全体からまんべんなく
  const K = opts.buckets || 5;
  for (let k = 0; k < K; k++) {
    const s = (duration * k) / K, e = (duration * (k + 1)) / K;
    const best = cands.filter(u => u.start >= s && u.start < e).sort((a, b) => b.score - a.score)[0];
    if (best && total + best.duration <= target) add(best);
  }
  // 残りは点数の高い順
  for (const u of [...cands].sort((a, b) => b.score - a.score)) {
    if (total >= target) break;
    if (total + u.duration <= target) add(u);
  }
  // 目標よりかなり短いときは、上限までの範囲で場面を足す（短い目標ほど1場面の長さの影響が大きいため）
  if (total < max - Math.max(3, max * 0.1)) {
    for (const u of [...cands].sort((a, b) => b.score - a.score)) add(u);
  }
  return [...chosen].sort((a, b) => a.start - b.start);
}

// 字幕を「1行最大 maxChars 文字 × 2行」のページに分け、表示時間を文字数で配分する。
// 日本語として自然な位置（読点の後 > 助詞の後 > 文字の種類が変わる所）で区切り、
// 1〜2文字だけが次の行・ページに残るような分け方はしない
const NO_LINE_START = '、。，．,.！？!?）」』ゃゅょっャュョッァィゥェォーぁぃぅぇぉ';
const PARTICLES = 'はをにでがともへやの';

function charType(c) {
  if (/[\u4e00-\u9fff々]/.test(c)) return 'kanji';
  if (/[\u30a0-\u30ff]/.test(c)) return 'kata';
  if (/[\u3040-\u309f]/.test(c)) return 'hira';
  if (/[0-9０-９]/.test(c)) return 'num';
  return 'other';
}

// text の i 文字目の前で区切るときの「自然さ」
function breakScore(text, i) {
  const prev = text[i - 1], next = text[i];
  if (!prev || !next || NO_LINE_START.includes(next)) return -Infinity;
  if ('、。！？!? '.includes(prev)) return 4;
  // 助詞の後（「…を」「…に」）。ただし「の」は名詞のつながりが多いので低め
  if (PARTICLES.includes(prev) && charType(next) !== 'hira') return prev === 'の' ? 1.5 : 3;
  // 漢字の後の助詞＋ひらがな（「形に／なりました」）。「が」は送り仮名（前下が|り）と紛らわしいので除く
  if ('はをにでへ'.includes(prev) && charType(text[i - 2]) === 'kanji') return 2.5;
  const a = charType(prev), b = charType(next);
  if (a === 'hira' && (b === 'kanji' || b === 'kata')) return 1;
  if ((a === 'num' || b === 'num') && a !== b) return -1; // 「0度」「45度」を分けない
  if (a === b && a !== 'hira') return -3; // カタカナ語・漢字語・数字の途中では切らない
  return 0;
}

// [lo, hi] の範囲で、中央 target に近く、自然な区切り位置を選ぶ
function bestBreak(text, lo, hi, target) {
  let best = -1, bestScore = -Infinity;
  for (let i = Math.max(1, lo); i <= Math.min(text.length - 1, hi); i++) {
    const sc = breakScore(text, i) * 2 - Math.abs(i - target) * 0.35;
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  return best > 0 ? best : Math.min(text.length - 1, Math.max(1, Math.round(target)));
}

export function wrapLines(text, maxChars) {
  const t = (text || '').trim();
  if (t.length <= maxChars) return t ? [t] : [];
  const lines = [];
  let rest = t;
  while (rest.length > maxChars) {
    // 残りが2行分以内なら半分ずつ、それより長ければ1行分を目安に区切る
    const target = rest.length <= maxChars * 2 ? rest.length / 2 : maxChars;
    const lo = Math.max(3, rest.length - maxChars * (rest.length <= maxChars * 2 ? 1 : 99));
    const cut = bestBreak(rest, Math.min(lo, maxChars), maxChars, target);
    lines.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) lines.push(rest);
  return lines.filter(Boolean);
}

// 2行に分けるとき、自然な区切りが見つかるか
function canWrap(t, maxChars) {
  if (t.length <= maxChars) return true;
  for (let i = t.length - maxChars; i <= maxChars; i++) if (breakScore(t, i) >= 1) return true;
  return false;
}

// 文を2行ずつのページに分ける。ページの切れ目も自然な位置にし、
// 2行にきれいに分けられない長さなら、もう1ページに分ける
function pageTexts(text, maxChars, maxLines) {
  const cap = maxChars * maxLines;
  const out = [];
  let rest = text;
  for (let guard = 0; guard < 20 && (rest.length > cap || !canWrap(rest, maxChars)); guard++) {
    const n = Math.max(2, Math.ceil(rest.length / cap));
    const target = rest.length / n; // ページの長さをそろえる
    const cut = bestBreak(rest, Math.max(3, rest.length - cap * (n - 1)), Math.min(cap, rest.length - 3), target);
    if (cut <= 0 || cut >= rest.length) break;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function subtitlePages(text, duration, maxChars = 14, maxLines = 2) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean || duration <= 0) return [];
  const pages = [];
  for (const sentence of splitSentences(clean)) {
    for (const pt of pageTexts(sentence.replace(/[、。]+$/, ''), maxChars, maxLines)) {
      // 行末の「、」「。」は字幕では付けない（すっきり見せる）
      const lines = wrapLines(pt, maxChars).map(l => l.replace(/[、。]+$/, '')).filter(Boolean);
      if (lines.length) pages.push(lines.slice(0, maxLines).length === lines.length ? lines : [lines.slice(0, maxLines - 1).join(''), lines.slice(maxLines - 1).join('')]);
    }
  }
  const lens = pages.map(p => p.join('').length);
  const total = lens.reduce((a, b) => a + b, 0);
  let t = 0;
  return pages.map((lines, i) => {
    const d = (duration * lens[i]) / total;
    const page = { start: t, end: t + d, lines };
    t += d;
    return page;
  });
}

// 9:16 に切り抜く範囲（表示座標）。cx は動きの横位置（0〜1）、box は動いている範囲（0〜1 の [x0,x1,y0,y1]）
export function cropRect(srcW, srcH, cx = 0.5, box = null) {
  const even = n => Math.max(2, Math.floor(n / 2) * 2);
  if (srcW / srcH > OUT_W / OUT_H) {
    const h = even(srcH);
    const w = even((h * OUT_W) / OUT_H);
    const center = (0.5 + (cx - 0.5) * 0.7) * srcW; // 端に寄りすぎないよう控えめに追従
    let left = center - w / 2;
    // 手元（動いている範囲）が枠に収まるなら、切れないように枠をずらす
    if (box) {
      const margin = w * 0.04, b0 = box[0] * srcW, b1 = box[1] * srcW;
      if (b1 - b0 + 2 * margin <= w) {
        if (b0 - margin < left) left = b0 - margin;
        if (b1 + margin > left + w) left = b1 + margin - w;
      }
    }
    left = Math.round(Math.min(srcW - w, Math.max(0, left)));
    return { left, top: 0, width: w, height: h };
  }
  const w = even(srcW);
  const h = even((w * OUT_H) / OUT_W);
  return { left: 0, top: Math.round((srcH - h) / 2), width: w, height: Math.min(h, even(srcH)) };
}

// 字幕の位置（文字の中心の高さ。画面の高さに対する割合）。
// YouTube ショートの画面下部（タイトル・ボタン）と上部を避けた高さにしている
export const SUB_ZONES = { top: 0.2, bottom: 0.745 };
const ZONE_BANDS = { top: [0.12, 0.29], bottom: [0.65, 0.84] };
export const ZOOM_MIN = 1.03;
export const ZOOM_MAX = 1.08;
const ZOOM_SPACING = 10; // ズームとズームの間は最低この秒数あける
// 編集スタイルごとのズーム。テンポ重視は間隔を短く、少しだけ強く（それでも 1.10 倍まで）
export const ZOOM_STYLES = {
  simple: { spacing: ZOOM_SPACING, max: ZOOM_MAX },
  tempo: { spacing: 6, max: 1.10 },
};
const FADE = 0.2;       // 字幕のフェード（秒）
const FADE_SHORT = 0.1; // 字幕が切れ目なく続くときのフェード

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// 表示座標の割合で表した範囲 box を、切り抜き枠 crop の中の割合に直す
function boxInCrop(box, crop, srcW, srcH) {
  if (!box) return null;
  return [
    (box[0] * srcW - crop.left) / crop.width, (box[1] * srcW - crop.left) / crop.width,
    (box[2] * srcH - crop.top) / crop.height, (box[3] * srcH - crop.top) / crop.height,
  ];
}

function bandHit(b, band) {
  if (!b) return false;
  return Math.max(0, Math.min(b[3], band[1]) - Math.max(b[2], band[0])) / (band[1] - band[0]) > 0.3;
}

// 書き出し用のタイムライン。ピースごとのフレーム数を確定し、字幕の時刻を出力側に変換する。
// opts: { srcW, srcH, zoom: 自然なズームを使うか, subtitles: 字幕を入れるか }
export function buildTimeline(clips, opts = {}) {
  const { srcW = 1080, srcH = 1920, zoom = false, subtitles = true } = opts;
  const zs = ZOOM_STYLES[opts.style] || ZOOM_STYLES.simple;
  let t = 0;
  const tl = clips.map(c => {
    const pieces = c.pieces.map(p => {
      const frames = Math.max(1, Math.round((p.end - p.start) * FPS));
      const piece = { srcStart: p.start, frames, outStart: t };
      t += frames / FPS;
      return piece;
    });
    const outStart = pieces[0].outStart;
    const outDuration = pieces.reduce((s, p) => s + p.frames / FPS, 0);
    const text = subtitles ? c.text : '';
    const clip = { ...c, pieces, outStart, outDuration };
    // 話している時刻がわかっている字幕は、元の動画の時刻から、カット後の時刻に変換して出す
    const subs = text && c.subStart != null && c.subEnd > c.subStart
      ? timedPages(clip, text)
      : subtitlePages(text, outDuration).map(p => ({ ...p, start: p.start + outStart, end: p.end + outStart }));
    const crop = cropRect(srcW, srcH, c.cx ?? 0.5, c.box);
    return { ...clip, subtitles: subs, crop, inCrop: boxInCrop(c.box, crop, srcW, srcH) };
  });

  // 字幕の位置: 基本は下。手元が下の方で動く場面が多い動画では上にする。
  // 場面ごとには、その場面で手元が字幕の位置にかかるときだけ反対側にする
  const moving = tl.filter(c => c.subtitles.length && c.inCrop && (c.motion ?? 0) >= 0.2);
  const lowHands = moving.filter(c => bandHit(c.inCrop, ZONE_BANDS.bottom) && !bandHit(c.inCrop, ZONE_BANDS.top)).length;
  const base = moving.length && lowHands > moving.length / 2 ? 'top' : 'bottom';
  const other = base === 'top' ? 'bottom' : 'top';
  for (const c of tl) {
    const hit = (c.motion ?? 0) >= 0.2 && bandHit(c.inCrop, ZONE_BANDS[base]) && !bandHit(c.inCrop, ZONE_BANDS[other]);
    c.subPos = hit ? other : base;
  }

  // 字幕のフェード: 前後に字幕が切れ目なく続くときは短く
  const pages = tl.flatMap(c => c.subtitles.map(p => Object.assign(p, { pos: c.subPos })));
  pages.forEach((p, i) => {
    const prev = pages[i - 1], next = pages[i + 1];
    p.fadeIn = prev && Math.abs(prev.end - p.start) < 0.05 && prev.pos === p.pos ? FADE_SHORT : FADE;
    p.fadeOut = next && Math.abs(next.start - p.end) < 0.05 && next.pos === p.pos ? FADE_SHORT : FADE;
  });

  // 自然なズーム: 手元がまとまって動いている2秒以上の場面だけ、ゆっくり 1.03〜1.08 倍まで寄る。
  // 続けてズームしない・間隔をあける・手元が枠からはみ出す場合はズームしない
  let lastEnd = -Infinity, prevZoomed = false;
  for (const c of tl) {
    c.zoom = null;
    const b = c.inCrop;
    const ok = zoom && b && c.outDuration >= 2 && (c.motion ?? 0) >= 0.35 && !prevZoomed && c.outStart - lastEnd >= zs.spacing;
    prevZoomed = false;
    if (!ok) continue;
    const bw = b[1] - b[0], bh = b[3] - b[2];
    let z = Math.min(zs.max,1 / (Math.max(bw, bh) * 1.25), 1 + 0.025 * c.outDuration);
    z = Math.floor(z * 200) / 200;
    if (z < ZOOM_MIN) continue;
    const { crop } = c;
    const zw = crop.width / z, zh = crop.height / z;
    const cx = crop.left + ((b[0] + b[1]) / 2) * crop.width;
    const cy = crop.top + ((b[2] + b[3]) / 2) * crop.height;
    const rect = {
      left: clamp(cx - zw / 2, crop.left, crop.left + crop.width - zw),
      top: clamp(cy - zh / 2, crop.top, crop.top + crop.height - zh),
      width: zw, height: zh,
    };
    // 手元（＋少しの余白）が寄った後の枠に収まるか確かめる
    const bx0 = crop.left + b[0] * crop.width, bx1 = crop.left + b[1] * crop.width;
    const by0 = crop.top + b[2] * crop.height, by1 = crop.top + b[3] * crop.height;
    const mx = zw * 0.04, my = zh * 0.04;
    if (bx0 - mx < rect.left || bx1 + mx > rect.left + zw || by0 - my < rect.top || by1 + my > rect.top + zh) continue;
    c.zoom = { z, rect };
    lastEnd = c.outStart + c.outDuration;
    prevZoomed = true;
  }
  return tl;
}

// 出力の時刻 t での切り抜き枠（ズームはゆっくり始まりゆっくり止まる）
export function cropAt(clip, t) {
  if (!clip.zoom) return clip.crop;
  const x = clamp((t - clip.outStart) / clip.outDuration, 0, 1);
  const e = x * x * (3 - 2 * x);
  const a = clip.crop, b = clip.zoom.rect;
  return {
    left: a.left + (b.left - a.left) * e, top: a.top + (b.top - a.top) * e,
    width: a.width + (b.width - a.width) * e, height: a.height + (b.height - a.height) * e,
  };
}

// 字幕の不透明度（フェードイン・フェードアウト）
export function subtitleAlpha(page, t) {
  return clamp(Math.min((t - page.start) / page.fadeIn, (page.end - t) / page.fadeOut, 1), 0, 1);
}

export function formatTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

// 文字起こしの1つの塊に複数の文が入っている場合（プロンプトを与えると Whisper は文ごとの時刻を出さなくなる）、
// 「。」で文に分け、音声の無音の切れ目に合わせて各文の時刻を割り当てる
export function splitSentences(text) {
  return (text || '').split(/(?<=[。！？!?])/).map(t => t.trim()).filter(Boolean);
}

export function alignSentences(chunks, regions) {
  const out = [];
  for (const c of chunks) {
    const sents = splitSentences(c.text);
    if (sents.length <= 1) { out.push(c); continue; }
    const pieces = speechPieces(regions, c.start - 0.3, c.end + 0.3);
    const start = pieces.length ? pieces[0].start : c.start;
    const end = pieces.length ? pieces[pieces.length - 1].end : c.end;
    const spans = pieces.length ? pieces : [{ start, end }];
    const total = piecesDuration(spans);
    // 話している時間の割合 f の地点の時刻
    const timeAt = f => {
      let rest = f * total;
      for (const p of spans) {
        const d = p.end - p.start;
        if (rest <= d) return p.start + rest;
        rest -= d;
      }
      return end;
    };
    const gaps = [], gapLens = [];
    for (let i = 1; i < spans.length; i++) {
      gaps.push((spans[i - 1].end + spans[i].start) / 2);
      gapLens.push(spans[i].start - spans[i - 1].end);
    }
    const lens = sents.map(moraCount); // 文字数ではなく読みの長さで割り振る
    const all = lens.reduce((a, b) => a + b, 0);
    const targets = [];
    let acc = 0;
    for (let i = 0; i < sents.length - 1; i++) { acc += lens[i]; targets.push(timeAt(acc / all)); }
    const bounds = [start, ...matchGaps(targets, gaps, gapLens)];
    bounds.push(end);
    sents.forEach((text, i) => {
      // 区切りは無音の真ん中なので、各文の時間を実際に話している部分に詰める
      const own = speechPieces(regions, bounds[i], bounds[i + 1]);
      const s0 = own.length ? own[0].start : bounds[i];
      const e0 = own.length ? own[own.length - 1].end : bounds[i + 1];
      out.push({ start: s0, end: e0, text, raw: c.raw, aligned: true });
    });
  }
  return out;
}

// 文の区切りの目安時刻 targets を、無音の切れ目 gaps に順番を保って割り当てる。
// 全体のずれが最小になる組み合わせを選ぶ（切れ目が足りない区切りは目安時刻のまま）。
// 文と文の間の「間」は読点の間より長いので、長い無音ほど選ばれやすくする
function matchGaps(targets, gaps, gapLens) {
  const K = targets.length, G = gaps.length, MISS = 2;
  const cost = (g, k) => Math.abs(gaps[g] - targets[k]) / (1 + gapLens[g]);
  // best[k][j]: k 個目までの区切りを決め、最後に使った切れ目が j-1 番（j=0 は未使用）のときの最小コスト
  const best = Array.from({ length: K + 1 }, () => new Array(G + 1).fill(Infinity));
  const prev = Array.from({ length: K + 1 }, () => new Array(G + 1).fill(null));
  best[0][0] = 0;
  for (let k = 0; k < K; k++) {
    for (let j = 0; j <= G; j++) {
      if (best[k][j] === Infinity) continue;
      // 切れ目を使わない
      if (best[k][j] + MISS < best[k + 1][j]) { best[k + 1][j] = best[k][j] + MISS; prev[k + 1][j] = [j, null]; }
      // j 番以降の切れ目を使う
      for (let g = j; g < G; g++) {
        const c = best[k][j] + cost(g, k);
        if (c < best[k + 1][g + 1]) { best[k + 1][g + 1] = c; prev[k + 1][g + 1] = [j, g]; }
      }
    }
  }
  let j = 0;
  for (let x = 1; x <= G; x++) if (best[K][x] < best[K][j]) j = x;
  const out = new Array(K);
  for (let k = K; k > 0; k--) {
    const [pj, g] = prev[k][j];
    out[k - 1] = g === null ? targets[k - 1] : gaps[g];
    j = pj;
  }
  for (let k = 1; k < K; k++) out[k] = Math.max(out[k], out[k - 1] + 0.2);
  return out;
}

// ---------- 字幕の時刻合わせ ----------

// 細かい発話区間（短い息継ぎでも区切る）。字幕の開始・終了とページの切り替えに使う
export function fineSpeech(rmsDb, threshold) {
  return detectSpeechWith(rmsDb, threshold, { minGap: 0.09, minLen: 0.08, pad: 0 });
}

function detectSpeechWith(rmsDb, threshold, { minGap, minLen, pad }) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= rmsDb.length; i++) {
    const on = i < rmsDb.length && rmsDb[i] > threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      const r = { start: start * FRAME_SEC - pad, end: i * FRAME_SEC + pad };
      const last = out[out.length - 1];
      if (last && r.start - last.end < minGap) last.end = r.end;
      else out.push(r);
      start = -1;
    }
  }
  return out.filter(r => r.end - r.start >= minLen);
}

// 読みの長さの目安（拍の数）。漢字は読みがわからないので 1.7 拍、数字は 1 桁 1.5 拍とみなす
export function moraCount(text) {
  let n = 0;
  for (const c of (text || '').replace(/[、。，．,.！？!?\s「」]/g, '')) {
    if ('ゃゅょぁぃぅぇぉャュョァィゥェォ'.includes(c)) n += 0.3;
    else if (/[\u4e00-\u9fff々]/.test(c)) n += 1.7;
    else if (/[0-9０-９]/.test(c)) n += 1.5;
    else if (/[A-Za-z]/.test(c)) n += 1.2;
    else n += 1;
  }
  return n;
}

// Whisper の文の時刻を、実際の声の出始め・終わりに合わせる（subStart, subEnd を付ける）。
// 自動カットに使う start / end は変えない。
// 先にすべての文の出始めを決めてから、終わりを「次の文の出始めより前の、最後の声の終わり」にする
export function refineSubtitleTiming(chunks, fine) {
  const out = chunks.map(c => ({ ...c }));
  // 1. 出始め: Whisper の開始時刻の近くにある声の出始め（前の文の出始めより後）
  let prevStart = -Infinity;
  for (const c of out) {
    let best = null;
    for (const r of fine) {
      if (r.start < c.start - 0.7 || r.start > c.start + 0.9 || r.start >= c.end || r.start <= prevStart + 0.2) continue;
      if (best === null || Math.abs(r.start - c.start) < Math.abs(best - c.start)) best = r.start;
    }
    c.subStart = best ?? Math.max(c.start, prevStart + 0.2);
    prevStart = c.subStart;
  }
  // 2. 終わり: 次の文の出始めより前で、Whisper の終了時刻を少し過ぎるまでの、最後の声の終わり
  out.forEach((c, i) => {
    const nextStart = i + 1 < out.length ? out[i + 1].subStart : Infinity;
    const limit = Math.min(c.end + 0.5, nextStart - 0.02);
    let end = null;
    for (const r of fine) {
      if (r.end <= c.subStart + 0.1 || r.start >= limit) continue;
      end = Math.min(r.end, limit);
    }
    c.subEnd = Math.max(c.subStart + 0.2, end ?? Math.min(c.end, limit));
    c.fine = fine.filter(r => r.end > c.subStart && r.start < c.subEnd)
      .map(r => ({ start: Math.max(r.start, c.subStart), end: Math.min(r.end, c.subEnd) }));
  });
  return out;
}

// 文の中のページの切り替え時刻（元の動画上）。読みの長さで話している時間を割り振り、近くの息継ぎに合わせる
export function pageSourceTimes(pageTexts, start, end, fine) {
  const spans = (fine && fine.length ? fine : [{ start, end }]).filter(r => r.end > r.start);
  const total = spans.reduce((a, r) => a + r.end - r.start, 0) || (end - start);
  const timeAt = f => {
    let rest = f * total;
    for (const r of spans) {
      if (rest <= r.end - r.start) return r.start + rest;
      rest -= r.end - r.start;
    }
    return end;
  };
  const gaps = [];
  for (let i = 1; i < spans.length; i++) gaps.push({ t: (spans[i - 1].end + spans[i].start) / 2, a: spans[i - 1].end, b: spans[i].start });
  const w = pageTexts.map(moraCount);
  const all = w.reduce((a, b) => a + b, 0) || 1;
  const times = [{ start, end }];
  let acc = 0;
  for (let i = 0; i < pageTexts.length - 1; i++) {
    acc += w[i];
    const target = timeAt(acc / all);
    // 近くの息継ぎに合わせる。長い間ほど区切りらしいので選ばれやすくする
    const cost = x => Math.abs(x.t - target) / (1 + 2 * (x.b - x.a));
    const g = gaps.filter(x => Math.abs(x.t - target) <= 1.2 && x.t > times[times.length - 1].start + 0.3 && cost(x) <= 0.5)
      .sort((x, y) => cost(x) - cost(y))[0];
    const prev = times[times.length - 1];
    if (g) { prev.end = g.a; times.push({ start: g.b, end }); }
    else { prev.end = target; times.push({ start: target, end }); }
  }
  return times;
}

// 元の動画の時刻 t を、書き出す動画（カット後）の時刻に変換する。カットで削った部分なら次の場面の頭にする
export function srcToOut(clip, t) {
  for (const p of clip.pieces) {
    const d = p.frames / FPS;
    if (t < p.srcStart) return p.outStart;
    if (t <= p.srcStart + d) return p.outStart + (t - p.srcStart);
  }
  return clip.outStart + clip.outDuration;
}

const SUB_LEAD = 0.1;   // 声より少しだけ先に出し始める（フェードの分）
const SUB_LINGER = 0.25; // 話し終わってから少しだけ残す

function timedPages(clip, text) {
  const pages = subtitlePages(text, 1);
  if (!pages.length) return [];
  // 手直しで表示時刻が変わっていても、その範囲の中の発話だけを使う
  const fine = (clip.fine || []).map(r => ({ start: Math.max(r.start, clip.subStart), end: Math.min(r.end, clip.subEnd) })).filter(r => r.end > r.start);
  const src = pageSourceTimes(pages.map(p => p.lines.join('')), clip.subStart, clip.subEnd, fine);
  const clipEnd = clip.outStart + clip.outDuration;
  const out = pages.map((p, i) => ({
    lines: p.lines,
    start: Math.max(clip.outStart, srcToOut(clip, src[i].start) - SUB_LEAD),
    end: Math.min(clipEnd, srcToOut(clip, src[i].end) + SUB_LINGER),
  }));
  for (let i = 0; i < out.length; i++) {
    const limit = i + 1 < out.length ? out[i + 1].start : clipEnd;
    out[i].end = Math.min(out[i].end, limit);
    // 短すぎて読めないページは、次のページの直前まで延ばす（文字は省かない）
    if (out[i].end - out[i].start < 0.5) out[i].end = Math.min(limit, out[i].start + 0.5);
  }
  return out;
}
