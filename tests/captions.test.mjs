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
  for (const t of ['でもレイヤーを入れるとなると', 'もしボブを軽くして', 'それはどこなのか', 'その後で切る', 'そのまま切る', '毛先がはねるので注意',
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

test('話し言葉の「〜するです」は「〜する」に（「〜ないです」「〜いです」はそのまま）・「下さい」は「ください」に', () => {
  assert.equal(displayText('生え際辺りを軽くするです').text, '生え際辺りを軽くする');
  assert.equal(displayText('あまり軽くしないです').text, 'あまり軽くしないです');
  assert.equal(displayText('落ちてしまいやすいです').text, '落ちてしまいやすいです');
  assert.equal(displayText('結べなくなります').text, '結べなくなります');
  assert.equal(displayText('中心にやってみて下さい').text, '中心にやってみてください');
});

test('字幕に書かなくても意味が変わらない言葉（このように・それは・そうならないために・しかも・その・あの）は省く（音声は残す）', () => {
  const cases = {
    'それは左右何度も': '左右何度も', 'それは表面の髪が長いからです': '表面の髪が長いからです',
    'しかもガタガタになりにくいです': 'ガタガタになりにくいです', 'そのパーセンテージが': 'パーセンテージが',
    'あのヘアクリップを': 'ヘアクリップを', 'このようにやっていきましょう': 'やっていきましょう', '目印をつけてです': '目印をつけて',
  };
  for (const [a, b] of Object.entries(cases)) assert.equal(displayText(a).text, b, a);
  // 「そうならないために」だけのページは字幕を出さない（字幕のない時間があってよい）
  assert.equal(displayText('そうならないために').text, '');
  // 文の中の「このように」も省く（時刻も一緒に外す）
  const c = cleanForDisplay('残したい長さにこのように留めておく', [...Array(17).keys()]);
  assert.equal(c.text, '残したい長さに留めておく');
  assert.equal(c.times.length, c.text.length);
  // 否定・条件は省かない
  assert.equal(displayText('しかも切らないでください').text, '切らないでください');
  assert.equal(displayText('もしそうならないために').text, 'もしそうならないために');
});

