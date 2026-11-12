// 高速書き出し（試作）用の、最小限の MP4 の書き手（映像1本・音声1本。動画全体をメモリで組み立てる）。
//
// 1本の映像トラックに、複数の「サンプルの説明」（stsd の avc1/hvc1。SPS/PPS などのデコーダーの設定）を持てるようにしてある。
// 元の動画からそのまま写した部分（元のエンコーダーの設定）と、カット位置の近くだけエンコードし直した部分（このiPhoneの
// エンコーダーの設定）は、設定が違うため、同じ説明では1本につなげない。チャンク（stsc）ごとに、どの説明を使うかを指定する。
// 音声は AAC（mp4a）。時刻は、映像 90000・音声 標本化周波数 の単位

const enc = new TextEncoder();
const u8 = (...xs) => Uint8Array.from(xs);
const u16 = v => u8((v >> 8) & 255, v & 255);
const u32 = v => u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const i32 = v => u32(v >>> 0);
const u64 = v => { const hi = Math.floor(v / 2 ** 32), lo = v >>> 0; return u8(...u32(hi), ...u32(lo)); };
const str = s => enc.encode(s);
function cat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const box = (type, ...parts) => { const body = cat(parts); return cat([u32(8 + body.length), str(type), body]); };
const full = (type, version, flags, ...parts) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);

// 色の情報（WebCodecs の VideoColorSpace の名前 → MP4 の colr nclx の番号）
const PRIM = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 };
const TRC = { bt709: 1, smpte170m: 6, 'iec61966-2-1': 13, linear: 8, pq: 16, hlg: 18 };
const MAT = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 };
function colr(cs) {
  if (!cs || !cs.primaries) return new Uint8Array(0);
  return box('colr', str('nclx'), u16(PRIM[cs.primaries] ?? 2), u16(TRC[cs.transfer] ?? 2), u16(MAT[cs.matrix] ?? 2), u8(cs.fullRange ? 0x80 : 0));
}

function videoEntry(e) {
  const name = new Uint8Array(32);
  const cfgType = /^(hvc1|hev1)$/.test(e.kind) ? 'hvcC' : 'avcC';
  return box(e.kind, new Uint8Array(6), u16(1), u16(0), u16(0), new Uint8Array(12), u16(e.width), u16(e.height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), name, u16(0x0018), u16(0xffff),
    box(cfgType, e.config), colr(e.colorSpace));
}

// AAC の ESDS（AudioSpecificConfig asc を入れる）
function esds(asc, bitrate = 160000) {
  const desc = (tag, body) => cat([u8(tag, 0x80, 0x80, 0x80, body.length), body]);
  const dsi = desc(5, asc);
  const dcd = desc(4, cat([u8(0x40, 0x15, 0, 0, 0), u32(bitrate), u32(bitrate), dsi]));
  const es = desc(3, cat([u16(1), u8(0), dcd, desc(6, u8(2))]));
  return full('esds', 0, 0, es);
}
function audioEntry(a) {
  return box('mp4a', new Uint8Array(6), u16(1), new Uint8Array(8), u16(a.channels), u16(16), u16(0), u16(0), u32(a.sampleRate * 65536 >>> 0), esds(a.asc));
}

// 回転（時計回りの度）→ tkhd の行列
function matrix(rotation, w, h) {
  const F = 0x10000, W = 0x40000000;
  const m = rotation === 90 ? [0, F, 0, -F, 0, 0, h * F, 0, W]
    : rotation === 180 ? [-F, 0, 0, 0, -F, 0, w * F, h * F, W]
      : rotation === 270 ? [0, -F, 0, F, 0, 0, 0, w * F, W]
        : [F, 0, 0, 0, F, 0, 0, 0, W];
  return cat(m.map(i32));
}

// 同じ値が続く所をまとめる（stts・ctts）
function runs(values) {
  const out = [];
  for (const v of values) { const r = out[out.length - 1]; if (r && r[1] === v) r[0]++; else out.push([1, v]); }
  return out;
}

// track: { kind: 'video'|'audio', timescale, samples: [{ data, dur, cto?, key?, entry? }], entries, ... }
// chunks: [{ track, first, count, entry }]（サンプルの番号の範囲。書く順）
function stbl(track, chunkList, offsets, co64) {
  const s = track.samples;
  const parts = [full('stsd', 0, 0, u32(track.entries.length), ...track.entries.map(e => (track.kind === 'video' ? videoEntry(e) : audioEntry(e))))];
  const stts = runs(s.map(x => x.dur));
  parts.push(full('stts', 0, 0, u32(stts.length), ...stts.flatMap(([n, d]) => [u32(n), u32(d)])));
  if (track.kind === 'video' && s.some(x => x.cto)) {
    const ct = runs(s.map(x => x.cto || 0));
    parts.push(full('ctts', 0, 0, u32(ct.length), ...ct.flatMap(([n, o]) => [u32(n), u32(o)])));
  }
  if (track.kind === 'video' && !s.every(x => x.key)) {
    const keys = s.map((x, i) => (x.key ? i + 1 : 0)).filter(Boolean);
    parts.push(full('stss', 0, 0, u32(keys.length), ...keys.map(u32)));
  }
  // stsc: チャンクごとのサンプル数と説明の番号（同じ組み合わせが続く所はまとめる）
  const sc = [];
  chunkList.forEach((c, i) => { const last = sc[sc.length - 1]; if (!last || last[1] !== c.count || last[2] !== c.entry + 1) sc.push([i + 1, c.count, c.entry + 1]); });
  parts.push(full('stsc', 0, 0, u32(sc.length), ...sc.flatMap(r => r.map(u32))));
  parts.push(full('stsz', 0, 0, u32(0), u32(s.length), ...s.map(x => u32(x.data.length))));
  parts.push(co64 ? full('co64', 0, 0, u32(offsets.length), ...offsets.map(u64)) : full('stco', 0, 0, u32(offsets.length), ...offsets.map(u32)));
  return box('stbl', ...parts);
}

function trak(track, id, movieDur, chunkList, offsets, co64) {
  const isV = track.kind === 'video';
  const mediaDur = track.samples.reduce((a, x) => a + x.dur, 0);
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(movieDur), new Uint8Array(8), u16(0), u16(0), u16(isV ? 0 : 0x0100), u16(0),
    matrix(isV ? track.rotation || 0 : 0, track.width || 0, track.height || 0), u32((isV ? track.width : 0) * 65536 >>> 0), u32((isV ? track.height : 0) * 65536 >>> 0));
  // 映像の表示の遅れ（B フレームの並べ替え）の分だけ、表示の始まりをずらす（編集リスト）
  const edts = isV && track.mediaStart ? box('edts', full('elst', 0, 0, u32(1), u32(movieDur), u32(track.mediaStart), u32(0x00010000))) : new Uint8Array(0);
  const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(track.timescale), u32(mediaDur), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', 0, 0, u32(0), str(isV ? 'vide' : 'soun'), new Uint8Array(12), str(isV ? 'VideoHandler\0' : 'SoundHandler\0'));
  const mh = isV ? full('vmhd', 0, 1, new Uint8Array(8)) : full('smhd', 0, 0, new Uint8Array(4));
  const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
  return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, box('minf', mh, dinf, stbl(track, chunkList, offsets, co64))));
}

// video: { timescale, width, height, rotation, entries: [{ kind, width, height, config, colorSpace }], samples, mediaStart }
// audio: { timescale, entries: [{ channels, sampleRate, asc }], samples }（なくてもよい）
// 返り値: MP4 のバイト列（Uint8Array）
export function writeMp4({ video, audio = null }) {
  const tracks = [{ ...video, kind: 'video' }, ...(audio ? [{ ...audio, kind: 'audio' }] : [])];
  // チャンク: 映像は説明が変わる所と約0.5秒ごと、音声は約0.5秒ごとに区切り、時刻の順に並べる（再生しやすいよう交互に置く）
  const chunks = [];
  for (const [ti, t] of tracks.entries()) {
    let first = 0, start = 0, time = 0;
    t.samples.forEach((x, i) => {
      const entry = x.entry || 0;
      const prevEntry = i ? t.samples[i - 1].entry || 0 : entry;
      if (i > first && (entry !== prevEntry || time - start >= t.timescale / 2)) { chunks.push({ ti, first, count: i - first, entry: prevEntry, at: start / t.timescale }); first = i; start = time; }
      time += x.dur;
    });
    if (t.samples.length > first) chunks.push({ ti, first, count: t.samples.length - first, entry: t.samples[t.samples.length - 1].entry || 0, at: start / t.timescale });
  }
  chunks.sort((a, b) => a.at - b.at || a.ti - b.ti);
  const total = chunks.reduce((s, c) => s + tracks[c.ti].samples.slice(c.first, c.first + c.count).reduce((n, x) => n + x.data.length, 0), 0);
  const co64 = total > 0xf0000000;
  const movieDur = Math.round(Math.max(...tracks.map(t => t.samples.reduce((a, x) => a + x.dur, 0) / t.timescale)) * 1000);
  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
  const build = offsetsOf => {
    const traks = tracks.map((t, ti) => {
      const list = chunks.filter(c => c.ti === ti);
      return trak(t, ti + 1, movieDur, list, offsetsOf(ti, list), co64);
    });
    const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movieDur), u32(0x00010000), u16(0x0100), new Uint8Array(10), matrix(0, 0, 0), new Uint8Array(24), u32(tracks.length + 1));
    return box('moov', mvhd, ...traks);
  };
  // 1回目: 大きさを測る（位置は仮）。2回目: 本当の位置を入れる
  const moovSize = build((ti, list) => list.map(() => 0)).length;
  const dataStart = ftyp.length + moovSize + (co64 ? 16 : 8);
  const pos = new Map();
  let o = dataStart;
  for (const c of chunks) { pos.set(c, o); o += tracks[c.ti].samples.slice(c.first, c.first + c.count).reduce((n, x) => n + x.data.length, 0); }
  const moov = build((ti, list) => list.map(c => pos.get(c)));
  const mdatHead = co64 ? cat([u32(1), str('mdat'), u64(16 + total)]) : cat([u32(8 + total), str('mdat')]);
  const out = new Uint8Array(ftyp.length + moov.length + mdatHead.length + total);
  out.set(ftyp, 0); out.set(moov, ftyp.length); out.set(mdatHead, ftyp.length + moov.length);
  let w = ftyp.length + moov.length + mdatHead.length;
  for (const c of chunks) for (const x of tracks[c.ti].samples.slice(c.first, c.first + c.count)) { out.set(x.data, w); w += x.data.length; }
  return out;
}

// avcC・hvcC から、パラメーターセット（SPS・PPS・VPS）の NAL と、長さの欄のバイト数を取り出す
export function paramSets(cfg, hevc) {
  const nals = [];
  let o, lenSize;
  const take = () => { const n = (cfg[o] << 8) | cfg[o + 1]; nals.push(cfg.subarray(o + 2, o + 2 + n)); o += 2 + n; };
  if (hevc) {
    lenSize = (cfg[21] & 3) + 1; o = 23;
    for (let a = 0, na = cfg[22]; a < na; a++) { const cnt = (cfg[o + 1] << 8) | cfg[o + 2]; o += 3; for (let i = 0; i < cnt; i++) take(); }
  } else {
    lenSize = (cfg[4] & 3) + 1; o = 6;
    for (let i = 0, n = cfg[5] & 31; i < n; i++) take();
    for (let i = 0, n = cfg[o++]; i < n; i++) take();
  }
  return { nals, lenSize };
}
// キーフレームの前に、パラメーターセットを入れる（映像データの中で設定を切り替える方式。長さの欄は lenSize バイト）
export function withParamSets(data, ps, lenSize) {
  const parts = ps.nals.map(n => { const h = new Uint8Array(lenSize + n.length); for (let i = 0; i < lenSize; i++) h[i] = (n.length >>> (8 * (lenSize - 1 - i))) & 255; h.set(n, lenSize); return h; });
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0) + data.length);
  let w = 0; for (const p of parts) { out.set(p, w); w += p.length; } out.set(data, w);
  return out;
}
