// 複数の動画（最大3本）を1本の完成動画にするための、時刻の計算。ブラウザAPIを使わないので Node でテストできる。
//
// 考え方: 選んだ動画を、間に無音（GAP 秒）をはさんで1本の長い動画に並べたものとして解析する（「つないだ時刻」）。
// 音量・声の区間・文字起こし・手元の動きは、動画ごとに解析してから時刻をずらしてつなぐ。カット・字幕・冒頭のテキスト・
// 最後のフェードは、今までと同じ計算（plan.js）をそのまま使える。
// 動画と動画の間の無音は、ほかの長い間と同じように「話していない所」として切られるので、完成動画には入らない。
// 書き出すときだけ、つないだ時刻を「何本目の動画の何秒」に戻して読む。
export const MAX_SOURCES = 3;
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
