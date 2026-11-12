// 動画を選ぶときに入力する「編集メモ」（全体のメモ・動画1本ごとのメモ）を読む。
//
// 読み方が1通りに決まる書き方だけを、字幕・カットの判断に使う（勝手に解釈して編集を変えない）。
// 読み取れなかった文は unread に入れ、画面で「反映していないメモ」として知らせる。
//   言い間違い:   「今回は言い間違いなし」「2本目の15秒付近に言い間違いあり」（1本ごとのメモなら「15秒付近に言い間違い」）
//   残す:         「2本目の10秒付近は削除しないで」「「ボブを切る際」は残して」
//   字幕で省く:   「字幕では「かなり」を省いて」「「ちなみに」は字幕に出さないで」
//   字幕に残す:   「字幕に「でも」を残して」
//   用語:         「「すきバサミ」を正確に表示」「専門用語: ヘアカッター、セニング」
// source: 1本ごとのメモのとき、その動画の番号（1から）。全体のメモは null

const NUM = '([0-9０-９]+(?:[.．][0-9０-９]+)?)';
const toNum = s => Number(String(s).replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
const quoted = s => [...s.matchAll(/[「『"“]([^」』"”]{1,30})[」』"”]/g)].map(m => m[1].trim()).filter(Boolean);

export function parseMemo(text, { source = null } = {}) {
  const out = { retake: null, retakeAt: [], keepAt: [], keepText: [], omitWords: [], keepWords: [], terms: [], read: [], unread: [] };
  const lines = (text || '').normalize('NFKC').split(/\n|。(?!」)/).map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    const s = line.replace(/\s+/g, '');
    let used = false;
    const where = () => {
      const m = s.match(new RegExp(`(?:${NUM}本目の?)?${NUM}秒(?:付近|あたり|頃|前後)?`));
      if (!m) return null;
      const src = m[1] != null ? toNum(m[1]) : source;
      return src ? { source: src, at: toNum(m[2]) } : null;
    };
    // 言い間違い
    if (/言い(?:間違い|間違え|直し)|噛ん|かんだ/.test(s)) {
      if (/(?:なし|無し|ない|ありません|ゼロ|0回)/.test(s) && !/(?:あり|有り|ある|あります)/.test(s.replace(/ありません/g, ''))) {
        out.retake = 'no'; used = true; out.read.push('言い間違いなし');
      } else if (/(?:あり|有り|ある|あります|した|して)/.test(s)) {
        const w = where();
        if (w) { out.retakeAt.push(w); out.read.push(`${w.source}本目の${w.at}秒付近に言い間違いあり`); }
        else out.read.push('言い間違いあり');
        out.retake = 'yes'; used = true;
      }
    }
    // 残す（削除しない）
    if (!used && /(?:削除しない|消さない|カットしない|切らない|残して|残す)/.test(s) && !/字幕/.test(s)) {
      const w = where();
      if (w) { out.keepAt.push(w); out.read.push(`${w.source}本目の${w.at}秒付近は残す`); used = true; }
      const q = quoted(line);
      if (q.length) { out.keepText.push(...q); out.read.push(`残す: ${q.join('、')}`); used = true; }
    }
    // 字幕の言葉
    if (!used && /字幕/.test(s)) {
      const q = quoted(line);
      if (q.length && /(?:省|消|出さない|表示しない|書かない|いらない|不要)/.test(s)) { out.omitWords.push(...q); out.read.push(`字幕で省く: ${q.join('、')}`); used = true; }
      else if (q.length && /(?:残|出して|表示して|書いて)/.test(s)) { out.keepWords.push(...q); out.read.push(`字幕に残す: ${q.join('、')}`); used = true; }
    }
    // 用語（正確に表示してほしい言葉）
    if (!used && /(?:用語|正確|表記|漢字で|カタカナで)/.test(s)) {
      const q = quoted(line);
      const list = q.length ? q : (s.split(/[:：]/)[1] || '').split(/[、,，・/／]/).map(x => x.trim()).filter(x => x.length >= 2 && x.length <= 20);
      if (list.length) { out.terms.push(...list); out.read.push(`用語: ${list.join('、')}`); used = true; }
    }
    if (!used) out.unread.push(line);
  }
  return out;
}

// 全体のメモと1本ごとのメモ（memos: [{ text }]・動画の順）をまとめて読む。lay: 動画ごとのつないだ時刻（sources.layout）
export function readMemos(brief, lay = null) {
  const all = parseMemo(brief?.memo || '');
  (brief?.memos || []).forEach((m, k) => {
    const r = parseMemo(m?.text || '', { source: k + 1 });
    for (const key of ['retakeAt', 'keepAt', 'keepText', 'omitWords', 'keepWords', 'terms', 'read']) all[key].push(...r[key]);
    all.unread.push(...r.unread.map(t => `${k + 1}本目: ${t}`));
    if (r.retake === 'yes' && all.retake !== 'no') all.retake = 'yes';
  });
  // 画面の選択（自動判定・あり・なし）がメモより優先
  if (brief?.retake === 'no' || brief?.retake === 'yes') all.retake = brief.retake;
  if (all.retake === 'no') all.retakeAt = [];
  // 「〇本目の〇秒」を、つないだ時刻にする
  const toT = w => {
    if (!lay) return w.source === 1 ? w.at : null;
    const L = lay[w.source - 1];
    return L && w.at >= 0 && w.at <= L.duration + 0.5 ? L.offset + Math.min(w.at, L.duration) : null;
  };
  all.retakeTimes = all.retakeAt.map(toT).filter(t => t != null);
  all.keepTimes = all.keepAt.map(toT).filter(t => t != null);
  return all;
}
