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

import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink } from 'mediabunny';
import { writeMp4, paramSets, withParamSets } from './mp4write.js';
import { hdrKind } from './color.js';

const TS = 90000;
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
  return { input, video, audio, vc, ac, vsink, asink: audio ? new EncodedPacketSink(audio) : null, meta, keys: meta.filter(p => p.type === 'key').map(p => p.timestamp).sort((x, y) => x - y), rotation: video.rotation || 0 };
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

// ranges: [{ source, start, end }]（元の動画の時刻・秒。完成した動画での順）
// 返り値: { mp4: Uint8Array, stats }
// paramMode: 'entries'（MP4 のサンプルの説明を分ける・QuickTime の方式） | 'inband'（説明は1つ。キーフレームの前にパラメーターセットを入れる）
export async function fastCut(files, ranges, { onProgress, bitrate, paramMode = 'inband' } = {}) {
  const t0 = performance.now();
  const srcs = [];
  for (const f of files) srcs.push(await openSource(f));
  const s0 = srcs[0];
  for (const s of srcs) {
    if (s.vc.codedWidth !== s0.vc.codedWidth || s.vc.codedHeight !== s0.vc.codedHeight || s.rotation !== s0.rotation || s.vc.codec.slice(0, 4) !== s0.vc.codec.slice(0, 4)) {
      throw Object.assign(new Error('動画の大きさ・向き・形式がそろっていないため、高速書き出しは使えません'), { name: 'FastCutUnsupported' });
    }
    if (hdrKind(s.vc.colorSpace)) throw Object.assign(new Error('HDR の動画は、高速書き出しに未対応です（エンコードし直す部分だけ色が変わるため）'), { name: 'FastCutUnsupported' });
  }
  const hevc = /^(hvc1|hev1)/.test(s0.vc.codec);
  // 元の動画ごとの「サンプルの説明」（同じ設定の動画は1つにまとめる）＋ エンコードし直した部分の説明
  const entries = [];
  const entryOf = cfg => {
    const c = bytes(cfg.description);
    let i = entries.findIndex(e => e.config.length === c.length && e.config.every((x, k) => x === c[k]));
    if (i < 0) { entries.push({ kind: hevc ? 'hvc1' : 'avc1', width: s0.vc.codedWidth, height: s0.vc.codedHeight, config: c, colorSpace: s0.vc.colorSpace }); i = entries.length - 1; }
    return i;
  };
  for (const s of srcs) s.entry = entryOf(s.vc);

  // エンコードし直す部分のエンコーダー（元の動画と同じ形式・大きさ。色の情報は元の動画のものを書く）
  const fps = s0.meta.length / Math.max(0.1, (s0.meta[s0.meta.length - 1].timestamp - s0.meta[0].timestamp) || 1) || 30;
  const encCfg = { codec: s0.vc.codec.replace(/^hev1/, 'hvc1'), width: s0.vc.codedWidth, height: s0.vc.codedHeight, bitrate: bitrate || Math.round(Math.max(8e6, (files[0].size * 8) / Math.max(1, s0.meta.length / fps) * 1.2)), framerate: Math.round(fps), latencyMode: 'quality', ...(hevc ? { hevc: { format: 'hevc' } } : { avc: { format: 'avc' } }) };
  let support = await VideoEncoder.isConfigSupported(encCfg).catch(() => ({ supported: false }));
  if (!support.supported && !hevc) { encCfg.codec = 'avc1.640028'; support = await VideoEncoder.isConfigSupported(encCfg).catch(() => ({ supported: false })); }
  if (!support.supported) throw Object.assign(new Error(`この端末では、${encCfg.codec} でエンコードし直せません`), { name: 'FastCutUnsupported' });
  let reEntry = -1;
  const out = []; // { data, pts（完成した動画の秒）, key, entry, order }
  let pending = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && reEntry < 0) reEntry = entryOf(meta.decoderConfig);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      out.push({ data, pts: chunk.timestamp / 1e6, key: chunk.type === 'key', entry: () => reEntry, reenc: true });
    },
    error: e => { pending = e; },
  });
  encoder.configure(encCfg);
  const stats = { copiedFrames: 0, reencodedFrames: 0, decodedFrames: 0, ranges: ranges.length, copyRuns: 0, reencodeRuns: 0 };

  // [x, y) をデコードして、完成した動画の時刻 outT から並べてエンコードし直す
  // ・デコーダーは、並べ替えの深さ（B フレーム）を最初のまとまりで読み違えて、コマを1枚落とすことがある（SPS に深さの情報がない動画。
  //   Chromium で確認）。1つ前のキーフレームから「慣らし」でデコードし（そのコマは使わない）、それでも欠けたコマは前のコマで埋める
  // ・必要なコマ（元の動画の表示時刻が [x, y) のコマ）は、コマの一覧から決めておく
  const reencode = async (s, x, y, outT) => {
    const want = s.meta.map(p => p.timestamp).filter(t => t >= x - 1e-3 && t < y - 1e-3).sort((a, b) => a - b);
    if (!want.length) return;
    const frames = [];
    const dec = new VideoDecoder({ output: f => frames.push(f), error: e => { pending = e; } });
    dec.configure(s.vc);
    const kx = [...s.keys].reverse().find(k => k <= x + 1e-3);
    if (s.dropsFrames == null) s.dropsFrames = await probeDrops(s);
    const warm = !s.dropsFrames || kx == null ? null : [...s.keys].reverse().find(k => k < kx - 1e-3);
    const key = await s.vsink.getKeyPacket(warm ?? kx ?? x, { verifyKeyPackets: true }) || await s.vsink.getFirstPacket();
    let first = true, wi = 0, prev = null;
    const emit = (frame, t) => {
      const vf = new VideoFrame(frame, { timestamp: Math.round((outT + t - x) * 1e6) });
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
          while (wi < want.length && want[wi] < ts - 1e-3) { emit(prev || f, want[wi]); stats.filledFrames = (stats.filledFrames || 0) + 1; wi++; }
          if (wi < want.length && Math.abs(want[wi] - ts) <= 1e-3) { emit(f, want[wi]); wi++; }
          prev?.close();
          prev = f.clone();
        }
        f.close();
        if (encoder.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 1));
      }
    };
    for (let p = key; p && p.timestamp < y + 0.5; p = await s.vsink.getNextPacket(p)) {
      if (p !== key && p.timestamp < key.timestamp) continue; // キーフレームより前に表示されるコマ（前のまとまりを参照する）は送らない
      dec.decode(p.toEncodedVideoChunk());
      if (dec.decodeQueueSize > 8) await new Promise(r => setTimeout(r, 1));
      await flushFrames();
      if (pending) throw pending;
    }
    await dec.flush();
    await flushFrames();
    dec.close();
    // 最後まで出てこなかったコマも、前のコマで埋める（長さを変えないため）
    while (wi < want.length && prev) { emit(prev, want[wi]); stats.filledFrames = (stats.filledFrames || 0) + 1; wi++; }
    prev?.close();
    // エンコードし直したコマを、ここで出し切る（このあと写すコマより前に並ぶように）
    await encoder.flush();
    if (pending) throw pending;
    stats.reencodeRuns++;
  };

  // [k1, kn) のまとまりを、元のコマのまま写す（デコードの順。キーフレームより前に表示されるコマは除く）
  const copy = async (s, k1, kn, outT) => {
    let p = await s.vsink.getKeyPacket(k1 + 1e-4, { verifyKeyPackets: true });
    for (; p; p = await s.vsink.getNextPacket(p)) {
      if (p.type === 'key' && p.timestamp >= kn - 1e-4) break;
      if (p.timestamp < k1 - 1e-4) continue;
      out.push({ data: bytes(p.data), pts: outT + p.timestamp - k1, key: p.type === 'key', entry: s.entry, reenc: false });
      stats.copiedFrames++;
    }
    stats.copyRuns++;
  };

  // 範囲ごとに、頭（エンコードし直し）・まとまり（写す）・終わり（エンコードし直し）に分ける
  let outT = 0;
  const audioPlan = [];
  for (const [i, r] of ranges.entries()) {
    const s = srcs[r.source];
    const k1 = s.keys.find(k => k >= r.start - 1e-3);
    const kn = [...s.keys].reverse().find(k => k <= r.end + 1e-3);
    const len = r.end - r.start;
    if (k1 == null || kn == null || kn - k1 < 0.5) {
      await reencode(s, r.start, r.end, outT);
    } else {
      if (k1 - r.start > 1e-3) await reencode(s, r.start, k1, outT);
      await copy(s, k1, kn, outT + k1 - r.start);
      if (r.end - kn > 1e-3) await reencode(s, kn, r.end, outT + kn - r.start);
    }
    audioPlan.push({ s, start: r.start, end: r.end, outT });
    outT += len;
    onProgress?.((i + 1) / ranges.length * 0.9);
  }
  encoder.close();

  // 映像: out はデコードの順（範囲の順・写した部分は元の順・エンコードし直した部分は出てきた順）
  const vsamples = out;
  const ptsSorted = vsamples.map(x => x.pts).sort((a, b) => a - b);
  const raw = vsamples.map((x, i) => Math.round((x.pts - ptsSorted[i]) * TS));
  const D = Math.max(0, -Math.min(0, ...raw));
  const fd = 1 / fps;
  let vEntries = entries;
  if (paramMode === 'inband') {
    // 長さの欄のバイト数は、最初の説明（元の動画）のものにそろえる
    const pss = entries.map(e => paramSets(e.config, hevc));
    const L = pss[0].lenSize;
    for (const x of vsamples) {
      const ei = typeof x.entry === 'function' ? x.entry() : x.entry;
      if (pss[ei].lenSize !== L) throw Object.assign(new Error('NAL の長さの欄がそろっていません'), { name: 'FastCutUnsupported' });
      if (x.key) x.data = withParamSets(x.data, pss[ei], L);
      x.entry = 0;
    }
    vEntries = [entries[0]];
  }
  const video = {
    timescale: TS, width: s0.vc.codedWidth, height: s0.vc.codedHeight, rotation: s0.rotation, mediaStart: D, entries: vEntries,
    samples: vsamples.map((x, i) => ({ data: x.data, dur: Math.max(1, Math.round((ptsSorted[i + 1] ?? ptsSorted[i] + fd) * TS) - Math.round(ptsSorted[i] * TS)), cto: raw[i] + D, key: x.key, entry: typeof x.entry === 'function' ? x.entry() : x.entry })),
  };

  // 音声: AAC のコマをそのまま写す。範囲ごとに、映像との合計の長さのずれが半コマ（約11ミリ秒）を超えないようにコマを選ぶ
  let audio = null;
  if (s0.ac) {
    const sr = s0.ac.sampleRate, asamples = [];
    let aOut = 0;
    for (const r of audioPlan) {
      if (!r.s.asink) continue;
      // 映像に対する遅れ・進み（前の範囲までの合計のずれ）を、ここで取り戻す
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
  stats.outSec = +outT.toFixed(3);
  stats.entries = entries.length;
  stats.warmSources = srcs.filter(x => x.dropsFrames).length;
  for (const s of srcs) s.input.dispose?.();
  return { mp4, stats };
}
