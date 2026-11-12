// 字幕AI（ReazonSpeech・RNN-T）の計算。ONNX Runtime（ort）と読み込んだモデルを外から渡すので、
// ブラウザ（reazon-worker.js）でも Node（テスト）でも同じ計算になる
import { fbank, FB_BINS } from './fbank.js';

export const FRAME_SEC = 0.04; // エンコーダーの出力1つ分の時間
const CONTEXT = 2;

// 音声（16kHz）→ エンコーダーの出力（T×D）
export async function encode(ort, enc, audio) {
  const { frames, data } = fbank(audio);
  if (frames < 10) return null;
  const x = new ort.Tensor('float32', data, [1, frames, FB_BINS]);
  const xl = new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1]);
  const e = await enc.run({ x, x_lens: xl });
  return { eo: e.encoder_out.data, T: Number(e.encoder_out_lens.data[0]), D: e.encoder_out.dims[2] };
}

// デコーダー・ジョイナーを、まとめて計算できる形にする（verify.js の model）
export function ortModel(ort, dec, joi) {
  let D = 0;
  return {
    async decoder(pairs) {
      const y = new ort.Tensor('int64', BigInt64Array.from(pairs.flat().map(BigInt)), [pairs.length, CONTEXT]);
      const r = (await dec.run({ y })).decoder_out;
      D = r.dims[1];
      return r.data;
    },
    async joiner(e, d, n) {
      const dim = D || e.length / n;
      const r = await joi.run({ encoder_out: new ort.Tensor('float32', e, [n, dim]), decoder_out: new ort.Tensor('float32', d, [n, dim]) });
      return r.logit.data;
    },
  };
}

// いちばん確からしい文字を1つずつ選ぶ（greedy）。返り値は1文字ごとの { t: 時刻（秒）, s: 文字, p: 確からしさ 0〜1 }
export async function greedy(ort, dec, joi, { eo, T, D }, symbols) {
  const ctx = new Array(CONTEXT).fill(0); // 0 は「文字なし（blank）」
  const decoderOut = async () => (await dec.run({ y: new ort.Tensor('int64', BigInt64Array.from(ctx.map(BigInt)), [1, CONTEXT]) })).decoder_out;
  let dOut = await decoderOut();
  const tokens = [];
  for (let t = 0; t < T; t++) {
    const e = new ort.Tensor('float32', eo.subarray(t * D, (t + 1) * D), [1, D]);
    const logit = (await joi.run({ encoder_out: e, decoder_out: dOut })).logit.data;
    let best = 0, max = -Infinity;
    for (let k = 0; k < logit.length; k++) if (logit[k] > max) { max = logit[k]; best = k; }
    if (best === 0) continue;
    let sum = 0;
    for (let k = 0; k < logit.length; k++) sum += Math.exp(logit[k] - max);
    const s = symbols[best] ?? '';
    if (s && !/^<.*>$/.test(s)) tokens.push({ t: +(t * FRAME_SEC).toFixed(2), s, p: +(1 / sum).toFixed(3) });
    ctx.push(best);
    ctx.shift();
    dOut = await decoderOut();
  }
  return tokens;
}

// tokens.txt（「文字 番号」の行）→ 番号ごとの文字
export function parseSymbols(text) {
  const symbols = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(.*)\s(\d+)$/);
    if (m) symbols[Number(m[2])] = m[1].replace(/▁/g, '');
  }
  return symbols;
}
