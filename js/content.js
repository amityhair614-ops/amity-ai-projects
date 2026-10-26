// 話した内容（文字起こし）から、言い直し・くり返しを見つける（ブラウザAPIを使わないので Node でテストできる）。
//
// 文字起こしは間違えることがあるので、確かなものだけ自動で外し、確かでないものは「候補」として確認画面に出す。
// - 自動で外す（high）: はっきりした合図（「言い直します」「いや、〜じゃなくて」など）があり、前後で同じことを言っている／
//   ほぼ同じ文を続けて2回話していて、用語（部位・角度・道具など）も同じ
// - 候補（mid）: 似ているが確かでない。初期状態では残し、確認画面で外せるようにする
// - 用語が違う（「サイドを45度」と「バックを45度」など）ときは、文が似ていても外さない（別の技術の説明）
import { normalizeText, similarity } from './plan.js';

// 言い直しの合図（文の中のどこにあってもよい）
export const RETAKE_RE = /言い直|いい直|言いなお|いいなお|いいなをし|撮り直|とり直|間違えました|間違えた|ごめんなさい|失礼しました/;
// 訂正の合図で始まる文（「いや、ここじゃなくて、耳後ろを…」）
const CORRECTION_HEAD_RE = /^(?:あ[、,]?\s*|あっ[、,]?\s*)?(?:いや|いえ|違う|ちがう|違います|じゃなくて|ではなくて|じゃない|すみません|すいません|ごめん|失礼)/;
// 訂正の合図の言葉（文の途中にあるとき）
const CORRECTION_MID_RE = /(?:[、,]\s*|^)(?:あ[、,]?\s*)?(?:いや[、,]|いえ[、,]|違う[、,]|ちがう[、,]|すみません[、,]|すいません[、,])|じゃなくて|ではなくて/;
const CUE_WORD_RE = /いや|いえ|違う|ちがう|違います|じゃなく|ではなく|じゃない|すみません|すいません|ごめん|失礼/;

// 内容を表す言葉（漢字の語・カタカナ語・数字と単位）。「ここ」「次」など、どの説明にも出る言葉は除く
const GENERIC = new Set(['次', '今', '今日', '最初', '最後', '全体', '部分', '感じ', '方', '所', '時', '後', '前', '上', '下', '中', '少', '一回', '一度', '大事', '注意', '確認']);
export function contentTerms(text) {
  const t = (text || '').normalize('NFKC');
  const out = new Set();
  for (const m of t.matchAll(/[0-9]+\s*(?:度|cm|センチ|ミリ|mm|本|個|つ)?/g)) out.add(m[0].replace(/\s/g, ''));
  const rest = t.replace(/[0-9]+\s*(?:度|cm|センチ|ミリ|mm|本|個|つ)?/g, ' ');
  for (const m of rest.matchAll(/[一-鿿々]+/g)) if (!GENERIC.has(m[0])) out.add(m[0]);
  for (const m of t.matchAll(/[゠-ヿ]{2,}/g)) out.add(m[0]);
  return out;
}

// b が a と同じ用語だけで話しているか（a の用語がすべて b にあり、b に新しい用語が多すぎない）
function sameTerms(a, b) {
  const A = contentTerms(a), B = contentTerms(b);
  for (const x of A) if (![...B].some(y => y.includes(x) || x.includes(y))) return false;
  let extra = 0;
  for (const y of B) if (![...A].some(x => y.includes(x) || x.includes(y))) extra++;
  return extra <= 1;
}

// 2つの文の述語（語尾の4文字）が同じか。「ここを軽くします」と「耳後ろを軽くします」は同じ「軽くします」
function samePredicate(a, b) {
  const A = normalizeText(a), B = normalizeText(b);
  if (A.length < 3 || B.length < 3) return false;
  return A.slice(-4) === B.slice(-4) || similarity(A.slice(-6), B.slice(-6)) >= 0.6;
}

// 文の先頭の訂正の部分（「いや、ここじゃなくて、」）の長さ。訂正の部分がなければ 0
function correctionHeadLength(text) {
  if (!CORRECTION_HEAD_RE.test(text)) return 0;
  // 合図の言葉を含む読点までを、訂正の部分とする（最大20文字）
  let end = 0;
  const re = /[、,]/g;
  let m;
  while ((m = re.exec(text)) && m.index <= 20) {
    if (CUE_WORD_RE.test(text.slice(0, m.index))) end = m.index + 1;
    else break;
  }
  if (!end) {
    // 読点がない「いや耳後ろを…」: 合図の言葉だけ
    const c = text.match(CORRECTION_HEAD_RE);
    end = c ? c[0].length : 0;
  }
  return text.slice(end).replace(/[、。\s]/g, '').length >= 4 ? end : 0;
}

// 文の途中の訂正（「ここを軽くします、いや、耳後ろを…」「ここを、じゃなくて耳後ろを」）の位置。
// 返り値は { cut: 残す部分の始まりの文字位置, before: 取り消された部分 }。なければ null
function midCorrection(text) {
  const m = text.slice(4).match(CORRECTION_MID_RE);
  if (!m) return null;
  const at = m.index + 4;
  // 合図を含む読点まで（「じゃなくて、」）を取り除く
  let cut = at + m[0].length;
  const comma = text.slice(cut, cut + 3).search(/[、,]/);
  if (comma >= 0) cut += comma + 1;
  const before = text.slice(0, at).replace(/[、,\s]+$/, '');
  const rest = text.slice(cut);
  if (normalizeText(before).length < 2 || normalizeText(rest).length < 4) return null;
  return { cut, before };
}

// 文の中のくり返し（「このパネルを、このパネルを45度で」）。返り値は { cut } か null
function stutter(text) {
  const parts = text.split(/(?<=[、,])/);
  let pos = 0;
  for (let k = 0; k + 1 < parts.length; k++) {
    const a = normalizeText(parts[k]), b = normalizeText(parts[k + 1]);
    pos += parts[k].length;
    if (a.length >= 3 && (b.startsWith(a) || similarity(a, b.slice(0, a.length)) >= 0.8)) return { cut: pos, repeated: parts[k].replace(/[、,]$/, '') };
  }
  return null;
}

// 文ごとの判定。chunks は時刻順の文（{ start, end, text }）。返り値は同じ数の配列:
// { drop: 理由（自動で外す）, candidate: 理由（候補として出す）, trim: { cut, reason, high } } の組み合わせ、または null
export function analyzeContent(chunks) {
  const out = chunks.map(() => null);
  const set = (i, v) => { out[i] = { ...(out[i] || {}), ...v }; };
  const text = chunks.map(c => (c.text || '').trim());
  const norm = text.map(normalizeText);
  const near = (i, j, sec) => chunks[j].start - chunks[i].end <= sec;

  for (let i = 0; i < chunks.length; i++) {
    const t = text[i];
    if (!norm[i]) continue;
    // 1. はっきりした言い直しの合図（「言い直します」など）
    if (RETAKE_RE.test(t)) {
      set(i, { drop: '言い直しの合図' });
      // 合図だけの短い発言なら、その直前の発言が言い直し前のもの。
      // 合図の前に内容がある（「…スライスで、すみません、言い直します」）なら、この発言自体が言い直し前
      const before = normalizeText(t.split(RETAKE_RE)[0].replace(/すみません|すいません|ごめんなさい/g, ''));
      if (before.length < 6 && i > 0 && near(i - 1, i, 10) && !out[i - 1]?.drop) set(i - 1, { drop: '言い直し前の発言' });
      continue;
    }
    // 2. 訂正の合図で始まる文（「いや、ここじゃなくて、耳後ろを軽くします」）
    const head = correctionHeadLength(t);
    if (head) {
      const kept = t.slice(head);
      set(i, { trim: { cut: head, reason: `冒頭の訂正「${t.slice(0, head).replace(/[、,]$/, '')}」`, high: true } });
      if (i > 0 && near(i - 1, i, 6) && !out[i - 1]?.drop) {
        const prev = text[i - 1];
        if (samePredicate(prev, kept) || [...contentTerms(prev)].some(x => kept.includes(x))) set(i - 1, { drop: '言い直し前の発言（すぐ後で訂正）' });
        else set(i - 1, { candidate: '直後に訂正の言葉があります（言い直し前の発言かもしれません）' });
      }
      continue;
    }
    // 3. 文の途中の訂正
    const mid = midCorrection(t);
    if (mid) {
      const kept = t.slice(mid.cut);
      const high = samePredicate(mid.before, kept) || [...contentTerms(mid.before)].some(x => kept.includes(x));
      set(i, { trim: { cut: mid.cut, reason: `言い直し前の「${mid.before}」`, high } });
      continue;
    }
    // 4. 文の中のくり返し
    const st = stutter(t);
    if (st) set(i, { trim: { cut: st.cut, reason: `くり返した「${st.repeated}」`, high: true } });
  }

  // 5. 同じ説明のくり返し（あとの発言を採用）。用語が違うものは別の説明として残す
  for (let i = 0; i < chunks.length; i++) {
    if (out[i]?.drop) continue;
    const a = norm[i];
    if (a.length < 4) continue;
    for (let j = i + 1; j < Math.min(chunks.length, i + 4); j++) {
      if (!near(i, j, 30)) break;
      if (out[j]?.drop) continue;
      const b = norm[j];
      const sim = similarity(a, b);
      const prefix = a.slice(0, Math.min(6, a.length));
      const restart = prefix.length >= 5 && b.startsWith(prefix) && a.length <= b.length + 3;
      if (!sameTerms(text[i], text[j])) continue;
      if (sim >= 0.8 || (restart && near(i, j, 12))) { set(i, { drop: restart && sim < 0.8 ? '言い直し（あとの発言を採用）' : '同じ説明のくり返し（あとの発言を採用）' }); break; }
      if (sim >= 0.55 && near(i, j, 12)) { set(i, { candidate: 'あとで似た説明をしています（くり返しかもしれません）' }); break; }
    }
  }
  return out;
}
