// 表示用の字幕（画面に出す短い言葉）を作る。文字起こし（話した内容をそのまま文字にしたもの）とは別の工程。
// ブラウザAPIを使わないので Node でテストできる。
//
// 1. 文字起こし（u.text）はそのまま残す（確認画面で直せる・言い直しの判断にも使う）
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
  return { text: out, times: times ? outTimes : null, omitted };
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
  return { text: t, omitted };
}
