// 編集プランを作る純粋関数（ブラウザAPIを使わないので Node でテストできる）
import { analyzeContent } from './content.js';

export const FRAME_SEC = 0.05; // 音量を測る単位（50ms）
export const OUT_W = 1080;
export const OUT_H = 1920;
export const FPS = 30;

// カット解説でよく出る言葉。字幕にこれらが含まれる場面を優先して残す
export const KEYWORDS = [
  'カット', 'ブロッキング', 'ブロック', 'パネル', '引き出し', '角度', 'セクション', 'スライス',
  'ガイド', 'レイヤー', 'グラデーション', 'ワンレン', 'ボブ', 'ショート', '前髪', '襟足', 'えりあし',
  'もみあげ', 'サイド', 'トップ', 'バック', '毛先', '量感', 'すき', 'セニング', 'ハサミ', 'シザー',
  'チョップ', 'ポイントカット', 'スライド', '段', '重さ', '軽さ', '丸み', '前下がり', '後ろ下がり',
  '仕上がり', 'ドライ', 'ブロー', '乾かし', 'コツ', '大事', '重要', '注意', 'ビフォー', 'アフター',
];
const DEGREE_RE = /[0-9０-９]+\s*度/;


// 文字起こしに先に与える「話題と用語」。Whisper はこれに引っぱられて専門用語を正しく書きやすくなる
export const ASR_PROMPT = '美容師のカット解説です。ブロッキング、スライス、パネル、0度、45度、90度、ガイド、毛先、前下がり、ボブ、レイヤー、グラデーション、セニング、量感、軽さ、重さ、丸み、シルエット、襟足、もみあげ、前髪、ドライ、ブロー。';

// 美容の専門用語の辞書。variants は Whisper がよく書き間違える形。
// ここから作るのは「修正案」だけで、実際に置き換えるかは音声で確かめてから決める（transcribe-worker.js）
// reading はカタカナの読み。書き間違いが読みと同じ（エリアシ → 襟足）なら、聞こえた音は同じなので文字の種類を整えるだけ
export const BEAUTY_TERMS = [
  { term: 'ショートボブ', variants: ['ショート部分', 'ショートボーブ', 'ショートボップ'] },
  { term: 'ショート', variants: ['ショット'] },
  { term: 'ボブ', variants: ['ボーブ', 'ボップ'] },
  { term: '前下がり', reading: 'マエサガリ', variants: ['前さがり', 'まえさがり', '前下り', '前坂'] },
  { term: '前上がり', reading: 'マエアガリ', variants: ['前さあがり', 'まえあがり'] },
  { term: 'グラデーション', variants: ['ブラデーション', 'グラデイション', 'クラデーション'] },
  { term: 'レイヤー', variants: ['レーヤー', 'レイア', 'レイヤ'] },
  { term: 'ブロッキング', variants: ['ブロッキン', 'ブロックキング', 'プロッキング'] },
  { term: 'セニング', variants: ['セーニング', 'センニング', 'せニング', 'セイニング'] },
  { term: '毛量調整', reading: 'モウリョウチョウセイ', variants: ['模様調整', '毛量調性', '猛量調整', '盲料調整', '猛料調整', 'もうりょう調整'] },
  { term: '毛量', reading: 'モウリョウ', variants: ['猛量', '盲料', '猛料', 'もうりょう'] },
  { term: '毛先', reading: 'ケサキ', variants: ['下先', '下さき', '傾作', '毛さき', 'けさき', '気先'] },
  { term: '襟足', reading: 'エリアシ', variants: ['エリアシ', 'えりあし', '襟脚', 'エリ足'] },
  { term: 'もみあげ', reading: 'モミアゲ', variants: ['模樣上', '模様上', 'もみ上げ', 'モミアゲ', '揉み上げ'] },
  { term: 'スライス', variants: ['スライズ', 'スライスト'] },
  { term: 'パネル', variants: ['ハネル', 'カネル', 'バネル'] },
  { term: 'ガイド', variants: ['ガイト'] },
  { term: 'サイドは', variants: ['再度は'] }, // 「再度」は普通の言葉なので「再度は」の形だけ
  { term: '量感', reading: 'リョウカン', variants: ['両感', '料感', '量勘', 'ローカー', '涼感'] },
  { term: 'シルエット', variants: ['シルエッド', 'シルエト'] },
  { term: 'すきバサミ', reading: 'スキバサミ', variants: ['スキーバサミ', 'すきばさみ', 'スキバサミ', '隙鋏', '好きバサミ'] },
  { term: 'チョップカット', variants: ['チョップカッと', 'チャップカット', 'チョップカッド', 'ちょっとカット'] },
  { term: '丸み', reading: 'マルミ', variants: ['マルミ', 'まるみ'] },
  { term: '軽さ', reading: 'カルサ', variants: ['カルサ'] },
  { term: '0度', variants: ['ゼロド', 'ゼロ度', '零度'] },
  { term: '45度', variants: ['45ド', '四十五度'] },
  { term: '90度', variants: ['90ド', '九十度'] },
];

const isKata = c => !!c && /[\u30a0-\u30ff]/.test(c);
const toKata = t => t.replace(/[\u3041-\u3096]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

// 文の中から、辞書の用語への修正案を作る。{ index, from, to } の配列（重なりは長いものを優先）
export function proposeCorrections(text) {
  const t = text || '';
  const found = [];
  for (const { term, variants } of BEAUTY_TERMS) {
    for (const v of variants) {
      let i = t.indexOf(v);
      while (i >= 0) {
        // カタカナの書き間違いは、より長いカタカナ語の一部（例: スライド の ライド）では使わない
        const inWord = isKata(v[0]) && isKata(t[i - 1]) || isKata(v[v.length - 1]) && isKata(t[i + v.length]);
        if (!inWord && !t.startsWith(term, i) && !t.slice(Math.max(0, i - term.length), i + v.length).includes(term)) {
          const reading = BEAUTY_TERMS.find(x => x.term === term).reading;
          found.push({ index: i, from: v, to: term, kind: reading && toKata(v) === reading ? 'reading' : 'variant' });
        }
        i = t.indexOf(v, i + 1);
      }
    }
  }
  // 辞書にない書き間違い: カタカナ語が用語と1〜2文字だけ違う場合（例: ブラデーション → グラデーション）
  const kataTerms = BEAUTY_TERMS.filter(x => [...toKata(x.term)].every(isKata));
  for (const m of t.matchAll(/[\u30a0-\u30ff]{3,}/g)) {
    for (const { term } of kataTerms) {
      const k = toKata(term);
      if (m[0] === k || m[0].includes(k)) continue;
      const limit = k.length >= 6 ? 2 : 1;
      if (Math.abs(m[0].length - k.length) <= limit && editDistance(m[0], k) <= limit) found.push({ index: m.index, from: m[0], to: term, kind: 'fuzzy' });
    }
  }
  found.sort((a, b) => a.index - b.index || b.from.length - a.from.length);
  const out = [];
  for (const f of found) {
    const last = out[out.length - 1];
    if (last && f.index < last.index + last.from.length) continue;
    out.push(f);
  }
  return out;
}

// 修正案を採用する基準（音声で確かめたときの、元の文に対する対数尤度の差の下限）
export const CORRECTION_MARGIN = { reading: 20, variant: 6, fuzzy: 3 };

export function applyCorrection(text, c) {
  return text.slice(0, c.index) + c.to + text.slice(c.index + c.from.length);
}

// 字幕から取り除くつなぎ言葉（文頭・読点の後のものだけ）。「Aと」は「えーと」の聞き間違い
const FILLER_HEAD_RE = /(^|[、。\s])(?:えーっと|えーと|えっと|ええと|Aと|あのー|あの、|えー|ええ、|まあ、|うーん)[、,\s]*/g;
// 助詞の直後に入る「えーと」（「全体を、えーと、四つに」→ Whisper は「全体をAと4つに」と書く）
const FILLER_MID_RE = /(?<=[をはにでがも])(?:、?\s*)(?:えーっと|えーと|えっと|Aと)(?:[、,\s]*)/g;

// 文字起こし結果を字幕向けに整える（つなぎ言葉の除去と、空白・句読点の整理だけ。言葉の置き換えはしない）
export function cleanSubtitle(text) {
  let t = (text || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i++) t = t.replace(FILLER_HEAD_RE, '$1');
  t = t.replace(FILLER_MID_RE, '');
  return t.replace(/^[、。\s]+/, '').replace(/、{2,}/g, '、').replace(/\s*([、。])\s*/g, '$1').trim();
}

// プロンプトの文がそのまま出てきたもの（無音部分などで起きる）
export function isPromptEcho(text) {
  const t = (text || '').replace(/\s/g, '');
  if (!t) return false;
  if (t.includes('美容師のカット解説です')) return true;
  const terms = t.split('、').filter(Boolean);
  return terms.length >= 5 && terms.filter(w => ASR_PROMPT.includes(w)).length / terms.length > 0.8;
}

// Whisper が無音部分で出しがちな定型文
const HALLUCINATION_RE = /ご視聴ありがとうございました|チャンネル登録|字幕は|お疲れ様でした$/;

const FILLER_RE = /(えーっと|えーと|えっと|えー+|あのー+|あの|うーん|うん|まあ|ま、)/g;

export function percentile(values, p) {
  const arr = Array.from(values).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const i = Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))));
  return arr[i];
}

// 音量（50msごとの dB）から話している区間を求める。
// regions: 前後に少し余白をつけた区間（文字起こし・字幕の割り当てに使う）
// voice: 声そのものの区間（余白なし）。自動カットの区切りはこちらから作る
// sounds: 声ではなく、ハサミのような短い音が続いているだけの区間（話している区間から外す）
//
// 声の出始め・語尾は小さな音なので、大きな音（threshold）で見つけた区間を、
// 小さな音（low）が続くところまで前後に広げる（言葉の頭・消えていく語尾を切らない）
export function detectSpeech(rmsDb, opts = {}) {
  const minGap = opts.minGap ?? 0.3;      // これより短い無音はつなげる
  const minLen = opts.minLen ?? 0.25;    // これより短い音は無視
  const pad = opts.pad ?? 0.1;           // 前後に残す余白
  const floor = percentile(rmsDb, 0.1);
  const peak = percentile(rmsDb, 0.95);
  const duration = rmsDb.length * FRAME_SEC;
  if (peak - floor < 6) return { floor, peak, threshold: peak + 1, low: peak + 1, regions: [], voice: [], sounds: [] };
  const threshold = Math.max(floor + 8, floor + (peak - floor) * 0.35);
  const low = Math.min(threshold - 2, Math.max(floor + 5, floor + (peak - floor) * 0.18));

  const raw = [];
  let start = -1;
  for (let i = 0; i <= rmsDb.length; i++) {
    const on = i < rmsDb.length && rmsDb[i] > threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      raw.push({ start: start * FRAME_SEC, end: i * FRAME_SEC, on: i - start });
      start = -1;
    }
  }
  const merged = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < minGap) { last.end = r.end; last.on += r.on; last.runs.push(r); }
    else merged.push({ ...r, runs: [r] });
  }
  // ハサミの音のすぐ後に話し始めた（ハサミの音と声がつながった）区間は、前後の「短い音（1〜2コマ）が2つ以上続く部分」を
  // 切り離してから判定する（声の前の短い音が1つだけなら、言葉の出始めかもしれないので残す）
  const SHORT_RUN = 2;
  const split = [];
  for (const r of merged) {
    const long = r.runs.filter(x => x.on > SHORT_RUN);
    let a = long.length ? r.runs.indexOf(long[0]) : 0, b = long.length ? r.runs.indexOf(long[long.length - 1]) : r.runs.length - 1;
    if (a < 2) a = 0;
    if (r.runs.length - 1 - b < 2) b = r.runs.length - 1;
    if (!long.length || (a === 0 && b === r.runs.length - 1)) { split.push(r); continue; }
    const part = runs => ({ start: runs[0].start, end: runs[runs.length - 1].end, on: runs.reduce((s, x) => s + x.on, 0), runs });
    if (a > 0) split.push(part(r.runs.slice(0, a)));
    split.push(part(r.runs.slice(a, b + 1)));
    if (b < r.runs.length - 1) split.push(part(r.runs.slice(b + 1)));
  }
  const voice = [], sounds = [];
  for (const r of split) {
    const density = r.on * FRAME_SEC / (r.end - r.start);
    if (r.end - r.start < minLen) {
      if (density < 1 && r.runs.length > 1) sounds.push({ start: r.start, end: r.end, density });
      continue;
    }
    // 大きな音の割合が低い区間は、短い音（ハサミなど）がとびとびに鳴っているだけ
    if (density < (opts.minDensity ?? 0.5) || r.runs.every(x => x.on <= SHORT_RUN)) { sounds.push({ start: r.start, end: r.end, density }); continue; }
    let a = Math.round(r.start / FRAME_SEC), b = Math.round(r.end / FRAME_SEC);
    const prevEnd = voice.length ? Math.round(voice[voice.length - 1].end / FRAME_SEC) : 0;
    for (let k = 0; k < 6 && a - 1 > prevEnd && rmsDb[a - 1] > low; k++) a--;       // 出始め: 最大0.3秒
    for (let k = 0; k < 9 && b < rmsDb.length && rmsDb[b] > low; k++) b++;          // 語尾: 最大0.45秒
    const last = voice[voice.length - 1];
    if (last && a * FRAME_SEC - last.end < minGap) last.end = b * FRAME_SEC;
    else voice.push({ start: a * FRAME_SEC, end: b * FRAME_SEC });
  }
  const regions = [];
  for (const v of voice) {
    const r = { start: Math.max(0, v.start - pad), end: Math.min(duration, v.end + pad) };
    const last = regions[regions.length - 1];
    // 余白で重なったものをまとめる
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else regions.push(r);
  }
  return { floor, peak, threshold, low, regions, voice, sounds };
}

// ---------- 自然なカット ----------

// 話のテンポごとの「間」の残し方（秒）。
// lead: 話し始めの前に残す時間 / tail: 話し終わりの後に残す時間（消えていく語尾・息）
// keepGap: 文の中でこれより短い間はそのまま残す / maxGap: 文の中の長い間は、ここまで縮める
// natural は手動編集のお手本（無音の間の中央値 約0.2秒・90%が0.33秒以下・最長0.44秒）に合わせている。
// 語尾は detectSpeech で消えていく小さな音まで含めてから tail を足すので、間を詰めても語尾は切れない
// 文の中の息継ぎの間は、細かい声の区間（fineSpeech）のすき間で測る（splitAtPauses）。
// natural は、手動編集2本（tests/fixtures/img5830・bob）の音声で同じだった間の長さ（話の途中の間の中央 0.15秒・
// 90% 0.30秒・最長 0.45秒）になるように決めた。1本の動画の長さに合わせたものではない
export const PACES = {
  natural: { lead: 0.1, tail: 0.18, keepGap: 0.26, minGap: 0.2, maxGap: 0.3 },
  tempo: { lead: 0.08, tail: 0.15, keepGap: 0.22, minGap: 0.16, maxGap: 0.24 },
};

// 声の区間 segs を、その中の息継ぎの間（細かい声の区間 fine のすき間が minGap 以上）で分ける。
// 区間の外側の端は、小さな音まで含めた声の区間（detectSpeech の voice）だと前後に最大0.3〜0.45秒広いので、
// 細かい声の区間の端から EDGE_LEAD・EDGE_TAIL まで（お手本の手動編集は、声の 0.1秒前から 0.1〜0.17秒後まで残していた）
const EDGE_LEAD = 0.05, EDGE_TAIL = 0.07;
export function splitAtPauses(segs, fine, minGap) {
  const out = [];
  for (const s0 of segs) {
    const f = (fine || []).filter(r => r.end > s0.start && r.start < s0.end);
    const s = f.length ? { ...s0, start: Math.max(s0.start, f[0].start - EDGE_LEAD), end: Math.min(s0.end, f[f.length - 1].end + EDGE_TAIL) } : s0;
    let cur = { ...s };
    for (let k = 0; k + 1 < f.length; k++) {
      const a = f[k].end, b = f[k + 1].start;
      if (b - a < minGap || a <= cur.start || b >= s.end) continue;
      out.push({ ...cur, end: a });
      cur = { ...s, start: b };
    }
    out.push(cur);
  }
  return out;
}

// [a, b] の中で一番音の小さい時刻（3コマの平均）。文と文がつながって聞こえる所の区切りに使う
export function quietestPoint(rmsDb, a, b) {
  let best = (a + b) / 2, bestDb = Infinity;
  for (let t = a; t <= b; t += FRAME_SEC) {
    const i = Math.floor(t / FRAME_SEC);
    const db = ((rmsDb[i - 1] ?? -120) + (rmsDb[i] ?? -120) + (rmsDb[i + 1] ?? -120)) / 3;
    if (db < bestDb) { bestDb = db; best = t; }
  }
  return best;
}

// 声の区間 segs（時刻順・余白なし）から、書き出す範囲（pieces）を作る。
// - 文の中の短い間はそのまま、長い間（考えながら話している間など）は自然な長さまで縮める
// - 話し始めの前・話し終わりの後に少し余白を残す（語尾や息を切らない）。ただし前後の声には食い込まない
// before / after: 使える無音の範囲（前の声の終わり・次の声の始まり）
export function shapePieces(segs, before, after, pace = PACES.natural) {
  if (!segs.length) return [];
  const out = [];
  let cur = { start: Math.max(before, segs[0].start - pace.lead), end: segs[0].end };
  for (let i = 1; i < segs.length; i++) {
    const g = segs[i].start - segs[i - 1].end;
    if (g <= pace.keepGap) { cur.end = segs[i].end; continue; }
    // 長い間ほど少しだけ長く残す（すべて同じ長さにすると機械的に聞こえる）
    const keep = pace.minGap + (pace.maxGap - pace.minGap) * Math.min(1, (g - pace.keepGap) / 1.5);
    cur.end = segs[i - 1].end + keep * 0.6; // 語尾の後を多めに残す
    out.push(cur);
    cur = { start: segs[i].start - keep * 0.4, end: segs[i].end };
  }
  cur.end = Math.min(after, cur.end + pace.tail);
  out.push(cur);
  return out;
}

// 話し始めの言葉が、前の文に続くことを表すもの（前の文がないと意味が通じない）
const CONTINUES_PREV_RE = /^(?:なので|ですので|だから|それで|そして|そうすると|すると|そのため|なぜなら|というのも|つまり|ただ、|ただし|でも|けど|あと、|それから|で、|そうならない|そうしないと)/;
// 文が終わっていない（次の文に続く）語尾
const CONTINUES_NEXT_RE = /(?:[、,]|て|で|ので|から|けど|けれど|けれども|が|と|し)$/;

// 文字起こしがないとき、これより短い間でつながった声は同じ文の続きとみなす（考えながら話す間を含む）
const SAME_SENTENCE_GAP = 1.2;

// 前後の文とつながっていて、片方だけ残すと話が通じない組み合わせに印をつける（u.linkNext）
export function linkSentences(units) {
  const speech = units.filter(u => u.kind === 'speech' && !u.excluded);
  for (let i = 0; i + 1 < speech.length; i++) {
    const a = speech[i], b = speech[i + 1];
    if (b.start - a.end > 4) continue;
    if (!a.text && !b.text) {
      // 文字起こしのない声どうし: 短い間でつながっていれば、文の途中で切らないよう一緒に扱う
      if ((b.voiceStart ?? b.start) - (a.voiceEnd ?? a.end) < SAME_SENTENCE_GAP) a.linkNext = b.id;
      continue;
    }
    if (!a.text || !b.text) continue;
    const t = a.text.replace(/\s+$/, '');
    if (CONTINUES_PREV_RE.test(b.text.trim()) || (!/[。！？!?]$/.test(t) && CONTINUES_NEXT_RE.test(t))) a.linkNext = b.id;
  }
}

// 文字起こしに送る音声の区切り（無音部分は送らない）
// speech: 区間の中で話している時間（文字起こしの結果が短すぎないかを確かめるのに使う）
export function transcriptionWindows(regions, maxLen = 28) {
  const windows = [];
  let cur = null;
  for (const r of regions) {
    if (cur && r.end - cur.start <= maxLen) { cur.end = r.end; cur.speech += r.end - r.start; cur.parts.push({ start: r.start, end: r.end }); }
    else {
      if (cur) windows.push(cur);
      cur = { start: r.start, end: r.end, speech: r.end - r.start, parts: [{ start: r.start, end: r.end }] };
    }
  }
  if (cur) windows.push(cur);
  return windows;
}

// ReazonSpeech の読み方（3通り）と、結果の合わせ方。
// 字幕AIの誤りのほとんどは「言葉を落とす」こと。どこで落とすかは、読む音声の区切り方で大きく変わる
// （同じ音声でも、区切り方しだいで文字の誤り率 3%〜35%）。とくに、文の途中で区切った窓や、長い無音をはさむ窓で落としやすい。
// そこで、区切り方の違う3通りで読み、どれかが落とした言葉を、ほかの読み方の結果で補う（文字の並びを照らし合わせて差し込む）。
//   A: 30秒ごとの窓（区切りは近くの一番静かな所）
//   B: A と15秒ずらした窓（A の区切りの所が、B では窓の真ん中になる）
//   C: はっきりした間（0.5秒以上）で分けた話のまとまりごと（無音の後の話を落とさないように）
// 手動編集の実際の音声2本・疑似素材2本で、まとまりごとに読む方法（誤り率 15〜18%）より少ない（3〜11%）
export const ASR_WINDOW = 30;
export function asrWindows(regions, rmsDb, L = ASR_WINDOW) {
  if (!regions.length) return [];
  // 0.3秒より短い間（言葉の中の「ッ」や息つぎ）では区切らない
  const merged = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < 0.3) last.end = r.end;
    else merged.push({ start: r.start, end: r.end });
  }
  const T0 = merged[0].start, T1 = merged[merged.length - 1].end;
  const quietAt = (t, r) => {
    if (!rmsDb) return t;
    const i0 = Math.max(Math.ceil(T0 / FRAME_SEC), Math.round((t - r) / FRAME_SEC)), i1 = Math.min(Math.floor(T1 / FRAME_SEC), Math.round((t + r) / FRAME_SEC));
    let k = Math.round(t / FRAME_SEC);
    for (let i = i0; i <= i1; i++) if (rmsDb[i] < (rmsDb[k] ?? Infinity)) k = i;
    return k * FRAME_SEC;
  };
  const speechIn = (a, b) => merged.reduce((s, r) => s + Math.max(0, Math.min(b, r.end) - Math.max(a, r.start)), 0);
  const grid = (off, pass) => {
    const cuts = [T0];
    for (let t = T0 + (off || L); t < T1 - 3; t = cuts[cuts.length - 1] + L) cuts.push(quietAt(t, 1.5));
    cuts.push(T1);
    const out = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i], b = cuts[i + 1];
      if (b - a < 0.3) continue;
      // 窓の頭は区切りの所から読む（前の窓の言葉を読まない）。終わりは少し先まで読む
      out.push({ start: a, end: b, padStart: 0.05, padEnd: 0.3, lo: a - 0.06, hi: b, speech: speechIn(a, b), pass });
    }
    return out;
  };
  // C: 0.5秒以上の間で分けた話のまとまり。30秒を超えるまとまりは、一番長い間（なければ一番静かな所）で分ける
  const groups = [];
  for (const r of merged) {
    const g = groups[groups.length - 1];
    if (g && r.start - g[g.length - 1].end < 0.5) g.push(r);
    else groups.push([r]);
  }
  const cutLongest = rs => {
    const a = rs[0].start, b = rs[rs.length - 1].end;
    if (b - a <= L) return [rs];
    if (rs.length === 1) {
      const t = quietAt((a + b) / 2, (b - a) / 4);
      return [...cutLongest([{ start: a, end: t }]), ...cutLongest([{ start: t, end: b }])];
    }
    let k = 1;
    for (let i = 2; i < rs.length; i++) if (rs[i].start - rs[i - 1].end > rs[k].start - rs[k - 1].end) k = i;
    return [...cutLongest(rs.slice(0, k)), ...cutLongest(rs.slice(k))];
  };
  const C = groups.flatMap(cutLongest).map(rs => {
    const a = rs[0].start, b = rs[rs.length - 1].end;
    return { start: a, end: b, padStart: 0.3, padEnd: 0.3, lo: a - 0.35, hi: b + 0.3, speech: speechIn(a, b), pass: 'C', parts: rs.map(r => ({ ...r })) };
  });
  return [...grid(0, 'A'), ...grid(L / 2, 'B'), ...C];
}

// 文字の並び a・b を照らし合わせる（編集距離）。返り値は [種類, a の番号, b の番号] の並び
function alignChars(a, b) {
  const n = a.length, m = b.length, D = Array.from({ length: n + 1 }, (_, i) => new Int32Array(m + 1).fill(0).map((_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) ops.push(['m', --i, --j]);
    else if (j > 0 && D[i][j] === D[i][j - 1] + 1) ops.push(['ins', null, --j]);
    else ops.push(['del', --i, null]);
  }
  return ops.reverse();
}

// base（文字の列）に、other にだけある文字の並び（minRun 文字以上）を差し込む。違う文字の所は base のまま
export function fillDeletions(base, other, minRun = 2) {
  const ops = alignChars(base.map(k => k.s), other.map(k => k.s));
  const out = [];
  let run = [];
  const flush = () => { if (run.length >= minRun) out.push(...run); run = []; };
  for (const [op, i, j] of ops) {
    if (op === 'ins') { run.push(other[j]); continue; }
    flush();
    out.push(base[i]);
  }
  flush();
  return out;
}

// 否定の言葉（意味が逆になるため、聞き落とすと大きな誤りになる）
const NEGATION_RE = /ない|なかっ|ません|ず[にのともで、。]|ず$|ダメ|だめ/;
export const hasNegation = text => NEGATION_RE.test(text || '');

// 3通りの結果（results[窓の番号] = chunks）を合わせて、1つの結果（文字ごとの時刻つき）にする。
// まとまり（C の窓）ごとに、A を基にして B・C で落とした言葉を補う。返り値の passes は、読み方ごとの文字（確認用）
export function mergeAsrPasses(windows, results) {
  if (!windows.some(w => w.pass)) return windows.flatMap((_, k) => results[k] || []);
  const tokensOf = pass => windows.flatMap((w, k) => w.pass === pass ? (results[k] || []).flatMap(c => c.tokens || []) : []).sort((x, y) => x.t - y.t);
  const P = { A: tokensOf('A'), B: tokensOf('B'), C: tokensOf('C') };
  const segs = windows.filter(w => w.pass === 'C');
  const out = [];
  segs.forEach((g, j) => {
    const lo = j ? (segs[j - 1].end + g.start) / 2 : -Infinity, hi = j + 1 < segs.length ? (g.end + segs[j + 1].start) / 2 : Infinity;
    const pick = p => P[p].filter(k => k.t >= lo && k.t < hi);
    const filled = fillDeletions(fillDeletions(pick('A'), pick('B')), pick('C'));
    if (!filled.length) return;
    // 差し込んだ文字は別の読み方の時刻なので、前後と順番が逆になることがある。文字の順に時刻をそろえる
    const tokens = [];
    for (const k of filled) tokens.push({ ...k, t: tokens.length ? Math.max(k.t, tokens[tokens.length - 1].t + 0.02) : k.t });
    const text = tokens.map(k => k.s).join('');
    out.push({ start: g.start, end: g.end, text, raw: text, timed: true, tokens });
  });
  out.passes = P;
  return out;
}

// 字幕の文 c について、読み方ごとの聞き取りを比べ、否定の言葉・入力された用語の有無が違えば理由を返す
export function passDoubts(c, passes, terms = []) {
  if (!passes) return [];
  const texts = Object.values(passes).map(P => P.filter(k => k.t >= c.start - 0.3 && k.t < c.end + 0.3).map(k => k.s).join('')).filter(Boolean);
  const out = [];
  if (texts.some(t => hasNegation(t) !== hasNegation(c.text))) out.push('否定の言葉（ない・ません）を聞き落としている可能性');
  for (const t of terms) if (t.length >= 2 && !(c.text || '').includes(t) && texts.some(x => x.includes(t))) out.push(`「${t}」を聞き落としている可能性`);
  return out;
}

export function normalizeText(text) {
  return (text || '')
    .replace(/[\s、。，．,.！？!?・「」『』（）()…~〜]+/g, '')
    .replace(FILLER_RE, '')
    .trim();
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, total = 0;
  for (const [g, n] of A) { inter += Math.min(n, B.get(g) || 0); total += n; }
  for (const n of B.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

export function keywordHits(text) {
  const t = text || '';
  const hits = KEYWORDS.filter(k => t.includes(k));
  if (DEGREE_RE.test(t)) hits.push('角度(〇度)');
  return hits;
}

// 言い直しの検出。後の発言を残し、前の発言を除外する（自動で外すものだけ。詳しくは content.js）
export function detectRetakes(chunks) {
  return analyzeContent(chunks).map(r => r?.drop || null);
}

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

// 区間 [start,end] のうち話している部分だけを取り出す
function speechPieces(regions, start, end) {
  const out = [];
  for (const r of regions) {
    const s = Math.max(r.start, start), e = Math.min(r.end, end);
    if (e - s > 0.05) out.push({ start: s, end: e });
  }
  return out;
}

function piecesDuration(pieces) {
  return pieces.reduce((s, p) => s + (p.end - p.start), 0);
}

// 長い発話を、音量が一番小さいところで区切る
function splitLong(region, rmsDb, maxLen = 8, minLen = 4) {
  const out = [];
  let s = region.start;
  while (region.end - s > maxLen) {
    let best = s + maxLen, bestDb = Infinity;
    for (let t = s + minLen; t < s + maxLen; t += FRAME_SEC) {
      const db = rmsDb[Math.floor(t / FRAME_SEC)] ?? 0;
      if (db < bestDb) { bestDb = db; best = t; }
    }
    out.push({ start: s, end: best });
    s = best;
  }
  out.push({ start: s, end: region.end });
  return out;
}

// motion: { times, values, cx }（約1秒ごとの手元の動き量と、動きの横位置0〜1）
// 動き量を 0〜1 にそろえる。中央値（ふだんの揺れ）を 0、上位5%を 1 とする
export function motionLevels(motion) {
  const med = percentile(motion.values, 0.5);
  const hi = percentile(motion.values, 0.95);
  const span = Math.max(hi - med, 0.5);
  return motion.values.map(v => Math.min(1, Math.max(0, (v - med) / span)));
}

function motionOver(motion, levels, start, end) {
  if (!motion || !motion.times.length) return { level: 0, cx: 0.5, cy: 0.5, box: null };
  let sum = 0, n = 0;
  const cxs = [], cys = [], boxes = [];
  for (let i = 0; i < motion.times.length; i++) {
    const t = motion.times[i];
    if (t >= start - 0.5 && t <= end + 0.5) {
      sum += levels[i]; n++;
      if (levels[i] >= 0.3) {
        cxs.push(motion.cx[i]);
        if (motion.cy) cys.push(motion.cy[i]);
        if (motion.box && motion.box[i]) boxes.push(motion.box[i]);
      }
    }
  }
  // 動いている範囲は、各時点の範囲を少し広めに合わせたもの
  const box = boxes.length
    ? [percentile(boxes.map(b => b[0]), 0.2), percentile(boxes.map(b => b[1]), 0.8), percentile(boxes.map(b => b[2]), 0.2), percentile(boxes.map(b => b[3]), 0.8)]
    : null;
  return { level: n ? sum / n : 0, cx: cxs.length ? percentile(cxs, 0.5) : 0.5, cy: cys.length ? percentile(cys, 0.5) : 0.5, box };
}

// 文 [start, end]（Whisper の時刻なので少しずれている）に当たる声の区間を、言葉の途中で切らずに取り出す。
// 声の区間が文の外まで大きくはみ出している（前後の文と続けて話している）ときだけ、
// 文の境目の近くの一番静かな所で分ける
function sentenceVoice(voice, rmsDb, start, end) {
  const segs = voice.filter(v => overlap(v.start, v.end, start, end) >= Math.min(0.05, (v.end - v.start) / 2)).map(v => ({ ...v }));
  if (!segs.length) return segs;
  const first = segs[0], last = segs[segs.length - 1];
  if (first.start < start - 0.35) first.start = quietestPoint(rmsDb, start - 0.4, Math.min(first.end - 0.1, start + 0.25));
  if (last.end > end + 0.5) last.end = quietestPoint(rmsDb, Math.max(last.start + 0.1, end - 0.25), end + 0.4);
  return segs.filter(s => s.end - s.start > 0.05);
}

// 文の中の文字の位置 at に当たる声の切れ目を、声の区間から探す。
// 文字の位置を読みの長さで時刻に直し、その近く（±0.6秒）の声の切れ目（0.08秒以上）を探す。見つからなければ null
function findGap(u, sp, at) {
  const text = u.text || '';
  const total = sp.reduce((a, r) => a + r.end - r.start, 0);
  const f = moraCount(text.slice(0, at)) / (moraCount(text) || 1);
  let rest = f * total, t = sp[sp.length - 1].end;
  for (const r of sp) { if (rest <= r.end - r.start) { t = r.start + rest; break; } rest -= r.end - r.start; }
  // 1文字ごとの時刻がわかる（ReazonSpeech）ときは、その時刻を使う（文字の時刻は声より少し早めに出るので少し足す）
  if (u.times && u.times.length === text.length && u.times[at] != null) t = u.times[at] + 0.15;
  let best = null, bestCost = Infinity;
  for (let k = 0; k + 1 < sp.length; k++) {
    const gap = sp[k + 1].start - sp[k].end;
    const mid = (sp[k].end + sp[k + 1].start) / 2;
    if (gap < 0.08 || Math.abs(mid - t) > 0.6) continue;
    const cost = Math.abs(mid - t) / (1 + 2 * gap);
    if (cost < bestCost) { bestCost = cost; best = { gapStart: sp[k].end, voiceStart: sp[k + 1].start }; }
  }
  return best;
}

// 文の一部を取り除く位置を探す。trim.cut は残す部分の始まり、trim.from（あれば）は取り除く部分の始まりの文字位置。
// 冒頭を取り除く（from なし）か、文の途中を取り除く（from あり）。どちらも声の切れ目が見つかったときだけ
export function findTrim(u, spans, trim) {
  const text = u.text || '';
  const sp = spans.filter(r => r.end > u.voiceStart - 0.05 && r.start < u.voiceEnd + 0.05)
    .map(r => ({ start: Math.max(r.start, u.voiceStart), end: Math.min(r.end, u.voiceEnd) })).filter(r => r.end > r.start);
  if (sp.length < 2) return null;
  if (trim.tail != null) {
    // 文の終わりを取り除く: 残す部分の語尾の後の声の切れ目。1文字ごとの時刻がわかるときは、残す最後の文字の
    // すぐ後の切れ目（言いかけの言葉の中の切れ目「トッ／プの」を選ばない）
    let a = null;
    const lastT = u.times && u.times.length === text.length ? u.times[trim.tail - 1] + CHAR_LAG : null;
    if (lastT != null) {
      for (let k = 0; k + 1 < sp.length && !a; k++) {
        if (sp[k].end >= lastT - 0.05 && sp[k + 1].start - sp[k].end >= 0.08) a = { gapStart: sp[k].end, voiceStart: sp[k + 1].start };
      }
    }
    a ||= findGap(u, sp, trim.tail);
    return a ? { tail: true, keepEnd: a.gapStart, dropStart: a.voiceStart, text: text.slice(0, trim.tail).replace(/[、,\s]+$/, ''), reason: trim.reason } : null;
  }
  const b = findGap(u, sp, trim.cut);
  if (!b) return null;
  const kept = (trim.from ? text.slice(0, trim.from) : '') + text.slice(trim.cut);
  if (!trim.from) return { gapStart: b.gapStart, voiceStart: b.voiceStart, text: kept.trim(), reason: trim.reason };
  const a = findGap(u, sp, trim.from);
  if (!a || a.voiceStart >= b.voiceStart) return null;
  return { mid: true, keepEnd: a.gapStart, gapStart: b.gapStart, voiceStart: b.voiceStart, text: kept.trim(), reason: trim.reason };
}

// 文の一部を取り除く（元に戻せるよう、もとの状態を u.trimmed.original に残す）
export function trimUnit(u, cut, pace = PACES.natural) {
  const original = { pieces: u.pieces.map(p => ({ ...p })), start: u.start, end: u.end, text: u.text, subStart: u.subStart, subEnd: u.subEnd, fine: u.fine, voiceStart: u.voiceStart, voiceEnd: u.voiceEnd, times: u.times };
  const from = Math.max(cut.gapStart + 0.02, cut.voiceStart - pace.lead);
  let pieces;
  if (cut.tail) {
    // 終わりを取り除く: 残す部分の語尾の後に余白（tail）を残して切る
    const to = Math.min(cut.keepEnd + pace.tail, (cut.dropStart ?? Infinity) - 0.02);
    pieces = u.pieces.filter(p => p.start < to - 0.05).map(p => ({ ...p, end: Math.min(p.end, to) }));
    if (pieces.length) pieces[pieces.length - 1].end = Math.max(pieces[pieces.length - 1].end, to);
    if (pieces.length) {
      u.voiceEnd = cut.keepEnd;
      if (u.subEnd != null) u.subEnd = Math.min(u.subEnd, cut.keepEnd);
      if (u.fine) u.fine = u.fine.filter(r => r.start < cut.keepEnd).map(r => ({ start: r.start, end: Math.min(r.end, cut.keepEnd) }));
      u.end = pieces[pieces.length - 1].end;
      // 残す文字の時刻はそのまま使える（字幕のページの切り替えに使う）
      if (u.times && u.times.length === (u.text || '').length && u.text.startsWith(cut.text)) u.times = u.times.slice(0, cut.text.length);
    }
  } else if (cut.mid) {
    // 途中を取り除く: 前の部分は語尾の後に短い間を残して切り、後ろの部分は話し始めの少し前から
    const to = Math.min(cut.keepEnd + pace.lead, from);
    pieces = [];
    for (const p of u.pieces) {
      if (p.end <= to || p.start >= from) { pieces.push({ ...p }); continue; }
      if (p.start < to) pieces.push({ start: p.start, end: to });
      if (p.end > from) pieces.push({ start: from, end: p.end });
    }
    pieces = pieces.filter(p => p.end - p.start > 0.05);
    if (u.fine) u.fine = u.fine.filter(r => r.end <= cut.keepEnd + 0.01 || r.start >= cut.voiceStart - 0.01);
  } else {
    pieces = u.pieces.filter(p => p.end > from + 0.05).map(p => ({ ...p, start: Math.max(p.start, from) }));
    if (pieces.length) {
      u.voiceStart = cut.voiceStart;
      if (u.subStart != null) u.subStart = Math.max(u.subStart, cut.voiceStart);
      if (u.fine) u.fine = u.fine.filter(r => r.end > cut.voiceStart).map(r => ({ start: Math.max(r.start, cut.voiceStart), end: r.end }));
    }
  }
  if (!pieces.length) return false;
  u.pieces = pieces;
  u.start = pieces[0].start;
  u.text = cut.text;
  u.duration = piecesDuration(u.pieces);
  u.trimmed = { reason: cut.reason, cut, original };
  delete u.trimOption;
  return true;
}

// 取り除いた部分を元に戻す（もう一度取り除けるよう、位置は u.trimOption に残す）
export function untrimUnit(u) {
  if (!u.trimmed) return;
  const o = u.trimmed.original;
  Object.assign(u, { pieces: o.pieces, start: o.start, text: o.text, subStart: o.subStart, fine: o.fine, voiceStart: o.voiceStart });
  if (o.end != null) Object.assign(u, { end: o.end, subEnd: o.subEnd, voiceEnd: o.voiceEnd, times: o.times });
  u.duration = piecesDuration(u.pieces);
  u.trimOption = u.trimmed.cut;
  delete u.trimmed;
}

// 文の最後の文字の後に、間をおいて文字起こしされていない声が続いている（言いかけてやめた・言い直しの頭などを
// 字幕AIが聞き落とした）。内容のある言葉かもしれないので自動では取り除かず、取り除ける候補として知らせる
function untranscribedTail(u, segs, rmsDb, nextT = Infinity) {
  const text = u.text || '';
  if (!u.times || u.times.length !== text.length || !segs.length) return;
  const lastT = u.times[u.times.length - 1] + CHAR_LAG;
  // 次の文の最初の文字より後の声は、次の文の声（間をおかずに話し始めた）
  segs = segs.filter(s => s.start < nextT - 0.05).map(s => ({ start: s.start, end: Math.min(s.end, nextT - 0.05) }));
  if (!segs.length) return;
  let k = -1;
  segs.forEach((s, j) => { if (s.start <= lastT + 0.1) k = j; });
  if (k < 0) return;
  // 最後の文字の後も、間をおかずに 0.5秒以上声が続いている（「…続けないと、うまくいきま」）:
  // 最後の文字のすぐ後の一番静かな所で切れる候補にする（言葉の切れ目が確かでないので、自動では切らない）
  if ((k + 1 >= segs.length || segs[k + 1].start - segs[k].end < 0.15) && rmsDb && segs[k].end - lastT >= 0.6) {
    const i0 = Math.round((lastT + 0.05) / FRAME_SEC), i1 = Math.round(Math.min(lastT + 0.4, segs[k].end - 0.3) / FRAME_SEC);
    let q = i0;
    for (let i = i0; i <= i1; i++) if (rmsDb[i] < rmsDb[q]) q = i;
    if (i1 < i0) return;
    const cutT = q * FRAME_SEC + FRAME_SEC / 2;
    const rest = piecesDuration(segs.slice(k).map((s, j) => j ? s : { start: cutT, end: s.end }));
    u.trimOption = { tail: true, keepEnd: cutT, dropStart: cutT + 0.02, text, reason: '文の後の、文字起こしされていない声' };
    u.candidate = `文の後に、文字起こしされていない声が約${rest.toFixed(1)}秒続いています（言いかけ・言い直しの可能性があります。不要なら取り除いてください。声が続いているため、切れ目は確かではありません）`;
    return;
  }
  if (k + 1 >= segs.length || segs[k + 1].start - segs[k].end < 0.15) return;
  const rest = piecesDuration(segs.slice(k + 1));
  if (rest < 0.4) return;
  u.trimOption = { tail: true, keepEnd: segs[k].end, dropStart: segs[k + 1].start, text, reason: '文の後の、文字起こしされていない声' };
  u.candidate = `文の後に、文字起こしされていない声が約${rest.toFixed(1)}秒あります（言いかけ・言い直しの可能性があります。不要なら取り除いてください）`;
}

// 文の途中で、文字と文字の間に文字にならない声がある（「…続けないと、うまくいきま（言いかけ）、うまくカバーできません」）。
// 字幕AIが言いかけを文字にしなかった所。声の切れ目があれば、取り除ける候補にする（自動では取り除かない）
function untranscribedMid(u, sp) {
  const text = u.text || '', times = u.times;
  if (!times || times.length !== text.length || sp.length < 2) return;
  for (let i = 0; i + 1 < times.length; i++) {
    const a = times[i] + CHAR_LAG, b = times[i + 1] + CHAR_LAG;
    if (b - a < 0.8 || /[、。]/.test(text[i + 1])) continue;
    // a の後で声が途切れる所（a を含む声の区間の終わり）と、b を話し始める声の区間
    const ka = sp.findIndex(r => r.end >= a - 0.05);
    const kb = sp.findIndex(r => r.end >= b - 0.05);
    if (ka < 0 || kb <= ka) continue;
    const mid = sp.slice(ka + 1, kb).map(r => ({ start: r.start, end: Math.min(r.end, b) }));
    const extra = (sp[ka].end - a > 0.3 ? sp[ka].end - a - 0.3 : 0) + piecesDuration(mid);
    if (extra < 0.4 || sp[kb].start - sp[kb - 1].end < 0.08) continue;
    const keepEnd = mid.length || sp[ka].end - a <= 0.3 ? sp[ka].end : a + 0.3;
    u.trimOption = { mid: true, keepEnd, gapStart: sp[kb - 1].end, voiceStart: sp[kb].start, text, reason: '文の途中の、文字起こしされていない声' };
    u.candidate = `「${text.slice(Math.max(0, i - 5), i + 1)}」と「${text.slice(i + 1, i + 6)}」の間に、文字起こしされていない声が約${extra.toFixed(1)}秒あります（言いかけ・言い直しの可能性があります。不要なら取り除いてください）`;
    return;
  }
}

// 候補となる場面（ユニット）を作り、点数をつける。
// pace: 'natural'（初期設定）/ 'tempo'（間を少し短く）。間の残し方は PACES を参照
export function buildUnits({ duration, rmsDb, speech, chunks, motion, pace }) {
  const regions = speech.regions;
  // 声の区間（余白なし）。古い形式のデータ（voice がない）では余白つきの区間を使う
  const voice = speech.voice || regions;
  const P = PACES[pace] || PACES.natural;
  const levels = motion ? motionLevels(motion) : [];
  const units = [];
  // 前後の声に食い込まない範囲で、話し始めの前・話し終わりの後の余白をつける
  // 声の途中（文と文の境目の静かな所）で分けた側には余白をつけない
  const shape = segs => {
    const s0 = segs[0].start, s1 = segs[segs.length - 1].end;
    const inside = t => voice.some(v => v.start < t - 1e-6 && v.end > t + 1e-6);
    const prevEnd = voice.filter(v => v.end <= s0 + 1e-6).pop()?.end ?? 0;
    const nextStart = voice.find(v => v.start >= s1 - 1e-6)?.start ?? duration;
    const before = inside(s0) ? s0 : Math.min(s0, Math.max(0, prevEnd + 0.05, s0 - 1));
    const after = inside(s1) ? s1 : Math.min(duration, nextStart - 0.05);
    return shapePieces(segs, before, Math.max(s1, after), P);
  };

  // 息継ぎの間を測る細かい声の区間
  const fineAll = speech.threshold != null ? fineSpeech(rmsDb, speech.threshold) : [];
  const covered = [];
  if (chunks && chunks.length) {
    const ca = analyzeContent(chunks);
    const flags = ca.map(r => r?.drop || null);
    chunks.forEach((c, i) => {
      const segs = sentenceVoice(voice, rmsDb, c.start, c.end);
      const speechDur = piecesDuration(speechPieces(regions, c.start, c.end));
      const len = Math.max(0.01, c.end - c.start);
      const text = (c.text || '').trim();
      // 無音部分の誤認識（文ごとに割り当て直したものは、話している部分に合わせてあるので割合では判定しない）
      if ((!c.aligned && speechDur / len < 0.3) || (HALLUCINATION_RE.test(text) && speechDur / len < 0.6) || isPromptEcho(text)) return;
      covered.push({ start: c.start, end: c.end });
      if (segs.length) covered.push({ start: segs[0].start, end: segs[segs.length - 1].end });
      if (!segs.length) return;
      const pieces = shape(splitAtPauses(segs, fineAll, P.keepGap));
      const u = {
        kind: 'speech', start: pieces[0].start, end: pieces[pieces.length - 1].end, pieces, text, subStart: c.subStart, subEnd: c.subEnd, fine: c.fine, times: c.times,
        voiceStart: segs[0].start, voiceEnd: segs[segs.length - 1].end,
      };
      if (flags[i]) u.excluded = flags[i];
      else if (!normalizeText(text)) u.excluded = 'つなぎ言葉のみ';
      // 言い直した後の発言（撮り直してまで伝えたかった説明）
      else if (flags[i - 1] || (flags[i - 2] && !normalizeText(chunks[i - 1].text))) u.redo = true;
      if (!u.excluded && ca[i]?.candidate) u.candidate = ca[i].candidate;
      // 文の一部（冒頭の訂正・言い直し前の部分・くり返し）を取り除く。声の切れ目が見つかったときだけ
      if (!u.excluded && ca[i]?.trim) {
        const cut = findTrim(u, c.fine && c.fine.length ? c.fine : segs, ca[i].trim);
        if (cut && ca[i].trim.high) trimUnit(u, cut, P);
        else if (cut) { u.trimOption = cut; u.candidate = `${ca[i].trim.reason}は取り除けます（確かでないため、そのまま残しています）`; }
        else u.candidate = `${ca[i].trim.reason}が残っています（声の切れ目が見つからないため、文の途中では切っていません）`;
      }
      if (!u.excluded && !u.trimmed && !u.trimOption) {
        // 細かい声の区間（字幕の表示範囲まで）と、その後ろの声の区間
        const fine = c.fine && c.fine.length ? c.fine : [];
        const fEnd = fine.length ? fine[fine.length - 1].end : -Infinity;
        const sp = [...fine, ...segs.filter(r => r.end > fEnd + 0.05).map(r => ({ start: Math.max(r.start, fEnd + 0.05), end: r.end }))];
        const nextT = chunks[i + 1]?.times?.length ? chunks[i + 1].times[0] + CHAR_LAG - 0.1 : (chunks[i + 1]?.start ?? Infinity);
        untranscribedTail(u, sp.length ? sp : segs, rmsDb, nextT);
        if (!u.trimOption) untranscribedMid(u, sp.length ? sp : segs);
      }
      units.push(u);
    });
  }
  // 文字起こしがない（または取りこぼした）発話
  for (const r of voice) {
    const restPieces = [];
    let cursor = r.start;
    const cov = covered.filter(c => overlap(c.start, c.end, r.start, r.end) > 0).sort((a, b) => a.start - b.start);
    for (const c of cov) {
      if (c.start - cursor > 0.4) restPieces.push({ start: cursor, end: Math.min(c.start, r.end) });
      cursor = Math.max(cursor, c.end);
    }
    if (r.end - cursor > 0.4) restPieces.push({ start: cursor, end: r.end });
    for (const p of restPieces) {
      for (const s of splitLong(p, rmsDb)) {
        const pieces = shape([s]);
        units.push({ kind: 'speech', start: pieces[0].start, end: pieces[pieces.length - 1].end, pieces, text: '', voiceStart: s.start, voiceEnd: s.end });
      }
    }
  }

  // 話していないが手元がよく動いている場面（技術を見せる場面）
  if (motion && motion.times.length) {
    let span = null;
    const spans = [];
    for (let i = 0; i < motion.times.length; i++) {
      const t = motion.times[i];
      const talking = regions.some(r => t > r.start - 0.5 && t < r.end + 0.5);
      if (levels[i] >= 0.35 && !talking) {
        if (span && t - span.end <= 1.6) { span.end = t; span.idx.push(i); }
        else { if (span) spans.push(span); span = { start: t, end: t, idx: [i] }; }
      } else if (span && t - span.end > 1.6) { spans.push(span); span = null; }
    }
    if (span) spans.push(span);
    // 長い作業場面は3秒ずつに分け、それぞれを候補にする
    for (const sp of spans) {
      const s0 = Math.max(0, sp.start - 0.5);
      const s1 = Math.min(duration, sp.end + 0.5);
      for (let s = s0; s1 - s >= 1.5; s += 3) {
        const piece = { start: s, end: Math.min(s + 3, s1) };
        for (const r of regions) {
          if (overlap(r.start, r.end, piece.start, piece.end) > 0) {
            if (r.start <= piece.start) piece.start = r.end; else piece.end = r.start;
          }
        }
        if (piece.end - piece.start >= 1.5) {
          units.push({ kind: 'action', start: piece.start, end: piece.end, pieces: [piece], text: '' });
        }
      }
    }
  }

  units.sort((a, b) => a.start - b.start);

  // 点数づけ
  const firstSpeech = units.filter(u => u.kind === 'speech' && !u.excluded).slice(0, 2);
  const introLimit = Math.max(40, duration * 0.12);
  units.forEach((u, i) => {
    u.id = 'u' + i;
    u.duration = piecesDuration(u.pieces);
    const m = motionOver(motion, levels, u.start, u.end);
    u.cx = m.cx;
    u.cy = m.cy;
    u.box = m.box;
    u.motion = m.level;
    u.keywords = keywordHits(u.text);
    const reasons = [];
    let score = 1;
    if (motion) { score += 1.5 * m.level; if (m.level >= 0.35) reasons.push('手元の動きが多い'); }
    if (u.keywords.length) { score += 1.2 * Math.min(3, u.keywords.length); reasons.push('用語: ' + u.keywords.slice(0, 3).join('・')); }
    if (firstSpeech.includes(u) && u.start < introLimit) { score += 1.5; u.intro = true; reasons.push('冒頭の導入'); }
    if (u.end > duration * 0.92) { score += 2; u.ending = true; reasons.push('仕上がり（最後）'); }
    // 文字起こしのない声: 文字起こしをしていないときは少し残しやすく、
    // 文字起こしをしたのに文字にならなかった声（言いよどみ・聞き取れない声）は外しやすくする
    if (u.kind === 'speech' && !u.text) {
      if (chunks && chunks.length) {
        score -= 0.6;
        // 2秒未満の短い声は、言いかけてやめた言葉・つなぎ言葉・物音であることが多いので、初めは使わない（候補に出す）。
        // 長い声は、字幕AIが聞き落とした説明の可能性があるので残す
        if (u.duration < 2) { u.optional = true; u.candidate = '文字にならなかった短い声です（言いかけ・言いよどみの可能性があるため、外しています。必要なら残してください）'; }
        else u.candidate = u.candidate || '文字にならなかった声です（言いよどみの可能性があります。必要なら残してください）';
      }
      else score += 0.3;
    }
    if (u.redo) { score += 1.2; reasons.push('言い直した説明'); }
    if (u.candidate) score -= 0.3;
    if (u.trimmed) reasons.push(u.trimmed.reason + 'を取り除きました');
    if (u.kind === 'action') {
      reasons.push('カット作業の場面');
      // ハサミの音が続いている（実際に切っている）無言の場面は、話していなくても残す価値が高い
      if ((speech.sounds || []).some(s => overlap(s.start, s.end, u.start, u.end) > 0.5)) { score += 0.3; reasons.push('ハサミの音'); }
    }
    if (u.duration < 0.8) score -= 2;
    u.score = score;
    u.reasons = reasons;
  });
  linkSentences(units);
  return units;
}

// 選んだ場面を書き出したときの長さ。続けて選んだ場面の余白が重なる分は1回だけ数える（buildTimeline と同じ数え方）
export function outputLength(list) {
  const ps = list.flatMap(u => u.pieces || [{ start: u.start, end: u.end }]).sort((x, y) => x.start - y.start);
  let sum = 0, end = -Infinity;
  for (const p of ps) { const s0 = Math.max(p.start, end); if (p.end > s0) sum += p.end - s0; end = Math.max(end, p.end); }
  return sum;
}

// 目標時間の許容幅（60秒なら ±5秒 → 55〜65秒）
export function targetTolerance(sec) {
  return Math.max(3, Math.round(sec / 12));
}

// 場面を選ぶ（話の内容を優先する）。手動編集のお手本と同じく、話している場面は言い直し・くり返し・
// つなぎ言葉を除いてすべて元の順番で残し、目標時間（target、上限 max）を大きく超えるときだけ、
// 点数の低い文を「文ごと」外す。前後の文とつながっている文（linkNext）はまとめて外す（文の途中から始めない）。
// 冒頭・最後・必ず残す場面は外さない（重要な説明を時間のために削らない）。
// 話している部分が目標より短いときだけ、手元の作業場面を足す（無音で水増しはしない）
// opts.lo: 目標の下限（既定は target − 許容幅）/ opts.buckets: 動画全体を何区間に分けて見るか（外す場面が偏らないように）
export function selectUnits(units, duration, target = 60, max = target + targetTolerance(target), opts = {}) {
  const lo = opts.lo ?? target - Math.max(max - target, targetTolerance(target));
  const cands = units.filter(u => !u.excluded && u.duration >= 0.5);
  const byId = new Map(cands.map(u => [u.id, u]));
  // 話している場面を、つながった文のまとまり（グループ）に分ける
  const speech = cands.filter(u => u.kind === 'speech' && !(u.optional && !u.mustKeep));
  const linked = new Set(speech.filter(u => u.linkNext && byId.has(u.linkNext)).map(u => u.linkNext));
  const groups = [];
  for (const u of speech) {
    if (linked.has(u.id)) continue; // 前の文の続き（前の文のグループに入る）
    const g = [u];
    for (let n = byId.get(u.linkNext); n && g.length < 8; n = byId.get(n.linkNext)) g.push(n);
    groups.push(g);
  }
  const dur = g => g.reduce((s, x) => s + x.duration, 0);
  const keep = new Set(groups);
  const extra = cands.filter(u => u.kind !== 'speech' && u.mustKeep);
  const totalOf = set => outputLength([...[...set].flat(), ...extra]);
  let total = totalOf(keep);
  const K = Math.max(1, opts.buckets || 5);
  const bucket = g => Math.min(K - 1, Math.floor((g[0].start / Math.max(1, duration)) * K));
  const isProtected = g => g.some(u => u.mustKeep || u.intro || u.ending);
  // 長すぎるとき: 点数の低いグループから外す。区間に1つしか残っていないグループは外しにくくする（流れが飛ばないように）。
  // 上限を少し（許容幅の半分まで）超えるだけなら、説明の文を外すより内容を優先して残す。
  // 外した後に下限を下回るものは外さない
  const slack = opts.slack ?? targetTolerance(target) / 2;
  while (total > max + slack) {
    const left = new Map();
    for (const g of keep) left.set(bucket(g), (left.get(bucket(g)) || 0) + 1);
    const value = g => Math.max(...g.map(u => u.score ?? 1)) + (left.get(bucket(g)) <= 1 ? 0.8 : 0);
    const removable = [...keep].filter(g => !isProtected(g)).sort((x, y) => value(x) - value(y) || dur(y) - dur(x));
    const options = removable.map(g => {
      const rest = new Set(keep);
      rest.delete(g);
      return { g, after: totalOf(rest) };
    }).filter(o => o.after >= lo);
    if (!options.length) break;
    // 外すと目安の範囲に収まるものがあれば、その中で失う内容（点数×長さ）が一番少ないもの。
    // なければ一番点数の低いもの（長い説明を、少しの時間のために丸ごと外さない）
    const fit = options.filter(o => o.after <= max + slack);
    const loss = o => value(o.g) * dur(o.g);
    const pick = fit.length ? fit.sort((x, y) => loss(x) - loss(y))[0] : options[0];
    keep.delete(pick.g);
    total = pick.after;
  }
  const chosen = new Set([...keep].flat());
  for (const u of cands) if (u.mustKeep) chosen.add(u);
  // 短いとき: 手元の作業場面（話していない場面）を、点数の高い順に足す。作業場面は目標の actionShare（初期 40%）まで
  if (total < lo) {
    const cap = target * (opts.actionShare ?? 0.4);
    let actionTotal = [...chosen].filter(u => u.kind === 'action').reduce((s, u) => s + u.duration, 0);
    for (const u of cands.filter(x => x.kind === 'action' && !chosen.has(x)).sort((a, b) => b.score - a.score)) {
      if (total >= lo) break;
      if (total + u.duration > max || actionTotal + u.duration > cap) continue;
      chosen.add(u);
      total += u.duration;
      actionTotal += u.duration;
    }
  }
  return [...chosen].sort((a, b) => a.start - b.start);
}

// 字幕を「1行最大 maxChars 文字 × 2行」のページに分け、表示時間を文字数で配分する。
// 日本語として自然な位置（読点の後 > 助詞の後 > 文字の種類が変わる所）で区切り、
// 1〜2文字だけが次の行・ページに残るような分け方はしない
const NO_LINE_START = '、。，．,.！？!?）」』ゃゅょっャュョッァィゥェォーぁぃぅぇぉ';
const PARTICLES = 'はをにでがともへやの';

function charType(c) {
  if (/[\u4e00-\u9fff々]/.test(c)) return 'kanji';
  if (/[\u30a0-\u30ff]/.test(c)) return 'kata';
  if (/[\u3040-\u309f]/.test(c)) return 'hira';
  if (/[0-9０-９]/.test(c)) return 'num';
  return 'other';
}

// 改行・ページの区切りで分けない言葉（美容用語・入力された用語）。setBreakTerms で入力された用語を足す
const BASE_TERMS = [...new Set([...KEYWORDS, ...BEAUTY_TERMS.map(t => t.term), 'すきバサミ', 'ハサミ', 'ヘアカッター', '髪の毛', '根元', 'セルフカット', '修正カット'])];
let breakTerms = BASE_TERMS;
export function setBreakTerms(extra = []) {
  breakTerms = [...new Set([...BASE_TERMS, ...extra.filter(w => typeof w === 'string' && w.length >= 2)])];
}

// text の中で、用語の途中にあたる位置（その前で区切ってはいけない位置）。inside.ends は用語の終わりの位置（区切りやすい）
function insideTerms(text) {
  const inside = new Set();
  inside.ends = new Set();
  for (const w of breakTerms) {
    for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + 1)) {
      for (let k = i + 1; k < i + w.length; k++) inside.add(k);
      inside.ends.add(i + w.length);
    }
  }
  for (const k of inside) inside.ends.delete(k);
  return inside;
}

// i 文字目の前が文の境目か。はっきりした文の終わり（〜ます・〜です・〜ません）のあとに続きの言葉（が・けど・ね・し…）が
// 来ない所、または言い切りの形（〜ない・〜した）のあとに次の文の始まりの言葉（それを・しかも…）が来る所
const STRONG_END_RE = /(?:ます|ません|です|でした|ました|ください|ましょう|ですよね|んですね|よね)$/;
const PLAIN_END_RE = /(?:ない|った|した|いる|ある|です|ます|ません)$/;
function sentenceBoundary(text, i) {
  const before = text.slice(0, i).replace(/[、。\s]+$/, ''), after = text.slice(i).replace(/^[、。\s]+/, '');
  if (!before || after.length < 2) return false;
  if (/[。！？!?]$/.test(text.slice(0, i))) return true;
  if (PLAIN_END_RE.test(before) && SENTENCE_STARTS.some(w => after.startsWith(w))) return true;
  return STRONG_END_RE.test(before) && (!/^[がけかよねのとしなわでもにはを]/.test(after) || SENTENCE_STARTS.some(w => after.startsWith(w)));
}

// 次の文の始まりによく使う言葉
// （特定の動画の言葉ではなく、一般的な接続の言葉・指示の言葉。前の語尾と合わせて判断する）
const SENTENCE_STARTS = ['それは', 'それを', 'それで', 'それが', 'そして', 'しかも', 'また', 'さらに', 'でも', 'しかし', 'ただ', 'なので', 'だから', 'ですので', 'そのため', 'つまり', '例えば', 'まず', '次に', '最後に', 'あとは', 'もし', 'となれば', '下手すれば', 'この', 'その', 'こう', 'そう'];
// 区切りやすい語尾（この後で区切ると、意味のまとまりで分かれる）
const GOOD_ENDINGS = ['際', 'ように', 'ために', 'ので', 'から', 'けど', 'けれど', 'ても', 'たら', 'れば', 'なら', 'ながら', 'まで', 'より', 'など', 'とき', 'ときに', '際に', '時に', '場合は', '場合', 'なのか', 'ます', 'です', 'ました', 'でした', 'ません', 'ください'];
// 助詞のあとにひらがなが続いても、ひとまとまりの言葉になる組み合わせ（「には」「でも」「です」「できる」など）
const PARTICLE_PAIRS = ['には', 'にも', 'では', 'でも', 'です', 'でき', 'でし', 'とは', 'とも', 'とき', 'とこ', 'はず', 'がら', 'もう', 'もの', 'への', 'との', 'での', 'にく', 'にな'];
// 「て・で」のあとに続く補助の言葉（「して／しまう」「て／ください」「で／いる」は分けない）
const AUX_AFTER_TE = 'しいくおみあもくだるたき'; // 「出て／きて」も分けない
// この言葉で始まる所の前では区切らない（打ち消し・否定）
const NEGATION_HEAD_RE = /^(?:ない|なく|なかっ|なけれ|ません|ず[、。にも]|ずに)/; // 「売って／る」「して／た」のような話し言葉の縮まった形も含む

// text の i 文字目の前で区切るときの「自然さ」。inside: 用語の途中の位置。
// pause: その位置の声の間（秒。わかるときだけ）。声の間は、意味の切れ目である可能性が高い
function breakScore(text, i, inside, pause = 0) {
  const prev = text[i - 1], next = text[i];
  if (!prev || !next || NO_LINE_START.includes(next) || next === 'ん') return -Infinity;
  // 否定・打ち消しの言葉を前の言葉から離さない（「軽く／しないように」と分けると、前のページだけで意味が逆になる）
  if (NEGATION_HEAD_RE.test(text.slice(i)) || (prev === 'く' && /^(?:し|な|さ)/.test(text.slice(i)))) return -Infinity;
  // 文の終わりの言葉（「です／よね」「ます／よ」）を切り離さない
  if (/(?:です|ます|ません|でした|ました|だ)$/.test(text.slice(0, i)) && /^(?:よね|よ|ね|か)/.test(text.slice(i)) && !SENTENCE_STARTS.some(w => text.startsWith(w, i))) return -Infinity;
  if (inside && inside.has(i)) return -6; // 「すき／バサミ」のように用語の途中では切らない
  let sc = grammarScore(text, i, inside, prev, next);
  // 声の間は意味の切れ目の手がかり。ただし、言葉の途中らしい所（「でき」「アホ／毛」「こ／の」）では、間があっても優先しない
  // （1文字ごとの時刻は少しずれるため、言葉の途中に間があるように見えることがある）
  if (sc <= -1) return sc;
  if (sc < 0) sc += pause >= 0.35 ? 1 : 0;
  else if (pause >= 0.35) sc += 4;
  else if (pause >= 0.18) sc += 1.5;
  return sc;
}

function grammarScore(text, i, inside, prev, next) {
  // 用語のすぐ後（「すきバサミ／以外に」）は、助詞が続かなければ区切りやすい。
  const a = charType(prev), b = charType(next);
  // ただし用語のあとに同じ種類の文字が続く（「根元／付近」）ときは、ひとつの言葉の続き
  // ただし用語のすぐ後が漢字なら、ひとまとまりの言葉のことが多い（「トップ表面」「ボブ全体」）
  if (inside?.ends?.has(i) && !PARTICLES.includes(next) && !(a === b && a !== 'hira')) return b === 'kanji' ? 0.5 : 3;
  if ('、。！？!? '.includes(prev)) return 4;
  // 次の文の始まりらしい言葉（「…しない／それを」「…です／この場所を」）。字幕AIは句読点を出さないため
  if (!PARTICLES.includes(prev) && SENTENCE_STARTS.some(w => text.startsWith(w, i)) && charType(prev) !== 'kata') return 3;
  const before = text.slice(0, i);
  // 「〜ないと／」「〜しまうと／」「〜すると／」: 条件の「と」のあとは、「〜なら」「〜れば」と同じく意味のまとまりの終わり
  if (prev === 'と' && 'いうるたすく'.includes(text[i - 2] || '') && b !== 'hira' || /(?:ないと|うと|ると)$/.test(before) && !PARTICLE_PAIRS.includes('と' + next)) return 3.5;
  // 「〜ように／なって」「〜ので／」「〜ます／」: 意味のまとまりの終わり
  if (GOOD_ENDINGS.some(e => before.endsWith(e)) && !PARTICLES.includes(next)) return 3.5;
  // 「て・で」＋補助の言葉は分けない（「して／しまう」）
  if ('てで'.includes(prev) && AUX_AFTER_TE.includes(next)) return -2;
  // 「〜して」「〜しまって」「〜入れて」のあと（文の途中の区切り）。「で」は助詞のことも多いので、
  // 前が動詞の形（っ・ん・い・し・き・り・べ・め・れ・せ・け）のときだけ
  if (prev === 'て' && !PARTICLES.includes(next)) return 3;
  // 「で」は「読んで／」のような形でも、後ろが「き」「す」（「でき」「です」）なら言葉の途中なので分けない
  if (prev === 'で' && 'んい'.includes(text[i - 2] || '') && !PARTICLES.includes(next) && charType(next) !== 'hira') return 2.5;
  // 助詞の後（「…を」「…に」）。ただし「の」は名詞のつながりが多いので低め
  if (PARTICLES.includes(prev) && b !== 'hira') return prev === 'の' ? 1.5 : 3;
  // 「の」のあとのひらがな（「アホ毛のような」「切ることのため」）は、ひとまとまりの言葉なので分けない
  if (prev === 'の' && b === 'hira') return -1.5;
  // 助詞の後にひらがな（「形に／なりました」）。「には」「です」のようにひとまとまりの組み合わせは分けない
  if ('はをにでがもへと'.includes(prev) && b === 'hira') {
    if (PARTICLE_PAIRS.includes(prev + next)) return -2;
    return a === 'hira' && charType(text[i - 2]) === 'hira' ? 0.5 : 2;
  }
  // 言い切りの形（「使わない」「使っていく」「使う」「短い」）のあとに漢字・カタカナで始まる言葉が来たら、次の文・句の始まり
  if (a === 'hira' && (b === 'kanji' || b === 'kata') && /(?:ない|ます|です|[くするうつむぬぶぐい])$/.test(before) && !/(?:という|ような|ように)$/.test(before)) return 2.5;
  if (a === 'hira' && (b === 'kanji' || b === 'kata')) return 1;
  if (a === 'kata' && b === 'kanji') return -0.5; // 「アホ毛」「カット面」のようなひとまとまりの言葉が多い
  if ((a === 'num' || b === 'num') && a !== b) return -1; // 「0度」「45度」を分けない
  if (a === 'kanji' && b === 'hira') return -1; // 送り仮名（「伸／びて」）を分けない
  if (a === b && a !== 'hira') return -3; // カタカナ語・漢字語・数字の途中では切らない
  if (a === 'hira' && b === 'hira') return -0.5; // ひらがなの言葉の途中（「よ／う」）は避ける
  return 0;
}

// [lo, hi] の範囲で、中央 target に近く、自然な区切り位置を選ぶ。pauseAt(i): i の前の声の間
function bestBreak(text, lo, hi, target, pauseAt, distW = 0.35) {
  let best = -1, bestScore = -Infinity;
  const inside = insideTerms(text);
  for (let i = Math.max(1, lo); i <= Math.min(text.length - 1, hi); i++) {
    const sc = breakScore(text, i, inside, pauseAt ? pauseAt(i) : 0) * 2 - Math.abs(i - target) * distW;
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  return best > 0 ? best : Math.min(text.length - 1, Math.max(1, Math.round(target)));
}

export function wrapLines(text, maxChars, pauseAt, slack = 2) {
  const t = (text || '').trim();
  // 1〜2文字（slack）だけはみ出す行は、改行せずに1行にする（書き出しでは文字を少し小さくして収める）
  if (t.length <= maxChars + slack) return t ? [t] : [];
  const lines = [];
  let rest = t, off = 0;
  while (rest.length > maxChars) {
    // 残りが2行分以内なら半分ずつ、それより長ければ1行分を目安に区切る
    const target = rest.length <= maxChars * 2 ? rest.length / 2 : maxChars;
    const lo = Math.max(3, rest.length - maxChars * (rest.length <= maxChars * 2 ? 1 : 99));
    const o = off;
    // 1行の文字数を、読点の1文字だけは超えてよい（「…することで、／軽やかで…」を「こと／で、」と分けない）
    const hi = maxChars + (/[、。]/.test(rest[maxChars] || '') ? 1 : 0);
    const cut = bestBreak(rest, Math.min(lo, maxChars), hi, target, pauseAt && (i => pauseAt(o + i)));
    lines.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
    off += cut;
  }
  if (rest.trim()) lines.push(rest.trim());
  return lines.filter(Boolean);
}

// 2行に分けるときの、いちばんよい改行位置の自然さ
function wrapQuality(text, maxChars, pauseAt) {
  const inside = insideTerms(text);
  let best = -Infinity;
  for (let i = Math.max(1, text.length - maxChars); i <= Math.min(maxChars, text.length - 1); i++) {
    best = Math.max(best, breakScore(text, i, inside, pauseAt ? pauseAt(i) : 0));
  }
  return best;
}

// 文を2行ずつのページに分ける。2行に収まる文は1ページにする（区切りがよくなくても、言葉の途中でページを変えない）。
// 2行に収まらない文・はっきりした声の間（0.5秒以上）がある文は、自然な位置でページを分ける
// 1行の字幕のページ分け: 文全体で、区切りの自然さ（breakScore）とページの長さ（目安12文字・最大 maxChars）が
// 一番よくなる区切り方を選ぶ（前から順に区切ると、後ろのページが「軽く／しないように」のように不自然になるため）
function linePages(text, maxChars, pauseAt) {
  const L = text.length;
  if (L <= 3) return [text];
  const inside = insideTerms(text);
  // ページの長さの悪さ（目安の文字数から離れるほど悪い）と、区切りの悪さ（よい区切り＝breakScore 4 以上なら 0）の合計を
  // 一番小さくする。よい区切りでもページを増やすほど点が下がるので、必要以上に細かく分けない
  const lenCost = n => (n < 4 ? 6 : 0) + 0.06 * (n - SUB_TARGET_CHARS) ** 2 + 1;
  // 文の境目（字幕AIは句点を出さないので、語尾と次の文の始まりの言葉から判断する）をまたぐページは作らない
  const ends = [];
  for (let k = 1; k < L; k++) if (!/[、。,\s]/.test(text[k]) && sentenceBoundary(text, k)) ends.push(k); // 読点の前ではなく後を境目とする
  const cost = new Array(L + 1).fill(Infinity), from = new Array(L + 1).fill(-1);
  cost[0] = 0;
  for (let j = 1; j <= L; j++) {
    const bs = j < L ? breakScore(text, j, inside, pauseAt ? pauseAt(j) : 0) : 0;
    if (bs === -Infinity) continue;
    for (let i = Math.max(0, j - maxChars); i <= j - 1; i++) {
      if (cost[i] === Infinity) continue;
      const mixed = ends.some(k => k > i && k < j) ? 8 : 0;
      // 話す時間が短すぎるページ（1.2秒未満で消える）は読みにくいので避ける（1文字ごとの時刻がわかるとき）
      const sec = pauseAt?.span ? pauseAt.span(i, j) : null;
      const c = cost[i] + lenCost(normalizeText(text.slice(i, j)).length || 1) + 1.5 * Math.max(0, 4 - bs) + (sec != null && sec < 1.2 ? 5 * (1.2 - sec) : 0) + mixed;
      if (c < cost[j]) { cost[j] = c; from[j] = i; }
    }
  }
  if (cost[L] === Infinity) return [text];
  const cuts = [];
  for (let j = L; j > 0; j = from[j]) cuts.unshift(j);
  return cuts.map((j, k) => text.slice(k ? cuts[k - 1] : 0, j).trim()).filter(Boolean);
}

function pageTexts(text, maxChars, maxLines, pauseAt) {
  if (maxLines === 1) return linePages(text, maxChars, pauseAt);
  const cap = maxChars * maxLines;
  const out = [];
  let rest = text, off = 0;
  for (let guard = 0; guard < 20; guard++) {
    const o = off;
    const pa = pauseAt && (i => pauseAt(o + i));
    let cut = -1;
    // 1行の字幕は、1ページ12文字前後を目安に分ける（お手本の手動編集は 7〜16文字・中央11文字）
    const n = Math.max(Math.ceil(rest.length / cap), maxLines === 1 ? Math.round(rest.length / SUB_TARGET_CHARS) : 0);
    if (n >= 2) {
      // ページの区切りは、長さをそろえるより意味の切れ目を優先する（どのページも2行に収まる範囲で）
      cut = bestBreak(rest, Math.max(3, rest.length - cap * (n - 1)), Math.min(cap, rest.length - 3), rest.length / n, pa, 0.15);
    } else if (rest.length > maxChars && wrapQuality(rest, maxChars, pa) < 1) {
      // 2行に分けると言葉の途中で改行してしまう（よい区切りがない）: 意味の切れ目でページを分ける
      const inside = insideTerms(rest);
      let bestI = -1, bestS = 1.5;
      for (let i = 4; i <= rest.length - 4; i++) {
        const sc = breakScore(rest, i, inside, pa ? pa(i) : 0) - Math.abs(i - rest.length / 2) * 0.05;
        if (sc > bestS) { bestS = sc; bestI = i; }
      }
      cut = bestI;
    }
    if (cut < 0 && pa && rest.length >= 10 && rest.length <= cap) {
      // 長めの間で、前後どちらも5文字以上なら、そこでページを変える（話す速さに合わせて読みやすく）
      const inside = insideTerms(rest);
      let bestI = -1, bestP = maxLines === 1 ? 0.3 : 0.5;
      for (let i = 5; i <= rest.length - 5; i++) {
        const p = pa(i);
        if (p >= bestP && breakScore(rest, i, inside) > -2) { bestP = p; bestI = i; }
      }
      cut = bestI;
    }
    if (cut <= 0 || cut >= rest.length) break;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
    off += cut;
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

// 字幕は1行だけ（2行にしない）。1ページ最大15文字・目安12文字で、意味のまとまり・声の間で切り替える
export const SUB_MAX_CHARS = 15;
export const SUB_LINES = 1;
const SUB_TARGET_CHARS = 11;
// pauseAt(i): text の i 文字目の前の声の間（秒）。わかるときは、声の間を意味の切れ目として区切りに使う
// pauseAt を文字の位置 off からの関数にする（話す時間 span もずらす）
function shiftPause(pa, off) {
  if (!pa) return null;
  const f = i => pa(off + i);
  if (pa.span) f.span = (i, j) => pa.span(off + i, off + j);
  return f;
}

export function subtitlePages(text, duration, maxChars = SUB_MAX_CHARS, maxLines = SUB_LINES, pauseAt = null) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean || duration <= 0) return [];
  const pa = clean === text ? pauseAt : null; // 空白を詰めて文字の位置がずれたときは使わない
  const pages = [];
  let cursor = 0;
  for (const sentence of splitSentences(clean)) {
    const sOff = clean.indexOf(sentence, cursor);
    cursor = sOff + sentence.length;
    const body = sentence.replace(/[、。]+$/, '');
    let pOff = 0;
    for (const pt of pageTexts(body, maxChars, maxLines, shiftPause(pa, sOff))) {
      const at = body.indexOf(pt, pOff);
      pOff = at + pt.length;
      // 行末の「、」「。」は字幕では付けない（すっきり見せる）
      const lines = (maxLines === 1 ? [pt] : wrapLines(pt, maxChars, pa && (i => pa(sOff + at + i)))).map(l => l.trim().replace(/[、。]+$/, '')).filter(Boolean);
      if (lines.length) pages.push(lines.slice(0, maxLines).length === lines.length ? lines : [lines.slice(0, maxLines - 1).join(''), lines.slice(maxLines - 1).join('')]);
    }
  }
  const lens = pages.map(p => p.join('').length);
  const total = lens.reduce((a, b) => a + b, 0);
  let t = 0;
  return pages.map((lines, i) => {
    const d = (duration * lens[i]) / total;
    const page = { start: t, end: t + d, lines };
    t += d;
    return page;
  });
}

// 9:16 に切り抜く範囲（表示座標）。cx は動きの横位置（0〜1）、box は動いている範囲（0〜1 の [x0,x1,y0,y1]）
export function cropRect(srcW, srcH, cx = 0.5, box = null) {
  const even = n => Math.max(2, Math.floor(n / 2) * 2);
  if (srcW / srcH > OUT_W / OUT_H) {
    const h = even(srcH);
    const w = even((h * OUT_W) / OUT_H);
    const center = (0.5 + (cx - 0.5) * 0.7) * srcW; // 端に寄りすぎないよう控えめに追従
    let left = center - w / 2;
    // 手元（動いている範囲）が枠に収まるなら、切れないように枠をずらす
    if (box) {
      const margin = w * 0.04, b0 = box[0] * srcW, b1 = box[1] * srcW;
      if (b1 - b0 + 2 * margin <= w) {
        if (b0 - margin < left) left = b0 - margin;
        if (b1 + margin > left + w) left = b1 + margin - w;
      }
    }
    left = Math.round(Math.min(srcW - w, Math.max(0, left)));
    return { left, top: 0, width: w, height: h };
  }
  const w = even(srcW);
  const h = even((w * OUT_H) / OUT_W);
  return { left: 0, top: Math.round((srcH - h) / 2), width: w, height: Math.min(h, even(srcH)) };
}

// 字幕の位置（文字の中心の高さ。画面の高さに対する割合）。
// 手動編集のお手本と同じく画面の下に固定する（場面ごとに上下が入れ替わると目が追いにくいため）。
// お手本（約0.88）より少しだけ上げて、YouTube ショートの下部の表示（チャンネル名・説明）と重なりにくくしている
// 字幕の縦の位置（文字の中心・画面の高さに対する割合）。お手本の手動編集は 0.90
export const SUB_ZONES = { top: 0.2, bottom: 0.9 };
export const ZOOM_MIN = 1.03;
export const ZOOM_MAX = 1.08;
const ZOOM_SPACING = 15; // ズームとズームの間は最低この秒数あける（頻繁に動かさない）
// 編集スタイルごとのズーム。テンポ重視は間隔を少し短く（倍率は同じ 1.03〜1.08 倍）
export const ZOOM_STYLES = {
  simple: { spacing: ZOOM_SPACING, max: ZOOM_MAX },
  tempo: { spacing: 9, max: ZOOM_MAX },
};
const FADE = 0.2;       // 字幕のフェード（秒）
const FADE_SHORT = 0.1; // 字幕が切れ目なく続くときのフェード

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// 表示座標の割合で表した範囲 box を、切り抜き枠 crop の中の割合に直す
function boxInCrop(box, crop, srcW, srcH) {
  if (!box) return null;
  return [
    (box[0] * srcW - crop.left) / crop.width, (box[1] * srcW - crop.left) / crop.width,
    (box[2] * srcH - crop.top) / crop.height, (box[3] * srcH - crop.top) / crop.height,
  ];
}

// 書き出し用のタイムライン。ピースごとのフレーム数を確定し、字幕の時刻を出力側に変換する。
// opts: { srcW, srcH, zoom: 自然なズームを使うか, subtitles: 字幕を入れるか }
export function buildTimeline(clips, opts = {}) {
  const { srcW = 1080, srcH = 1920, zoom = false, subtitles = true } = opts;
  const zs = ZOOM_STYLES[opts.style] || ZOOM_STYLES.simple;
  // 続けて選んだ場面の余白が元の動画で重なっている場合は、同じ部分を2回使わないよう後ろの場面を詰める
  // （その間はカットせず、元の動画のまま自然につながる）
  let srcEnd = -Infinity;
  clips = clips.map(c => {
    const pieces = [];
    for (const p of c.pieces) {
      const start = Math.max(p.start, srcEnd);
      if (p.end - start >= 1 / FPS) { pieces.push({ ...p, start }); srcEnd = p.end; }
    }
    return { ...c, pieces };
  }).filter(c => c.pieces.length);
  let t = 0, prevEnd = -Infinity;
  const tl = clips.map(c => {
    const pieces = c.pieces.map(p => {
      const frames = Math.max(1, Math.round((p.end - p.start) * FPS));
      // contiguous: 元の動画で前のピースの続き（音声のつなぎ方を変える）
      const piece = { srcStart: p.start, frames, outStart: t, contiguous: Math.abs(p.start - prevEnd) < 1.5 / FPS };
      t += frames / FPS;
      prevEnd = p.start + frames / FPS;
      return piece;
    });
    const outStart = pieces[0].outStart;
    const outDuration = pieces.reduce((s, p) => s + p.frames / FPS, 0);
    const text = subtitles ? c.text : '';
    const clip = { ...c, pieces, outStart, outDuration };
    // 話している時刻がわかっている字幕は、元の動画の時刻から、カット後の時刻に変換して出す
    const subs = text && c.subStart != null && c.subEnd > c.subStart
      ? timedPages(clip, text)
      : subtitlePages(text, outDuration).map(p => ({ ...p, start: p.start + outStart, end: p.end + outStart }));
    const crop = cropRect(srcW, srcH, c.cx ?? 0.5, c.box);
    return { ...clip, subtitles: subs, crop, inCrop: boxInCrop(c.box, crop, srcW, srcH) };
  });

  // 字幕の位置: いつも下（お手本と同じ）。文字を小さめにして、髪や手元を隠す面積を減らしている
  for (const c of tl) c.subPos = 'bottom';

  // 字幕のフェード: 前後に字幕が切れ目なく続くときは短く
  const pages = tl.flatMap(c => c.subtitles.map(p => Object.assign(p, { pos: c.subPos })));
  pages.forEach((p, i) => {
    const prev = pages[i - 1], next = pages[i + 1];
    p.fadeIn = prev && Math.abs(prev.end - p.start) < 0.05 && prev.pos === p.pos ? FADE_SHORT : FADE;
    p.fadeOut = next && Math.abs(next.start - p.end) < 0.05 && next.pos === p.pos ? FADE_SHORT : FADE;
  });

  // 自然なズーム: 手元がまとまって動いている2秒以上の場面だけ、ゆっくり 1.03〜1.08 倍まで寄る。
  // 続けてズームしない・間隔をあける・手元が枠からはみ出す場合はズームしない
  let lastEnd = -Infinity, prevZoomed = false, zoomCount = 0;
  for (const c of tl) {
    c.zoom = null;
    const b = c.inCrop;
    const ok = zoom && b && c.outDuration >= 2 && (c.motion ?? 0) >= 0.35 && !prevZoomed && c.outStart - lastEnd >= zs.spacing;
    prevZoomed = false;
    if (!ok) continue;
    const bw = b[1] - b[0], bh = b[3] - b[2];
    let z = Math.min(zs.max,1 / (Math.max(bw, bh) * 1.25), 1 + 0.025 * c.outDuration);
    z = Math.floor(z * 200) / 200;
    if (z < ZOOM_MIN) continue;
    const { crop } = c;
    const zw = crop.width / z, zh = crop.height / z;
    // 寄った後の範囲が書き出しの大きさ（1080）より小さくなる＝拡大になる素材（1080pなど）ではズームしない（ぼやけるため）
    if (zw < OUT_W - 1) continue;
    const cx = crop.left + ((b[0] + b[1]) / 2) * crop.width;
    const cy = crop.top + ((b[2] + b[3]) / 2) * crop.height;
    const rect = {
      left: clamp(cx - zw / 2, crop.left, crop.left + crop.width - zw),
      top: clamp(cy - zh / 2, crop.top, crop.top + crop.height - zh),
      width: zw, height: zh,
    };
    // 手元（＋少しの余白）が寄った後の枠に収まるか確かめる
    const bx0 = crop.left + b[0] * crop.width, bx1 = crop.left + b[1] * crop.width;
    const by0 = crop.top + b[2] * crop.height, by1 = crop.top + b[3] * crop.height;
    const mx = zw * 0.04, my = zh * 0.04;
    if (bx0 - mx < rect.left || bx1 + mx > rect.left + zw || by0 - my < rect.top || by1 + my > rect.top + zh) continue;
    // ゆっくり寄る（in）と、寄った所からゆっくり引く（out）を交互に使う
    c.zoom = { z, rect, dir: zoomCount++ % 2 ? 'out' : 'in' };
    lastEnd = c.outStart + c.outDuration;
    prevZoomed = true;
  }
  // 手元がまとまって動く場面がなく、一度もズームしなかったとき: 単調にならないよう、長めの説明の場面だけ
  // ごく控えめ（1.04倍）に、画面の中央へゆっくり寄る・引く。手元の範囲がわかる場面は、それが切れない場合だけ
  if (zoom && !zoomCount) {
    lastEnd = -Infinity;
    for (const c of tl) {
      if (c.outDuration < 4 || c.outStart - lastEnd < zs.spacing || c.outStart < 2) continue;
      const z = 1.04, { crop } = c;
      const zw = crop.width / z, zh = crop.height / z;
      if (zw < OUT_W - 1) continue; // 拡大になる（ぼやける）素材ではズームしない
      const rect = { left: crop.left + (crop.width - zw) / 2, top: crop.top + (crop.height - zh) / 2, width: zw, height: zh };
      const b = c.inCrop;
      if (b) {
        const bx0 = crop.left + b[0] * crop.width, bx1 = crop.left + b[1] * crop.width;
        const by0 = crop.top + b[2] * crop.height, by1 = crop.top + b[3] * crop.height;
        if (bx0 < rect.left || bx1 > rect.left + zw || by0 < rect.top || by1 > rect.top + zh) continue;
      }
      c.zoom = { z, rect, dir: zoomCount++ % 2 ? 'out' : 'in', gentle: true };
      lastEnd = c.outStart + c.outDuration;
    }
  }
  return tl;
}

// 出力の時刻 t での切り抜き枠（ズームはゆっくり始まりゆっくり止まる）
export function cropAt(clip, t) {
  if (!clip.zoom) return clip.crop;
  const x = clamp((t - clip.outStart) / clip.outDuration, 0, 1);
  const s = x * x * (3 - 2 * x);
  const e = clip.zoom.dir === 'out' ? 1 - s : s;
  const a = clip.crop, b = clip.zoom.rect;
  return {
    left: a.left + (b.left - a.left) * e, top: a.top + (b.top - a.top) * e,
    width: a.width + (b.width - a.width) * e, height: a.height + (b.height - a.height) * e,
  };
}

// 字幕の不透明度（フェードイン・フェードアウト）
export function subtitleAlpha(page, t) {
  return clamp(Math.min((t - page.start) / page.fadeIn, (page.end - t) / page.fadeOut, 1), 0, 1);
}

export function formatTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

// 文字起こしの1つの塊に複数の文が入っている場合（プロンプトを与えると Whisper は文ごとの時刻を出さなくなる）、
// 「。」で文に分け、音声の無音の切れ目に合わせて各文の時刻を割り当てる
export function splitSentences(text) {
  return (text || '').split(/(?<=[。！？!?])/).map(t => t.trim()).filter(Boolean);
}

export function alignSentences(chunks, regions) {
  const out = [];
  for (const c of chunks) {
    const sents = splitSentences(c.text);
    if (sents.length <= 1) { out.push(c); continue; }
    const pieces = speechPieces(regions, c.start - 0.3, c.end + 0.3);
    const start = pieces.length ? pieces[0].start : c.start;
    const end = pieces.length ? pieces[pieces.length - 1].end : c.end;
    const spans = pieces.length ? pieces : [{ start, end }];
    const total = piecesDuration(spans);
    // 話している時間の割合 f の地点の時刻
    const timeAt = f => {
      let rest = f * total;
      for (const p of spans) {
        const d = p.end - p.start;
        if (rest <= d) return p.start + rest;
        rest -= d;
      }
      return end;
    };
    const gaps = [], gapLens = [];
    for (let i = 1; i < spans.length; i++) {
      gaps.push((spans[i - 1].end + spans[i].start) / 2);
      gapLens.push(spans[i].start - spans[i - 1].end);
    }
    const lens = sents.map(moraCount); // 文字数ではなく読みの長さで割り振る
    const all = lens.reduce((a, b) => a + b, 0);
    const targets = [];
    let acc = 0;
    for (let i = 0; i < sents.length - 1; i++) { acc += lens[i]; targets.push(timeAt(acc / all)); }
    const bounds = [start, ...matchGaps(targets, gaps, gapLens)];
    bounds.push(end);
    sents.forEach((text, i) => {
      // 区切りは無音の真ん中なので、各文の時間を実際に話している部分に詰める
      const own = speechPieces(regions, bounds[i], bounds[i + 1]);
      const s0 = own.length ? own[0].start : bounds[i];
      const e0 = own.length ? own[own.length - 1].end : bounds[i + 1];
      out.push({ start: s0, end: e0, text, raw: c.raw, aligned: true });
    });
  }
  return out;
}

// 文の区切りの目安時刻 targets を、無音の切れ目 gaps に順番を保って割り当てる。
// 全体のずれが最小になる組み合わせを選ぶ（切れ目が足りない区切りは目安時刻のまま）。
// 文と文の間の「間」は読点の間より長いので、長い無音ほど選ばれやすくする
function matchGaps(targets, gaps, gapLens) {
  const K = targets.length, G = gaps.length, MISS = 2;
  const cost = (g, k) => Math.abs(gaps[g] - targets[k]) / (1 + gapLens[g]);
  // best[k][j]: k 個目までの区切りを決め、最後に使った切れ目が j-1 番（j=0 は未使用）のときの最小コスト
  const best = Array.from({ length: K + 1 }, () => new Array(G + 1).fill(Infinity));
  const prev = Array.from({ length: K + 1 }, () => new Array(G + 1).fill(null));
  best[0][0] = 0;
  for (let k = 0; k < K; k++) {
    for (let j = 0; j <= G; j++) {
      if (best[k][j] === Infinity) continue;
      // 切れ目を使わない
      if (best[k][j] + MISS < best[k + 1][j]) { best[k + 1][j] = best[k][j] + MISS; prev[k + 1][j] = [j, null]; }
      // j 番以降の切れ目を使う
      for (let g = j; g < G; g++) {
        const c = best[k][j] + cost(g, k);
        if (c < best[k + 1][g + 1]) { best[k + 1][g + 1] = c; prev[k + 1][g + 1] = [j, g]; }
      }
    }
  }
  let j = 0;
  for (let x = 1; x <= G; x++) if (best[K][x] < best[K][j]) j = x;
  const out = new Array(K);
  for (let k = K; k > 0; k--) {
    const [pj, g] = prev[k][j];
    out[k - 1] = g === null ? targets[k - 1] : gaps[g];
    j = pj;
  }
  for (let k = 1; k < K; k++) out[k] = Math.max(out[k], out[k - 1] + 0.2);
  return out;
}

// ---------- 字幕の時刻合わせ ----------

// 細かい発話区間（短い息継ぎでも区切る）。字幕の開始・終了とページの切り替えに使う
export function fineSpeech(rmsDb, threshold) {
  return detectSpeechWith(rmsDb, threshold, { minGap: 0.09, minLen: 0.08, pad: 0 });
}

function detectSpeechWith(rmsDb, threshold, { minGap, minLen, pad }) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= rmsDb.length; i++) {
    const on = i < rmsDb.length && rmsDb[i] > threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      const r = { start: start * FRAME_SEC - pad, end: i * FRAME_SEC + pad };
      const last = out[out.length - 1];
      if (last && r.start - last.end < minGap) last.end = r.end;
      else out.push(r);
      start = -1;
    }
  }
  return out.filter(r => r.end - r.start >= minLen);
}

// 読みの長さの目安（拍の数）。漢字は読みがわからないので 1.7 拍、数字は 1 桁 1.5 拍とみなす
export function moraCount(text) {
  let n = 0;
  for (const c of (text || '').replace(/[、。，．,.！？!?\s「」]/g, '')) {
    if ('ゃゅょぁぃぅぇぉャュョァィゥェォ'.includes(c)) n += 0.3;
    else if (/[\u4e00-\u9fff々]/.test(c)) n += 1.7;
    else if (/[0-9０-９]/.test(c)) n += 1.5;
    else if (/[A-Za-z]/.test(c)) n += 1.2;
    else n += 1;
  }
  return n;
}

// Whisper の文の時刻を、実際の声の出始め・終わりに合わせる（subStart, subEnd を付ける）。
// 自動カットに使う start / end は変えない。
// 先にすべての文の出始めを決めてから、終わりを「次の文の出始めより前の、最後の声の終わり」にする
export function refineSubtitleTiming(chunks, fine) {
  const out = chunks.map(c => ({ ...c }));
  // 1. 出始め: Whisper の開始時刻の近くにある声の出始め（前の文の出始めより後）
  let prevStart = -Infinity;
  for (const c of out) {
    let best = null;
    for (const r of fine) {
      if (r.start < c.start - 0.7 || r.start > c.start + 0.9 || r.start >= c.end || r.start <= prevStart + 0.2) continue;
      if (best === null || Math.abs(r.start - c.start) < Math.abs(best - c.start)) best = r.start;
    }
    c.subStart = best ?? Math.max(c.start, prevStart + 0.2);
    prevStart = c.subStart;
  }
  // 2. 終わり: 次の文の出始めより前で、Whisper の終了時刻を少し過ぎるまでの、最後の声の終わり
  out.forEach((c, i) => {
    const nextStart = i + 1 < out.length ? out[i + 1].subStart : Infinity;
    const limit = Math.min(c.end + 0.5, nextStart - 0.02);
    let end = null;
    for (const r of fine) {
      if (r.end <= c.subStart + 0.1 || r.start >= limit) continue;
      end = Math.min(r.end, limit);
    }
    c.subEnd = Math.max(c.subStart + 0.2, end ?? Math.min(c.end, limit));
    c.fine = fine.filter(r => r.end > c.subStart && r.start < c.subEnd)
      .map(r => ({ start: Math.max(r.start, c.subStart), end: Math.min(r.end, c.subEnd) }));
  });
  return out;
}

// 文の中のページの切り替え時刻（元の動画上）。読みの長さで話している時間を割り振り、近くの息継ぎに合わせる
export function pageSourceTimes(pageTexts, start, end, fine) {
  const spans = (fine && fine.length ? fine : [{ start, end }]).filter(r => r.end > r.start);
  const total = spans.reduce((a, r) => a + r.end - r.start, 0) || (end - start);
  const timeAt = f => {
    let rest = f * total;
    for (const r of spans) {
      if (rest <= r.end - r.start) return r.start + rest;
      rest -= r.end - r.start;
    }
    return end;
  };
  const gaps = [];
  for (let i = 1; i < spans.length; i++) gaps.push({ t: (spans[i - 1].end + spans[i].start) / 2, a: spans[i - 1].end, b: spans[i].start });
  const w = pageTexts.map(moraCount);
  const all = w.reduce((a, b) => a + b, 0) || 1;
  const times = [{ start, end }];
  let acc = 0;
  for (let i = 0; i < pageTexts.length - 1; i++) {
    acc += w[i];
    const target = timeAt(acc / all);
    // 近くの息継ぎに合わせる。長い間ほど区切りらしいので選ばれやすくする
    const cost = x => Math.abs(x.t - target) / (1 + 2 * (x.b - x.a));
    const g = gaps.filter(x => Math.abs(x.t - target) <= 1.2 && x.t > times[times.length - 1].start + 0.3 && cost(x) <= 0.5)
      .sort((x, y) => cost(x) - cost(y))[0];
    const prev = times[times.length - 1];
    if (g) { prev.end = g.a; times.push({ start: g.b, end }); }
    else { prev.end = target; times.push({ start: target, end }); }
  }
  return times;
}

// 元の動画の時刻 t を、書き出す動画（カット後）の時刻に変換する。カットで削った部分なら次の場面の頭にする
export function srcToOut(clip, t) {
  for (const p of clip.pieces) {
    const d = p.frames / FPS;
    if (t < p.srcStart) return p.outStart;
    if (t <= p.srcStart + d) return p.outStart + (t - p.srcStart);
  }
  return clip.outStart + clip.outDuration;
}

const SUB_LEAD = 0.1;   // 声より少しだけ先に出し始める（フェードの分）
const SUB_LINGER = 0.25; // 話し終わってから少しだけ残す

// 1文字ごとの時刻（ReazonSpeech・原稿）がわかるときは、ページの最初の文字を話した時刻でページを切り替える。
// 文字の時刻は声より少し早めに出るので CHAR_LAG を足す。字幕を手直しした・文の一部を取り除いた場合（文字と時刻が
// 合わない）は使わない（null を返す）
const CHAR_LAG = 0.15;
function charPageTimes(pageTexts, clip, fine) {
  const text = clip.text || '', times = clip.times;
  if (!times || times.length !== text.length) return null;
  const strip = t => t.replace(/[、。\s]/g, '');
  const out = [];
  let cursor = 0;
  for (const pt of pageTexts) {
    const head = strip(pt).slice(0, 2);
    let at = -1;
    for (let i = cursor; i < text.length; i++) if (strip(text.slice(i, i + 4)).startsWith(head)) { at = i; break; }
    if (at < 0) return null;
    out.push({ at, start: times[at] + CHAR_LAG });
    cursor = at + Math.max(1, strip(pt).length - 1);
  }
  // 最後のページの終わり: 最後の文字の時刻のあと、声が続いている所まで
  const lastT = times[times.length - 1] + CHAR_LAG;
  const v = fine.find(r => r.start <= lastT + 0.05 && r.end >= lastT - 0.05);
  const end = Math.min(clip.subEnd ?? lastT + 0.4, Math.max(lastT + 0.2, v ? v.end : lastT + 0.3));
  // 2ページ目からは、文字の時刻の少し後に声の出始め（声の区間の始まり）があれば、そこに合わせる。
  // 原稿の文字の時刻は、字幕AIの文字と対応しない所では前後から割り振るため、声より早くなることがある
  for (let i = 1; i < out.length; i++) {
    const on = fine.find(r => r.start >= out[i].start - 0.15 && r.start <= out[i].start + 0.8);
    if (on) out[i].start = Math.max(out[i - 1].start + 0.3, on.start - 0.1);
  }
  // 最初のページは、声の出始めに合わせた表示開始（subStart）から
  return out.map((p, i) => ({ start: i ? p.start : (clip.subStart ?? p.start), end: i + 1 < out.length ? out[i + 1].start : end }));
}

// 時刻 a〜b の間の無音（声の区間 fine のすき間）の長さ
function silenceBetween(fine, a, b) {
  let sum = 0;
  for (let i = 1; i < fine.length; i++) {
    const g0 = Math.max(a, fine[i - 1].end), g1 = Math.min(b, fine[i].start);
    if (g1 > g0) sum += g1 - g0;
  }
  return sum;
}

// 1文字ごとの時刻と声の区間から、「i 文字目の前の声の間」を返す関数を作る（わからないときは null）
function charPauses(clip, fine) {
  const text = clip.text || '', times = clip.times;
  if (!times || times.length !== text.length || !fine.length) return null;
  const f = i => {
    let a = i - 1;
    while (a >= 0 && /[、。\s]/.test(text[a])) a--;
    if (a < 0 || i >= text.length) return 0;
    return silenceBetween(fine, times[a] + CHAR_LAG, times[i] + CHAR_LAG);
  };
  // i〜j 文字目を表示しておく時間（i 文字目を話し始めてから j 文字目を話し始めるまで。文の最後は少し残す）
  // ページの切り替えは、文字の時刻の少し後の声の出始めに合わせる（charPageTimes と同じ）
  const at = k => { const t = times[k] + CHAR_LAG, on = fine.find(r => r.start >= t - 0.15 && r.start <= t + 0.8); return on ? on.start - 0.1 : t; };
  f.span = (i, j) => (j < text.length ? at(j) : times[text.length - 1] + CHAR_LAG + 0.4) - (i ? at(i) : times[0]);
  return f;
}

// 1ページを表示しておく長さの上限（読むのに十分な時間）。字幕AIが言葉を聞き落とした区間で、
// 残った文字が何秒も出たままにならないようにする
export function pageMaxDuration(text) {
  return Math.max(1.6, 1.0 + moraCount(text) * 0.2);
}

function timedPages(clip, text) {
  // 手直しで表示時刻が変わっていても、その範囲の中の発話だけを使う
  const fine = (clip.fine || []).map(r => ({ start: Math.max(r.start, clip.subStart), end: Math.min(r.end, clip.subEnd) })).filter(r => r.end > r.start);
  // 声の間を、ページ・行の区切りに使う（1文字ごとの時刻がわかるとき）
  const pages = subtitlePages(text, 1, SUB_MAX_CHARS, SUB_LINES, text === clip.text ? charPauses(clip, fine) : null);
  if (!pages.length) return [];
  const src = charPageTimes(pages.map(p => p.lines.join('')), clip, fine) || pageSourceTimes(pages.map(p => p.lines.join('')), clip.subStart, clip.subEnd, fine);
  const clipEnd = clip.outStart + clip.outDuration;
  const out = pages.map((p, i) => ({
    lines: p.lines,
    start: Math.max(clip.outStart, srcToOut(clip, src[i].start) - SUB_LEAD),
    end: Math.min(clipEnd, srcToOut(clip, src[i].end) + SUB_LINGER),
  }));
  for (let i = 0; i < out.length; i++) {
    const limit = i + 1 < out.length ? out[i + 1].start : clipEnd;
    out[i].end = Math.min(out[i].end, limit, out[i].start + pageMaxDuration(out[i].lines.join('')));
    // 短すぎて読めないページは、次のページの直前まで延ばす（文字は省かない）
    if (out[i].end - out[i].start < 0.5) out[i].end = Math.min(limit, out[i].start + 0.5);
  }
  return out;
}

// ---------- 冒頭のテキスト・最後のフェード ----------

// 冒頭に大きく出す短い文字（白の太いゴシック・最大3行）。表示は約2秒で、ふわっと出てふわっと消える
// お手本の手動編集は、冒頭の約0.7秒だけ・画面の中央（文字の中心が高さの47%）に出していた。初期設定は1秒・高さの45%
export const OPENING = { maxLines: 3, maxChars: 9, start: 0, duration: 1.0, minDuration: 0.6, maxDuration: 4.0, fadeIn: 0.1, fadeOut: 0.25, y: 0.45 };
// 冒頭のテキストの表示時間の選択肢（秒）
export const OPENING_DURATIONS = [0.7, 1.0, 1.5, 2.0, 3.0];

// 動画タイトルから、冒頭に出す文字の案を作る（1行9文字前後・最大3行。言葉の途中では改行しない）。
// 長いタイトルは3行に収まる所までにする（確認画面で直せる）
export function openingLines(title) {
  const t = (title || '').normalize('NFKC').replace(/[【】「」『』《》〈〉"]/g, ' ').trim();
  if (!t) return [];
  const parts = t.split(/[\n／/｜|!！?？。・]+|\s{1,}|、/).map(x => x.trim()).filter(Boolean);
  for (const maxChars of [OPENING.maxChars, OPENING.maxChars + 2]) {
    const lines = parts.flatMap(p => wrapLines(p, maxChars, null, 0));
    if (lines.length <= OPENING.maxLines || maxChars > OPENING.maxChars) return lines.slice(0, OPENING.maxLines);
  }
  return [];
}

// 入力された冒頭の文字（改行で行を分ける）を、表示する行にする。1行が長すぎるときは自然な位置で折り返す
export function openingText(text) {
  const lines = (text || '').normalize('NFKC').split('\n').map(l => l.trim()).filter(Boolean)
    .flatMap(l => (l.length > OPENING.maxChars + 3 ? wrapLines(l, OPENING.maxChars + 2, null, 0) : [l]));
  return lines.slice(0, OPENING.maxLines);
}

// 書き出しに使う冒頭のテキストの設定。clip: 最初の場面（手元の位置を避ける）
export function openingPlan(lines, duration = OPENING.duration, firstClip = null) {
  if (!lines || !lines.length) return null;
  const d = clamp(duration, OPENING.minDuration, OPENING.maxDuration);
  // 最初の場面で手元が画面の上の方で動いているときは、文字を少し下げる（手元を隠さない）
  const b = firstClip?.inCrop;
  const y = b && (firstClip.motion ?? 0) >= 0.2 && b[2] < 0.4 && b[3] < 0.6 ? 0.5 : OPENING.y;
  return { lines: lines.slice(0, OPENING.maxLines), start: OPENING.start, end: OPENING.start + d, fadeIn: OPENING.fadeIn, fadeOut: OPENING.fadeOut, y };
}

// 冒頭のテキストの不透明度（ゆっくり始まりゆっくり終わる）
export function openingAlpha(op, t) {
  if (!op) return 0;
  const x = clamp(Math.min((t - op.start) / op.fadeIn, (op.end - t) / op.fadeOut, 1), 0, 1);
  return x * x * (3 - 2 * x);
}

// 最後のフェードアウト（映像をなめらかに黒く・音声も同じ時間で小さくする）。
// END_FADE 秒で黒くなり、最後の END_HOLD 秒は真っ黒のまま終わる（最後のコマが必ず黒になる）
export const END_FADE = 0.9;
export const END_HOLD = 0.2;

// 出力の時刻 t での黒の濃さ（0〜1）。total は完成動画の長さ
export function endFadeAlpha(t, total, sec = END_FADE, hold = END_HOLD) {
  const h = Math.min(hold, total * 0.1);
  const d = Math.min(sec, total * 0.2);
  const end = total - h; // ここで真っ黒になる
  if (d <= 0 || t < end - d) return 0;
  const x = clamp((t - (end - d)) / d, 0, 1);
  return x * x * (3 - 2 * x);
}

// 最後の場面の後ろを少しだけ延ばす（最後のフェードアウトが話し声に重なりすぎないように）。
// 次の声が始まる前・元の動画の終わりまでの範囲で、最大 extra 秒。フェードは消えていく語尾（声の区間の最後）に
// 少し重なってよい（お手本の手動編集は、話し終わりから約0.2秒で終わり、最後の言葉に重ねて黒くしていた）
export function extendEnding(clips, voice, duration, extra = END_FADE * 0.4 + END_HOLD) {
  if (!clips.length) return clips;
  const last = clips[clips.length - 1];
  const p = last.pieces[last.pieces.length - 1];
  const next = (voice || []).find(v => v.start >= p.end - 0.01);
  const end = Math.min(duration, p.end + extra, next ? next.start - 0.05 : Infinity);
  if (end <= p.end) return clips;
  const pieces = [...last.pieces.slice(0, -1), { ...p, end }];
  return [...clips.slice(0, -1), { ...last, pieces, end }];
}
