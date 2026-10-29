// 字幕の区切り（意味のまとまり）を、手動編集3本の字幕と比べる。
// 手動編集の字幕の文字をつないで（字幕AIと同じく句読点なし／字幕の切れ目に読点あり の2通り）、アプリの区切り方で1行の字幕に分け、
// 手動編集の字幕の切れ目のうち、アプリでも切れ目になった割合を測る。1本の動画だけに合わせた区切り方になっていないかを確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subtitlePages } from '../js/plan.js';
import { breakRecall } from './reference.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const sets = {
  img5830: JSON.parse(fs.readFileSync(path.join(root, 'img5830/manual.json'))).subtitles,
  bob: JSON.parse(fs.readFileSync(path.join(root, 'bob/manual.json'))).subtitles,
  haircutter: JSON.parse(fs.readFileSync(path.join(root, 'haircutter/manual-subtitles.json'))).subtitles,
};
const pages = text => subtitlePages(text, text.length * 0.15).map(p => { assert.equal(p.lines.length, 1); assert.ok(p.lines[0].length <= 15, p.lines[0]); return p.lines[0]; });

for (const [name, subs] of Object.entries(sets)) {
  const texts = subs.map(s => s.text.replace(/、$/, ''));
  test(`字幕の区切り（${name}）: 手動編集の字幕の切れ目の多くで切れ目になる`, () => {
    const comma = breakRecall(texts, pages(texts.join('、')));
    const plain = breakRecall(texts, pages(texts.join('').replace(/、/g, '')));
    assert.ok(comma.recall >= 0.75, `切れ目に読点あり ${(comma.recall * 100).toFixed(0)}% ${comma.missed.join(' / ')}`);
    assert.ok(plain.recall >= 0.55, `句読点なし ${(plain.recall * 100).toFixed(0)}% ${plain.missed.join(' / ')}`);
  });
}
