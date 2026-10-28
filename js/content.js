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

// a の用語がすべて b にあれば、b にだけある用語の数を返す（a にしかない用語があれば -1 = 別の説明）
function extraTerms(a, b) {
  const A = contentTerms(a), B = contentTerms(b);
  for (const x of A) if (![...B].some(y => y.includes(x) || x.includes(y))) return -1;
  let extra = 0;
  for (const y of B) if (![...A].some(x => y.includes(x) || x.includes(y))) extra++;
  return extra;
}

// a にだけある用語が、すべて b のどれかと「同じ長さで1文字違い」か（数字を含む用語は違う説明とみなす）
function lookAlikeTerms(a, b) {
  const A = [...contentTerms(a)], B = [...contentTerms(b)];
  const only = A.filter(x => !B.some(y => y.includes(x) || x.includes(y)));
  if (!only.length) return false;
  return only.every(x => !/[0-9]/.test(x) && B.some(y => y.length === x.length && [...x].filter((c, k) => c !== y[k]).length === 1));
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
  // 合図の言葉を含む句（読点で区切られた部分）が続くところまでを、訂正の部分とする（最大20文字）。
  // 先頭の「あ、」「あっ、」は合図の一部として含める
  const inter = text.match(/^(?:あっ?|えっ?)[、,]\s*/);
  let end = inter ? inter[0].length : 0;
  const re = /[、,]/g;
  let m;
  while ((m = re.exec(text)) && m.index <= 20) {
    if (CUE_WORD_RE.test(text.slice(end, m.index))) end = m.index + 1;
    else break;
  }
  if (!end || (inter && end === inter[0].length)) {
    // 読点がない「いや耳後ろを…」: 合図の言葉だけ（すぐ後の読点も含める）
    const c = text.match(CORRECTION_HEAD_RE);
    end = c ? c[0].length : 0;
    if (/^[、,]/.test(text.slice(end))) end++;
  }
  return text.slice(end).replace(/[、。\s]/g, '').length >= 4 ? end : 0;
}

// 文の途中の訂正（「ここを軽くします、いや、耳後ろを…」「スライスは、一センチ、すみません、二センチの幅で」）。
// 合図の直前の句（言い間違えた部分）と合図を取り除き、その前の句は残す。
// 返り値は { from, cut, before, after }（from〜cut の文字を取り除く）。なければ null
function midCorrection(text) {
  const m = text.slice(2).match(CORRECTION_MID_RE);
  if (!m) return null;
  const at = m.index + 2;
  // 合図の後ろの読点まで（「じゃなくて、」「すみません、」）を取り除く
  let cut = at + m[0].length;
  const comma = text.slice(cut, cut + 3).search(/[、,]/);
  if (comma >= 0) cut += comma + 1;
  // 言い間違えた句: 合図の直前の句（直前の読点の後から）
  const head = text.slice(0, at).replace(/[、,\s]+$/, '');
  const prevComma = Math.max(head.lastIndexOf('、'), head.lastIndexOf(','));
  const from = prevComma + 1;
  const before = head.slice(from);
  const after = text.slice(cut).split(/[、,。]/)[0];
  if (normalizeText(before).length < 2 || normalizeText(text.slice(cut)).length < 2) return null;
  return { from, cut, before, after };
}

// 言い間違えた句と正しい句が、同じ形をしているか（同じ助詞で終わる・どちらも数と単位・語尾が同じ）
function parallel(a, b) {
  const tail = x => (x.match(/[をにでがはもへとからまで]+$/) || [''])[0];
  const num = x => /[0-9０-９一二三四五六七八九十]+\s*(?:度|センチ|ミリ|cm|mm|本|個|つ)/.test(x);
  return (tail(a) && tail(a) === tail(b)) || (num(a) && num(b)) || samePredicate(a, b) || [...contentTerms(a)].some(x => b.includes(x));
}

// 文の中のくり返し（「このパネルを、このパネルを45度で」）。返り値は { cut } か null
function stutter(text) {
  // 読点がなくても、文の頭の言葉（4〜6文字）をすぐ後でもう一度言い出した（「このようなヘアカッターこのようなアイテム」）
  for (let len = 6; len >= 4; len--) {
    const head = text.slice(0, len);
    if (/[、,。]/.test(head) || normalizeText(head).length < len) continue;
    const at = text.indexOf(head, len);
    if (at > 0 && at <= 16 && text.length - at > len) return { cut: at, repeated: text.slice(0, at).replace(/[、,]$/, '') };
  }
  const parts = text.split(/(?<=[、,])/);
  let pos = 0;
  for (let k = 0; k + 1 < parts.length; k++) {
    const a = normalizeText(parts[k]), b = normalizeText(parts[k + 1]);
    pos += parts[k].length;
    if (a.length >= 3 && (b.startsWith(a) || similarity(a, b.slice(0, a.length)) >= 0.8)) return { cut: pos, repeated: parts[k].replace(/[、,]$/, '') };
    // 同じ言い出しで話し直した（「このようなヘアカッター、このようなアイテム」）: 前の短い句を言い直し前とみなす
    let common = 0;
    while (common < Math.min(a.length, b.length) && a[common] === b[common]) common++;
    if (common >= 4 && a.length <= 14 && b.length > common) return { cut: pos, repeated: parts[k].replace(/[、,]$/, '') };
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
        const pred = samePredicate(prev, kept), term = [...contentTerms(prev)].some(x => x.length >= 2 && kept.includes(x)) || parallel(prev, kept);
        // 「すみません」「ごめん」は、訂正でなく普通のおわびのこともあるので、語尾と用語の両方が合うときだけ自動で外す
        const apology = /^(?:あ[、,]?\s*)?(?:すみません|すいません|ごめん|失礼)/.test(t);
        if (apology ? pred && term : pred || term) set(i - 1, { drop: '言い直し前の発言（すぐ後で訂正）' });
        else set(i - 1, { candidate: '直後に訂正の言葉があります（言い直し前の発言かもしれません）' });
      }
      continue;
    }
    // 3. 文の途中の訂正
    const mid = midCorrection(t);
    if (mid) {
      const high = parallel(mid.before, mid.after) || samePredicate(mid.before, t.slice(mid.cut));
      set(i, { trim: { from: mid.from, cut: mid.cut, reason: `言い直し前の「${mid.before}」`, high } });
      continue;
    }
    // 4. 文の中のくり返し
    const st = stutter(t);
    if (st) set(i, { trim: { cut: st.cut, reason: `くり返した「${st.repeated}」`, high: true } });
  }

  // 5. 文の終わりで言い出してやめ、次の文で同じ言葉から言い直した（「それはどこなのか、トップの」「トップの根元付近です」）。
  //    文の終わりの言いかけ（3〜8文字）を取り除く。声の切れ目があるときだけ取り除く（findTrim）
  for (let i = 0; i + 1 < chunks.length; i++) {
    if (out[i]?.drop || out[i]?.trim || !near(i, i + 1, 4)) continue;
    const t = text[i].replace(/[、。,.\s]+$/, '');
    const next = text[i + 1].replace(/^[、,\s]+/, '');
    for (let len = Math.min(8, t.length - 4); len >= 3; len--) {
      const tail = t.slice(-len);
      if (/[、。,]/.test(tail) || !next.startsWith(tail) || next.length <= len + 1) continue;
      // 「…します」「します、…」のような語尾のくり返しは言い直しではない
      if (/(?:ます|です|さい|した|よね)$/.test(tail)) break;
      set(i, { trim: { tail: t.length - len, reason: `言いかけてやめた「${tail}」（次の文で言い直し）`, high: /[のをにはがでと]$/.test(tail) || len >= 4 } });
      break;
    }
  }

  // 6. 同じ説明のくり返し（あとの発言を採用）。用語が違うものは別の説明として残す
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
      const extra = extraTerms(text[i], text[j]);
      if (extra < 0) {
        // 用語が違う: 別の説明。ただし文全体がほぼ同じで、違う用語が「1文字違い」（猛量／毛量など）なら、
        // 文字起こしの間違いかもしれないので候補にする（サイド／バック、0度／45度 は別の説明）
        if (sim >= 0.85 && near(i, j, 12) && lookAlikeTerms(text[i], text[j])) { set(i, { candidate: 'あとでほぼ同じ説明をしています（用語の文字が違うため、自動では外していません）' }); break; }
        continue;
      }
      // 用語がまったく同じときだけ自動で外す。あとの文に用語が加わっている（「サイドは、…」）ときは、くわしく言い直したのか、
      // 別の部位の説明なのか確かでないので候補にする
      if (extra === 0 && (sim >= 0.8 || (restart && near(i, j, 12)))) { set(i, { drop: restart && sim < 0.8 ? '言い直し（あとの発言を採用）' : '同じ説明のくり返し（あとの発言を採用）' }); break; }
      if ((sim >= 0.55 || restart) && near(i, j, 12)) { set(i, { candidate: 'あとで似た説明をしています（くり返しかもしれません）' }); break; }
    }
  }
  return out;
}
