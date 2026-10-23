// 音声のサンプリング周波数の変換（文字起こし用に 48kHz などから 16kHz へ）。
// 少しずつ届く音声のかたまりを順に受け取り、窓関数つき sinc の低域通過フィルターで変換する。
// 単純な間引きだと、8kHz より高い音が折り返して雑音になり、Whisper の聞き取りが悪くなる。
const HALF = 16;     // フィルターの片側のタップ数
const PHASES = 512;  // 分数位置の刻み（係数表の細かさ）

function buildTable(srIn, srOut) {
  // 出力の上限周波数（ナイキスト）の 92% あたりで切る
  const cutoff = Math.min(1, srOut / srIn) * 0.92;
  const table = new Float32Array((PHASES + 1) * (2 * HALF));
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let k = 0; k < 2 * HALF; k++) {
      const x = k - HALF + 1 - frac; // 入力サンプルとの距離
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / HALF); // ハン窓
      const v = Math.abs(x) >= HALF ? 0 : cutoff * sinc * w;
      table[p * 2 * HALF + k] = v;
      sum += v;
    }
    for (let k = 0; k < 2 * HALF; k++) table[p * 2 * HALF + k] /= sum || 1; // 直流の大きさを保つ
  }
  return table;
}

export class Resampler {
  // write(outIndex, value) で出力する。outIndex は出力側のサンプル番号（時刻 × srOut）
  constructor(srIn, srOut, write) {
    this.srIn = srIn;
    this.ratio = srIn / srOut;
    this.write = write;
    this.table = buildTable(srIn, srOut);
    this.buf = new Float32Array(0);
    this.base = 0;     // buf[0] の入力サンプル番号
    this.next = 0;     // 次に出す出力サンプル番号
  }

  // start: このかたまりの先頭の入力サンプル番号、samples: モノラル音声
  push(start, samples) {
    if (!this.buf.length || Math.abs(start - (this.base + this.buf.length)) > 2) {
      // 最初、または途切れがあったときは、そこから新しく始める
      if (this.buf.length) this.flush();
      this.buf = Float32Array.from(samples);
      this.base = start;
      this.next = Math.ceil(start / this.ratio);
    } else {
      const merged = new Float32Array(this.buf.length + samples.length);
      merged.set(this.buf);
      merged.set(samples, this.buf.length);
      this.buf = merged;
    }
    this.produce(false);
  }

  produce(final) {
    const { buf, base, ratio, table } = this;
    const end = base + buf.length;
    for (;;) {
      const x = this.next * ratio;
      const i0 = Math.floor(x);
      if (!final && i0 + HALF >= end) break;
      if (i0 >= end) break;
      const p = Math.round((x - i0) * PHASES);
      const row = p * 2 * HALF;
      let y = 0;
      for (let k = 0; k < 2 * HALF; k++) {
        const idx = i0 - HALF + 1 + k - base;
        if (idx >= 0 && idx < buf.length) y += buf[idx] * table[row + k];
      }
      this.write(this.next, y);
      this.next++;
    }
    // 次の計算に必要な分だけ残す
    const keepFrom = Math.max(0, Math.floor(this.next * ratio) - HALF - 1 - base);
    if (keepFrom > 0) {
      this.buf = this.buf.slice(keepFrom);
      this.base += keepFrom;
    }
  }

  flush() {
    this.produce(true);
    this.buf = new Float32Array(0);
  }
}
