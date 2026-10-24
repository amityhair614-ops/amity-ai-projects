// 編集前に入力する「動画の情報」（タイトル・内容・伝えたいこと・流れ・必ず残したい場面・希望時間・編集スタイル）。
// どれも任意。入力された言葉は、場面の点数・必ず残す場面・選び方・文字起こしの用語に使う。
// 入力から字幕の文字や場面を作ることはしない（話していない言葉を足さない・元の映像の順番を変えない）
import { KEYWORDS, BEAUTY_TERMS, normalizeText, similarity } from './plan.js';

export const FORMATS = {
  short: { label: 'ショート', aspect: '縦 9:16', size: '1080×1920', presets: [30, 45, 60], defaultSec: 60, min: 10, max: 180 },
  long: { label: 'ロング', aspect: '横 16:9', size: '1920×1080', presets: [300, 480, 600, 720], defaultSec: 600, min: 60, max: 1800 },
};

export const STYLES = {
  simple: { label: 'シンプル・オシャレ' },
  tempo: { label: 'テンポ重視' },
};

export const EMPTY_BRIEF = {
  title: '', content: '', message: '', flow: '', mustKeep: '',
  format: 'short', targetSec: 60, style: 'simple',
};

// 入力の値をそろえる（保存データが古い・壊れている場合も安全な値にする）
export function normalizeBrief(b) {
  const o = { ...EMPTY_BRIEF };
  if (!b || typeof b !== 'object') return o;
  for (const k of ['title', 'content', 'message', 'flow', 'mustKeep']) {
    if (typeof b[k] === 'string') o[k] = b[k].slice(0, 2000);
  }
  if (FORMATS[b.format]) o.format = b.format;
  if (STYLES[b.style]) o.style = b.style;
  const f = FORMATS[o.format];
  const sec = Number(b.targetSec);
  o.targetSec = Number.isFinite(sec) && sec > 0 ? Math.round(Math.min(f.max, Math.max(f.min, sec))) : f.defaultSec;
  return o;
}

export function hasText(b) {
  return ['title', 'content', 'message', 'flow', 'mustKeep'].some(k => (b[k] || '').trim());
}

// 入力文の「説明そのもの」を表す言葉は、話の中身ではないので用語にしない
const META_WORDS = new Set([
  '動画', '説明', '場面', '内容', '視聴者', '今回', '今日', '方法', '冒頭', '最初', '最後', '実践', '仕上', '流れ', '紹介',
  '解説', '撮影', '編集', '部分', '工程', '技術', '自分', '皆様', '皆さん', '一番', '必ず', '大切', '伝え', '残', '全体',
  'ポイント', 'ショート', 'ロング', 'ユーチューブ', 'カット解説',
]);
const DICT = [...new Set([...KEYWORDS, ...BEAUTY_TERMS.map(t => t.term)])];

// 自由に書かれた日本語から、話の中に出てきそうな言葉を取り出す。
// 辞書の美容用語・カタカナ語（3文字以上）・漢字の言葉（2文字以上）・「45度」のような数字＋単位・英字
export function extractTerms(text) {
  const t = (text || '').normalize('NFKC');
  const out = [];
  const add = w => {
    w = w.trim();
    if (w.length < 2 || META_WORDS.has(w) || out.includes(w)) return;
    out.push(w);
  };
  for (const d of DICT) if (d.length >= 2 && t.includes(d)) add(d);
  for (const m of t.matchAll(/[゠-ヿー]{3,}/g)) add(m[0]);
  for (const m of t.matchAll(/[一-鿿々]{2,6}/g)) add(m[0]);
  for (const m of t.matchAll(/[0-9]+\s*(?:度|cm|センチ|ミリ|mm)/g)) add(m[0].replace(/\s/g, ''));
  for (const m of t.matchAll(/[A-Za-z]{2,}/g)) add(m[0]);
  // ほかの言葉に含まれる短い言葉（「前下がり」の中の「前下」など）は外す
  return out.filter(w => !out.some(o => o !== w && o.length > w.length && o.includes(w) && !DICT.includes(w))).slice(0, 40);
}

// 「必ず残したい説明や場面」を、1つずつの項目に分ける（改行・「、」「。」・箇条書きの記号で区切る）
export function splitItems(text) {
  return (text || '').normalize('NFKC')
    .split(/[\n、。,;・]|(?:^|\s)[-*•]\s*/)
    .map(s => s.replace(/^\s*(?:\d+[.)）]\s*)?/, '').trim()) // 「1.」「2)」のような番号だけ外す
    .filter(s => normalizeText(s).length >= 2)
    .slice(0, 12);
}

// 流れ（冒頭・説明・実践・仕上がり など）の段階の数。場面を動画全体から選ぶときの区切りの数に使う
export function flowSteps(text) {
  const items = (text || '').split(/[\n、,・→>＞\/|]|->/).map(s => s.trim()).filter(Boolean);
  return items.length;
}

// 項目 item と、場面の文字 text がどれだけ合うか（0〜1）
export function matchStrength(item, text) {
  const a = normalizeText(item.normalize('NFKC')), b = normalizeText((text || '').normalize('NFKC'));
  if (!a || !b) return 0;
  if (b.includes(a)) return 1;
  const terms = extractTerms(item);
  const hit = terms.filter(w => b.includes(w)).length;
  const termScore = terms.length ? hit / terms.length : 0;
  return Math.max(termScore * 0.9, similarity(a, b) >= 0.5 ? similarity(a, b) : 0);
}

// 入力内容から、場面選びに使う情報を作る
export function briefPlan(brief) {
  const b = normalizeBrief(brief);
  const themeTerms = extractTerms([b.title, b.content, b.flow].join('\n'));
  const messageTerms = extractTerms(b.message);
  const mustItems = splitItems(b.mustKeep);
  const steps = flowSteps(b.flow);
  return {
    brief: b,
    themeTerms: themeTerms.filter(w => !messageTerms.includes(w)),
    messageTerms,
    mustItems,
    buckets: steps >= 2 ? Math.min(8, Math.max(3, steps)) : 5,
    // 文字起こしで書き始めたら続きを選びやすくする用語（辞書にない、この動画の言葉）
    asrTerms: [...new Set([...messageTerms, ...themeTerms, ...mustItems.flatMap(extractTerms)])]
      .filter(w => /[゠-ヿ一-鿿]/.test(w) && w.length <= 10 && !DICT.includes(w)).slice(0, 30),
  };
}

const MUST_MIN = 0.6;

// 場面に入力内容を反映する（点数を足し、必ず残す場面に印をつける）。units を書き換える
export function applyBrief(units, bp) {
  if (!bp) return { must: [] };
  const speech = units.filter(u => u.kind === 'speech' && !u.excluded && u.text);
  for (const u of units) {
    if (u.kind !== 'speech' || !u.text) continue;
    const theme = bp.themeTerms.filter(w => u.text.includes(w));
    const msg = bp.messageTerms.filter(w => u.text.includes(w));
    if (theme.length) { u.score += 0.6 * Math.min(2, theme.length); u.reasons.push('入力した内容: ' + theme.slice(0, 2).join('・')); }
    if (msg.length) { u.score += 1.0 * Math.min(2, msg.length); u.reasons.push('伝えたいこと: ' + msg.slice(0, 2).join('・')); }
  }
  // 必ず残したい項目: いちばん合う場面は必ず残す。ほかに合う場面と、その直後の作業場面は点数を上げる
  const must = [];
  for (const item of bp.mustItems) {
    const scored = speech.map(u => ({ u, s: matchStrength(item, u.text) })).filter(x => x.s >= MUST_MIN)
      .sort((x, y) => y.s - x.s || y.u.score - x.u.score);
    if (!scored.length) { must.push({ item, unit: null }); continue; }
    const best = scored[0].u;
    best.mustKeep = best.mustKeep || item;
    if (!best.reasons.some(r => r.startsWith('必ず残す'))) best.reasons.unshift('必ず残す: ' + item);
    must.push({ item, unit: best });
    for (const { u } of scored.slice(1)) { u.score += 1.5; if (!u.reasons.includes('関連: ' + item)) u.reasons.push('関連: ' + item); }
    for (const { u } of scored) {
      // 説明のすぐ後の作業場面（実際に切っているところ）
      const next = units.find(a => a.kind === 'action' && a.start >= u.end - 0.2 && a.start - u.end < 5);
      if (next && !next.reasons.includes('説明の続きの作業')) { next.score += 1.2; next.reasons.push('説明の続きの作業'); }
    }
  }
  return { must };
}

// テンポ重視: 長い場面より、短くまとまった場面を選びやすくする
export function applyStyle(units, style) {
  if (style !== 'tempo') return;
  for (const u of units) if (u.duration > 4) u.score -= 0.15 * (u.duration - 4);
}

// 目標時間（秒）から、選ぶときの目安と上限を決める
export function targetRange(sec) {
  return { target: sec - Math.min(2, sec * 0.04), max: sec };
}

// 選んだ結果が目標時間に収まったか。収まらない場合は理由をつける
export function fitReport({ targetSec, selected, units, sourceDuration }) {
  const planned = selected.reduce((s, u) => s + u.duration, 0);
  const mustSec = selected.filter(u => u.mustKeep).reduce((s, u) => s + u.duration, 0);
  const usable = units.filter(u => !u.excluded && u.duration >= 0.5).reduce((s, u) => s + u.duration, 0);
  const r = { targetSec, planned, mustSec, usable, ok: true, reason: '' };
  const tol = Math.max(3, targetSec * 0.1);
  if (planned > targetSec + 0.5) {
    r.ok = false;
    r.reason = `必ず残す場面だけで約${Math.round(mustSec)}秒あるため、目標の${fmt(targetSec)}に収まりません。重要な説明は削らずに残しています。`;
  } else if (planned < targetSec - tol) {
    r.ok = false;
    r.reason = sourceDuration < targetSec
      ? `元の動画が${fmt(sourceDuration)}のため、目標の${fmt(targetSec)}より短くなります。`
      : usable < targetSec
        ? `話している部分と手元の作業場面が合計約${fmt(usable)}しか見つからなかったため、目標の${fmt(targetSec)}より短くなります。無音や不要な場面で水増しはしていません。`
        : `場面の区切り（発言や作業のまとまり）を途中で切らないようにしたため、目標の${fmt(targetSec)}より少し短くなります。「ほかの候補」から場面を足せます。`;
  }
  return r;
}

export function fmt(sec) {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return m ? `${m}分${s % 60 ? String(s % 60).padStart(2, '0') + '秒' : ''}` : `${s}秒`;
}
