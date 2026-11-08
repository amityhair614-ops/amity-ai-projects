// 固定テスト素材 IMG_6443〜6445（1107・3本）: 手動編集には字幕がないため、字幕の区切りの決まった所だけを確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planFixture } from './reference.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/img1107');
const analysis = JSON.parse(fs.readFileSync(path.join(dir, 'analysis.json'), 'utf8'));
const { timeline } = planFixture(analysis, 45);
const texts = timeline.flatMap(c => c.subtitles.filter(p => !p.cont).map(p => p.lines.join('')));
const all = texts.join(' / ');

test('IMG_1107: 言葉のまとまりで区切る（問いかけ・「〜たり」・「または」の前）。言葉の途中・名詞の説明の途中では区切らない', () => {
  for (const t of ['どうやればよいのか', 'やってはいけないのか', '短くなりすぎちゃったり', '思ったスタイルにならないです', 'または美容室行って見てもらう']) assert.ok(texts.includes(t), `「${t}」: ${all}`);
  assert.ok(!texts.includes('よいのか') && !texts.some(t => /思った$/.test(t)), all);
  for (const t of texts) assert.ok(t.length <= 15 && t.length >= 3, t);
});

test('IMG_1107: 言いかけの「これ」・くり返しの「それから」は字幕に出さない', () => {
  assert.ok(!/これ$|^それから/.test(texts.join('\n').replace(/\n/g, '|')) && !texts.some(t => t === 'これ' || t.startsWith('それから')), all);
});
