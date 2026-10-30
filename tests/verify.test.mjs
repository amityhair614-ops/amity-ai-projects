// 字幕AIの聞き取りを音声で確かめる処理（js/verify.js）のテスト。
// 本物のモデルを使った確認（固定テスト素材4本）は README の v0.9.7 の項。ここでは計算の正しさと、直し方の決まりを確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VERIFY, baseLattice, scoreEdit, scoreEdits, diffRegions, endingCandidates, briefWords, domainWords,
  proposeEdits, chooseEdits, applyEdits, verifyUnits, verifiedRaw, attachAudioFixes,
} from '../js/verify.js';
import { BEAUTY_TERMS } from '../js/plan.js';
import { fixTerms } from '../js/asrtext.js';

// 小さな作り物のモデル（文字6種類・4次元）。ジョイナーは「エンコーダー＋デコーダー」の線形の組み合わせ
function fakeModel(V = 6, D = 4, seed = 1) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const W = Array.from({ length: D * V }, rnd), U = Array.from({ length: D * V }, rnd);
  const decVec = ([a, b]) => Array.from({ length: D }, (_, k) => Math.sin(a * 1.3 + b * 0.7 + k));
  return {
    D,
    async decoder(pairs) { return Float32Array.from(pairs.flatMap(decVec)); },
    async joiner(e, d, n) {
      const out = new Float32Array(n * V);
      for (let i = 0; i < n; i++) for (let v = 0; v < V; v++) {
        let s = 0;
        for (let k = 0; k < D; k++) s += e[i * D + k] * W[k * V + v] + d[i * D + k] * U[k * V + v];
        out[i * V + v] = 2 * s;
      }
      return out;
    },
  };
}
const fakeEnc = (T, D, seed = 3) => {
  let x = seed;
  return Float32Array.from({ length: T * D }, () => ((x = (x * 48271) % 2147483647) / 2147483647) * 2 - 1);
};

test('verify: 直す候補の点数は、直した文字の並びを最初から計算したときと同じ（前後を使い回す計算が正しい）', async () => {
  const m = fakeModel(), T = 40, eo = fakeEnc(T, m.D);
  const ids = [1, 2, 3, 4, 5, 2, 3], frames = [3, 7, 12, 17, 22, 28, 33];
  const L = await baseLattice(m, eo, T, m.D, ids, frames);
  assert.ok(Number.isFinite(L.ll));
  const cases = [
    { i: 2, j: 3, ids: [5], frames: [12] }, // 置き換え
    { i: 2, j: 4, ids: [1], frames: [14] }, // 2文字→1文字
    { i: 3, j: 3, ids: [2, 1], frames: [14, 15] }, // 差し込み
    { i: 4, j: 5, ids: [], frames: [] }, // 消す
    { i: 6, j: 7, ids: [1, 4], frames: [33, 35] }, // 最後の文字
    { i: 0, j: 1, ids: [4], frames: [3] }, // 最初の文字
    { i: 7, j: 7, ids: [4, 4], frames: [36, 38] }, // 文の終わりに足す
  ];
  for (const e of cases) {
    const h = [...ids.slice(0, e.i), ...e.ids, ...ids.slice(e.j)], hf = [...frames.slice(0, e.i), ...e.frames, ...frames.slice(e.j)];
    const full = await baseLattice(m, eo, T, m.D, h, hf);
    const r = await scoreEdit(L, e);
    assert.ok(Math.abs(r.ac - (full.ll - L.ll)) < 1e-6, `${JSON.stringify(e)}: ${r.ac} / ${full.ll - L.ll}`);
  }
  // まとめて計算しても同じ
  const many = await scoreEdits(L, cases);
  for (const [k, e] of cases.entries()) assert.ok(Math.abs(many[k].ac - (await scoreEdit(L, e)).ac) < 1e-9);
});

test('verify: 文字の違う所（書き方だけの違いは同じとみなす）・両方の文字を残す候補', () => {
  assert.deepEqual(diffRegions([...'うまくいきうません'], [...'うまくカバー']), [{ i: 3, j: 9, k: 3, l: 6 }]);
  const ed = proposeEdits([...'ボをね軽く'].map((s, k) => ({ s, t: k * 0.2 })), { passes: [[...'ボブを軽く'].map((s, k) => ({ s, t: k * 0.2 }))] });
  const tos = ed.filter(e => e.kind === 'pass').map(e => e.to.join(''));
  assert.ok(tos.includes('ブを') && tos.includes('ブをね'), tos.join(','));
  // ギリギリ・ぎりぎりは同じ言葉（直さない）
  const g = proposeEdits([...'特にギリギリ結べる'].map((s, k) => ({ s, t: k * 0.2 })), { passes: [[...'特にぎりぎり結べる'].map((s, k) => ({ s, t: k * 0.2 }))] });
  assert.equal(g.filter(e => e.kind === 'pass').length, 0);
  // まとまりの頭・終わりの文字を消すだけの直しはしない
  const h = proposeEdits([...'伸びて重く'].map((s, k) => ({ s, t: k * 0.2 })), { passes: [[...'びて重く'].map((s, k) => ({ s, t: k * 0.2 }))] });
  assert.equal(h.filter(e => e.kind === 'pass').length, 0);
});

test('verify: 文の終わりの聞き落としの候補（話し言葉の形から。動画ごとの言葉ではない）', () => {
  assert.ok(endingCandidates('結べなく').includes('なります'));
  assert.ok(endingCandidates('やっていき').includes('ましょう'));
  assert.deepEqual(endingCandidates('できませ'), ['ん']);
  assert.deepEqual(endingCandidates('軽くしないです'), []);
  assert.deepEqual(endingCandidates('この辺り'), []);
  // 間のある所だけ（間なく続く所・すでに続きがある所には足さない）
  const base = [...'結べなくなぜか'].map((s, k) => ({ s, t: k < 4 ? k * 0.15 : 1 + k * 0.15 }));
  const ends = proposeEdits(base).filter(e => e.kind === 'end');
  assert.ok(ends.length && ends.every(e => e.i === 4), JSON.stringify(ends.map(e => [e.i, e.to.join('')])));
  const tight = [...'結べなくなります'].map((s, k) => ({ s, t: k * 0.12 }));
  assert.equal(proposeEdits(tight).filter(e => e.kind === 'end').length, 0);
});

test('verify: 入力した言葉の取り出し（送りがなを言葉にしない）・美容の用語', () => {
  const w = briefWords(['伸びて重くなったボブをセルフで軽くする', '絶対にすいてはいけない場所'], ['ヘアカッター']);
  for (const x of ['ボブ', 'セルフ', '絶対', '場所', 'ヘアカッター']) assert.ok(w.includes(x), x);
  assert.ok(!w.includes('くなった') && !w.some(x => x.startsWith('にす')), w.join(' '));
  const d = domainWords(BEAUTY_TERMS).map(x => x.w);
  assert.ok(d.includes('ボブ') && d.includes('すかない'));
  // 普通の言葉とまぎらわしい形（すいて・すきます）は入れない
  assert.ok(!d.includes('すいて') && !d.includes('すきます'));
});

test('verify: 入力した言葉の候補は、言葉の途中・助詞1文字・否定の有無が変わる所には作らない', () => {
  const mk = t => [...t].map((s, k) => ({ s, t: k * 0.12 }));
  const all = () => 0;
  const words = ['ボブ', 'すかない', 'すきます'];
  const tos = base => proposeEdits(mk(base), { words, firstProb: all }).filter(e => e.kind === 'term').map(e => base.slice(e.i, e.j) + '→' + e.to.join(''));
  const a = tos('なった部分を軽く');
  assert.ok(a.includes('部分→ボブ'), a.join(','));
  assert.ok(!a.includes('部→ボブ') && !a.includes('分→ボブ') && !a.some(x => x.startsWith('を→')), a.join(','));
  // 「つきません」の否定を消す置き換え（→すきます）は作らない（後ろの「ん」も見る）
  const b = tos('まとまりがつきません');
  assert.ok(!b.some(x => /^(?:つきませ|つきません|きません|ません)→すきます$/.test(x)), b.join(','));
  assert.ok(tos('絶対につかないで').includes('つかない→すかない'));
});

test('verify: 使う直しの選び方（決まった差より大きいときだけ・重なりは1つ・入力した言葉は話に出やすい分を足す）', () => {
  const e = (kind, i, j, to, score, ac, extra = {}) => ({ kind, i, j, to: [...to], score, ac, ...extra });
  // 別の読み方の「棒」（4.88）より、入力した「ボブ」（2.48 ＋ 話に出やすさ 4.5）を選ぶ（IMG_5980 で測った値）
  let c = chooseEdits([e('pass', 5, 6, '棒', 4.88, 3.95), e('term', 5, 6, 'ボブ', 2.48, -2.8)]);
  assert.deepEqual(c.map(x => x.to.join('')), ['ボブ']);
  // 差が小さい・音声に合っていない候補は使わない
  c = chooseEdits([e('term', 1, 3, '場所', -5, -6), e('term', 4, 5, 'ボブ', 0, -12), e('pass', 7, 8, 'あ', 2, 2), e('end', 9, 9, 'ね', 1, 0.2)]);
  assert.equal(c.length, 0);
  // 入力した言葉への直しで、音声との一致が低めのものは「要確認」
  c = chooseEdits([e('term', 1, 3, 'すかない', -2.8, -5.2)]);
  assert.ok(c[0].check);
  // となり合う直しは1つだけ（「ボ→ボブ」と「をね→ブをね」で「ボブブをね」にしない）
  c = chooseEdits([e('term', 2, 3, 'ボブ', 12.5, 10.8), e('pass', 3, 5, 'ブをね', 12.49, 10.8)]);
  assert.equal(c.length, 1);
  // 文の終わり: 否定と肯定の候補が近いときは要確認
  c = chooseEdits([e('end', 4, 4, 'なります', 2.8, 1), e('end', 4, 4, 'なりません', 1.6, -1)]);
  assert.equal(c[0].to.join(''), 'なります');
  assert.ok(c[0].check && /否定か肯定か/.test(c[0].note));
});

test('verify: 直しを当てはめる（時刻は前後の文字の間に並べる）・文の印', () => {
  const base = [...'結べなくなぜ'].map((s, k) => ({ s, t: k < 4 ? 1 + k * 0.15 : 2.5 + k * 0.1 }));
  const { tokens, fixes } = applyEdits(base, [{ kind: 'end', i: 4, j: 4, to: [...'なります'], score: 3.2, ac: 1.2, check: false }]);
  assert.equal(tokens.map(k => k.s).join(''), '結べなくなりますなぜ');
  for (let k = 1; k < tokens.length; k++) assert.ok(tokens[k].t >= tokens[k - 1].t);
  assert.ok(tokens[4].t > base[3].t && tokens[7].t < base[4].t);
  assert.equal(fixes[0].to, 'なります');
  const raw = verifiedRaw([{ tokens, fixes: [{ ...fixes[0], check: true, note: '文の終わりを音声から補いました' }] }]);
  const chunks = attachAudioFixes([{ start: 0.9, end: 3.4, text: '結べなくなりますなぜ' }], raw.fixes);
  assert.equal(chunks[0].fixed[0].to, 'なります');
  assert.ok(chunks[0].doubts.some(d => /要確認/.test(d)));
});

test('verify: 確かめる単位は、はっきりした間で分け、言葉の途中・助詞の前では分けない', () => {
  const toks = [];
  let t = 0;
  for (const s of 'もしボブをね軽くして') { toks.push({ s, t }); t += s === 'し' ? 0.5 : 0.15; }
  const fine = [{ start: 0, end: 0.2 }, { start: 0.65, end: 2.5 }];
  const u = verifyUnits(toks, fine, null, { maxSec: 0.5 });
  // 「ブ｜を」（助詞の前）・「ボ｜ブ」（カタカナの途中）では分けない
  for (const x of u) assert.ok(!/^[をブ]/.test(x.tokens.map(k => k.s).join('')), u.map(x => x.tokens.map(k => k.s).join('')).join(' | '));
  assert.ok(u.every(x => x.start <= x.tokens[0].t && x.end > x.tokens[x.tokens.length - 1].t));
});

test('fixTerms: 音声で確かめた後は、入力した言葉に似ているだけの言葉を置き換えず、要確認の候補にする', () => {
  const c = { start: 0, end: 3, text: '絶対につかないでください' };
  assert.equal(fixTerms(c, [], ['すかないで']).text, '絶対にすかないでください'); // 音声で確かめていないとき（従来どおり・確認の印つき）
  const v = fixTerms(c, [], ['すかないで'], { audioChecked: true });
  assert.equal(v.text, '絶対につかないでください');
  assert.deepEqual(v.suggest, [{ from: 'つかないで', to: 'すかないで' }]);
  // 読みが同じ書き方の直し（すきばさみ → すきバサミ）は、音声で確かめた後も行う
  assert.equal(fixTerms({ start: 0, end: 2, text: 'すきばさみで' }, [], [], { audioChecked: true }).text, 'すきバサミで');
});

test('verify: 決まりの値（固定テスト素材で測った正しい直しと、話していない言葉への置き換えの間）', () => {
  // 正しい直し（−3.8〜+4.9）は通り、話していない言葉（−4.8以下）は通らない
  assert.ok(VERIFY.termMin > -4.8 && VERIFY.termMin <= -3.8);
  assert.ok(VERIFY.endMin <= 2.17 && VERIFY.endMin > 0);
});

test('verify: 長さで分けたまとまりの端（となりの声が窓にかかる所）の文字は直さない', () => {
  // 0.5秒ごとの文字（間0.3秒）が20秒続く: 長さで分ける。「下手」の後の間が一番長いが、送りがなの前なので分けない
  const toks = [];
  for (let k = 0; k < 40; k++) toks.push({ s: k === 20 ? '下' : k === 21 ? '手' : 'あ', t: k * 0.5 + (k >= 22 ? 0.15 : 0) });
  const fine = toks.map(k => ({ start: k.t - 0.1, end: k.t + 0.1 }));
  const u = verifyUnits(toks, fine, null, { maxSec: 12 });
  assert.ok(u.length >= 2);
  assert.ok(u.slice(1).every(x => x.lockHead > 0) && u.slice(0, -1).every(x => x.lockTail > 0));
  assert.ok(!u.some(x => x.tokens[0].t === toks[22].t), u.map(x => x.tokens.map(k => k.s).join('')).join(' | '));
  // まとまりの最後が「…です下手」（「すれば」は次のまとまり）のとき、「下手」を入力した言葉に置き換えない
  const base = [...'できないです下手'].map((s, k) => ({ s, t: k * 0.15 }));
  const ed = proposeEdits(base, { words: ['絶対'], firstProb: () => 0, lockTail: 3 });
  assert.ok(!ed.some(e => e.kind === 'term' && e.j > 5), JSON.stringify(ed.map(e => [e.i, e.j, e.to.join('')])));
  assert.ok(proposeEdits(base, { words: ['絶対'], firstProb: () => 0 }).some(e => e.j === 8));
});

test('verify: 美容の用語で、直すほどではないが音声とかなり合う候補は、直さずに要確認として知らせる', () => {
  const e = (kind, i, j, to, score, ac, extra = {}) => ({ kind, i, j, to: [...to], score, ac, ...extra });
  const c = chooseEdits([e('term', 3, 7, 'すかない', -3.26, -4.55, { domain: true }), e('term', 9, 11, 'パネル', -6, -8, { domain: true })]);
  assert.equal(c.length, 0);
  assert.deepEqual(c.suggest.map(x => x.to.join('')), ['すかない']);
  const chunks = attachAudioFixes([{ start: 0, end: 8, text: '絶対につかないでください' }], [], [{ from: 'つかない', to: 'すかない', t0: 6.2 }]);
  assert.deepEqual(chunks[0].suggest, [{ from: 'つかない', to: 'すかない' }]);
  assert.equal(chunks[0].text, '絶対につかないでください');
});
