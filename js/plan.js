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
const RETAKE_RE = /言い直|撮り直|間違えました|間違えた|ごめんなさい|失礼しました/;

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
      if (i > 0 && chunks[i].start - chunks[i - 1].end < 10 && !flags[i - 1]) flags[i - 1] = '言い直し前の発言';
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
      if (speechDur / len < 0.3 || (HALLUCINATION_RE.test(text) && speechDur / len < 0.6)) return; // 無音部分の誤認識
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
