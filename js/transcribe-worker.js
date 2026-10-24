// 端末内で日本語の文字起こしを行う（Whisper / Transformers.js）。
// モデルは初回だけ Hugging Face からダウンロードされ、以降はブラウザに保存される。
//
// 精度とタイミングのための方針:
// - iPhone ではメモリの使い方が読みやすい WASM（CPU）を既定にする。WebGPU は明示したときだけ試す
// - プロンプト（話題の文章）は使わない。与えると Whisper が文ごとの時刻を出さなくなり、字幕がずれるため
// - 代わりに、美容用語を書き始めたら続きの文字を選びやすくする（用語の書き始めは強制しない）
// - 用語の書き間違いは「修正案」として、同じ音声に対して元の文と修正案のどちらがもっともらしいかを
//   Whisper 自身に採点させ、基準を満たしたものだけ直す（音声と合わない置き換えはしない）
// - 時刻は Whisper の出力（<|時刻|>）を使い、アプリ側で音声の開始・終了に合わせる
import { pipeline, LogitsProcessor, LogitsProcessorList, Tensor } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';
import { BEAUTY_TERMS, proposeCorrections, applyCorrection, CORRECTION_MARGIN } from './plan.js';

let asr = null;
let initIds = null;
let special = null;
let termSeqs = [];

// 用語を書き始めていたら、その続きの文字を選びやすくする
class TermContinuation extends LogitsProcessor {
  constructor(seqs, begin, boost) {
    super();
    this.seqs = seqs;
    this.begin = begin;
    this.boost = boost;
  }

  _call(input_ids, logits) {
    for (let i = 0; i < input_ids.length; i++) {
      const data = logits[i].data;
      const ids = input_ids[i].slice(this.begin).map(Number);
      const boosted = new Set();
      for (const s of this.seqs) {
        for (let k = Math.min(s.length - 1, ids.length); k >= 1; k--) {
          let ok = true;
          for (let j = 0; j < k; j++) if (ids[ids.length - k + j] !== s[j]) { ok = false; break; }
          if (ok) {
            if (!boosted.has(s[k])) { data[s[k]] += this.boost; boosted.add(s[k]); }
            break;
          }
        }
      }
    }
    return logits;
  }
}

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

const tokenId = s => asr.tokenizer._tokenizer.token_to_id(s);
const decode = ids => asr.tokenizer.decode(ids, { skip_special_tokens: true }).trim();
const encode = text => asr.tokenizer.encode(text, { add_special_tokens: false });

// 生成されたトークン列を「<|時刻|> 文 <|時刻|>」の並びとして読み、文ごとに分ける。
// a, b は seq の中での文のトークンの範囲（b は終わりの時刻トークンの位置）
function toSegments(seq, duration) {
  const tb = asr.tokenizer.timestamp_begin;
  const eos = tokenId('<|endoftext|>');
  const segs = [];
  let cur = [], start = null, a = -1;
  for (let i = 0; i < seq.length; i++) {
    const id = seq[i];
    if (id === eos) break;
    if (id >= tb) {
      const t = (id - tb) * 0.02;
      if (cur.length) {
        segs.push({ start: start ?? t, end: t, ids: cur, a, b: i, timed: start !== null });
        cur = [];
        start = null;
      } else {
        start = t;
      }
    } else if (!special.has(id)) {
      if (!cur.length) a = i;
      cur.push(id);
    }
  }
  if (cur.length) segs.push({ start: start ?? 0, end: duration, ids: cur, a, b: seq.length, timed: false });
  return segs;
}

// 同じ言葉が何度も続く（Whisper が暴走した）部分を1回にまとめる
function collapseRepeats(text) {
  return text.replace(/(.{2,12}?)\1{3,}/g, '$1');
}

// 音声の特徴（エンコーダーの出力）を使い回して、文のトークン列のもっともらしさ（対数尤度）を測る
async function scorer(inputFeatures) {
  const enc = await asr.model.sessions.model.run({ input_features: inputFeatures.ort_tensor });
  const encoder_outputs = new Tensor(enc.last_hidden_state);
  return async (ids, from) => {
    const input = new Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]);
    const out = await asr.model.forward({ encoder_outputs, decoder_input_ids: input });
    const V = out.logits.dims[2], data = out.logits.data;
    let lp = 0;
    for (let i = from; i < ids.length; i++) {
      const row = data.subarray((i - 1) * V, i * V);
      let max = -Infinity;
      for (let k = 0; k < V; k++) if (row[k] > max) max = row[k];
      let sum = 0;
      for (let k = 0; k < V; k++) sum += Math.exp(row[k] - max);
      lp += row[ids[i]] - max - Math.log(sum);
    }
    return lp;
  };
}

// 用語の修正案を、音声で確かめてから採用する
async function verifyCorrections(segs, seq, inputFeatures) {
  const work = segs.map(s => ({ s, text: decode(s.ids), cands: proposeCorrections(decode(s.ids)) })).filter(w => w.cands.length);
  if (!work.length) return;
  let score;
  try {
    score = await scorer(inputFeatures);
  } catch (err) {
    for (const w of work) w.s.fixes = [{ error: String(err && err.message || err) }];
    return;
  }
  for (const { s, cands } of work) {
    let text = decode(s.ids), ids = s.ids;
    // 文脈は「文の始まりの時刻」までに絞る（短くして速く。比べる2つの条件は同じ）
    const pre = [...initIds, ...(s.a > 0 && seq[s.a - 1] >= asr.tokenizer.timestamp_begin ? [seq[s.a - 1]] : [])];
    const post = seq.slice(s.b, s.b + 1);
    let base = await score([...pre, ...ids, ...post], pre.length);
    s.fixes = [];
    for (const c of cands) {
      const idx = text.indexOf(c.from);
      if (idx < 0) continue;
      const candText = applyCorrection(text, { ...c, index: idx });
      const candIds = encode(candText);
      const lc = await score([...pre, ...candIds, ...post], pre.length);
      const delta = lc - base;
      const ok = delta > -CORRECTION_MARGIN[c.kind];
      s.fixes.push({ from: c.from, to: c.to, kind: c.kind, delta: +delta.toFixed(2), ok });
      if (ok) { text = candText; ids = candIds; base = lc; }
    }
    s.text = text;
  }
}

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const device = await load(m.model, m.device);
      special = new Set(asr.tokenizer.all_special_ids);
      initIds = [tokenId('<|startoftranscript|>'), tokenId('<|ja|>'), tokenId('<|transcribe|>')];
      // 辞書の用語に加えて、編集前に入力された言葉（この動画のタイトルや内容に出てくる用語）も使う
      const terms = [...new Set([...BEAUTY_TERMS.map(t => t.term), ...(Array.isArray(m.terms) ? m.terms : [])])];
      termSeqs = terms.map(t => encode(t)).filter(s => s.length >= 2);
      self.postMessage({ type: 'loaded', device, sessions: describeSessions() });
    } else if (m.type === 'run') {
      const duration = m.audio.length / 16000;
      const { input_features } = await asr.processor(m.audio);
      const lp = new LogitsProcessorList();
      lp.push(new TermContinuation(termSeqs, initIds.length, m.boost ?? 3));
      const out = await asr.model.generate({ inputs: input_features, decoder_input_ids: initIds, return_timestamps: true, logits_processor: lp });
      const seq = (out.sequences ?? out).tolist()[0].map(Number).slice(initIds.length);
      const segs = toSegments(seq, duration);
      if (m.verify !== false) await verifyCorrections(segs, seq, input_features);
      const chunks = segs.map(s => {
        const raw = decode(s.ids);
        return { start: s.start, end: Math.max(s.end, s.start + 0.1), text: collapseRepeats(s.text ?? raw), raw, timed: s.timed, fixes: s.fixes };
      }).filter(c => c.text);
      self.postMessage({ type: 'result', id: m.id, chunks });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message ? err.message : err) });
  }
};

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
