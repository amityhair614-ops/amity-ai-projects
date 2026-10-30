// 書き出す音声のつなぎ方（ブラウザAPIを使わない計算だけ。Node でテストできる）
//
// カットのつなぎ目で音を一度0にすると、部屋の雑音まで消えて「プツッ」と途切れて聞こえる。
// そこで、前のピースの音を少し長めに読み、次のピースの頭と重ねて入れ替える（クロスフェード）。
// - 元の動画で離れた所をつなぐとき: 等パワー（中央で音量が下がらない）で 40ms
// - 元の動画で続いているとき（コマ数の丸めの境目）: 直線で 10ms（同じ音なので音量は変わらない）
// - 動画の最初と最後だけは、ごく短くフェードイン・フェードアウトする

export const XFADE_SEC = 0.04;
export const XFADE_CONTIGUOUS_SEC = 0.01;
export const FADE_IN_SEC = 0.02;
export const FADE_OUT_SEC = 0.08;

// 音量をそろえ、大きすぎる音だけをやわらかく抑える
export function applyGain(data, gain) {
  for (const ch of data) {
    for (let i = 0; i < ch.length; i++) {
      let y = ch[i] * gain;
      const a = Math.abs(y);
      if (a > 0.9) y = Math.sign(y) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1));
      ch[i] = y;
    }
  }
}

// cur の頭 n サンプルに、前のピースの続き tail を重ねて入れ替える
export function crossfade(cur, tail, n, equalPower) {
  n = Math.min(n, cur[0].length, tail[0].length);
  for (let c = 0; c < cur.length; c++) {
    const d = cur[c], t = tail[Math.min(c, tail.length - 1)];
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n;
      const fin = equalPower ? Math.sin(x * Math.PI / 2) : x;
      const fout = equalPower ? Math.cos(x * Math.PI / 2) : 1 - x;
      d[i] = d[i] * fin + t[i] * fout;
    }
  }
}

export function fadeIn(data, n) {
  for (const ch of data) for (let i = 0; i < Math.min(n, ch.length); i++) ch[i] *= i / n;
}

export function fadeOut(data, n) {
  for (const ch of data) {
    const L = ch.length;
    for (let i = 0; i < Math.min(n, L); i++) ch[L - 1 - i] *= i / n;
  }
}

// ピースごとの音声を順に受け取り、つなぎ目を重ねて返す。
// add(data, sr, { len, contiguous, last }): data は len サンプル＋つなぎ用に少し長めに読んだ音声。
// 返り値は、ちょうど len サンプルの音声（映像のコマ数と同じ長さ）
export class AudioStitcher {
  constructor() {
    this.tail = null;
    this.first = true;
  }

  // 次のピースのために、どれだけ長めに読めばよいか（秒）
  static extra() {
    return XFADE_SEC;
  }

  add(data, sr, { len, contiguous = false, last = false }) {
    const out = data.map(ch => ch.slice(0, len));
    if (out[0].length < len) for (let c = 0; c < out.length; c++) { const z = new Float32Array(len); z.set(out[c]); out[c] = z; }
    if (this.first) fadeIn(out, Math.round(FADE_IN_SEC * sr));
    else if (this.tail) crossfade(out, this.tail, Math.round((contiguous ? XFADE_CONTIGUOUS_SEC : XFADE_SEC) * sr), !contiguous);
    this.first = false;
    this.tail = data.map(ch => ch.slice(len, len + Math.round(XFADE_SEC * sr)));
    if (!this.tail[0].length) this.tail = null;
    if (last) fadeOut(out, Math.round(FADE_OUT_SEC * sr));
    return out;
  }
}

// 最後のフェードアウト: 完成動画の最後の sec 秒で、音量をなめらかに 0 にする（映像が黒くなるのと同じ曲線）。
// data は出力の時刻 outStart から始まる音声。total は完成動画の長さ
// hold: 最後の hold 秒は無音（映像が真っ黒のまま終わる時間）
export function applyEndFade(data, sr, outStart, total, sec, hold = 0) {
  const h = Math.min(hold, total * 0.1);
  const d = Math.min(sec, total * 0.2);
  if (d <= 0) return;
  const from = total - h - d;
  for (const ch of data) {
    for (let i = 0; i < ch.length; i++) {
      const t = outStart + i / sr;
      if (t < from) continue;
      const x = Math.min(1, (t - from) / d);
      ch[i] *= 1 - x * x * (3 - 2 * x);
    }
  }
}
