// 途中から再開するための計算（ブラウザAPIを使わないので Node でテストできる）
import { FPS } from './plan.js';

export const SEGMENT_SEC = 8; // 書き出しの1区間の長さの目安（秒）

// タイムラインを、書き出しの区間に分ける。区間は { index, outStart, frames, slices: [{ c, p, f0, f1 }] }。
// c: 場面の番号、p: その場面のピースの番号、f0〜f1: そのピースの中のコマの範囲。
// ピースはなるべく途中で分けない（1区間に収まらない長いピースだけ、コマの位置で分ける）
export function planSegments(timeline, segSec = SEGMENT_SEC) {
  const cap = Math.max(1, Math.round(segSec * FPS));
  const segs = [];
  let cur = null, frames = 0;
  const open = () => { cur = { index: segs.length, outStart: frames / FPS, frames: 0, slices: [] }; segs.push(cur); };
  timeline.forEach((clip, c) => clip.pieces.forEach((piece, p) => {
    let f0 = 0;
    while (f0 < piece.frames) {
      const rest = piece.frames - f0;
      if (!cur || cur.frames >= cap || (cur.frames > 0 && rest > cap - cur.frames && rest <= cap)) open();
      const take = Math.min(rest, cap - cur.frames);
      cur.slices.push({ c, p, f0, f1: f0 + take });
      cur.frames += take;
      frames += take;
      f0 += take;
    }
  }));
  return segs;
}

export const MB = 1024 * 1024;

// 書き出しに必要な保存容量の見積もり（バイト）。
// 区間のファイル（完成した動画とほぼ同じ大きさ）と、完成したMP4の両方が一時的に必要
export function renderBytes(outSec, videoBitrate = 10_000_000, audioBitrate = 160_000) {
  const out = outSec * (videoBitrate + audioBitrate) / 8 * 1.05;
  return { segments: out, output: out, total: out * 2 + 30 * MB };
}

// 保存できそうか（ブラウザの見積もりの残り容量と比べる）。見積もりが取れないときは「不明」として進める
export function spaceCheck(info, needBytes) {
  if (info?.quota == null || info?.usage == null) return { ok: true, known: false, free: null, need: needBytes };
  const free = Math.max(0, info.quota - info.usage);
  return { ok: free >= needBytes, known: true, free, need: needBytes };
}

export function formatBytes(n) {
  if (n == null) return '不明';
  if (n >= 1024 * MB) return (n / 1024 / MB).toFixed(1) + 'GB';
  return Math.max(1, Math.round(n / MB)) + 'MB';
}

// 保存してある作業の状態を、画面に出す言葉にする
export const STAGES = {
  analyze: '解析',
  review: '構成の確認',
  render: 'MP4の書き出し',
  assemble: '仕上げ（区間をつなぐ）',
  done: '完成',
};

export function describeJob(job) {
  const lines = [];
  const a = job.analysis || {};
  const mark = ok => (ok ? '✓' : '・');
  if (job.stage === 'analyze' || job.stage === 'review' || job.stage === 'render' || job.stage === 'assemble' || job.stage === 'done') {
    lines.push(`${mark(a.audio)} 音声の解析${a.audio ? '（保存済み）' : ''}`);
    if (job.useAsr) {
      const total = a.asr?.windows?.length || 0;
      const got = a.asr ? Object.keys(a.asr.results || {}).length : 0;
      lines.push(`${mark(a.asr?.done)} 文字起こし${a.asr?.done ? '（保存済み）' : a.asr?.failed ? '（できなかったため字幕なし）' : total ? `（${got}/${total}区間 保存済み）` : ''}`);
    }
    const mt = a.motion?.done ? '（保存済み）' : a.motion?.partial ? `（${Math.round(Math.min(1, a.motion.partial.nextT / (job.duration || 1)) * 100)}%まで保存済み）` : '';
    lines.push(`${mark(a.motion?.done)} 手元の動きの解析${mt}`);
  }
  const r = job.render;
  if (r) {
    const done = r.done.filter(Boolean).length;
    lines.push(`${mark(done === r.segments.length)} 映像の書き出し（${done}/${r.segments.length}区間 保存済み）`);
    lines.push(`${mark(job.stage === 'done')} 仕上げ（区間をつないで音声を入れる）`);
  }
  return { stage: STAGES[job.stage] || job.stage, lines, percent: jobPercent(job) };
}

// 全体の進み具合（目安）。解析 30%・書き出し 60%・仕上げ 10%
export function jobPercent(job) {
  if (job.stage === 'done') return 100;
  const a = job.analysis || {};
  let p = 0;
  if (a.audio) p += 8;
  if (job.useAsr) {
    const total = a.asr?.windows?.length || 0;
    p += a.asr?.done ? 12 : total ? 12 * Object.keys(a.asr.results || {}).length / total : 0;
  } else p += 12;
  p += a.motion?.done ? 10 : a.motion?.partial ? 10 * Math.min(1, a.motion.partial.nextT / (job.duration || 1)) : 0;
  const r = job.render;
  if (r) {
    const all = r.segments.reduce((s, x) => s + x.frames, 0) || 1;
    p += 60 * r.segments.filter((x, i) => r.done[i]).reduce((s, x) => s + x.frames, 0) / all;
  }
  return Math.round(Math.min(99, p));
}

// 動画ごとの作業の名前（保存場所のフォルダ名に使う。ファイル名と大きさから作る）
export function jobIdFor(file) {
  const s = `${file.name}|${file.size}`;
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return 'j' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// 再開のために選び直された動画が、保存してある作業と同じ動画か。
// 写真アプリから選び直すとファイル名が変わることがあるので、大きさと長さで確かめる
export function sameSource(job, file, duration) {
  return !!job && !!file && job.file.size === file.size && Math.abs((job.duration ?? 0) - (duration ?? 0)) < 0.2;
}
