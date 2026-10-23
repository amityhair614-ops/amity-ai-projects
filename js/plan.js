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

// よくある聞き間違い → 正しい用語（前後の文脈つきで、誤変換しにくいものだけ）
const CORRECTIONS = [
  [/[カハ]ネル(?=[をはのがにで])/g, 'パネル'],
  [/ゼロ[ドど度]/g, '0度'],
  [/下先(?=[をはのがにで])/g, '毛先'],
  [/まえさがり|前さがり/g, '前下がり'],
  [/マルミ|まるみ/g, '丸み'],
  [/シルエッド/g, 'シルエット'],
  [/ローカー(?=[をはのがにで])/g, '量感'],
  [/カルサ(?=[をはのがにで])/g, '軽さ'],
  [/ブロッキン(?=[をはのがにで])/g, 'ブロッキング'],
  [/セーニング|センニング/g, 'セニング'],
  [/ライドに合わせ/g, 'ガイドに合わせ'],
  [/指1本/g, '指一本'],
];
// 字幕から取り除くつなぎ言葉（文頭・読点の後のものだけ）。「Aと」は「えーと」の聞き間違い
const FILLER_HEAD_RE = /(^|[、。\s])(?:えーっと|えーと|えっと|ええと|Aと|あのー|あの、|えー|ええ、|まあ、|うーん)[、,\s]*/g;

// 文字起こし結果を字幕向けに整える
export function cleanSubtitle(text) {
  let t = (text || '').replace(/\s+/g, ' ').trim();
  for (const [re, to] of CORRECTIONS) t = t.replace(re, to);
  for (let i = 0; i < 2; i++) t = t.replace(FILLER_HEAD_RE, '$1');
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
  if (!motion || !motion.times.length) return { level: 0, cx: 0.5 };
  let sum = 0, n = 0;
  const cxs = [];
  for (let i = 0; i < motion.times.length; i++) {
    const t = motion.times[i];
    if (t >= start - 0.5 && t <= end + 0.5) {
      sum += levels[i]; n++;
      if (levels[i] >= 0.3) cxs.push(motion.cx[i]);
    }
  }
  return { level: n ? sum / n : 0, cx: cxs.length ? percentile(cxs, 0.5) : 0.5 };
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
      const u = { kind: 'speech', start: pieces[0].start, end: pieces[pieces.length - 1].end, pieces, text };
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

// 目標の長さになるように場面を選ぶ
export function selectUnits(units, duration, target = 58, max = 60) {
  const cands = units.filter(u => !u.excluded && u.duration >= 0.5);
  const chosen = new Set();
  let total = 0;
  const add = u => { if (!chosen.has(u) && total + u.duration <= max) { chosen.add(u); total += u.duration; } };

  // 冒頭と最後
  const intro = cands.filter(u => u.intro).sort((a, b) => b.score - a.score)[0];
  const ending = cands.filter(u => u.ending).sort((a, b) => b.score - a.score)[0];
  if (intro) add(intro);
  if (ending) add(ending);
  // 動画全体からまんべんなく
  const K = 5;
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
  return [...chosen].sort((a, b) => a.start - b.start);
}

// 字幕を「1行最大 maxChars 文字 × 2行」のページに分け、表示時間を文字数で配分する
const NO_LINE_START = '、。，．,.！？!?）」』ゃゅょっャュョッァィゥェォー';
export function wrapLines(text, maxChars) {
  const lines = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = maxChars;
    const window = rest.slice(0, maxChars + 1);
    const punct = Math.max(window.lastIndexOf('、'), window.lastIndexOf('。'), window.lastIndexOf(' '));
    if (punct >= maxChars * 0.5) cut = punct + 1;
    while (cut < rest.length && NO_LINE_START.includes(rest[cut]) && cut < maxChars + 1) cut++;
    if (cut > maxChars) cut = maxChars; // 1行に収まらない場合は諦めて切る
    lines.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) lines.push(rest);
  return lines.filter(Boolean);
}

export function subtitlePages(text, duration, maxChars = 13, maxLines = 2) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean || duration <= 0) return [];
  const lines = wrapLines(clean, maxChars);
  const pages = [];
  for (let i = 0; i < lines.length; i += maxLines) pages.push(lines.slice(i, i + maxLines));
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

// 9:16 に切り抜く範囲（表示座標）。cx は動きの横位置（0〜1）
export function cropRect(srcW, srcH, cx = 0.5) {
  const even = n => Math.max(2, Math.floor(n / 2) * 2);
  if (srcW / srcH > OUT_W / OUT_H) {
    const h = even(srcH);
    const w = even((h * OUT_W) / OUT_H);
    const center = (0.5 + (cx - 0.5) * 0.7) * srcW; // 端に寄りすぎないよう控えめに追従
    const left = Math.round(Math.min(srcW - w, Math.max(0, center - w / 2)));
    return { left, top: 0, width: w, height: h };
  }
  const w = even(srcW);
  const h = even((w * OUT_H) / OUT_W);
  return { left: 0, top: Math.round((srcH - h) / 2), width: w, height: Math.min(h, even(srcH)) };
}

// 書き出し用のタイムライン。ピースごとのフレーム数を確定し、字幕の時刻を出力側に変換する
export function buildTimeline(clips) {
  let t = 0;
  return clips.map(c => {
    const pieces = c.pieces.map(p => {
      const frames = Math.max(1, Math.round((p.end - p.start) * FPS));
      const piece = { srcStart: p.start, frames, outStart: t };
      t += frames / FPS;
      return piece;
    });
    const outStart = pieces[0].outStart;
    const outDuration = pieces.reduce((s, p) => s + p.frames / FPS, 0);
    const subtitles = subtitlePages(c.text, outDuration).map(p => ({ ...p, start: p.start + outStart, end: p.end + outStart }));
    return { ...c, pieces, outStart, outDuration, subtitles };
  });
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
    const lens = sents.map(s => s.length);
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
