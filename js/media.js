// 動画の読み込み・解析・書き出し（iPhone の Safari 上で WebCodecs を使って処理する）
//
// メモリを節約するための方針:
// - ファイルは必要な部分だけを少しずつ読む（全体を読み込まない）
// - 映像は自前の VideoDecoder で1コマずつ展開し、使い終わったコマはすぐ閉じる。先読みは数コマまで
// - 解析用の画像は 96×54 程度に縮小してから扱う。書き出しは 1080×1920 固定
// - 音声は区切りながら読み、解析に必要な 16kHz モノラルだけを残す
import {
  Input, ALL_FORMATS, BlobSource, AudioBufferSink, EncodedPacketSink, EncodedAudioPacketSource,
  Output, Mp4OutputFormat, BufferTarget, StreamTarget, CanvasSource, AudioBufferSource, EncodedVideoPacketSource,
  canEncodeAudio, canEncodeVideo,
} from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { FRAME_SEC, FPS, OUT_W, OUT_H, SUB_ZONES, cropAt, subtitleAlpha, openingAlpha, endFadeAlpha } from './plan.js';
import { log } from './diag.js';
import { Resampler } from './resample.js';
import { AudioStitcher, applyGain, applyEndFade } from './audiomix.js';

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
    // 色の情報（HDR の HLG / PQ か、SDR の BT.709 か）。iPhone の HDR 動画は、ブラウザで SDR に変換するときに
    // 暗く・薄くなる可能性があるため、診断情報で確かめられるようにする
    color: colorText(decoderConfig.colorSpace),
    audio: audio ? `${CODEC_NAMES[audio.codec] || audio.codec} ${audio.sampleRate}Hz ${audio.numberOfChannels}ch` : 'なし',
  };
  return { input, video, audio, duration, width, height, rotation, decoderConfig, info, hdr };
}

function colorText(cs) {
  if (!cs) return '不明';
  return [cs.primaries, cs.transfer, cs.matrix, cs.fullRange == null ? null : cs.fullRange ? 'full' : 'limited'].map(x => x ?? '?').join(' / ');
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

// 縮小・拡大の補間を高品質にする（ブラウザの初期設定は「低」で、4Kから縮小すると髪の細い線がつぶれる）
function hq(ctx) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

class FramePainter {
  constructor(rotation, outW, outH) {
    this.rotation = rotation;
    this.outW = outW;
    this.outH = outH;
    if (rotation) {
      const side = rotation === 180;
      this.tmp = new OffscreenCanvas(side ? outW : outH, side ? outH : outW);
      this.tctx = hq(this.tmp.getContext('2d'));
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

// 約1秒ごとにキーフレームだけを展開し、縮小画像で前のコマとの差（手元の動き）を測る。
// resume: 前回途中まで解析した結果（{ out, nextT, lastKey }）。onCheckpoint で途中の結果を定期的に渡す（保存用）
export async function analyzeMotion(src, onProgress, step = 1, { resume = null, onCheckpoint = null, every = 30 } = {}) {
  const packets = new EncodedPacketSink(src.video);
  const landscape = src.width >= src.height;
  const w = landscape ? 96 : 54, h = landscape ? 54 : 96;
  const full = { left: 0, top: 0, width: src.width, height: src.height };
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const painter = new FramePainter(src.rotation, w, h);
  const dec = new FrameDecoder(src.decoderConfig);
  const out = resume?.out ?? { times: [], values: [], cx: [], cy: [], box: [] };
  const cols = new Float32Array(w), rows = new Float32Array(h);
  // 再開したときは、最初に展開したコマを「前のコマ」にする（そのコマの動きの値だけ欠ける）
  let prev = null, lastKey = resume?.lastKey ?? -1;

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
    let n = 0;
    for (let t = resume?.nextT ?? 0; t < src.duration; t += step) {
      const kp = await packets.getKeyPacket(t, { verifyKeyPackets: true });
      if (kp && kp.timestamp > lastKey + step * 0.5) {
        lastKey = kp.timestamp;
        // キーフレームだけを続けて送る（1枚ごとに flush するとメモリが増え続ける環境があるため）
        dec.decoder.decode(kp.toEncodedVideoChunk());
        await dec.drain(onFrame, 1);
      }
      onProgress?.(Math.min(1, (t + step) / src.duration));
      // 送ったコマがすべて解析済みになった時点の結果を渡す（その次の時刻から再開できる）
      if (onCheckpoint && ++n % every === 0) {
        await dec.flush(onFrame);
        await onCheckpoint({ out, nextT: t + step, lastKey });
      }
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
  const write = (j, v) => { if (j >= 0 && j < pcm.length) pcm[j] = v; };
  let resampler = null;

  for await (const { timestamp, sr, chans, length: len } of audioBlocks(src, 0, src.duration, ASR_RATE)) {
    const mono = mix(chans, len);
    for (let i = 0; i < len; i++) {
      const f = Math.floor((timestamp + i / sr) / FRAME_SEC);
      if (f >= 0 && f < nFrames) { sumSq[f] += mono[i] * mono[i]; counts[f]++; }
    }
    // 文字起こし用に 16kHz へ（低域通過フィルターつきで変換）
    if (!resampler || resampler.srIn !== sr) {
      resampler?.flush();
      resampler = new Resampler(sr, ASR_RATE, write);
    }
    resampler.push(Math.round(timestamp * sr), mono);
    onProgress?.(Math.min(1, (timestamp + len / sr) / src.duration));
  }
  resampler?.flush();
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

function toAudioBuffer(data, sr, from, to) {
  const b = new AudioBuffer({ length: to - from, numberOfChannels: data.length, sampleRate: sr });
  data.forEach((d, c) => b.copyToChannel(d.subarray(from, to), c));
  return b;
}

// ---------- 書き出し ----------

// 字幕: 白の読みやすいゴシック体・最大2行・薄い黒の影。文字は動かさず、不透明度だけで出し入れする。
// 大きさは手動編集のお手本（画面の幅に対して小さめ）に近づけ、髪や手元を隠す面積を減らしている
const FONT_FAMILY = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "IPAGothic", sans-serif';
const FONT_SIZE = 50;
const LINE_HEIGHT = 1.4;
const MAX_TEXT_W = OUT_W * 0.86;

// 冒頭のテキスト: 白の太いゴシック体・大きめ・薄い黒の影（背景の帯はつけない）
const TITLE_SIZE = 96;
const TITLE_LINE_HEIGHT = 1.28;
const TITLE_MAX_W = OUT_W * 0.84;

function drawOpening(ctx, op, t) {
  const alpha = openingAlpha(op, t);
  if (alpha <= 0) return;
  ctx.save();
  let size = TITLE_SIZE;
  ctx.font = `800 ${size}px ${FONT_FAMILY}`;
  const widest = Math.max(...op.lines.map(l => ctx.measureText(l).width));
  if (widest > TITLE_MAX_W) {
    size = Math.floor(size * TITLE_MAX_W / widest);
    ctx.font = `800 ${size}px ${FONT_FAMILY}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';
  const lh = size * TITLE_LINE_HEIGHT;
  const firstY = OUT_H * op.y - ((op.lines.length - 1) * lh) / 2;
  // 影は2重（近くの薄い影で輪郭を読みやすく、広い影で明るい背景でも浮かせる）
  for (const [color, blur, dy] of [['rgba(0, 0, 0, 0.35)', 18, 4], ['rgba(0, 0, 0, 0.45)', 4, 2]]) {
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetY = dy;
    op.lines.forEach((line, i) => ctx.fillText(line, OUT_W / 2, firstY + i * lh));
  }
  ctx.restore();
}

// 最後のフェードアウト（映像をなめらかに黒くする）
function drawEndFade(ctx, t, total) {
  const a = endFadeAlpha(t, total);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, OUT_W, OUT_H);
  ctx.restore();
}

function drawSubtitle(ctx, page, t) {
  if (!page) return;
  const alpha = subtitleAlpha(page, t);
  if (alpha <= 0) return;
  ctx.save();
  // 1行が長すぎるときだけ、そのページの文字を少し小さくする
  let size = FONT_SIZE;
  ctx.font = `700 ${size}px ${FONT_FAMILY}`;
  const widest = Math.max(...page.lines.map(l => ctx.measureText(l).width));
  if (widest > MAX_TEXT_W) {
    size = Math.floor(size * MAX_TEXT_W / widest);
    ctx.font = `700 ${size}px ${FONT_FAMILY}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  const lh = size * LINE_HEIGHT;
  const centerY = OUT_H * (SUB_ZONES[page.pos] ?? SUB_ZONES.bottom);
  const firstY = centerY - ((page.lines.length - 1) * lh) / 2;
  page.lines.forEach((line, i) => ctx.fillText(line, OUT_W / 2, firstY + i * lh));
  ctx.restore();
}

// ---------- 区間ごとの書き出しと、完成したMP4の組み立て ----------
//
// 途中でSafariが閉じられても続きから再開できるよう、書き出しを2段階に分ける。
// 1. 映像を数秒ずつの「区間」に分けて書き出し、区間ごとに端末内のファイルに保存する（renderSegment）
//    → 途中で止まっても、保存済みの区間はやり直さない（書きかけの区間だけやり直す）
// 2. 保存した区間の映像を、作り直さずに（再エンコードせずに）つなぎ、
//    音声は元の動画から最初から最後まで通して作って、1つのMP4にする（assembleOutput）
//    → 音声を区間ごとに作ると、つなぎ目ごとに AAC の先頭の無音（エンコーダーの遅延）が入って「プツッ」となるため
// どちらも書き出し先はファイル（StreamTarget）で、動画全体をメモリに持たない（10分の動画でも使うメモリは一定）

async function checkVideoEncoder() {
  if (!(await canEncodeVideo('avc', { width: OUT_W, height: OUT_H }))) {
    throw new Error('この端末では H.264 の書き出しに対応していません。');
  }
}

// 書き出しを一時停止するときの合図（画面を離れたときなど）。この例外は失敗ではない
export class RenderPaused extends Error {
  constructor() { super('一時停止しました'); this.name = 'RenderPaused'; }
}

// 書き出しに使う canvas と描画の準備。区間ごとに作り直すと、iPhone では使い終わった canvas の
// メモリ（GPU）がすぐに解放されずに積み重なるため、書き出し全体で1つを使い回す
export function createRenderContext(src) {
  const canvas = new OffscreenCanvas(OUT_W, OUT_H);
  const base = new OffscreenCanvas(OUT_W, OUT_H); // 字幕を載せる前のコマ
  return {
    canvas, ctx: hq(canvas.getContext('2d')), base, bctx: hq(base.getContext('2d')),
    painter: new FramePainter(src.rotation, OUT_W, OUT_H),
  };
}

// デコーダーの失敗を、原因を調べられるよう詳しく記録した例外にする
function decodeError(err, info) {
  if (err?.detail?.stage) { err.detail = { ...info, ...err.detail }; return err; } // 内側で段階を記録済み（エンコードなど）
  const e = new Error(`${err?.name || 'Error'}: ${err?.message || err}`);
  e.name = err?.name || 'Error';
  e.cause = err;
  e.detail = { stage: err?.stage || 'decode', ...info, stack: String(err?.stack || '').split('\n').slice(0, 4).join(' | ') };
  return e;
}

// ピース piece のうち、出力のコマ f0〜f1 を描く。コマごとに emit(出力の時刻) を呼ぶ（その時点の画像は base にある）。
// opts.lowLatency: false にすると、デコーダーの低遅延モードを使わない（やり直しのとき）
// opts.earlierKey: true にすると、1つ前のキーフレームからデコードする（やり直しのとき）
async function drawFrames(src, packets, rc, clip, piece, f0, f1, emit, opts = {}) {
  const from = piece.srcStart + f0 / FPS;
  const n = f1 - f0;
  const end = from + n / FPS;
  let k = 0, decoded = 0, sent = 0, skipped = 0, lastTs = null;
  const out = async () => { await emit(piece.outStart + (f0 + k) / FPS); k++; };
  // 新しいコマが来たら、それより前の時刻の出力コマを直前の画像で埋めてから描き替える
  const onFrame = async frame => {
    decoded++;
    const ts = frame.timestamp / 1e6;
    while (k < n && from + k / FPS < ts - 1e-3) await out();
    // ズーム中は、このコマの出力時刻に合わせた枠で切り抜く
    if (k < n) {
      try { rc.painter.draw(rc.bctx, frame, cropAt(clip, piece.outStart + f0 / FPS + Math.max(0, ts - from))); }
      catch (err) { throw Object.assign(err, { stage: 'draw' }); }
    }
  };
  const config = { ...src.decoderConfig, optimizeForLatency: opts.lowLatency !== false };
  let key = (await packets.getKeyPacket(from, { verifyKeyPackets: true })) ?? (await packets.getFirstPacket());
  if (opts.earlierKey && key && key.timestamp > 0) {
    key = (await packets.getKeyPacket(Math.max(0, key.timestamp - 0.001), { verifyKeyPackets: true })) ?? key;
  }
  const info = () => ({
    srcFrom: +from.toFixed(3), frames: `${f0}-${f1}`, outFrame: k, key: key && +key.timestamp.toFixed(3),
    lastPacket: lastTs, sent, skipped, decoded, codec: config.codec, coded: `${config.codedWidth}x${config.codedHeight}`,
    rotation: src.rotation, decoderState: dec?.decoder?.state, queue: dec?.decoder?.decodeQueueSize, lowLatency: config.optimizeForLatency,
  });
  let dec = null;
  try {
    dec = new FrameDecoder(config);
    let p = key;
    // B フレームの並べ替えを考えて少し先まで送る
    while (p && p.timestamp < end + 0.5 && k < n) {
      // キーフレームより前に表示されるコマ（HEVC の「前のまとまりを参照するコマ」など）は、
      // キーフレームから始めると正しくデコードできないので送らない（表示時刻が from より前なので出力には使わない）
      if (p !== key && p.timestamp < key.timestamp) { skipped++; }
      else {
        lastTs = +p.timestamp.toFixed(3);
        dec.decoder.decode(p.toEncodedVideoChunk());
        sent++;
        await dec.drain(onFrame, 2);
      }
      try { p = await packets.getNextPacket(p); }
      catch (err) { throw Object.assign(err, { stage: 'read' }); }
    }
    await dec.flush(onFrame);
  } catch (err) {
    if (err instanceof RenderPaused) throw err;
    throw decodeError(err, info());
  } finally {
    dec?.close();
  }
  while (k < n) await out();
}

// 区間 seg（resume.planSegments の結果の1つ）の映像だけを、stream（ファイル）に MP4 として書き出す。
// rc: createRenderContext の結果（区間をまたいで使い回す）。shouldPause() が true になったら、きりのよい所で RenderPaused を投げる
// overlay: { opening: 冒頭のテキスト（openingPlan の結果）, total: 完成動画の長さ（最後のフェード用）}
export async function renderSegment(src, timeline, seg, stream, { onProgress, rc, shouldPause, decode, overlay } = {}) {
  await checkVideoEncoder();
  rc = rc || createRenderContext(src);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(stream) });
  rc.bctx.fillStyle = '#000';
  rc.bctx.fillRect(0, 0, OUT_W, OUT_H);
  // 髪の質感がつぶれないよう、ビットレートは高め（約 150MB/分）。色の加工はしない
  const videoSource = new CanvasSource(rc.canvas, { codec: 'avc', bitrate: VIDEO_BITRATE, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: FPS });
  await output.start();
  const packets = new EncodedPacketSink(src.video);
  let done = 0;
  let current = null;
  try {
    for (const s of seg.slices) {
      const clip = timeline[s.c];
      current = s;
      await drawFrames(src, packets, rc, clip, clip.pieces[s.p], s.f0, s.f1, async t => {
        if (shouldPause?.()) throw new RenderPaused();
        rc.ctx.drawImage(rc.base, 0, 0);
        drawSubtitle(rc.ctx, clip.subtitles.find(p => t >= p.start && t < p.end), t);
        if (overlay?.opening) drawOpening(rc.ctx, overlay.opening, t);
        if (overlay?.total) drawEndFade(rc.ctx, t, overlay.total);
        try {
          await videoSource.add(t - seg.outStart, 1 / FPS);
        } catch (err) {
          throw Object.assign(new Error(`${err?.name || 'Error'}: ${err?.message || err}`), { name: err?.name || 'Error', cause: err, detail: { stage: 'encode', outTime: +t.toFixed(3), stack: String(err?.stack || '').split('\n').slice(0, 4).join(' | ') } });
        }
        done++;
        onProgress?.(done / seg.frames);
      }, decode);
    }
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    if (err && !(err instanceof RenderPaused)) {
      err.detail = { segment: seg.index, slice: current && { clip: current.c, piece: current.p }, framesDone: done, ...(err.detail || {}) };
    }
    throw err;
  }
}

let bundledAac = false;
function useBundledAac() {
  if (bundledAac) return;
  registerAacEncoder();
  bundledAac = true;
  log('音声は内蔵のAACエンコーダーで作成');
}

// 映像のビットレート。髪の細かい線は圧縮で真っ先に失われるため高めにする（4Kの細かい模様の試験で、10Mbps では
// 細かさが元の66%、20Mbps では78%。約150MB/分）
export const VIDEO_BITRATE = 20_000_000;
export const AUDIO_BITRATE = 160_000;

function sameConfig(a, b) {
  if (!a || !b || a.codec !== b.codec || a.codedWidth !== b.codedWidth || a.codedHeight !== b.codedHeight) return false;
  const da = a.description ? new Uint8Array(ArrayBuffer.isView(a.description) ? a.description.buffer.slice(a.description.byteOffset, a.description.byteOffset + a.description.byteLength) : a.description) : null;
  const db = b.description ? new Uint8Array(ArrayBuffer.isView(b.description) ? b.description.buffer.slice(b.description.byteOffset, b.description.byteOffset + b.description.byteLength) : b.description) : null;
  if (!da || !db) return !da && !db;
  return da.length === db.length && da.every((v, i) => v === db[i]);
}

// 保存した区間の映像をつなぎ、音声を通して作って、stream（ファイル）に完成したMP4を書き出す。
// getSegment(i): i 番目の区間のファイル（File）
export async function assembleOutput(src, timeline, segments, getSegment, stream, { gainDb = 0, onProgress, endFade = 0, endHold = 0 } = {}) {
  const withAudio = !!src.audio;
  // 音声は、ブラウザの AAC エンコーダーではなく、内蔵の AAC エンコーダー（FFmpeg の WASM 版）で作る。
  // WebKit（Safari と同じエンジン）のエンコーダーは、1回に渡した音声から作られる AAC のフレームすべてに
  // 同じ時刻を付けて返すことがあり（Linux の WebKit で確認）、MP4 の音声の時刻が壊れるため
  if (withAudio) useBundledAac();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(stream) });
  const videoSource = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(videoSource, { frameRate: FPS });
  let audioSource = null;
  if (withAudio) {
    audioSource = new AudioBufferSource({ codec: 'aac', bitrate: AUDIO_BITRATE });
    output.addAudioTrack(audioSource);
  }
  await output.start();
  const gain = Math.pow(10, gainDb / 20);
  const stitcher = new AudioStitcher();
  const lastSeg = segments[segments.length - 1];
  const outTotal = timeline.reduce((sum, c) => sum + c.outDuration, 0);
  let firstConfig = null;
  try {
    for (const seg of segments) {
      // 音声: この区間の分を、前の区間から続けて作る（つなぎ目のクロスフェードは区間をまたいでも同じ）
      if (withAudio) {
        for (const s of seg.slices) {
          const piece = timeline[s.c].pieces[s.p];
          const dur = (s.f1 - s.f0) / FPS;
          const raw = await readAudioSafe(src, piece.srcStart + s.f0 / FPS, dur + AudioStitcher.extra());
          applyGain(raw.data, gain);
          const len = Math.round(dur * raw.sr);
          const last = seg === lastSeg && s === seg.slices[seg.slices.length - 1];
          const data = stitcher.add(raw.data, raw.sr, { len, contiguous: s.f0 > 0 || piece.contiguous, last });
          // 最後のフェードアウト（映像が黒くなるのと同じ時間で、音声も小さくする）
          if (endFade) applyEndFade(data, raw.sr, piece.outStart + s.f0 / FPS, outTotal, endFade, endHold);
          await audioSource.add(toAudioBuffer(data, raw.sr, 0, len));
        }
      }
      // 映像: 保存した区間のデータを、時刻だけずらしてそのまま入れる
      const file = await getSegment(seg.index);
      if (!file) throw new Error(`書き出した区間 ${seg.index + 1} の保存データが見つかりません。`);
      const input = new Input({ source: new BlobSource(file, { maxCacheSize: 4 * 1024 * 1024 }), formats: ALL_FORMATS });
      try {
        const track = await input.getPrimaryVideoTrack();
        const config = await track.getDecoderConfig();
        if (!firstConfig) firstConfig = config;
        else if (!sameConfig(firstConfig, config)) {
          throw Object.assign(new Error('区間ごとの映像の形式が一致しないため、つなげられませんでした。'), { name: 'SegmentMismatch' });
        }
        const sink = new EncodedPacketSink(track);
        let first = seg === segments[0];
        for (let p = await sink.getFirstPacket(); p; p = await sink.getNextPacket(p)) {
          await videoSource.add(p.clone({ timestamp: p.timestamp + seg.outStart }), first ? { decoderConfig: config } : undefined);
          first = false;
        }
      } finally {
        input.dispose();
      }
      onProgress?.((seg.index + 1) / segments.length);
    }
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  }
}
