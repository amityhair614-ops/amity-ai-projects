// 動画の読み込み・解析・書き出し（iPhone の Safari 上で WebCodecs を使って処理する）
//
// メモリを節約するための方針:
// - ファイルは必要な部分だけを少しずつ読む（全体を読み込まない）
// - 映像は自前の VideoDecoder で1コマずつ展開し、使い終わったコマはすぐ閉じる。先読みは数コマまで
// - 解析用の画像は 96×54 程度に縮小してから扱う。書き出しは 1080×1920 固定
// - 音声は区切りながら読み、解析に必要な 16kHz モノラルだけを残す
import {
  Input, ALL_FORMATS, BlobSource, AudioBufferSink, EncodedPacketSink, EncodedAudioPacketSource,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource,
  canEncodeAudio, canEncodeVideo,
} from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { FRAME_SEC, FPS, OUT_W, OUT_H, SUB_ZONES, cropAt, subtitleAlpha } from './plan.js';
import { log } from './diag.js';

export const ASR_RATE = 16000;

// 音声の読み方。'webcodecs' が失敗したら 'webaudio'（Safari の従来の音声デコーダー）に切り替える
let audioMode = new URLSearchParams(location.search).get('audio') === 'webaudio' ? 'webaudio' : 'webcodecs';
export const getAudioMode = () => audioMode;

export function checkSupport() {
  const missing = [];
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') missing.push('映像の処理（WebCodecs）');
  if (typeof OffscreenCanvas === 'undefined') missing.push('OffscreenCanvas');
  return missing;
}

const CODEC_NAMES = { avc: 'H.264', hevc: 'HEVC（高効率）', vp9: 'VP9', av1: 'AV1', aac: 'AAC', opus: 'Opus' };

export async function openVideo(file) {
  // ReadableStream での読み込みは一部の環境でメモリを多く使うため、ファイルの一部ずつ読む方式にする
  const input = new Input({ source: new BlobSource(file, { useStreamReader: false, maxCacheSize: 8 * 1024 * 1024 }), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error('この動画には映像が見つかりませんでした。');
  const codec = video.codec;
  const decoderConfig = await video.getDecoderConfig();
  if (!decoderConfig) throw new Error(`この映像形式（${codec ?? '不明'}）には対応していません。`);
  const support = await VideoDecoder.isConfigSupported(decoderConfig).catch(() => ({ supported: false }));
  if (!support.supported) {
    const hint = codec === 'hevc'
      ? '\niPhoneの「設定」→「カメラ」→「フォーマット」を「互換性優先」にして撮影した動画なら読み込める可能性があります。'
      : '';
    throw new Error(`この端末のブラウザでは、この映像形式（${CODEC_NAMES[codec] || codec}）を読み込めません。${hint}`);
  }
  let audio = await input.getPrimaryAudioTrack();
  if (audio && !(await audio.canDecode()) && audioMode === 'webcodecs') {
    log('WebCodecsで音声を読めないため Web Audio 方式に切り替え', audio.codec);
    audioMode = 'webaudio';
  }
  const duration = await input.computeDuration();
  const width = await video.getDisplayWidth();
  const height = await video.getDisplayHeight();
  const rotation = await video.getRotation();
  const hdr = await video.hasHighDynamicRange().catch(() => false);
  const info = {
    container: file.name.split('.').pop().toUpperCase(),
    sizeMB: +(file.size / 1e6).toFixed(1),
    duration: +duration.toFixed(2),
    video: `${CODEC_NAMES[codec] || codec} ${await video.getCodedWidth()}×${await video.getCodedHeight()} 回転${rotation}° 表示${width}×${height}${hdr ? ' HDR' : ''}`,
    decoder: decoderConfig.codec,
    audio: audio ? `${CODEC_NAMES[audio.codec] || audio.codec} ${audio.sampleRate}Hz ${audio.numberOfChannels}ch` : 'なし',
  };
  return { input, video, audio, duration, width, height, rotation, decoderConfig, info };
}

export function closeVideo(src) {
  try { src?.input?.dispose(); } catch {}
}

// ---------- 映像のデコード（コマ数を絞って順に処理する） ----------

const tick = () => new Promise(r => setTimeout(r, 0));

class FrameDecoder {
  constructor(config) {
    this.frames = [];
    this.error = null;
    this.decoder = new VideoDecoder({
      output: f => this.frames.push(f),
      error: e => { this.error = e; },
    });
    this.decoder.configure({ ...config, optimizeForLatency: true });
  }

  // たまったコマを順に処理し、デコード待ちが maxPending 以下になるまで待つ
  async drain(onFrame, maxPending) {
    for (;;) {
      while (this.frames.length) {
        const f = this.frames.shift();
        try { await onFrame(f); } finally { f.close(); }
        // 描画に使ったコマのメモリは、いったん処理を区切らないと解放されない
        await tick();
      }
      if (this.error) throw this.error;
      if (this.decoder.decodeQueueSize <= maxPending) return;
      await tick();
    }
  }

  async flush(onFrame) {
    await this.decoder.flush();
    await this.drain(onFrame, 0);
  }

  close() {
    for (const f of this.frames) f.close();
    this.frames = [];
    if (this.decoder.state !== 'closed') this.decoder.close();
  }
}

// 回転と切り抜きを考慮してコマを描く。crop は表示（回転後）の座標。
// 動画のコマを「変換（回転・拡大）をかけた canvas」に直接描くと、ブラウザによってはコマのメモリが
// 解放されずに増え続ける。そこで、コマは切り抜き＋縮小だけで描き、回転は描いた後の画像に対して行う。
function codedRect(crop, rotation, cw, ch) {
  const { left: L, top: T, width: W, height: H } = crop;
  if (rotation === 90) return { x: T, y: ch - L - W, w: H, h: W };
  if (rotation === 180) return { x: cw - L - W, y: ch - T - H, w: W, h: H };
  if (rotation === 270) return { x: cw - T - H, y: L, w: H, h: W };
  return { x: L, y: T, w: W, h: H };
}

class FramePainter {
  constructor(rotation, outW, outH) {
    this.rotation = rotation;
    this.outW = outW;
    this.outH = outH;
    if (rotation) {
      const side = rotation === 180;
      this.tmp = new OffscreenCanvas(side ? outW : outH, side ? outH : outW);
      this.tctx = this.tmp.getContext('2d');
    }
  }

  draw(ctx, frame, crop) {
    const r = codedRect(crop, this.rotation, frame.displayWidth, frame.displayHeight);
    const { outW, outH } = this;
    if (!this.rotation) {
      ctx.drawImage(frame, r.x, r.y, r.w, r.h, 0, 0, outW, outH);
      return;
    }
    this.tctx.drawImage(frame, r.x, r.y, r.w, r.h, 0, 0, this.tmp.width, this.tmp.height);
    ctx.save();
    if (this.rotation === 90) { ctx.translate(outW, 0); ctx.rotate(Math.PI / 2); }
    else if (this.rotation === 180) { ctx.translate(outW, outH); ctx.rotate(Math.PI); }
    else { ctx.translate(0, outH); ctx.rotate(-Math.PI / 2); }
    ctx.drawImage(this.tmp, 0, 0);
    ctx.restore();
  }
}

// 分布 arr の累積が全体の ratio に達する位置
function massPoint(arr, total, ratio) {
  let acc = 0;
  for (let i = 0; i < arr.length; i++) {
    acc += arr[i];
    if (acc >= total * ratio) return i;
  }
  return arr.length - 1;
}

// 約1秒ごとにキーフレームだけを展開し、縮小画像で前のコマとの差（手元の動き）を測る
export async function analyzeMotion(src, onProgress, step = 1) {
  const packets = new EncodedPacketSink(src.video);
  const landscape = src.width >= src.height;
  const w = landscape ? 96 : 54, h = landscape ? 54 : 96;
  const full = { left: 0, top: 0, width: src.width, height: src.height };
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const painter = new FramePainter(src.rotation, w, h);
  const dec = new FrameDecoder(src.decoderConfig);
  const out = { times: [], values: [], cx: [], cy: [], box: [] };
  const cols = new Float32Array(w), rows = new Float32Array(h);
  let prev = null, lastKey = -1;

  const onFrame = async frame => {
    painter.draw(ctx, frame, full);
    const px = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) gray[p] = 0.299 * px[p * 4] + 0.587 * px[p * 4 + 1] + 0.114 * px[p * 4 + 2];
    if (prev) {
      let sum = 0;
      cols.fill(0);
      rows.fill(0);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const d = Math.abs(gray[y * w + x] - prev[y * w + x]);
        if (d > 12) { sum += d; cols[x] += d; rows[y] += d; }
      }
      out.times.push(frame.timestamp / 1e6);
      out.values.push(sum / (w * h));
      // 動いている範囲（動きの量の 10%〜90% が入る範囲）と中心。0〜1 の割合で持つ
      out.cx.push(sum > 0 ? massPoint(cols, sum, 0.5) / (w - 1) : 0.5);
      out.cy.push(sum > 0 ? massPoint(rows, sum, 0.5) / (h - 1) : 0.5);
      out.box.push(sum > 0
        ? [massPoint(cols, sum, 0.1) / (w - 1), massPoint(cols, sum, 0.9) / (w - 1), massPoint(rows, sum, 0.1) / (h - 1), massPoint(rows, sum, 0.9) / (h - 1)]
        : null);
    }
    prev = gray;
  };

  try {
    for (let t = 0; t < src.duration; t += step) {
      const kp = await packets.getKeyPacket(t, { verifyKeyPackets: true });
      if (kp && kp.timestamp > lastKey + step * 0.5) {
        lastKey = kp.timestamp;
        // キーフレームだけを続けて送る（1枚ごとに flush するとメモリが増え続ける環境があるため）
        dec.decoder.decode(kp.toEncodedVideoChunk());
        await dec.drain(onFrame, 1);
      }
      onProgress?.(Math.min(1, (t + step) / src.duration));
    }
    await dec.flush(onFrame);
  } finally {
    dec.close();
  }
  return out;
}

// ---------- 音声 ----------

function mix(chans, len) {
  if (chans.length === 1) return chans[0];
  const mono = new Float32Array(len);
  for (const d of chans) for (let i = 0; i < len; i++) mono[i] += d[i] / chans.length;
  return mono;
}

// Web Audio 方式: 区間の音声データだけを小さな M4A に詰め直し、Safari の音声デコーダーで展開する
async function decodeWithWebAudio(src, start, end, sampleRate) {
  const sink = new EncodedPacketSink(src.audio);
  let p = (await sink.getPacket(Math.max(0, start - 0.2))) ?? (await sink.getFirstPacket());
  if (!p) return null;
  const t0 = p.timestamp;
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new EncodedAudioPacketSource(src.audio.codec);
  output.addAudioTrack(source);
  await output.start();
  const decoderConfig = await src.audio.getDecoderConfig();
  let first = true;
  while (p && p.timestamp < end + 0.1) {
    await source.add(p.clone({ timestamp: p.timestamp - t0 }), first ? { decoderConfig } : undefined);
    first = false;
    p = await sink.getNextPacket(p);
  }
  await output.finalize();
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  const buf = await ctx.decodeAudioData(output.target.buffer);
  const chans = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chans.push(buf.getChannelData(c));
  return { timestamp: t0, sr: buf.sampleRate, chans, length: buf.length };
}

// 区間 [start,end) の音声を少しずつ返す
async function* audioBlocks(src, start, end, webAudioRate) {
  if (audioMode === 'webcodecs') {
    const sink = new AudioBufferSink(src.audio);
    for await (const { buffer, timestamp } of sink.buffers(start, end)) {
      const chans = [];
      for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chans.push(buffer.getChannelData(c));
      yield { timestamp, sr: buffer.sampleRate, chans, length: buffer.length };
    }
    return;
  }
  const CHUNK = 20;
  for (let s = start; s < end; s += CHUNK) {
    const e = Math.min(end, s + CHUNK);
    const block = await decodeWithWebAudio(src, s, e, webAudioRate);
    if (!block) return;
    // 前後の余分を切り落とす
    const from = Math.max(0, Math.round((s - block.timestamp) * block.sr));
    const to = Math.min(block.length, Math.round((e - block.timestamp) * block.sr));
    if (to <= from) continue;
    yield { timestamp: block.timestamp + from / block.sr, sr: block.sr, chans: block.chans.map(c => c.subarray(from, to)), length: to - from };
  }
}
// 音声を最後まで読み、50msごとの音量(dB)と、文字起こし用の16kHzモノラル音声を作る
export async function analyzeAudio(src, onProgress) {
  try {
    return await analyzeAudioOnce(src, onProgress);
  } catch (err) {
    if (audioMode !== 'webcodecs') throw err;
    log('WebCodecsでの音声読み込みに失敗。Web Audio方式でやり直し', String(err?.message || err));
    audioMode = 'webaudio';
    return analyzeAudioOnce(src, onProgress);
  }
}

async function analyzeAudioOnce(src, onProgress) {
  const nFrames = Math.ceil(src.duration / FRAME_SEC) + 1;
  const sumSq = new Float64Array(nFrames);
  const counts = new Uint32Array(nFrames);
  const pcm = new Float32Array(Math.ceil(src.duration * ASR_RATE) + ASR_RATE);

  for await (const { timestamp, sr, chans, length: len } of audioBlocks(src, 0, src.duration, ASR_RATE)) {
    const mono = mix(chans, len);
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

// 指定区間の音声（元の音質）を取り出す
async function readAudio(src, start, duration) {
  const sr0 = src.audio.sampleRate;
  const ch = Math.min(2, src.audio.numberOfChannels) || 1;
  let data = null, sr = sr0;
  for await (const block of audioBlocks(src, start, start + duration, sr0)) {
    if (!data) {
      sr = block.sr;
      data = Array.from({ length: ch }, () => new Float32Array(Math.round(duration * sr)));
    }
    const off = Math.round((block.timestamp - start) * sr);
    for (let c = 0; c < ch; c++) {
      const s = block.chans[Math.min(c, block.chans.length - 1)];
      const d = data[c];
      for (let i = 0; i < block.length; i++) {
        const k = off + i;
        if (k >= 0 && k < d.length) d[k] = s[i];
      }
    }
  }
  if (!data) data = Array.from({ length: ch }, () => new Float32Array(Math.round(duration * sr)));
  return { sr, data };
}

async function readAudioSafe(src, start, duration) {
  try {
    return await readAudio(src, start, duration);
  } catch (err) {
    if (audioMode !== 'webcodecs') throw err;
    log('書き出し中の音声読み込みに失敗。Web Audio方式に切り替え', String(err?.message || err));
    audioMode = 'webaudio';
    return readAudio(src, start, duration);
  }
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
  const b = new AudioBuffer({ length: to - from, numberOfChannels: data.length, sampleRate: sr });
  data.forEach((d, c) => b.copyToChannel(d.subarray(from, to), c));
  return b;
}

// ---------- 書き出し ----------

// 字幕: 白の読みやすいゴシック体・最大2行・薄い黒の影。文字は動かさず、不透明度だけで出し入れする
const FONT_FAMILY = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "IPAGothic", sans-serif';
const FONT_SIZE = 58;
const LINE_HEIGHT = 1.42;
const MAX_TEXT_W = OUT_W * 0.86;

function drawSubtitle(ctx, page, t) {
  if (!page) return;
  const alpha = subtitleAlpha(page, t);
  if (alpha <= 0) return;
  ctx.save();
  // 1行が長すぎるときだけ、そのページの文字を少し小さくする
  let size = FONT_SIZE;
  ctx.font = `600 ${size}px ${FONT_FAMILY}`;
  const widest = Math.max(...page.lines.map(l => ctx.measureText(l).width));
  if (widest > MAX_TEXT_W) {
    size = Math.floor(size * MAX_TEXT_W / widest);
    ctx.font = `600 ${size}px ${FONT_FAMILY}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.42)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 2;
  const lh = size * LINE_HEIGHT;
  const centerY = OUT_H * (SUB_ZONES[page.pos] ?? SUB_ZONES.bottom);
  const firstY = centerY - ((page.lines.length - 1) * lh) / 2;
  page.lines.forEach((line, i) => ctx.fillText(line, OUT_W / 2, firstY + i * lh));
  ctx.restore();
}

// timeline: plan.buildTimeline の結果。gainDb: 音量補正
export async function renderShort(src, timeline, { gainDb = 0, onProgress } = {}) {
  if (!(await canEncodeVideo('avc', { width: OUT_W, height: OUT_H }))) {
    throw new Error('この端末では H.264 の書き出しに対応していません。');
  }
  const withAudio = !!src.audio;
  if (withAudio && !(await canEncodeAudio('aac'))) {
    log('AACの書き出しに端末が対応していないため、内蔵のAACエンコーダーを使用');
    registerAacEncoder();
  }

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const canvas = new OffscreenCanvas(OUT_W, OUT_H);
  const ctx = canvas.getContext('2d');
  const base = new OffscreenCanvas(OUT_W, OUT_H); // 字幕を載せる前のコマ
  const bctx = base.getContext('2d');
  bctx.fillStyle = '#000';
  bctx.fillRect(0, 0, OUT_W, OUT_H);
  // 髪の質感がつぶれないよう、ビットレートは高め（約 75MB/分）。色の加工はしない
  const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: 10_000_000, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: FPS });
  let audioSource = null;
  if (withAudio) {
    audioSource = new AudioBufferSource({ codec: 'aac', bitrate: 160_000 });
    output.addAudioTrack(audioSource);
  }
  await output.start();

  const gain = Math.pow(10, gainDb / 20);
  const totalFrames = timeline.reduce((s, c) => s + c.pieces.reduce((a, p) => a + p.frames, 0), 0);
  const packets = new EncodedPacketSink(src.video);
  const painter = new FramePainter(src.rotation, OUT_W, OUT_H);
  let done = 0;

  try {
    for (const clip of timeline) {
      for (const piece of clip.pieces) {
        const dur = piece.frames / FPS;
        const end = piece.srcStart + dur;
        let audio = null, sent = 0, k = 0;
        if (withAudio) {
          audio = await readAudioSafe(src, piece.srcStart, dur);
          processAudio(audio.data, audio.sr, gain);
        }
        // 出力の k 番目のコマを、いま base にある画像で作る
        const emit = async () => {
          const t = piece.outStart + k / FPS;
          ctx.drawImage(base, 0, 0);
          drawSubtitle(ctx, clip.subtitles.find(p => t >= p.start && t < p.end), t);
          if (audio) {
            // 音声は映像と交互に少しずつ渡す
            const until = Math.min(audio.data[0].length, Math.round(((k + 1) / FPS + 0.5) * audio.sr));
            if (until - sent >= audio.sr * 0.5 || until === audio.data[0].length) {
              if (until > sent) await audioSource.add(toAudioBuffer(audio.data, audio.sr, sent, until));
              sent = until;
            }
          }
          await videoSource.add(t, 1 / FPS);
          k++; done++;
          onProgress?.(done / totalFrames);
        };
        // 新しいコマが来たら、それより前の時刻の出力コマを直前の画像で埋めてから描き替える
        const onFrame = async frame => {
          const ts = frame.timestamp / 1e6;
          while (k < piece.frames && piece.srcStart + k / FPS < ts - 1e-3) await emit();
          // ズーム中は、このコマの出力時刻に合わせた枠で切り抜く
          if (k < piece.frames) painter.draw(bctx, frame, cropAt(clip, piece.outStart + Math.max(0, ts - piece.srcStart)));
        };

        const dec = new FrameDecoder(src.decoderConfig);
        try {
          let p = (await packets.getKeyPacket(piece.srcStart, { verifyKeyPackets: true })) ?? (await packets.getFirstPacket());
          // B フレームの並べ替えを考えて少し先まで送る
          while (p && p.timestamp < end + 0.5 && k < piece.frames) {
            dec.decoder.decode(p.toEncodedVideoChunk());
            await dec.drain(onFrame, 2);
            p = await packets.getNextPacket(p);
          }
          await dec.flush(onFrame);
        } finally {
          dec.close();
        }
        while (k < piece.frames) await emit();
        if (audio && sent < audio.data[0].length) await audioSource.add(toAudioBuffer(audio.data, audio.sr, sent, audio.data[0].length));
      }
    }
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  }
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
