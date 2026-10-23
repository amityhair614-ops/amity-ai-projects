// 端末内で日本語の文字起こしを行う（Whisper / Transformers.js）。
// モデルは初回だけ Hugging Face からダウンロードされ、以降はブラウザに保存される。
//
// 安定のための方針:
// - iPhone ではメモリの使い方が読みやすい WASM（CPU）を既定にする。WebGPU は明示したときだけ試す
// - 美容の専門用語を並べた「プロンプト」を先に与えて、用語の聞き取りを良くする
//   （Transformers.js v4 は prompt_ids に未対応のため、デコーダーの初期トークンとして直接渡す）
// - 結果は Transformers.js の後処理を通さず、時刻トークンを自分で読んで文ごとに区切る
//   （プロンプトを与えると、後処理では文ごとの時刻が失われ、プロンプトの文も混ざるため）
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';

let asr = null;
let initIds = null;
let special = null;

async function load(model, device) {
  const progress_callback = p => self.postMessage({ type: 'load-progress', p });
  if (device === 'webgpu' && 'gpu' in navigator) {
    try {
      asr = await pipeline('automatic-speech-recognition', model, {
        device: 'webgpu',
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
        progress_callback,
      });
      return 'webgpu';
    } catch (e) {
      asr = null;
    }
  }
  asr = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback });
  return 'wasm';
}

function buildInitIds(prompt) {
  const t = asr.tokenizer;
  const id = s => t._tokenizer.token_to_id(s);
  const head = [id('<|startoftranscript|>'), id('<|ja|>'), id('<|transcribe|>')];
  if (!prompt) return head;
  // Whisper のプロンプトは最大 224 トークン程度。長すぎる場合は後ろ（新しい側）を残す
  const p = t.encode(prompt, { add_special_tokens: false }).slice(-200);
  return [id('<|startofprev|>'), ...p, ...head];
}

// 生成されたトークン列を「<|時刻|> 文 <|時刻|>」の並びとして読み、文ごとに分ける
function toSegments(ids, duration) {
  const tb = asr.tokenizer.timestamp_begin;
  const eos = asr.model.generation_config?.eos_token_id ?? asr.tokenizer._tokenizer.token_to_id('<|endoftext|>');
  const segs = [];
  let cur = [], start = null;
  for (const id of ids) {
    if (id === eos) break;
    if (id >= tb) {
      const t = (id - tb) * 0.02;
      if (cur.length) {
        segs.push({ start: start ?? t, end: t, ids: cur });
        cur = [];
        start = null;
      } else {
        start = t;
      }
    } else if (!special.has(id)) {
      cur.push(id);
    }
  }
  if (cur.length) segs.push({ start: start ?? 0, end: duration, ids: cur });
  return segs
    .map(s => ({ start: s.start, end: Math.max(s.end, s.start + 0.1), text: asr.tokenizer.decode(s.ids, { skip_special_tokens: true }).trim() }))
    .filter(s => s.text);
}

function describeSessions() {
  try {
    return Object.entries(asr.model.sessions || {}).map(([k, s]) => {
      const heavy = (s.outputNames || []).some(n => n.includes('attentions'));
      return `${k}: 出力${(s.outputNames || []).length}個${heavy ? '（注意の重みあり・メモリ多め）' : ''}`;
    }).join(' / ');
  } catch {
    return '不明';
  }
}

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const device = await load(m.model, m.device);
      special = new Set(asr.tokenizer.all_special_ids);
      initIds = buildInitIds(m.prompt);
      self.postMessage({ type: 'loaded', device, sessions: describeSessions(), promptTokens: initIds.length - 3 });
    } else if (m.type === 'run') {
      const duration = m.audio.length / 16000;
      const { input_features } = await asr.processor(m.audio);
      const out = await asr.model.generate({ inputs: input_features, decoder_input_ids: initIds, return_timestamps: true });
      const seq = (out.sequences ?? out).tolist()[0].map(Number).slice(initIds.length);
      const tb = asr.tokenizer.timestamp_begin;
      self.postMessage({ type: 'result', id: m.id, chunks: toSegments(seq, duration), times: seq.filter(t => t >= tb).map(t => +((t - tb) * 0.02).toFixed(2)) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message ? err.message : err) });
  }
};
