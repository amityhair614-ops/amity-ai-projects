// 表示用の字幕（captions.js）: 字幕に書かなくてよい言葉だけを省き、意味を変える言葉は省かない
import test from 'node:test';
import assert from 'node:assert/strict';
import { displayText, cleanForDisplay } from '../js/captions.js';

test('つなぎ言葉・調子をとる「ね」・「という」・文の頭の「なので」を省く', () => {
  assert.equal(displayText('えっとまずはブロッキングです').text, 'まずはブロッキングです');
  assert.equal(displayText('レイヤーがねついていないので').text, 'レイヤーがついていないので');
  assert.equal(displayText('その分ねまとまりやすいというメリットはねあります').text, 'その分まとまりやすいメリットはあります');
  assert.equal(displayText('なので軽くしないでください').text, '軽くしないでください');
  assert.equal(displayText('そうなると美容室に行って').text, '美容室に行って');
});

test('意味を変える言葉・言葉の一部は省かない', () => {
  for (const t of ['でもレイヤーを入れるとなると', 'もしボブを軽くして', 'それは表面の髪が長いからです', '毛先がはねるので注意',
    '重くて仕方ないということであれば', 'だから軽くしない', '45度で引き出します', '切ってるね']) {
    assert.equal(displayText(t).text, t, t);
  }
});

test('文の中で省いた文字の時刻も一緒に外す（ページの切り替えを話した時刻に合わせるため）', () => {
  const text = 'ボブをね軽く';
  const c = cleanForDisplay(text, [0, 1, 2, 3, 4, 5]);
  assert.equal(c.text, 'ボブを軽く');
  assert.deepEqual(c.times, [0, 1, 2, 4, 5]);
});

test('接続の言葉だけのページ（「なので」「そうなると」）は字幕を出さない（音声は残す）', () => {
  assert.equal(displayText('なので').text, '');
  assert.equal(displayText('そうなると').text, '');
  assert.equal(displayText('でも').text, 'でも');
});
