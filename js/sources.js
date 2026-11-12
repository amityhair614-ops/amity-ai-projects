// 複数の動画（最大3本）を1本の完成動画にするための、時刻の計算。ブラウザAPIを使わないので Node でテストできる。
//
// 考え方: 選んだ動画を、間に無音（GAP 秒）をはさんで1本の長い動画に並べたものとして解析する（「つないだ時刻」）。
// 音量・声の区間・文字起こし・手元の動きは、動画ごとに解析してから時刻をずらしてつなぐ。カット・字幕・冒頭のテキスト・
// 最後のフェードは、今までと同じ計算（plan.js）をそのまま使える。
// 動画と動画の間の無音は、ほかの長い間と同じように「話していない所」として切られるので、完成動画には入らない。
// 書き出すときだけ、つないだ時刻を「何本目の動画の何秒」に戻して読む。
// 動画の本数の上限。解析は1本ずつ（音声も1本ぶんずつ読む）・書き出しも区間ごとなので、本数ではなく合計の長さで時間とメモリが決まる。
// 合計の長さの目安は MAX_TOTAL_SEC（それより長いと、iPhone で書き出しに長い時間がかかる・端末内の空きが足りなくなることがある）
export const MAX_SOURCES = 20;
export const MAX_TOTAL_SEC = 15 * 60;
export const GAP = 1.0; // 動画と動画の間にはさむ無音（秒）。場面の前後の余白（最大0.4秒）より長くする

// sources: [{ duration }] → [{ index, offset, duration, end }]（offset: つないだ時刻での始まり）
export function layout(sources) {
  let t = 0;
  return sources.map((s, index) => {
    const out = { index, offset: t, duration: s.duration, end: t + s.duration };
    t = out.end + GAP;
    return out;
  });
}

export function totalDuration(lay) {
  return lay.length ? lay[lay.length - 1].end : 0;
}

// つないだ時刻 t が、何本目の動画か（無音の間なら、近い方）
export function sourceAt(lay, t) {
  let best = lay[0], bd = Infinity;
  for (const s of lay) {
    const d = t < s.offset ? s.offset - t : t > s.end ? t - s.end : 0;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

// 動画ごとの1列の値（50msごとの音量など）を、間に fill をはさんでつなぐ
export function concatFrames(arrays, lay, frameSec, fill) {
  const n = Math.ceil(totalDuration(lay) / frameSec) + 1;
  const out = new Float32Array(n).fill(fill);
  arrays.forEach((a, k) => {
    if (!a) return;
    const at = Math.round(lay[k].offset / frameSec);
    out.set(a.subarray ? a.subarray(0, Math.max(0, Math.min(a.length, n - at))) : a.slice(0, n - at), at);
  });
  return out;
}

// 文字起こし用の音声（16kHz）をつなぐ（間は無音）
export function concatPcm(pcms, lay, rate) {
  const out = new Float32Array(Math.ceil(totalDuration(lay) * rate) + rate);
  pcms.forEach((p, k) => { if (p) out.set(p.subarray(0, Math.max(0, Math.min(p.length, out.length - Math.round(lay[k].offset * rate)))), Math.round(lay[k].offset * rate)); });
  return out;
}

// 手元の動き（analyzeMotion の結果）をつなぐ。時刻をずらすだけ
export function concatMotion(list, lay) {
  if (list.every(m => !m)) return null;
  const out = { times: [], values: [], cx: [], cy: [], box: [] };
  list.forEach((m, k) => {
    if (!m) return;
    for (let i = 0; i < m.times.length; i++) {
      out.times.push(m.times[i] + lay[k].offset);
      out.values.push(m.values[i]);
      out.cx.push(m.cx[i]);
      out.cy.push(m.cy[i]);
      out.box.push(m.box[i]);
    }
  });
  return out;
}

// 場面の使う範囲（pieces: [{ start, end }]）を、それぞれ1本の動画の中に収める（動画と動画の間の無音・
// となりの動画にはみ出した余白を除く）。どの動画かは、その範囲の真ん中で決める
export function clampPieces(pieces, lay) {
  const out = [];
  for (const p of pieces) {
    const s = sourceAt(lay, (p.start + p.end) / 2);
    const start = Math.max(p.start, s.offset), end = Math.min(p.end, s.end);
    if (end - start > 0.02) out.push({ ...p, start, end });
  }
  return out;
}

// 書き出し: つないだ時刻のピース（srcStart）を、動画の番号と、その動画の中の時刻にする
export function localPiece(lay, piece) {
  const s = sourceAt(lay, piece.srcStart + 0.02);
  return { source: s.index, piece: { ...piece, srcStart: Math.max(0, piece.srcStart - s.offset) } };
}

// 複数の動画を1本にできるか（向き・大きさがそろっているか）。できないときは理由を返す
export function checkCompatible(infos) {
  if (infos.length > MAX_SOURCES) return `動画は${MAX_SOURCES}本までです。`;
  const a = infos[0];
  for (const b of infos.slice(1)) {
    if ((a.width >= a.height) !== (b.width >= b.height)) return '縦向きの動画と横向きの動画は、1本にまとめられません。同じ向きで撮影した動画を選んでください。';
    if (Math.abs(a.width / a.height - b.width / b.height) > 0.02) return '画面の縦横の比率が違う動画は、1本にまとめられません。同じ設定で撮影した動画を選んでください。';
  }
  return null;
}

// 並べ替え・削除（一覧の操作）
export function move(list, i, d) {
  const j = i + d;
  if (j < 0 || j >= list.length) return list.slice();
  const out = list.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// ---- 1本ずつ解析した結果を、つないだ時刻に並べる（結合のときに解析をやり直さない） ----

// 動画の見分け（名前・大きさ・長さ）。解析の結果を、並べ替え・追加の後も使い回すための鍵
export function sourceKey(file, duration) {
  return `${file.name}|${file.size}|${(+duration).toFixed(2)}`;
}

// 時刻 t（秒）の項目をずらす（文・ページ・ピースなどの { start, end, ... }）
const TIME_KEYS = ['start', 'end', 'subStart', 'subEnd', 'next', 't', 't0', 't1'];
function shiftObj(o, off) {
  const out = { ...o };
  for (const k of TIME_KEYS) if (typeof out[k] === 'number') out[k] = +(out[k] + off).toFixed(3);
  return out;
}

// 1本の動画の字幕の文（tokensToChunks の結果）を、つないだ時刻にする
export function shiftChunks(chunks, off) {
  return (chunks || []).map(c => {
    const out = shiftObj(c, off);
    if (c.times) out.times = c.times.map(t => +(t + off).toFixed(3));
    if (c.tokens) out.tokens = c.tokens.map(k => shiftObj(k, off));
    if (c.fine) out.fine = c.fine.map(r => shiftObj(r, off));
    out.source = c.source ?? null;
    return out;
  });
}

// 1本ずつの音量（dB）と声の区間を、つないだ時刻に並べる。動画ごとに声の大きさ（マイクとの距離）が違うので、
// それぞれの「声とみなす境目」（threshold）が同じ値（基準）になるよう、音量をずらしてからつなぐ
// parts: [{ rmsDb, speech: detectSpeech の結果 }]（音声のない動画は null）
export function combineAudio(parts, lay, frameSec) {
  const ok = parts.filter(p => p && p.speech && Number.isFinite(p.speech.threshold) && p.speech.regions.length);
  const ref = ok.length ? ok[0].speech.threshold : 0;
  const norm = parts.map(p => {
    if (!p) return null;
    const d = p.speech && p.speech.regions.length ? ref - p.speech.threshold : 0;
    return Float32Array.from(p.rmsDb, v => v + d);
  });
  const floor = Math.min(...norm.filter(Boolean).map(a => a.reduce((m, x) => Math.min(m, x), Infinity)));
  const rmsDb = concatFrames(norm, lay, frameSec, Number.isFinite(floor) ? floor : -100);
  const pick = key => parts.flatMap((p, k) => (p?.speech?.[key] || []).map(r => shiftObj(r, lay[k].offset)));
  const sp = ok[0]?.speech;
  const speech = {
    floor: sp ? sp.floor : -100, peak: sp ? sp.peak : -100, threshold: ref, low: sp ? sp.low + (ref - sp.threshold) : ref,
    regions: pick('regions'), voice: pick('voice'), sounds: pick('sounds'),
  };
  return { rmsDb, speech };
}

// 言いかけ（音の繰り返し）の検出結果をつなぐ
export function combineRestarts(list, lay) {
  return list.flatMap((rs, k) => (rs || []).map(r => shiftObj(r, lay[k].offset)));
}
