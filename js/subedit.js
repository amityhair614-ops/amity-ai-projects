// 字幕の手直し（文字・表示時刻・全体のずらし）の保存と反映。画面に依存しない計算だけ
export const STEP = 0.1; // 時刻を動かす単位（秒）

// 同じ動画かどうかを見分ける鍵（ファイル名・大きさ・長さ）
export function videoKey(file, duration) {
  return `amity.subs.v1:${file.name}:${file.size}:${Math.round(duration * 10)}`;
}

// 場面を見分ける鍵（同じ動画をもう一度解析しても同じになる）
export function unitKey(u) {
  return u.start.toFixed(2);
}

const round1 = t => Math.round(t * 1000) / 1000;

// 字幕の時刻を動かす。場面の前後1秒まで、長さは0.3秒以上を保つ
export function nudge(u, which, delta) {
  const lo = u.start - 1, hi = u.end + 1;
  if (which === 'start') u.subStart = round1(Math.min(Math.max(lo, u.subStart + delta), u.subEnd - 0.3));
  else u.subEnd = round1(Math.max(Math.min(hi, u.subEnd + delta), u.subStart + 0.3));
  u.subEdited = true;
}

// 保存する内容（AIの結果から変えたものだけ）
export function collectEdits(units, offset) {
  const edits = {};
  for (const u of units) {
    if (u.kind !== 'speech' || u.subStart == null) continue;
    const e = {};
    if (u.text !== u.aiText) e.text = u.text;
    if (u.subEdited) { e.subStart = u.subStart; e.subEnd = u.subEnd; }
    if (Object.keys(e).length) edits[unitKey(u)] = e;
  }
  return { offset: round1(offset || 0), edits };
}

// 保存してあった修正を当てはめる。当てはめた数を返す
export function applyEdits(units, saved) {
  let n = 0;
  for (const u of units) {
    if (u.aiText === undefined) { u.aiText = u.text; u.aiSubStart = u.subStart; u.aiSubEnd = u.subEnd; }
    const e = saved && saved.edits && saved.edits[unitKey(u)];
    if (!e || u.kind !== 'speech') continue;
    if (typeof e.text === 'string') u.text = e.text;
    if (typeof e.subStart === 'number' && typeof e.subEnd === 'number' && u.subStart != null) {
      u.subStart = e.subStart; u.subEnd = e.subEnd; u.subEdited = true;
    }
    n++;
  }
  return n;
}

// AIの結果に戻す
export function resetEdits(units) {
  for (const u of units) {
    if (u.aiText === undefined) continue;
    u.text = u.aiText; u.subStart = u.aiSubStart; u.subEnd = u.aiSubEnd; u.subEdited = false;
  }
}

// 書き出し用: 全体のずらし（offset）を足した字幕の時刻
export function shifted(u, offset) {
  if (u.subStart == null) return {};
  const off = offset || 0;
  return {
    subStart: u.subStart + off,
    subEnd: u.subEnd + off,
    fine: (u.fine || []).map(r => ({ start: r.start + off, end: r.end + off })),
  };
}

export function formatClock(t) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
