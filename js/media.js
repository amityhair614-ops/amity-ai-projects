// 動画の読み込み・解析・書き出し（iPhone の Safari 上で WebCodecs を使って処理する）
import {
  Input, ALL_FORMATS, BlobSource, AudioBufferSink, CanvasSink, EncodedPacketSink,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource,
  canEncodeAudio, canEncodeVideo,
} from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { FRAME_SEC, FPS, OUT_W, OUT_H, cropRect } from './plan.js';

export const ASR_RATE = 16000;

export function checkSupport() {
  const missing = [];
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') missing.push('映像の処理（WebCodecs）');
  if (typeof AudioDecoder === 'undefined') missing.push('音声の処理（WebCodecs Audio）');
  return missing;
}

export async function openVideo(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error('この動画には映像が見つかりませんでした。');
  if (!(await video.canDecode())) throw new Error(`この端末ではこの映像形式（${video.codec ?? '不明'}）を読み込めません。`);
  let audio = await input.getPrimaryAudioTrack();
  if (audio && !(await audio.canDecode())) audio = null;
  const duration = await input.computeDuration();
  return { input, video, audio, duration, width: video.displayWidth, height: video.displayHeight };
}

// 音声を最後まで読み、50msごとの音量(dB)と、文字起こし用の16kHzモノラル音声を作る
export async function analyzeAudio(src, onProgress) {
  const nFrames = Math.ceil(src.duration / FRAME_SEC) + 1;
  const sumSq = new Float64Array(nFrames);
  const counts = new Uint32Array(nFrames);
  const pcm = new Float32Array(Math.ceil(src.duration * ASR_RATE) + ASR_RATE);
  const sink = new AudioBufferSink(src.audio);

  for await (const { buffer, timestamp } of sink.buffers()) {
    const sr = buffer.sampleRate, len = buffer.length, ch = buffer.numberOfChannels;
    const mono = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i] / ch;
    }
    for (let i = 0; i < len; i++) {
      const f = Math.floor((timestamp + i / sr) / FRAME_SEC);
      if (f >= 0 && f < nFrames) { sumSq[f] += mono[i] * mono[i]; counts[f]++; }
    }
    // 16kHz へ（簡易ローパス付きの間引き）
    const r = Math.max(0, Math.floor(sr / ASR_RATE / 2));
    const j0 = Math.max(0, Math.ceil(timestamp * ASR_RATE));
    const j1 = Math.min(pcm.length, Math.floor((timestamp + len / sr) * ASR_RATE));
    for (let j = j0; j < j1; j++) {
      const idx = Math.round((j / ASR_RATE - timestamp) * sr);
      let s = 0, n = 0;
      for (let k = idx - r; k <= idx + r; k++) if (k >= 0 && k < len) { s += mono[k]; n++; }
      if (n) pcm[j] = s / n;
    }
    onProgress?.(Math.min(1, (timestamp + len / sr) / src.duration));
  }
  const rmsDb = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) rmsDb[f] = counts[f] ? 10 * Math.log10(sumSq[f] / counts[f] + 1e-12) : -120;
  return { rmsDb, pcm };
}

// 約1秒ごとに小さな画像を取り出し、前のコマとの差（手元の動き）を測る
export async function analyzeMotion(src, onProgress, step = 1) {
  const packets = new EncodedPacketSink(src.video);
  const wanted = [];
  for (let t = 0; t < src.duration; t += step) wanted.push(t);
  // キーフレームに合わせるとデコードが少なくて済む
  const times = [];
  for (const t of wanted) {
    const kp = await packets.getKeyPacket(t, { metadataOnly: true });
    let ts = kp && t - kp.timestamp < step * 1.5 ? kp.timestamp : t;
    if (!times.length || ts - times[times.length - 1] > step * 0.5) times.push(ts);
    else if (ts !== t && t - times[times.length - 1] > step * 0.5) times.push(t);
  }
  const landscape = src.width >= src.height;
  const w = landscape ? 96 : 54, h = landscape ? 54 : 96;
  const sink = new CanvasSink(src.video, { width: w, height: h, fit: 'fill', poolSize: 1 });
  const work = new OffscreenCanvas(w, h);
  const ctx = work.getContext('2d', { willReadFrequently: true });

  const out = { times: [], values: [], cx: [] };
  let prev = null, i = 0;
  for await (const wc of sink.canvasesAtTimestamps(times)) {
    i++;
    if (!wc) continue;
    ctx.drawImage(wc.canvas, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) gray[p] = 0.299 * px[p * 4] + 0.587 * px[p * 4 + 1] + 0.114 * px[p * 4 + 2];
    if (prev) {
      let sum = 0, sx = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const d = Math.abs(gray[y * w + x] - prev[y * w + x]);
        if (d > 12) { sum += d; sx += d * x; }
      }
      out.times.push(wc.timestamp);
      out.values.push(sum / (w * h));
      out.cx.push(sum > 0 ? sx / sum / (w - 1) : 0.5);
    }
    prev = gray;
    onProgress?.(i / times.length);
  }
  return out;
}

// 指定区間の音声を AudioBuffer として取り出す
async function readAudio(track, start, duration) {
  const sink = new AudioBufferSink(track);
  let sr = track.sampleRate, ch = Math.min(2, track.numberOfChannels);
  let data = null;
  for await (const { buffer, timestamp } of sink.buffers(start, start + duration)) {
    if (!data) {
      sr = buffer.sampleRate; ch = Math.min(2, buffer.numberOfChannels);
      data = Array.from({ length: ch }, () => new Float32Array(Math.round(duration * sr)));
    }
    const off = Math.round((timestamp - start) * sr);
    for (let c = 0; c < ch; c++) {
      const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
      for (let i = 0; i < src.length; i++) {
        const k = off + i;
        if (k >= 0 && k < data[c].length) data[c][k] = src[i];
      }
    }
  }
  if (!data) data = Array.from({ length: ch }, () => new Float32Array(Math.round(duration * sr)));
  return { sr, data };
}

// 音量をそろえ、つなぎ目の「プチッ」を防ぐ
function processAudio(data, sr, gain) {
  const fade = Math.min(Math.round(sr * 0.012), Math.floor(data[0].length / 2));
  for (const ch of data) {
    for (let i = 0; i < ch.length; i++) {
      let y = ch[i] * gain;
      const a = Math.abs(y);
      if (a > 0.9) y = Math.sign(y) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1));
      if (i < fade) y *= i / fade;
      else if (i >= ch.length - fade) y *= (ch.length - 1 - i) / fade;
      ch[i] = y;
    }
  }
}

function toAudioBuffer(data, sr, from, to) {
  const buf = new AudioBuffer({ length: to - from, numberOfChannels: data.length, sampleRate: sr });
  data.forEach((d, c) => buf.copyToChannel(d.subarray(from, to), c));
  return buf;
}

const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "IPAGothic", sans-serif';
function drawSubtitle(ctx, page) {
  if (!page) return;
  ctx.save();
  ctx.font = `bold 70px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const lh = 92;
  const baseY = OUT_H * 0.72 - ((page.lines.length - 1) * lh) / 2;
  page.lines.forEach((line, i) => {
    const y = baseY + i * lh;
    ctx.lineWidth = 14;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(line, OUT_W / 2, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line, OUT_W / 2, y);
  });
  ctx.restore();
}

// timeline: plan.buildTimeline の結果。gainDb: 音量補正
export async function renderShort(src, timeline, { gainDb = 0, onProgress } = {}) {
  if (!(await canEncodeVideo('avc', { width: OUT_W, height: OUT_H }))) {
    throw new Error('この端末では H.264 の書き出しに対応していません。');
  }
  const withAudio = !!src.audio;
  if (withAudio && !(await canEncodeAudio('aac'))) registerAacEncoder();

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const canvas = new OffscreenCanvas(OUT_W, OUT_H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, OUT_W, OUT_H);
  const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: 8_000_000, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: FPS });
  let audioSource = null;
  if (withAudio) {
    audioSource = new AudioBufferSource({ codec: 'aac', bitrate: 160_000 });
    output.addAudioTrack(audioSource);
  }
  await output.start();

  const gain = Math.pow(10, gainDb / 20);
  const totalFrames = timeline.reduce((s, c) => s + c.pieces.reduce((a, p) => a + p.frames, 0), 0);
  let done = 0;
  const frame = document.createElement('canvas'); // 直前のコマ（取り出せなかった時用）
  frame.width = OUT_W; frame.height = OUT_H;
  const fctx = frame.getContext('2d');

  for (const clip of timeline) {
    const crop = cropRect(src.width, src.height, clip.cx);
    const sink = new CanvasSink(src.video, { crop, width: OUT_W, height: OUT_H, fit: 'fill', poolSize: 2 });
    for (const piece of clip.pieces) {
      const dur = piece.frames / FPS;
      let audio = null, sent = 0;
      if (withAudio) {
        audio = await readAudio(src.audio, piece.srcStart, dur);
        processAudio(audio.data, audio.sr, gain);
      }
      const times = Array.from({ length: piece.frames }, (_, k) => piece.srcStart + k / FPS);
      let k = 0;
      for await (const wc of sink.canvasesAtTimestamps(times)) {
        const t = piece.outStart + k / FPS;
        if (wc) fctx.drawImage(wc.canvas, 0, 0, OUT_W, OUT_H);
        ctx.drawImage(frame, 0, 0);
        drawSubtitle(ctx, clip.subtitles.find(p => t >= p.start && t < p.end));
        // 音声は映像と交互に少しずつ渡す
        if (audio) {
          const until = Math.min(audio.data[0].length, Math.round(((k + 1) / FPS + 0.5) * audio.sr));
          if (until - sent >= audio.sr * 0.5 || until === audio.data[0].length) {
            if (until > sent) await audioSource.add(toAudioBuffer(audio.data, audio.sr, sent, until));
            sent = until;
          }
        }
        await videoSource.add(t, 1 / FPS);
        k++; done++;
        onProgress?.(done / totalFrames);
      }
      if (audio && sent < audio.data[0].length) await audioSource.add(toAudioBuffer(audio.data, audio.sr, sent, audio.data[0].length));
    }
  }
  await output.finalize();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
