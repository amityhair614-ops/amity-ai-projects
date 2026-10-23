// 端末内で日本語の文字起こしを行う（Whisper / Transformers.js）。
// モデルは初回だけ Hugging Face からダウンロードされ、以降はブラウザに保存される。
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';

let asr = null;

async function load(model) {
  const progress_callback = p => self.postMessage({ type: 'load-progress', p });
  if ('gpu' in navigator) {
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

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const device = await load(m.model);
      self.postMessage({ type: 'loaded', device });
    } else if (m.type === 'run') {
      const len = m.audio.length / 16000;
      const out = await asr(m.audio, {
        language: 'japanese',
        task: 'transcribe',
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      const chunks = (out.chunks && out.chunks.length ? out.chunks : [{ timestamp: [0, len], text: out.text }])
        .map(c => ({ start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? len, text: c.text }));
      self.postMessage({ type: 'result', id: m.id, chunks });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message ? err.message : err) });
  }
};
