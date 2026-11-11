// 高速書き出し（試作）: 元の動画の映像データ（エンコード済みのコマ）をそのまま使い、カット位置の近くだけエンコードし直す。
//
// 今の書き出し（media.js）は、全部のコマをデコード → canvas に描く（切り抜き・字幕） → エンコードするので、
// 完成した動画の長さに比例して時間がかかる。カットだけ（切り抜き・字幕・ズームなし）なら、残す範囲 [a, b) のうち
//   - キーフレームからキーフレームまでの「まとまり」（GOP）は、元のコマをそのまま写す（デコードもエンコードもしない・画質も色も元のまま）
//   - 範囲の頭（a から次のキーフレームまで）と終わり（最後のキーフレームから b まで）だけ、デコードしてエンコードし直す
// 写したコマと、エンコードし直したコマはエンコーダーの設定（SPS・PPS）が違う。設定の切り替え方は2通り（paramMode）:
//   'inband'（標準）: キーフレームの前に、そのコマの設定を入れる（Chromium・ffmpeg で再生を確認）
//   'entries': MP4 の「サンプルの説明」を分ける（QuickTime の方式。ffmpeg は読めるが、Chromium の <video> はデコードのエラーになる）
// 音声は AAC のコマをそのまま写す（カットは話の間にあるので、つなぎ目の小さな乱れは聞こえにくい。映像とのずれは1コマ未満に保つ）。
//
// 制限（試作）: 元の動画の大きさ・向き・映像の形式がすべて同じであること（切り抜き・縮小はしない）。HDR（HLG・PQ）は未対応
// （エンコードし直す部分だけ色が変わるため）。動画全体をメモリで組み立てる（長い動画では、端末内のファイルに少しずつ書く必要がある）

import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink, EncodedPacket } from 'mediabunny';
import { writeMp4, paramSets, withParamSets } from './mp4write.js';
import { hdrKind } from './color.js';

const TS = 90000;
const GRID = 30; // 完成した動画のコマの速さ（media.js の FPS と同じ）
const bytes = d => (d instanceof Uint8Array ? d : d?.buffer ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) : new Uint8Array(d));

async function openSource(file) {
  const input = new Input({ source: new BlobSource(file, { maxCacheSize: 16 * 1024 * 1024 }), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  const vc = await video.getDecoderConfig();
  const ac = audio ? await audio.getDecoderConfig() : null;
  const vsink = new EncodedPacketSink(video);
  // 映像のコマの一覧（デコードの順・データなし）
  const meta = [];
  for (let p = await vsink.getFirstPacket({ metadataOnly: true }); p; p = await vsink.getNextPacket(p, { metadataOnly: true })) meta.push(p);
  // キーフレームの「前に表示されるコマ」（オープン GOP の RASL など。デコードの順ではキーフレームの後ろにある）の始まりの時刻。
  // 写す部分をキーフレーム kn で終えると、これらのコマは写せないので、終わりのエンコードし直しをこの時刻から始める
  const lead = new Map();
  meta.forEach((p, i) => {
    if (p.type !== 'key') return;
    let m = p.timestamp;
    for (let j = i + 1; j < meta.length && meta[j].type !== 'key'; j++) if (meta[j].timestamp < m) m = meta[j].timestamp;
    lead.set(p.timestamp, m);
  });
  return { input, video, audio, vc, ac, vsink, asink: audio ? new EncodedPacketSink(audio) : null, meta, keys: meta.filter(p => p.type === 'key').map(p => p.timestamp).sort((x, y) => x - y), lead, rotation: video.rotation || 0 };
}

// この端末のデコーダーが、この動画の最初のまとまりでコマを落とすか（並べ替えの深さの読み違い）を、最初の2つのまとまりで試す
async function probeDrops(s) {
  const end = s.keys[2] ?? Infinity;
  let n = 0, got = 0, err = null;
  const dec = new VideoDecoder({ output: f => { got++; f.close(); }, error: e => { err = e; } });
  dec.configure(s.vc);
  for (let p = await s.vsink.getFirstPacket(); p && !(p.type === 'key' && p.timestamp >= end - 1e-4); p = await s.vsink.getNextPacket(p)) {
    dec.decode(p.toEncodedVideoChunk());
    n++;
    if (dec.decodeQueueSize > 8) await new Promise(r => setTimeout(r, 1));
  }
  await dec.flush().catch(e => { err = e; });
  dec.close();
  return !!err || got < n;
}

const unsupported = msg => Object.assign(new Error(msg), { name: 'FastCutUnsupported' });

// 元の動画のコマの速さ（コマの一覧の時刻から）
function frameRate(meta) {
  const ts = meta.map(p => p.timestamp).sort((a, b) => a - b);
  const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
  const med = d.length ? d[Math.floor(d.length / 2)] : 1 / 30;
  return { fps: 1 / Math.max(1e-3, med), maxGap: d.length ? d[d.length - 1] : 0 };
}

// 高速書き出しで使える動画か（使えないときは理由の文を返す）。元の動画を開いたあとに確かめる
function sourceProblem(srcs) {
  const s0 = srcs[0];
  for (const s of srcs) {
    if (!/^(avc1|avc3|hvc1|hev1)/.test(s.vc.codec)) return `映像の形式（${s.vc.codec}）が H.264・HEVC ではありません`;
    if (s.vc.codedWidth !== s0.vc.codedWidth || s.vc.codedHeight !== s0.vc.codedHeight || s.rotation !== s0.rotation || s.vc.codec.slice(0, 3) !== s0.vc.codec.slice(0, 3)) return '動画の大きさ・向き・映像の形式がそろっていません';
    if (hdrKind(s.vc.colorSpace)) return 'HDR の動画です（エンコードし直す部分だけ色が変わるため）';
    if (!s.vc.description) return '映像の設定（avcC・hvcC）が見つかりません';
    const { fps, maxGap } = frameRate(s.meta);
    if (fps < 29 || fps > 31) return `コマの速さが毎秒${fps.toFixed(1)}コマです（毎秒30コマの動画だけ対応）`;
    if (maxGap > 0.1) return 'コマの間隔が大きく空いている所があります';
  }
  return null;
}

// 範囲ごとに、頭（エンコードし直し）・まとまり（写す）・終わり（エンコードし直し）に分けて、映像のコマを順に onSample に渡す。
// サンプル: { data, pts（完成した動画の秒）, key, entry（設定の番号）, reenc }。デコードの順に渡す
async function cutCore(files, ranges, { onSample, onProgress, bitrate, onOpen } = {}) {
  const srcs = [];
  for (const f of files) srcs.push(await openSource(f));
  const s0 = srcs[0];
  const why = sourceProblem(srcs);
  if (why) { for (const s of srcs) s.input.dispose?.(); throw unsupported(why); }
  const hevc = /^(hvc1|hev1)/.test(s0.vc.codec);
  // 元の動画ごとの設定（同じ設定の動画は1つにまとめる）＋ エンコードし直した部分の設定
  const entries = [];
  const entryOf = cfg => {
    const c = bytes(cfg.description);
    let i = entries.findIndex(e => e.config.length === c.length && e.config.every((x, k) => x === c[k]));
    if (i < 0) { entries.push({ kind: hevc ? 'hvc1' : 'avc1', width: s0.vc.codedWidth, height: s0.vc.codedHeight, config: c, colorSpace: s0.vc.colorSpace }); i = entries.length - 1; }
    return i;
  };
  for (const s of srcs) s.entry = entryOf(s.vc);

  // エンコードし直す部分のエンコーダー（元の動画と同じ形式・大きさ・ビットレートの目安）
  const { fps } = frameRate(s0.meta);
  const encCfg = { codec: s0.vc.codec.replace(/^hev1/, 'hvc1'), width: s0.vc.codedWidth, height: s0.vc.codedHeight, bitrate: bitrate || Math.round(Math.max(8e6, (files[0].size * 8) / Math.max(1, s0.meta.length / fps) * 1.2)), framerate: Math.round(fps), latencyMode: 'quality', ...(hevc ? { hevc: { format: 'hevc' } } : { avc: { format: 'avc' } }) };
  let support = await VideoEncoder.isConfigSupported(encCfg).catch(() => ({ supported: false }));
  if (!support.supported && !hevc) { encCfg.codec = 'avc1.640028'; support = await VideoEncoder.isConfigSupported(encCfg).catch(() => ({ supported: false })); }
  if (!support.supported) { for (const s of srcs) s.input.dispose?.(); throw unsupported(`この端末では ${encCfg.codec} でエンコードし直せません`); }
  let reEntry = -1;
  let pending = null;
  const encoded = []; // エンコードし直したコマ（出し切ってから順に渡す）
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && reEntry < 0) reEntry = entryOf(meta.decoderConfig);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      encoded.push({ data, pts: chunk.timestamp / 1e6, key: chunk.type === 'key', reenc: true });
    },
    error: e => { pending = e; },
  });
  encoder.configure(encCfg);
  const stats = { copiedFrames: 0, reencodedFrames: 0, decodedFrames: 0, filledFrames: 0, ranges: ranges.length, copyRuns: 0, reencodeRuns: 0, codec: s0.vc.codec, encoder: encCfg.codec };
  onOpen?.({ entries, hevc, s0, fps });
  let thumbCtx = null;
  try { thumbCtx = thumbCanvas().getContext('2d', { willReadFrequently: true }); } catch {}
  const joins = []; // つなぎ目（写す・エンコードし直すの始まり）: 完成した動画の時刻と、元の動画の時刻（あとで確かめる）

  // [x, y) をデコードして、完成した動画の時刻 outT から並べてエンコードし直す
  // ・デコーダーは、並べ替えの深さ（B フレーム）を最初のまとまりで読み違えて、コマを1枚落とすことがある（SPS に深さの情報がない動画。
  //   Chromium で確認）。そういう動画は、1つ前のキーフレームから「慣らし」でデコードし（そのコマは使わない）、それでも欠けたコマは前のコマで埋める
  // ・必要なコマ（元の動画の表示時刻が [x, y) のコマ）は、コマの一覧から決めておく
  const reencode = async (s, x, y, slot, source) => {
    const want = s.meta.map(p => p.timestamp).filter(t => t >= x - 1e-3 && t < y - 1e-3).sort((a, b) => a - b);
    if (!want.length) return;
    joins.push({ outT: slot(want[0]), source, srcT: want[0], kind: 'reencode' });
    const frames = [];
    const dec = new VideoDecoder({ output: f => frames.push(f), error: e => { pending = e; } });
    dec.configure(s.vc);
    const kx = [...s.keys].reverse().find(k => k <= x + 1e-3);
    if (s.dropsFrames == null) s.dropsFrames = await probeDrops(s);
    const warm = !s.dropsFrames || kx == null ? null : [...s.keys].reverse().find(k => k < kx - 1e-3);
    const key = await s.vsink.getKeyPacket(warm ?? kx ?? x, { verifyKeyPackets: true }) || await s.vsink.getFirstPacket();
    let first = true, wi = 0, prev = null;
    const join = joins[joins.length - 1];
    const emit = (frame, t) => {
      // つなぎ目の確かめ用: エンコードに渡した最初のコマ（元の動画のコマ）の縮小した明るさを覚えておく
      if (first && thumbCtx) { try { join.ref = lumaOf(frame, thumbCtx); } catch {} }
      const vf = new VideoFrame(frame, { timestamp: Math.round(slot(t) * 1e6) });
      encoder.encode(vf, { keyFrame: first });
      first = false;
      vf.close();
      stats.reencodedFrames++;
    };
    const flushFrames = async () => {
      while (frames.length) {
        const f = frames.shift();
        const ts = f.timestamp / 1e6;
        stats.decodedFrames++;
        if (wi < want.length && ts >= want[wi] - 1e-3 && ts < y - 1e-3) {
          // 欠けたコマ（ts より前の必要なコマ）は、前のコマ（なければこのコマ）で埋める
          while (wi < want.length && want[wi] < ts - 1e-3) { emit(prev || f, want[wi]); stats.filledFrames++; wi++; }
          if (wi < want.length && Math.abs(want[wi] - ts) <= 1e-3) { emit(f, want[wi]); wi++; }
          prev?.close();
          prev = f.clone();
        }
        f.close();
        if (encoder.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 1));
      }
    };
    try {
      for (let p = key; p && p.timestamp < y + 0.5; p = await s.vsink.getNextPacket(p)) {
        if (p !== key && p.timestamp < key.timestamp) continue; // キーフレームより前に表示されるコマ（前のまとまりを参照する）は送らない
        dec.decode(p.toEncodedVideoChunk());
        if (dec.decodeQueueSize > 8) await new Promise(r => setTimeout(r, 1));
        await flushFrames();
        if (pending) throw pending;
      }
      await dec.flush();
      await flushFrames();
    } finally {
      if (dec.state !== 'closed') dec.close();
      for (const f of frames) f.close();
    }
    // 最後まで出てこなかったコマも、前のコマで埋める（長さを変えないため）
    while (wi < want.length && prev) { emit(prev, want[wi]); stats.filledFrames++; wi++; }
    prev?.close();
    // エンコードし直したコマを、ここで出し切ってから渡す（このあと写すコマより前に並ぶように）
    await encoder.flush();
    if (pending) throw pending;
    while (encoded.length) { const x2 = encoded.shift(); x2.entry = reEntry; await onSample(x2); }
    stats.reencodeRuns++;
  };

  // [k1, tail) のまとまりを、元のコマのまま写す（デコードの順。キーフレームより前に表示されるコマは除く）
  const copy = async (s, k1, kn, tail, slot, source) => {
    joins.push({ outT: slot(k1), source, srcT: k1, kind: 'copy' });
    let p = await s.vsink.getKeyPacket(k1 + 1e-4, { verifyKeyPackets: true });
    for (; p; p = await s.vsink.getNextPacket(p)) {
      if (p.type === 'key' && p.timestamp >= kn - 1e-4) break;
      if (p.timestamp < k1 - 1e-4 || p.timestamp >= tail - 1e-4) continue; // k1 の前に表示されるコマ・終わりのエンコードし直しで作るコマは写さない
      await onSample({ data: bytes(p.data), pts: slot(p.timestamp), key: p.type === 'key', entry: s.entry, reenc: false });
      stats.copiedFrames++;
    }
    stats.copyRuns++;
  };

  // 完成した動画のコマの時刻は、毎秒30コマの格子にのせる（範囲の始まりがコマの途中でも、となりのコマと時刻が重ならないように。
  // MP4 に書くときも格子に丸められるため、自分で丸めないと2つのコマが同じ時刻になることがある）
  let outT = 0, outF = 0;
  const audioPlan = [];
  try {
    for (const [i, r] of ranges.entries()) {
      const s = srcs[r.source];
      if (!s) throw new Error(`範囲の動画（${r.source + 1}本目）が見つかりません`);
      const nF = Math.max(1, Math.round((r.end - r.start) * GRID));
      const base = outF;
      const slot = t => (base + Math.min(nF - 1, Math.max(0, Math.floor((t - r.start) * GRID + 1e-3)))) / GRID;
      const k1 = s.keys.find(k => k >= r.start - 1e-3);
      const kn = [...s.keys].reverse().find(k => k <= r.end + 1e-3);
      const tail = kn == null ? null : Math.min(kn, s.lead.get(kn) ?? kn); // 写す部分の表示の終わり（kn の前に表示されるコマの手前）
      if (k1 == null || kn == null || tail - k1 < 0.5) {
        await reencode(s, r.start, r.end, slot, r.source);
      } else {
        if (k1 - r.start > 1e-3) await reencode(s, r.start, k1, slot, r.source);
        await copy(s, k1, kn, tail, slot, r.source);
        if (r.end - tail > 1e-3) await reencode(s, tail, r.end, slot, r.source);
      }
      outF += nF;
      audioPlan.push({ s, start: r.start, end: r.end, outT });
      outT += r.end - r.start;
      onProgress?.((i + 1) / ranges.length);
    }
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  stats.outSec = +outT.toFixed(3);
  stats.entries = entries.length;
  stats.warmSources = srcs.filter(x => x.dropsFrames).length;
  return { srcs, s0, entries, hevc, fps, stats, outT, audioPlan, joins };
}

// ranges: [{ source, start, end }]（元の動画の時刻・秒。完成した動画での順）
// 返り値: { mp4: Uint8Array, stats }（音声は AAC をそのまま写す。試験用: tests/e2e/fastcut.mjs）
// paramMode: 'entries'（MP4 のサンプルの説明を分ける・QuickTime の方式） | 'inband'（説明は1つ。キーフレームの前にパラメーターセットを入れる）
export async function fastCut(files, ranges, { onProgress, bitrate, paramMode = 'inband' } = {}) {
  const t0 = performance.now();
  const out = [];
  const { srcs, s0, entries, hevc, fps, stats, outT, audioPlan } = await cutCore(files, ranges, { onSample: async x => { out.push(x); }, onProgress: r => onProgress?.(r * 0.9), bitrate });
  // 映像: out はデコードの順
  const vsamples = out;
  const ptsSorted = vsamples.map(x => x.pts).sort((a, b) => a - b);
  const raw = vsamples.map((x, i) => Math.round((x.pts - ptsSorted[i]) * TS));
  const D = Math.max(0, -Math.min(0, ...raw));
  const fd = 1 / fps;
  let vEntries = entries;
  if (paramMode === 'inband') {
    const pss = entries.map(e => paramSets(e.config, hevc));
    const L = pss[0].lenSize;
    for (const x of vsamples) {
      if (pss[x.entry].lenSize !== L) throw unsupported('NAL の長さの欄がそろっていません');
      if (x.key) x.data = withParamSets(x.data, pss[x.entry], L);
      x.entry = 0;
    }
    vEntries = [entries[0]];
  }
  const video = {
    timescale: TS, width: s0.vc.codedWidth, height: s0.vc.codedHeight, rotation: s0.rotation, mediaStart: D, entries: vEntries,
    samples: vsamples.map((x, i) => ({ data: x.data, dur: Math.max(1, Math.round((ptsSorted[i + 1] ?? ptsSorted[i] + fd) * TS) - Math.round(ptsSorted[i] * TS)), cto: raw[i] + D, key: x.key, entry: x.entry })),
  };
  // 音声: AAC のコマをそのまま写す。範囲ごとに、映像との合計の長さのずれが半コマ（約11ミリ秒）を超えないようにコマを選ぶ
  let audio = null;
  if (s0.ac) {
    const sr = s0.ac.sampleRate, asamples = [];
    let aOut = 0;
    for (const r of audioPlan) {
      if (!r.s.asink) continue;
      const want0 = r.start + (aOut - r.outT);
      const targetEnd = r.outT + (r.end - r.start);
      let p = await r.s.asink.getPacket(Math.max(0, want0));
      while (p && aOut + p.duration / 2 <= targetEnd) {
        asamples.push({ data: bytes(p.data), dur: Math.round(p.duration * sr) });
        aOut += p.duration;
        p = await r.s.asink.getNextPacket(p);
      }
    }
    audio = { timescale: sr, entries: [{ channels: s0.ac.numberOfChannels, sampleRate: sr, asc: bytes(s0.ac.description) }], samples: asamples };
  }
  const mp4 = writeMp4({ video, audio });
  onProgress?.(1);
  stats.sec = +((performance.now() - t0) / 1000).toFixed(2);
  stats.bytes = mp4.length;
  for (const s of srcs) s.input.dispose?.();
  return { mp4, stats };
}

// アプリの書き出し用: 映像のコマ（mediabunny の EncodedPacket）を、デコードの順に onPacket(packet, meta) へ渡す。
// 設定（SPS・PPS）はキーフレームの前に入れる（MP4 の説明は1つ）。音声は渡さない（media.js の assembleOutput が今までどおり作る）。
// 返り値: { stats, joins, codec: 'avc' | 'hevc' }
export async function fastCutVideo(files, ranges, { onPacket, onProgress, bitrate } = {}) {
  const t0 = performance.now();
  let first = true, ctx = null;
  const pss = [];
  const res = await cutCore(files, ranges, {
    bitrate, onProgress,
    onSample: async x => {
      const { entries, hevc, s0 } = ctx;
      while (pss.length < entries.length) pss.push(paramSets(entries[pss.length].config, hevc));
      const L = pss[0].lenSize;
      if (pss[x.entry].lenSize !== L) throw unsupported('NAL の長さの欄がそろっていません');
      // （動作確認用: __amityFastTest = 'noparams' で設定を入れない＝壊れた動画を作り、確かめで見つかるかを試す）
      const data = x.key && globalThis.__amityFastTest !== 'noparams' ? withParamSets(x.data, pss[x.entry], L) : x.data;
      const meta = first ? { decoderConfig: { codec: s0.vc.codec, codedWidth: s0.vc.codedWidth, codedHeight: s0.vc.codedHeight, description: entries[0].config, colorSpace: s0.vc.colorSpace } } : undefined;
      if (first && !x.key) throw new Error('最初のコマがキーフレームではありません');
      first = false;
      await onPacket(new EncodedPacket(data, x.key ? 'key' : 'delta', x.pts, 1 / GRID), meta);
    },
    onOpen: c => { ctx = c; },
  });
  for (const s of res.srcs) s.input.dispose?.();
  res.stats.sec = +((performance.now() - t0) / 1000).toFixed(2);
  return { stats: res.stats, joins: res.joins, codec: res.hevc ? 'hevc' : 'avc' };
}

// ---------- 書き出したあとの確かめ ----------
// つなぎ目（写す部分・エンコードし直した部分の始まり）のコマを、完成した MP4 から、この端末のデコーダーで読み、
// 元の動画の同じコマと比べる（縮小した明るさの PSNR）。設定の切り替えをデコーダーが読めないと、コマが崩れて値が下がる。
// 返り値: { ok, checked, minPsnr, worst, reason }
const TW = 32, TH = 56;
function thumbCanvas() {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(TW, TH);
  const c = document.createElement('canvas'); c.width = TW; c.height = TH; return c;
}
function lumaOf(frame, ctx) {
  ctx.drawImage(frame, 0, 0, TW, TH);
  const d = ctx.getImageData(0, 0, TW, TH).data, y = new Float32Array(TW * TH);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) y[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return y;
}
const psnr = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m += (a[i] - b[i]) ** 2; m /= a.length; return m < 1e-6 ? 99 : 10 * Math.log10(255 * 255 / m); };

// キーフレーム1枚だけをデコードする（前後のコマを使わないので、デコーダーがコマの時刻を取り違えても関係しない）
async function keyFrameAt(sink, config, t, ctx) {
  // 時刻は半コマまでの違いを許す（MP4 に書くとき、最初のコマの時刻が0にそろえられることがある）
  const key = await sink.getKeyPacket(t + 0.017, { verifyKeyPackets: true });
  if (!key) throw new Error('キーフレームが見つかりません');
  if (Math.abs(key.timestamp - t) > 0.017) throw new Error(`${t.toFixed(2)}秒にキーフレームがありません（${key.timestamp.toFixed(2)}秒）`);
  let frame = null, err = null;
  const dec = new VideoDecoder({ output: f => { if (frame) f.close(); else frame = f; }, error: e => { err = e; } });
  dec.configure(config);
  try {
    dec.decode(key.toEncodedVideoChunk());
    await dec.flush().catch(e => { err = e; });
  } finally { if (dec.state !== 'closed') dec.close(); }
  if (err) { frame?.close(); throw err; }
  if (!frame) throw new Error('コマをデコードできませんでした');
  const y = lumaOf(frame, ctx);
  frame.close();
  return y;
}

export async function verifyJoins(outFile, files, joins, { max = 40, minPsnr = 25 } = {}) {
  const pick = joins.length <= max ? joins : Array.from({ length: max }, (_, i) => joins[Math.round(i * (joins.length - 1) / (max - 1))]);
  const outIn = new Input({ source: new BlobSource(outFile, { maxCacheSize: 8 * 1024 * 1024 }), formats: ALL_FORMATS });
  const srcIn = files.map(f => new Input({ source: new BlobSource(f, { maxCacheSize: 8 * 1024 * 1024 }), formats: ALL_FORMATS }));
  const canvas = thumbCanvas(), ctx = canvas.getContext('2d', { willReadFrequently: true });
  let minV = 99, worst = null, checked = 0;
  try {
    const ot = await outIn.getPrimaryVideoTrack();
    const ocfg = await ot.getDecoderConfig();
    const osink = new EncodedPacketSink(ot);
    const sv = [];
    for (const inp of srcIn) { const t = await inp.getPrimaryVideoTrack(); sv.push({ sink: new EncodedPacketSink(t), cfg: await t.getDecoderConfig() }); }
    for (const j of pick) {
      // 完成した動画のつなぎ目のコマは、どちらもキーフレーム（写した部分の始まり＝元のキーフレーム、エンコードし直した部分の始まり＝新しいキーフレーム）
      let a, b;
      try {
        a = await keyFrameAt(osink, ocfg, j.outT, ctx);
      } catch (e) {
        return { ok: false, checked, minPsnr: minV, worst: j, reason: `完成した動画の ${j.outT.toFixed(2)}秒のコマを読めません（${e?.message || e}）` };
      }
      // 比べる相手: 写した部分は元の動画の同じキーフレーム、エンコードし直した部分はエンコーダーに渡したコマ
      if (j.kind === 'copy') b = await keyFrameAt(sv[j.source].sink, sv[j.source].cfg, j.srcT, ctx);
      else if (j.ref) b = j.ref;
      else continue;
      const v = psnr(a, b);
      checked++;
      if (v < minV) { minV = v; worst = { ...j, psnr: +v.toFixed(1) }; }
    }
  } finally {
    outIn.dispose?.();
    for (const i of srcIn) i.dispose?.();
  }
  const ok = minV >= minPsnr;
  return { ok, checked, minPsnr: +minV.toFixed(1), worst, reason: ok ? null : `つなぎ目のコマが元の動画と一致しません（${worst.outT.toFixed(2)}秒・${worst.psnr}dB）` };
}
