// 端末内で日本語の文字起こしを行う（ReazonSpeech k2 v2・日本語専用のモデル。Apache-2.0）。
// モデルは初回だけ Hugging Face からダウンロードし、ブラウザの保存領域（Cache Storage）に残す。音声は外部に送らない。
//
// Whisper との違い:
// - 日本語の会話（テレビ放送の音声）だけで学習したモデルで、日常の言葉・カタカナ語の書き間違いが少ない
// - 1文字ごとに「その文字を話した時刻」がわかる（字幕を声に合わせる・文の途中を正確に取り除くのに使う）
// - 音声にない文を作り出すこと（Whisper の「ご視聴ありがとうございました」のような作文）が起きにくい
// - 句読点は出さない。文の区切りは、アプリ側で声の切れ目から決める
//
// モデルの構成（RNN-T）: エンコーダー（音声の特徴→512次元×25回/秒）・デコーダー（直前の2文字）・ジョイナー（次の文字の確率）
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs';
import { encode, greedy, ortModel, parseSymbols } from './rnnt.js';
import { verifySegment } from './verify.js';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
ort.env.wasm.numThreads = 1; // 複数スレッドには特別なサーバー設定が必要なため1つで動かす

// 同じファイルを置いている場所（先に見つかった方を使う）
const BASES = [
  'https://huggingface.co/csukuangfj/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01/resolve/main/',
  'https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/main/',
];
const FILES = {
  encoder: 'encoder-epoch-99-avg-1.int8.onnx',
  decoder: 'decoder-epoch-99-avg-1.int8.onnx',
  joiner: 'joiner-epoch-99-avg-1.int8.onnx',
  tokens: 'tokens.txt',
};
const SIZES = { encoder: 154670139, decoder: 2959337, joiner: 2696970, tokens: 45754 }; // 進み具合の表示用（目安）
const CACHE = 'amity-asr-reazon-v1';

let enc = null, dec = null, joi = null, symbols = null;

async function download(name, onProgress) {
  const file = FILES[name];
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* 保存できない環境では毎回ダウンロードする */ }
  if (cache) {
    for (const base of BASES) {
      const hit = await cache.match(base + file).catch(() => null);
      if (hit) { onProgress(SIZES[name]); return new Uint8Array(await hit.arrayBuffer()); }
    }
  }
  let lastErr = null;
  for (const base of BASES) {
    try {
      const res = await fetch(base + file);
      if (!res.ok) throw new Error(`${res.status} ${file}`);
      const total = Number(res.headers.get('content-length')) || SIZES[name];
      const reader = res.body.getReader();
      let buf = new Uint8Array(total), n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (n + value.length > buf.length) { const b = new Uint8Array(Math.max(buf.length * 1.5, n + value.length)); b.set(buf.subarray(0, n)); buf = b; }
        buf.set(value, n);
        n += value.length;
        onProgress(n);
      }
      const bytes = n === buf.length ? buf : buf.slice(0, n);
      if (cache) await cache.put(base + file, new Response(bytes)).catch(() => {});
      return bytes;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`文字起こしモデル（${file}）をダウンロードできませんでした: ${lastErr?.message || lastErr}`);
}

async function load() {
  const loaded = {};
  const progress = () => self.postMessage({
    type: 'load-progress',
    p: { status: 'progress', file: 'reazonspeech', loaded: Object.values(loaded).reduce((a, b) => a + b, 0), total: Object.values(SIZES).reduce((a, b) => a + b, 0) },
  });
  const get = name => download(name, n => { loaded[name] = n; progress(); });
  symbols = parseSymbols(new TextDecoder().decode(await get('tokens')));
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  dec = await ort.InferenceSession.create(await get('decoder'), opts);
  joi = await ort.InferenceSession.create(await get('joiner'), opts);
  // いちばん大きいエンコーダーは最後に。読み込んだ後は元のデータを手放す（メモリを2重に使わない）
  let bytes = await get('encoder');
  enc = await ort.InferenceSession.create(bytes, opts);
  bytes = null;
}

// audio（16kHz）を文字にする。返り値は1文字ごとの { t: 時刻（秒）, s: 文字, p: 確からしさ 0〜1 }
async function recognize(audio) {
  const E = await encode(ort, enc, audio);
  return E ? greedy(ort, dec, joi, E, symbols) : [];
}

// 文字起こしのまとまり unit を、同じ音声で確かめる（verify.js）。audio は unit.start からの音声
async function verify(audio, offset, unit, words) {
  const E = await encode(ort, enc, audio);
  if (!E) return { tokens: unit.tokens, fixes: [], suggest: [], tried: 0 };
  const r = await verifySegment(ortModel(ort, dec, joi), E.eo, E.T, E.D, offset, unit, symbols, { words });
  return { tokens: r.tokens, fixes: r.fixes, suggest: r.suggest, tried: r.tried };
}

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      await load();
      self.postMessage({ type: 'loaded', device: 'wasm', sessions: `ReazonSpeech k2 v2（int8）・文字数 ${symbols.length}` });
    } else if (m.type === 'run') {
      const tokens = await recognize(m.audio);
      const text = tokens.map(x => x.s).join('');
      const duration = m.audio.length / 16000;
      const chunks = text ? [{ start: 0, end: duration, text, raw: text, timed: true, tokens }] : [];
      self.postMessage({ type: 'result', id: m.id, chunks });
    } else if (m.type === 'verify') {
      const r = await verify(m.audio, m.offset, m.unit, m.words || []);
      self.postMessage({ type: 'verified', id: m.id, ...r });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message ? err.message : err) });
  }
};
