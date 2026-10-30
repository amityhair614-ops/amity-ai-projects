// 表示用の字幕（画面に出す短い言葉）を作る。文字起こし（話した内容をそのまま文字にしたもの）とは別の工程。
// ブラウザAPIを使わないので Node でテストできる。
//
// 1. 文字起こし（u.text）はそのまま残す（数も漢字のまま。字幕にするときに算用数字にする）（確認画面で直せる・言い直しの判断にも使う）
// 2. 字幕のページの区切りは plan.js（subtitlePages）で決める（意味のまとまり・息継ぎ・話す時間）
// 3. ここでは、各ページの文字から「字幕に書かなくても意味が伝わる言葉」だけを省く（音声は削らない）
//
// 省くのは、確かに意味に関わらない言葉だけ:
// - つなぎ言葉（えー・えっと・あのー・まあ・うーん）
// - ページの頭の「なので」「ですので」「それで」「そして」「それから」「そうなると」「なぜかというと」「で、」「じゃあ」
//   （前のページとのつながりは、話のテンポで伝わる）
// - ページの終わりの「〜際に」の「に」（「軽くしていく際」）
// - 動詞の終わりの形のあとの「です」（「軽くするです」→「軽くする」。話し言葉の言い方で、字幕では不自然なため）
// - 文の途中の、調子をとる「ね」（「レイヤーがね、ついていない」「その分ね」）。名詞＋助詞（が・を・は・に・で・も・と）の後、
//   または「その分」「それを」などの後の「ね」だけ（「毛先がはねる」のように言葉の一部の「ね」は省かない）
// - 形容詞の後の「という」（「まとまりやすいというメリット」→「まとまりやすいメリット」。後ろに名詞が続くときだけ）
// - ページの頭の、読点で区切られた「それ、」「あれ、」（何かを指していない、言いよどみの「それ」）
// 「でも」「もし」「ただ」「だから」など、省くと意味が変わる言葉は省かない。「それは」「それも」のように、
// 文の中で何かを指している指示語も省かない。否定の言葉・用語・数字・注意の言葉を含む部分は、省く対象にならない
const FILLER_RE = /^(?:えー+と?|えっと|ええと|あのー?|あの[、,]|まあ|まぁ|うーん|んー)[、,\s]*/;
const HEAD_CONNECTIVE_RE = /^(?:なので|ですので|それで|そして|それから|そうなると|なぜかというと|で[、,]|じゃあ)[、,\s]*/;
// 調子をとる「ね」: 漢字・カタカナの言葉＋助詞の後、「分」の後、指示語＋助詞の後。後ろに言葉が続くときだけ
const INTERJECTION_NE_RE = /((?:[一-鿿々ァ-ヶー]|それ|これ|あれ)[がをはにでもとの]|分|[一-鿿][ぁ-ゖ]?な)ね(?=[^、。\s]{2})/g;
// 形容詞（〜い）・「〜ない」の後の「という」＋名詞
const TOIU_RE = /([いな])という(?=[一-鿿々ァ-ヶ])/g;
const HEAD_DEMONSTRATIVE_RE = /^(?:それ|あれ|これ)[、,]\s*/;
// 省いた後に残る文字がこれより短いときは省かない（「なので」だけのページは、そのまま出す）
const MIN_REST = 4;

const restLen = t => t.replace(/[、。,\s]/g, '').length;

const MID_FILLER_RE = /([、,]\s*)(?:えー+と?|えっと|ええと|あのー|まあ|まぁ|うーん)[、,]/g;

// 1段目（字幕のページに分ける前）: 文の中の、調子をとる「ね」・「という」・つなぎ言葉を省く。
// 1文字ごとの時刻 times があれば、同じ文字を省いた時刻の並びも返す（ページの切り替えを話した時刻に合わせるため）。
// 返り値: { text, times, omitted }
export function cleanForDisplay(text, times = null) {
  const t = text || '';
  const drop = new Uint8Array(t.length);
  const omitted = [];
  const mark = (re, keep, label) => {
    for (const m of t.matchAll(re)) {
      const from = m.index + keep(m).length, len = m[0].length - keep(m).length;
      // 区切りの読点（「、えっと、」の最後の読点）は残す
      const end = from + len - (/[、,]$/.test(m[0]) && label !== 'ね' && label !== 'という' ? 1 : 0);
      for (let k = from; k < end; k++) drop[k] = 1;
      omitted.push(label || m[0].replace(/[、,\s]/g, ''));
    }
  };
  mark(INTERJECTION_NE_RE, m => m[1], 'ね');
  mark(TOIU_RE, m => m[1], 'という');
  mark(MID_FILLER_RE, m => m[1]);
  let out = '';
  const outTimes = [];
  for (let k = 0; k < t.length; k++) if (!drop[k]) { out += t[k]; if (times) outTimes.push(times[k]); }
  // 数を算用数字にする（「一回二回」→「1回、2回」）。ページの区切りも、そろえた後の文字で決める
  const n = formatNumbers(out, times ? outTimes : null);
  return { text: n.text, times: times ? n.times : null, omitted };
}

// 2段目（ページに分けた後）: ページの頭の、字幕に書かなくてよい言葉（つなぎ言葉・「なので」など）を省く。
// 返り値: { text, omitted: [省いた言葉] }
export function displayText(text) {
  const c = cleanForDisplay((text || '').trim());
  let t = c.text;
  const omitted = [...c.omitted];
  // つなぎ言葉・接続の言葉だけのページ（「なので」「そうなると」「えっと」）は、字幕を出さない（音声はそのまま）
  const lone = t.replace(/[、。,\s]/g, '');
  if (lone && (FILLER_RE.test(lone) || HEAD_CONNECTIVE_RE.test(lone)) && !lone.replace(FILLER_RE, '').replace(HEAD_CONNECTIVE_RE, '')) {
    return { text: '', omitted: [...omitted, lone] };
  }
  for (let guard = 0; guard < 4; guard++) {
    const m = t.match(FILLER_RE) || t.match(HEAD_CONNECTIVE_RE) || t.match(HEAD_DEMONSTRATIVE_RE);
    if (!m || restLen(t.slice(m[0].length)) < MIN_REST) break;
    omitted.push(m[0].replace(/[、,\s]+$/, ''));
    t = t.slice(m[0].length);
  }
  t = t.replace(/^[、,\s]+|[、。,\s]+$/g, '');
  // ページの終わりの「〜際に」は「〜際」（「軽くしていく際に」→「軽くしていく際」）
  if (/際に$/.test(t)) { t = t.slice(0, -1); omitted.push('に'); }
  // 話し言葉で、動詞の終わりの形に「です」をつけた所（「軽くするです」）は、字幕では「です」を書かない（意味は同じ）。
  // 「〜ないです」「〜いです」（形容詞）は自然な言い方なので、そのまま
  if (/[うくすつぬむるぐぶ]です$/.test(t) && !/(?:ます|ません)です$/.test(t)) { t = t.slice(0, -2); omitted.push('です'); }
  // 表記をそろえる（「やってみて下さい」→「やってみてください」）
  t = t.replace(/て下さい/g, 'てください');
  // ページの終わりの、調子をとる「ね」（「1〜3度ぐらいね」「その分ね」）は書かない（「ですね」「よね」は文の終わりの言い方なので残す）
  if (/(?:ぐらい|くらい|ほど|まで|から|[一-鿿々ァ-ヶー][はをにでがも]|分)ね$/.test(t) && restLen(t) - 1 >= MIN_REST) { t = t.slice(0, -1); omitted.push('ね'); }
  t = formatNumbers(t).text.replace(/[、。]+$/, '');
  return { text: t, omitted };
}

// ---------- 数の表示（算用数字にそろえる） ----------
// 回数・長さ・時間・割合など、数を表す言葉は算用数字で出す（「一回」→「1回」、「三センチ」→「3cm」）。
// - 数の言葉の後に、数える言葉（回・度・センチ…）が続くときだけ（「一緒」「一応」「統一」は変えない）
// - 慣用の言い方は漢字のまま: 「一度」だけ（もう一度・一度に・一度ずつ）、「十分」（じゅうぶん）、「二度と」
// - 同じ数え方が続く（「一回二回三回」）ときは読点で区切る（「1回、2回、3回」）。同じ数がくり返されたとき
//   （「四回四回は」＝「4回。4回は」）は、そこで文が分かれているので句点を入れる（字幕はそこで切り替わる）
// - 続いた数字1けたの並び＋数える言葉（「二三回」）は、およその範囲（「2〜3回」）。「一から三度」も「1〜3度」
const KANJI_DIGITS = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_UNITS = { 十: 10, 百: 100, 千: 1000 };
const COUNTERS = [['センチメートル', 'cm'], ['センチ', 'cm'], ['ミリ', 'mm'], ['パーセント', '%'], ['％', '%'], ['%', '%'], ['cm', 'cm'], ['mm', 'mm'],
  ['時間', '時間'], ['週間', '週間'], ['ヶ月', 'ヶ月'], ['か月', 'か月'], ['カ月', 'カ月'], ['箇所', '箇所'], ['か所', 'か所'], ['ヶ所', 'ヶ所'], ['番目', '番目'],
  ['回', '回'], ['度', '度'], ['本', '本'], ['枚', '枚'], ['個', '個'], ['人', '人'], ['歳', '歳'], ['秒', '秒'], ['分', '分'], ['日', '日'], ['年', '年'], ['割', '割'], ['段', '段'], ['つ', 'つ']];
const NUM_CHAR_RE = /[〇零一二三四五六七八九十百千0-9０-９]/;

// 漢字の数（「百二十三」「二十」「十五」）の値。位取りのない並び（「一二三」）は null
export function kanjiNumber(s) {
  if (/^[0-9０-９]+$/.test(s)) return Number(s.normalize('NFKC'));
  if (![...s].every(c => c in KANJI_DIGITS || c in KANJI_UNITS)) return null;
  if (s.length > 1 && ![...s].some(c => c in KANJI_UNITS)) return s === '〇' ? 0 : null;
  let total = 0, cur = 0, lastUnit = Infinity;
  for (const c of s) {
    if (c in KANJI_DIGITS) { if (cur) return null; cur = KANJI_DIGITS[c]; }
    else {
      const u = KANJI_UNITS[c];
      if (u >= lastUnit) return null;
      total += (cur || 1) * u; cur = 0; lastUnit = u;
    }
  }
  return total + cur;
}

function counterAt(text, i) {
  for (const [w, to] of COUNTERS) if (text.startsWith(w, i)) return { w, to };
  return null;
}

// 文字列 text（times: 1文字ごとの時刻。なくてもよい）の数を算用数字にする。返り値: { text, times, numbers: [{ value, counter, at }] }
export function formatNumbers(text, times = null) {
  const t = text || '';
  let out = '';
  const outTimes = [];
  const numbers = [];
  const put = (s, tm) => { out += s; if (times) for (let k = 0; k < s.length; k++) outTimes.push(tm); };
  let i = 0;
  let last = null; // 直前の数（同じ数え方の並びを見る）: { value, counter, end }
  while (i < t.length) {
    const tm = times ? times[i] : null;
    if (!NUM_CHAR_RE.test(t[i])) { put(t[i], tm); i++; if (!/[、,\s]/.test(t[i - 1])) last = null; continue; }
    let j = i;
    while (j < t.length && NUM_CHAR_RE.test(t[j])) j++;
    const run = t.slice(i, j);
    // 範囲（「一から三度」）
    let range = null, k = j;
    const rm = t.slice(j).match(/^(?:から|〜|~|ー)([〇零一二三四五六七八九十百千0-9０-９]+)/);
    if (rm && counterAt(t, j + rm[0].length)) { range = rm[1]; k = j + rm[0].length; }
    const c = counterAt(t, k);
    const lone = run === '一' && !range && c && c.w === '度' && !(last && last.counter === '度');
    const idiom = lone || (run === '十' && c?.w === '分') || (run === '二' && c?.w === '度' && t[k + 1] === 'と')
      || (c?.w === 'つ' && !/^[一二三四五六七八九]$/.test(run))
      // 漢字の言葉の一部（「統一」の「一」）は数にしない。前の数のすぐ後（「1回二回」）・「約」「第」の後は数
      || (i > 0 && /[一-鿿々]/.test(t[i - 1]) && !(last && last.end === out.length) && t[i - 1] !== '約' && t[i - 1] !== '第');
    if (!c || idiom) { put(run, tm); i = j; last = null; continue; }
    let label;
    const v = kanjiNumber(run), v2 = range != null ? kanjiNumber(range) : null;
    if (v != null && (range == null || v2 != null)) label = range != null ? `${v}〜${v2}` : String(v);
    else if (v == null && range == null && /^[一二三四五六七八九]{2,}$/.test(run)) {
      // 1けたの数の並び（「二三回」）: 続いた数ならおよその範囲、そうでなければ読点で並べる
      const ds = [...run].map(ch => KANJI_DIGITS[ch]);
      label = ds.every((d, n) => !n || d === ds[n - 1] + 1) ? `${ds[0]}〜${ds[ds.length - 1]}` : ds.join('、');
    } else { put(run, tm); i = j; last = null; continue; }
    // 同じ数え方が続く: 読点（同じ数のくり返しなら句点）を入れる
    if (last && last.counter === c.to && last.end === out.length) {
      const sep = last.label === label ? '。' : '、';
      put(sep, tm);
    }
    put(label + c.to, tm);
    numbers.push({ value: v ?? null, label, counter: c.to, at: out.length - label.length - c.to.length });
    last = { counter: c.to, end: out.length, label };
    i = k + c.w.length;
  }
  return { text: out, times: times ? outTimes : null, numbers };
}
