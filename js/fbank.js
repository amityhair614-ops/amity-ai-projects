// 文字起こしモデル（ReazonSpeech）に入れる音声の特徴量（80次元のメルフィルタバンク）。
// 学習に使われた Kaldi 方式（kaldi-native-fbank の既定値）と同じ計算をする。ブラウザAPIを使わないので Node でテストできる
// 25ms の窓を 10ms ずつずらす / 窓の中心を合わせ、端は折り返す（snip_edges=false）/ 直流成分を除く /
// プリエンファシス 0.97 / Povey 窓 / 512点FFTのパワー / 20Hz〜7600Hz の80個のメルフィルタ / 対数
export const FB_RATE = 16000;
export const FB_BINS = 80;
const FRAME_LEN = 400;
const FRAME_SHIFT = 160;
const NFFT = 512;
const EPS = 1.1920928955078125e-7; // float32 の最小の差（対数の下限）

const melScale = f => 1127 * Math.log(1 + f / 700);

let cached = null;
function tables() {
  if (cached) return cached;
  const win = new Float64Array(FRAME_LEN);
  for (let i = 0; i < FRAME_LEN; i++) win[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1)), 0.85);
  const lo = melScale(20), hi = melScale(FB_RATE / 2 - 400);
  const d = (hi - lo) / (FB_BINS + 1);
  // メルフィルタは使う範囲（first〜）だけを持つ
  const filters = [];
  for (let b = 0; b < FB_BINS; b++) {
    const l = lo + b * d, c = l + d, r = c + d;
    const w = [];
    let first = -1;
    for (let k = 0; k < NFFT / 2; k++) {
      const m = melScale((k * FB_RATE) / NFFT);
      if (m > l && m < r) {
        if (first < 0) first = k;
        w.push(m <= c ? (m - l) / (c - l) : (r - m) / (r - c));
      } else if (first >= 0) break;
    }
    filters.push({ first, w: Float64Array.from(w) });
  }
  // FFT 用のビット反転と回転因子
  const rev = new Uint32Array(NFFT);
  const bits = Math.log2(NFFT);
  for (let i = 0; i < NFFT; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(NFFT / 2), sin = new Float64Array(NFFT / 2);
  for (let i = 0; i < NFFT / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / NFFT); sin[i] = -Math.sin((2 * Math.PI * i) / NFFT); }
  cached = { win, filters, rev, cos, sin };
  return cached;
}

function fft(re, im, t) {
  const n = re.length;
  for (let i = 0; i < n; i++) {
    const j = t.rev[i];
    if (j > i) { let x = re[i]; re[i] = re[j]; re[j] = x; x = im[i]; im[i] = im[j]; im[j] = x; }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2, step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0; k < half; k++) {
        const wr = t.cos[k * step], wi = t.sin[k * step];
        const a = s + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

// samples: 16kHz の音声（-1〜1）。返り値は { frames, data }（data は frames×80 の Float32Array）
export function fbank(samples) {
  const t = tables();
  const N = samples.length;
  const frames = Math.floor((N + FRAME_SHIFT / 2) / FRAME_SHIFT);
  const data = new Float32Array(frames * FB_BINS);
  const buf = new Float64Array(FRAME_LEN);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  const power = new Float64Array(NFFT / 2);
  for (let f = 0; f < frames; f++) {
    const s = f * FRAME_SHIFT + FRAME_SHIFT / 2 - FRAME_LEN / 2;
    let mean = 0;
    for (let i = 0; i < FRAME_LEN; i++) {
      let k = s + i;
      if (k < 0) k = -k - 1;
      else if (k >= N) k = 2 * N - 1 - k;
      const v = N ? samples[Math.min(N - 1, Math.max(0, k))] : 0;
      buf[i] = v;
      mean += v;
    }
    mean /= FRAME_LEN;
    for (let i = 0; i < FRAME_LEN; i++) buf[i] -= mean;
    for (let i = FRAME_LEN - 1; i > 0; i--) buf[i] -= 0.97 * buf[i - 1];
    buf[0] -= 0.97 * buf[0];
    re.fill(0); im.fill(0);
    for (let i = 0; i < FRAME_LEN; i++) re[i] = buf[i] * t.win[i];
    fft(re, im, t);
    for (let k = 0; k < NFFT / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    const o = f * FB_BINS;
    for (let b = 0; b < FB_BINS; b++) {
      const { first, w } = t.filters[b];
      let e = 0;
      for (let j = 0; j < w.length; j++) e += w[j] * power[first + j];
      data[o + b] = Math.log(Math.max(EPS, e));
    }
  }
  return { frames, data };
}
