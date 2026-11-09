// 日本語の言葉の区切り（形態素解析: kuromoji.js・辞書は IPAdic。無料・端末の中で動く）。
//
// 字幕を「文字数」ではなく「言葉のまとまり（文節）」で区切るために使う。字幕AIの文字には句読点がないため、
// 文字の種類だけでは「なっちゃうお／それが」「通らないか／なり」のような、言葉の途中の区切りが起きていた。
// 読み込み: ブラウザでは CDN（jsdelivr）から1回だけ（約17MB・ブラウザに保存される）。Node（テスト）では node_modules から。
// 読み込めないとき（通信できない等）は null を返し、字幕は今までの区切り方（plan.js の linePages）で作る。

export const KUROMOJI_BASE = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/';
let tokenizer = null;
let loading = null;
const memo = new Map();

export function hasTokenizer() { return !!tokenizer; }
export function setTokenizer(tk) { tokenizer = tk; memo.clear(); }

// 形態素解析の準備（1回だけ）。base: kuromoji の置き場所（build/kuromoji.js と dict/）
export function loadTokenizer({ base = KUROMOJI_BASE } = {}) {
  if (tokenizer) return Promise.resolve(tokenizer);
  if (loading) return loading;
  loading = (async () => {
    let km;
    if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node) {
      const { createRequire } = await import('node:module');
      const path = await import('node:path');
      const require = createRequire(import.meta.url);
      km = require('kuromoji');
      base = path.join(path.dirname(require.resolve('kuromoji/package.json')), '/');
    } else {
      // kuromoji の本体は、アプリと同じ場所（vendor/kuromoji。辞書の読み込み部分を直した版）から読み込む。
      // 別のサイトから読み込むと、中で起きた例外が Safari では「Script error.」としか分からない。辞書（約17MB）は CDN から
      if (!globalThis.kuromoji) await loadScript(new URL('../vendor/kuromoji/kuromoji.js', import.meta.url).href);
      km = globalThis.kuromoji;
      if (!km?.builder) throw new Error('言葉の区切りの辞書の仕組み（kuromoji）を読み込めませんでした');
    }
    const tk = await new Promise((resolve, reject) => {
      try { km.builder({ dicPath: base + 'dict/' }).build((err, t) => (err || !t ? reject(err || new Error('辞書を組み立てられませんでした')) : resolve(t))); }
      catch (err) { reject(err); }
    });
    setTokenizer(tk);
    return tk;
  })().catch(err => { loading = null; throw err; });
  return loading;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('言葉の区切りの辞書を読み込めませんでした'));
    document.head.appendChild(s);
  });
}

// 形態素: { s: 表記, pos: 品詞, d1: 品詞の細分類, cf: 活用形, base: 基本形, start, end（text の中の位置） }
export function tokenize(text) {
  if (!tokenizer || !text) return null;
  if (memo.has(text)) return memo.get(text);
  const out = [];
  let pos = 0;
  for (const t of tokenizer.tokenize(text)) {
    const s = t.surface_form;
    out.push({ s, pos: t.pos, d1: t.pos_detail_1, cf: t.conjugated_form, base: t.basic_form, start: pos, end: pos + s.length });
    pos += s.length;
  }
  fixTokens(out);
  if (memo.size > 5000) memo.clear();
  memo.set(text, out);
  return out;
}

// 句読点のない話し言葉で辞書が取り違えやすい所を直す（どれも、どの動画にも出てくる言い方）
function fixTokens(ts) {
  for (let i = 0; i + 1 < ts.length; i++) {
    const a = ts[i], b = ts[i + 1], c = ts[i + 2];
    // 「なっちゃうおそれがあります」: 「お（接頭詞）＋それ（代名詞）」は「おそれ（名詞）」
    if (a.s === 'お' && a.pos === '接頭詞' && b.s === 'それ' && c && /^[がはも]$/.test(c.s)) merge(ts, i, '名詞', '一般');
    // 「イメージしやすいでも若干…」: 言い切りの形の後の「でも」は、次の文の頭の接続の言葉
    if (b.s === 'でも' && b.pos === '助詞' && (a.pos === '形容詞' || a.pos === '動詞' || a.pos === '助動詞') && a.cf === '基本形' && c && /^(?:名詞|動詞|副詞|形容詞|連体詞)$/.test(c.pos)) { ts[i + 1] = { ...b, pos: '接続詞', d1: '*' }; continue; }
    // 「通らないかなり傷んでる」: 「か（助詞）＋なり（助詞）」の後に動詞・形容詞が続くなら、副詞「かなり」
    else if (a.s === 'か' && b.s === 'なり' && b.pos === '助詞' && c && /^(?:動詞|形容詞|名詞)$/.test(c.pos)) merge(ts, i, '副詞', '一般');
  }
}
function merge(ts, i, pos, d1) {
  const a = ts[i], b = ts[i + 1];
  ts.splice(i, 2, { s: a.s + b.s, pos, d1, cf: '*', base: a.s + b.s, start: a.start, end: b.end });
}

// 文節の頭になる形態素か（前の形態素 p に続けて1つのまとまりにしない）
function startsPhrase(t, p) {
  if (!p) return true;
  if (p.pos === '接頭詞') return false;
  if (p.pos === '記号') return t.pos !== '記号';
  switch (t.pos) {
    case '名詞':
      if (t.d1 === '非自立' || t.d1 === '接尾') return false;
      if (t.d1 === '代名詞' || p.d1 === '代名詞') return true; // 「理由／それは」「スタイル／それを」
      // 名詞が続く（「セルフ＋カット」「すき＋量」）のは1つの言葉。数と数える言葉も
      if (p.pos === '名詞' && p.d1 !== '非自立' && !(p.d1 === '副詞可能' && t.d1 !== '接尾')) return false;
      return true;
    case '動詞':
      if (t.d1 !== '自立') return false;
      // 「ピンピン＋した」「ふわっと＋する」: 様子の言葉と「する」
      if ((p.pos === '副詞' || p.pos === '名詞') && /^(?:する|できる)$/.test(t.base) && /^[ァ-ヶーぁ-ゖ]+$/.test(p.s) && p.s.length >= 2 && p.d1 !== '非自立') return false;
      // 「イメージ＋し」「カット＋する」: サ変の名詞と「する・できる」
      if (p.pos === '名詞' && p.d1 === 'サ変接続' && /^(?:する|できる|しまう|出来る)$/.test(t.base)) return false;
      return true;
    case '形容詞':
      return t.d1 === '自立';
    case '副詞':
      return !(p.pos === '副詞' && p.s === t.s); // 「ピン＋ピン」: 同じ言葉のくり返しは1つの言葉
    case '連体詞': case '接続詞': case '感動詞': case '接頭詞': case 'フィラー':
      return true;
    default:
      return false; // 助詞・助動詞・記号
  }
}

// 文を文節（言葉のまとまり）に分ける。返り値: [{ start, end, text, toks }]
export function phraseUnits(text) {
  const ts = tokenize(text);
  if (!ts) return null;
  const units = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (!units.length || startsPhrase(t, ts[i - 1])) units.push({ start: t.start, end: t.end, toks: [t] });
    else { const u = units[units.length - 1]; u.end = t.end; u.toks.push(t); }
  }
  for (const u of units) u.text = text.slice(u.start, u.end);
  return units;
}

// 言い切りの形の後に名詞が続く所（「落ち着かない／まとまりが」「切った／次」）。文の終わりか、後ろの名詞の説明か、
// 文字だけでは決まらない。声の間（0.18秒以上）があれば文の終わりとする（phrasePages）
export function ambiguousEnd(a, b) {
  const last = a.toks[a.toks.length - 1], first = b.toks[0];
  return (last.pos === '助動詞' || last.pos === '動詞' || last.pos === '形容詞') && last.cf === '基本形' && first.pos === '名詞'
    && !/^(?:代名詞|非自立|接尾|副詞可能)$/.test(first.d1) && !CLAUSE_NOUNS.test(first.s) && !PREDICATE_NOUNS.test(first.s);
}

function politeEnd(ts) {
  const t = ts[ts.length - 1], p = ts[ts.length - 2];
  if (t.pos === '助動詞' && /^(?:ます|です|ません)$/.test(t.s)) return true;
  if (t.pos === '助動詞' && t.s === 'た' && p && /^(?:まし|でし)$/.test(p.s)) return true;
  if (t.pos === '助動詞' && t.s === 'う' && p && /^(?:ましょ|でしょ)$/.test(p.s)) return true;
  if (t.pos === '動詞' && /^(?:ください|下さい)$/.test(t.s)) return true;
  return false;
}

// 名詞＋が/は＋ある・ない で言い切る言い方（「〜おそれがあります」「〜必要があります」）の名詞。前の言葉から区切ってよい
const PREDICATE_NOUNS = /^(?:おそれ|恐れ|可能性|必要|心配|傾向|場合|こと|もの|ため)$/;
// 区切りのはっきりした名詞（「〜際」「〜時」「〜場合」の後は、次の言葉から区切る）
const CLAUSE_NOUNS = /^(?:際|時|とき|場合|うち|あと|後|前|間)$/;
const STRONG_CONJ = /^(?:ば|と|ので|から|けど|けれど|けれども|が|のに|ても|でも|し|ながら|たら|なら)$/;

// 文節 a の後ろ（次の文節 b の前）の区切りの強さ。
// 9: 文の終わり 8: 接続の言葉の前 7: 条件・理由などの節の終わり 6: 「〜際」 5: 「〜は」 4〜4.5: 「〜で」「〜に」「〜が」
// 3: 「〜を」・名詞だけ 2: 副詞・「〜て」 1: 後ろの名詞を説明している（「短い／髪」）
export function boundaryStrength(a, b) {
  const last = a.toks[a.toks.length - 1], first = b.toks[0];
  const prev = a.toks[a.toks.length - 2];
  if (first.pos === '接続詞') return 8;
  // 丁寧な言い切り（〜ます・〜です・〜ました・〜ください・〜ましょう）の後は、次に何が続いても文の終わり
  if (politeEnd(a.toks)) return 9;
  // 名詞で言い切った後に、指示の言葉で次の文を始めた（「重さを感じやすい理由／それは」）
  if (b.toks[0].pos === '名詞' && b.toks[0].d1 === '代名詞' && /^(?:それ|これ|あれ)$/.test(b.toks[0].s) && b.toks[1] && /^[はがもを]$/.test(b.toks[1].s) && last.pos === '名詞') return 7;
  // 「高ければ／高いほど」「やれば／やるほど」: 〜ば〜ほど は1つの言い方
  if (last.s === 'ば' && b.text && /ほど/.test(b.text)) return 2;
  // 「ガタガタに／なる」「短く／なる」「軽く／する」「〜ように／やっていきましょう」: 前の言葉と後ろの動詞で1つの意味
  if (last.pos === '助詞' && /^(?:に|と)$/.test(last.s) && first.pos === '動詞' && /^(?:なる|する)$/.test(first.base)) return 2;
  if (last.s === 'に' && prev && prev.s === 'よう' && first.pos === '動詞') return 2.5;
  // 句読点の後は区切る。「1〜3度」「15%」の記号・続けて数えた所（「1回、2回、3回」）では区切らない
  if (last.pos === '記号') {
    if (last.s === '、' && prev && /数|接尾|助数詞/.test(prev.d1 + (a.toks[a.toks.length - 3]?.d1 || '')) && /^[0-9０-９一二三四五六七八九十]/.test(b.text || first.s)) return 0.5;
    return /^[、。！？!?,，]$/.test(last.s) ? 7 : 0;
  }
  // 「逆に」「特に」「まず」: 後ろの言葉を導く言葉は、後ろと一緒にする（「逆に／低いもの」と分けない。声の間があっても）
  if (/^(?:逆に|特に|さらに|次に|最後に|まず|まずは|実は|本当に|あとは|一度|もし)$/.test(a.text)) return 1;
  // 打ち消し・「〜く／する・なる」の前では区切らない（「軽く／しないように」と分けると、前のページだけで意味が逆になる）
  if (/^(?:ない|なく|なかっ|なけれ|ません|ず)/.test(b.text || '')) return 0;
  if (last.pos === '形容詞' && /連用/.test(last.cf) && first.pos === '動詞' && /^(?:する|なる)$/.test(first.base)) return 0;
  if (first.pos === '記号' && !/^[、。！？!?]$/.test(first.s)) return 0;
  // 「切った方が／よい」「〜した方がいい」: 方が＋よい・いい は1つの言い方
  if (last.s === 'が' && prev && /^(?:方|ほう)$/.test(prev.s) && first.pos === '形容詞') return 1;
  if (last.pos === '助詞' && /終助詞/.test(last.d1) && /^(?:か|よ|ね|な|わ|ぞ|の)$/.test(last.s)) return 9;
  if (last.pos === '助詞' && last.d1 === '接続助詞') {
    // 「〜て」の後に動詞が続く（「濡らして／切る」）のは1つの動作。名詞などで新しい言葉が始まる（「使って／髪の量を」）のは節の切れ目
    if (/^(?:て|で)$/.test(last.s)) return /^(?:名詞|連体詞|副詞|接頭詞)$/.test(first.pos) ? 4 : 2;
    // 「〜すると」の後に問いかけが続く（「軽くするとどうなってしまうのか」）ときは、つなげて1つの問いにする
    if (last.s === 'と') return /^(?:どう|何|なに|なぜ|どこ|どんな)/.test(b.text || '') ? 4 : 7;
    return STRONG_CONJ.test(last.s) ? 7 : 3;
  }
  if (last.pos === '助動詞' && last.cf === '仮定形') return 7; // 〜たら・〜なら
  if (last.pos === '助詞' && last.d1 === '係助詞') return /^(?:は|も)$/.test(last.s) ? 5 : 4;
  if (last.pos === '助詞' && last.d1 === '格助詞') {
    if (last.s === 'を') return 3;
    if (last.s === 'が') return 4;
    if (last.s === 'の') return 1;
    if (last.s === 'に' && prev && CLAUSE_NOUNS.test(prev.s)) return 6.8; // 〜際に・〜時に
    return 4.5;
  }
  if (last.pos === '助詞' && last.d1 === '連体化') return 1;
  // 「〜したり／〜したり」: 並べて言う所は、節の切れ目に近い（「短くなりすぎちゃったり／思ったスタイルにならない」）
  if (last.pos === '助詞' && last.d1 === '並立助詞' && /^(?:たり|だり)$/.test(last.s)) return 6.5;
  if (last.pos === '助詞' && last.d1 === '副助詞') return 3;
  if (last.pos === '名詞' && CLAUSE_NOUNS.test(last.s) && a.toks.length > 1) return 6.8; // 〜していく際
  const ender = (last.pos === '助動詞' || last.pos === '動詞' || last.pos === '形容詞') && last.cf === '基本形';
  if (ender) {
    // 言い切りの形の後に名詞が続くなら、後ろの名詞の説明（「短くなっちゃう／おそれ」「細かな／髪」）
    if (first.pos === '名詞' && /^(?:副詞可能|形容動詞語幹)$/.test(first.d1) && b.toks.length === 1) return 3; // 「重くなった／ギリギリ結べる」: 2つの説明の切れ目
    if (first.pos === '名詞' && first.d1 !== '代名詞') return PREDICATE_NOUNS.test(first.s) && b.toks.some(t => /^[がは]$/.test(t.s)) ? 5 : 1;
    if (/^(?:ます|です|た|だ|ない|ん|う|ぬ)$/.test(last.s) || last.pos !== '助動詞') return 9;
  }
  if (last.pos === '副詞' || last.pos === '連体詞' || last.pos === '接頭詞') return last.pos === '副詞' ? 2 : 0.5;
  // 後ろの名詞を説明する形（「細かな／短い髪」「きれいな／髪」）: 後ろとつなげる（声の間があっても）
  if ((last.pos === '助動詞' || last.pos === '形容詞') && /体言接続|連体/.test(last.cf)) return 1;
  // 「ギリギリ結べる」「全部切る」: 副詞のように使う名詞は、後ろの言葉とつなげる
  if (last.pos === '名詞' && /^(?:副詞可能|形容動詞語幹)$/.test(last.d1) && a.toks.length === 1 && first.pos === '動詞') return 1;
  // 名詞の後に助詞がない所: 話し言葉で「が」を省いた（「まとまり（が）つかない」）ことが多いので、後ろとつなげておく。
  // 名詞だけで言い切って、はっきり間をあけた所（「結論／傷んでなかったら」）は、phrasePages が声の間で区切る
  if (last.pos === '名詞') return 2;
  if ((last.pos === '形容詞' || last.pos === '助動詞') && /連用/.test(last.cf)) return 2; // 「短く／なる」
  return 2;
}

// 字幕で省く言葉（声は残し、字幕の文字だけ省く）。形態素でわかる所だけ。返り値: [{ start, end, word }]
// keep: 省かない言葉（編集メモで「字幕に残す」と書いた言葉）。extra: 省く言葉（編集メモで「字幕で省く」と書いた言葉）
const OMIT_CONJ = /^(?:それとも|でも|ちなみに)$/;
const OMIT_DEGREE = /^(?:かなり|とても|非常に|めっちゃ|めちゃくちゃ)$/;
export function subtitleOmissions(text, { keep = [], extra = [] } = {}) {
  const ts = tokenize(text);
  if (!ts) return null;
  const out = [];
  const kept = w => keep.some(k => k && w.includes(k));
  const add = (start, end) => { const word = text.slice(start, end); if (!kept(word)) out.push({ start, end, word }); };
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i], n = ts[i + 1], n2 = ts[i + 2];
    const atHead = i === 0 || ts[i - 1].pos === '記号' || isEnd(ts, i - 1);
    // つなぎの言葉（文・節の頭の「それとも」「でも」「ちなみに（ですが）」）
    if (OMIT_CONJ.test(t.s) && (t.pos === '接続詞' || (t.s === 'ちなみに')) && (atHead || t.s !== 'でも')) {
      let end = t.end;
      if (t.s === 'ちなみに' && n && n.s === 'です' && n2 && n2.s === 'が') end = n2.end;
      add(t.start, end); continue;
    }
    // 文の頭の「それは」（「それは／トップの根元付近です」）: 答えの言葉が続くときだけ。「それは何か」「それはなぜか」は残す
    if (t.s === 'それ' && n?.s === 'は' && atHead && n2 && n2.pos === '名詞' && !/^(?:何|なぜ|どこ|いつ|どう)/.test(n2.s)) { add(t.start, n.end); i++; continue; }
    // 程度の言葉（「かなり傷んでる」）
    // 程度の言葉は、人・物を説明している所（「かなり傷んでる方は」）だけ省く。言い切りにかかる所（「かなり難しいです」）は伝えたい言葉なので残す
    if (t.pos === '副詞' && OMIT_DEGREE.test(t.s) && n && /^(?:動詞|形容詞|名詞|副詞)$/.test(n.pos) && describesNoun(ts, i + 1)) { add(t.start, t.end); continue; }
    // 前の話を指す飾りの言葉（「そのようなやり方」）。後ろに名詞が続くときだけ
    if (/^(?:その|この)$/.test(t.s) && n && n.s === 'よう' && n2 && n2.s === 'な' && ts[i + 3]?.pos === '名詞') { add(t.start, n2.end); i += 2; continue; }
    if (/^(?:そういう|こういう|そういった|こういった)$/.test(t.s) && n?.pos === '名詞') { add(t.start, t.end); continue; }
    // 「〜したいのであれば」の「のであれば」（「〜したい」だけで伝わる）
    if (t.s === 'の' && t.d1 === '非自立' && ts[i - 1]?.s === 'たい' && n?.s === 'で' && n2?.s === 'あれ' && ts[i + 3]?.s === 'ば') { add(t.start, ts[i + 3].end); i += 3; continue; }
  }
  for (const w of extra) {
    if (!w) continue;
    for (let k = text.indexOf(w); k >= 0; k = text.indexOf(w, k + w.length)) if (!out.some(o => o.start < k + w.length && o.end > k)) add(k, k + w.length);
  }
  return out.sort((a, b) => a.start - b.start);
}

// i 番目から始まる言葉が、後ろの名詞（「方」「人」「もの」）を説明しているか（言い切らずに名詞へ続く）
function describesNoun(ts, i) {
  for (let k = i; k < Math.min(ts.length, i + 6); k++) {
    const t = ts[k], n = ts[k + 1];
    if (!n) return false;
    if ((t.pos === '動詞' || t.pos === '形容詞' || t.pos === '助動詞') && t.cf === '基本形') return n.pos === '名詞' && n.d1 !== '代名詞';
    if (t.pos === '助詞' && t.d1 !== '接続助詞') return false;
  }
  return false;
}

// i 番目の形態素で文が終わっているか（次が新しい文の頭）
function isEnd(ts, i) {
  const t = ts[i], n = ts[i + 1];
  if (!t || !n) return false;
  if (t.pos === '助詞' && /終助詞/.test(t.d1)) return true;
  if ((t.pos === '助動詞' || t.pos === '動詞' || t.pos === '形容詞') && t.cf === '基本形' && n.pos !== '助詞' && n.pos !== '助動詞' && n.pos !== '名詞') return true;
  return false;
}
