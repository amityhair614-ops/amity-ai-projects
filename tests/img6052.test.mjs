// 固定テスト素材 IMG_6052（57.19秒・言い間違い・くり返しを含む）: 手動編集のお手本（49.53秒）と比べる。
// 複数の動画を1本にする確かめにも使った（この動画を話の切れ目で3本に分けて選び、1本の動画と同じ構成になることを確かめた）
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture, planFixture, compare } from './reference.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/img6052');
const { analysis, manual } = loadFixture(dir);
const { timeline, units } = planFixture(analysis, manual.targetSec);
const cmp = compare(manual, timeline, analysis);
const texts = cmp.pages.map(p => p.text);

test('IMG_6052: 念を押すくり返し（「すき量15%…」→あとで「15%…」）は、前のくわしい説明を外さない', () => {
  const first = units.find(u => u.text.startsWith('すき量十五'));
  assert.ok(first && !first.excluded, first?.excluded);
  for (const s of cmp.spoken.filter(s => !s.retake)) assert.ok(s.cover >= 0.8, `「${s.text}」 ${(s.cover * 100).toFixed(0)}%`);
});

test('IMG_6052: 長さは手動編集より長いが、その差は手動編集が削った「ただ単に…」（4.7秒）の分まで', () => {
  // 手動編集が削った「ただ単に切れないっていうことにつながっていきます」は、言い間違いか説明かを話した内容から決められないため残している
  assert.ok(cmp.outSec - manual.duration <= 4.7 + 0.5, `${cmp.outSec.toFixed(2)}秒`);
});

test('IMG_6052: 字幕の数・用語・区切り（「すき量」「15%」「2000円」・言葉の途中で切らない）', () => {
  const all = texts.join('');
  for (const w of ['すき量です', 'すき量15%', '10%', '5%', '2000円以上', '100均']) assert.ok(all.includes(w), w);
  assert.ok(!all.includes('好き料') && !/[一二三四五六七八九十百千]+[％%円]/.test(all));
  for (const t of texts) {
    assert.ok(t.length <= 15, t);
    assert.ok(!/^(?:けでは|円|はなく|高いほど)|[0-9]$|わ$|逆に$/.test(t), `不自然な区切り: ${t}`);
  }
  assert.ok(texts.includes('高ければ高いほど'), texts.join(' / '));
  assert.ok(texts.some(t => t.startsWith('逆に')), '「逆に」は次の文の頭');
  assert.ok(texts.includes('すき量です'), '答えの「それは」は字幕に書かない');
  // 否定の注意は省かない
  assert.ok(all.includes('使わないほうがよいです'));
});
