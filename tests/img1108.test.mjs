// 固定テスト素材 IMG_6486〜6491（1108・6本・72.57秒）: 手動編集（52.80秒・字幕なし）と、ご指定の字幕の区切り（正解例）と比べる
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture, planFixture, compare } from './reference.mjs';
import { passDoubts } from '../js/plan.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/img1108');
const { analysis, manual } = loadFixture(dir);
const { timeline } = planFixture(analysis, manual.targetSec, { pace: 'tight' });
const cmp = compare(manual, timeline, analysis);
const texts = cmp.pages.map(p => p.text);
const all = texts.join(' / ');

test('IMG_1108: ご指定の字幕の区切り（意味のまとまり）になる', () => {
  for (const t of ['セルフカットで', 'ボブを切っていく際', '髪の毛を', '濡らして切った方がよいのか', '乾いた状態の髪を切ればよいのか', '結論', '傷んでなかったら', '長さが短くなっちゃう', 'おそれがあります', '仕上がりをイメージしたい']) {
    assert.ok(texts.includes(t), `「${t}」: ${all}`);
  }
  assert.equal(cmp.breaks.recall, 1, '正解例の切れ目はすべて切れ目になる');
  for (const t of texts) assert.ok(t.length <= 15, t);
});

test('IMG_1108: 字幕で省く言葉（それとも・でも・ちなみにですが・かなり・そのような・〜したいのであれば）を出さない。声は残す', () => {
  for (const w of ['それとも', 'でも若干', 'ちなみに', 'かなり', 'そのような', 'したいのであれば']) assert.ok(!all.includes(w), `「${w}」: ${all}`);
  // 否定・条件は残す
  for (const w of ['傷んでなかったら', 'イメージできないです', 'くしも通らない', '濡れている髪を切るのであれば']) assert.ok(all.replace(/ \/ /g, '').includes(w), w);
});

test('IMG_1108: 6本目の最初の文（長い窓で3通りとも落とした文）が字幕に出る', () => {
  assert.ok(all.includes('ダメージしている場合です'), all);
  // 否定の聞き落としの確認: 「ダメージ」を打ち消しの言葉と取り違えない・文をまるごと落とした読み方とは比べない
  for (const key of ['ダメージ', 'イメージできない', 'おそれ']) {
    const c = analysis.chunks.find(x => x.text.includes(key));
    const k = analysis.lay.findIndex(l => c.start >= l.offset - 0.5 && c.start < l.end);
    const off = analysis.lay[k].offset;
    assert.deepEqual(passDoubts({ ...c, start: c.start - off, end: c.end - off }, analysis.verify.perSource[k].passes), [], key);
  }
});

test('IMG_1108: テンポ重視の間は手動編集と同じくらい（話の途中の間の中央0.1秒）・言葉は削らない', () => {
  assert.ok(cmp.pauses.median <= manual.pauses.median + 0.03 && cmp.pauses.p90 <= manual.pauses.p90 + 0.05, JSON.stringify(cmp.pauses));
  assert.ok(cmp.outSec - manual.duration <= 2.5, `${cmp.outSec.toFixed(2)}秒（手動 ${manual.duration}秒。手動は語尾の小さな音を少し切っている所がある）`);
  for (const s of cmp.spoken) assert.ok(s.cover >= 0.85, `${s.text} ${(s.cover * 100).toFixed(0)}%`);
});
