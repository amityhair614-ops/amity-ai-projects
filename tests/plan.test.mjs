// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_SEC, detectSpeech, transcriptionWindows, detectRetakes, buildUnits, selectUnits,
  subtitlePages, wrapLines, cropRect, buildTimeline, keywordHits, FPS,
} from '../js/plan.js';

// 区間 [start,end] だけ音がある dB 配列を作る
function makeRms(duration, loud) {
  const arr = new Float32Array(Math.ceil(duration / FRAME_SEC)).fill(-60);
  for (const [s, e] of loud) for (let t = s; t < e; t += FRAME_SEC) arr[Math.floor(t / FRAME_SEC)] = -20;
  return arr;
}

test('無音を検出し、短い無音はつなげる', () => {
  const rms = makeRms(30, [[1, 3], [3.2, 5], [10, 12]]);
  const { regions } = detectSpeech(rms);
  assert.equal(regions.length, 2);
  assert.ok(Math.abs(regions[0].start - 0.9) < 0.06);
  assert.ok(Math.abs(regions[0].end - 5.1) < 0.06);
  assert.ok(Math.abs(regions[1].start - 9.9) < 0.06);
});

test('全部無音なら話し区間なし', () => {
  assert.equal(detectSpeech(new Float32Array(200).fill(-70)).regions.length, 0);
});

test('文字起こし用の区切りは28秒以内', () => {
  const w = transcriptionWindows([{ start: 0, end: 10 }, { start: 12, end: 25 }, { start: 26, end: 40 }]);
  assert.deepEqual(w, [{ start: 0, end: 25 }, { start: 26, end: 40 }]);
});

test('言い直しを検出する（似た発言・合図の言葉）', () => {
  const flags = detectRetakes([
    { start: 0, end: 3, text: 'まずはバックからブロッキングを' },
    { start: 3.5, end: 7, text: 'まずはバックからブロッキングをしていきます' },
    { start: 8, end: 10, text: '次はサイドを切ります' },
    { start: 11, end: 13, text: 'あ、間違えた、言い直します' },
    { start: 14, end: 17, text: '次はトップを45度で引き出します' },
  ]);
  assert.ok(flags[0]);
  assert.equal(flags[1], null);
  assert.ok(flags[2]);
  assert.ok(flags[3]);
  assert.equal(flags[4], null);
});

test('「もう一回」だけでは言い直しにしない', () => {
  const flags = detectRetakes([
    { start: 0, end: 3, text: 'もう一回ここを確認します' },
    { start: 5, end: 8, text: '毛先を少しすいていきます' },
  ]);
  assert.deepEqual(flags, [null, null]);
});

test('用語の検出', () => {
  assert.deepEqual(keywordHits('45度でパネルを引き出します').sort(), ['パネル', '引き出し', '角度(〇度)'].sort());
});

function fakeVideo() {
  const duration = 600;
  const loud = [];
  const chunks = [];
  const lines = ['今日はボブの切り方を解説します', '最初に全体を濡らしておきます', '耳の後ろで分けていきます', 'ここは指一本分の厚さです', '毛先の重さを残すのが大事です', 'クシで真下にとかします', 'ハサミは横に入れます', '反対側も同じようにやります'];
  for (let s = 5; s < 590; s += 12) {
    loud.push([s, s + 6]);
    chunks.push({ start: s, end: s + 6, text: s % 36 === 5 ? 'ここでブロッキングを分けます' : lines[Math.floor(s / 12) % lines.length] });
  }
  // 無音部分での誤認識
  chunks.push({ start: 595, end: 599, text: 'ご視聴ありがとうございました' });
  chunks.sort((a, b) => a.start - b.start);
  const motion = { times: [], values: [], cx: [] };
  for (let t = 1; t < duration; t++) {
    motion.times.push(t);
    motion.values.push((t > 200 && t < 230) ? 10 : 1 + (t % 7) * 0.1);
    motion.cx.push(0.3);
  }
  const rmsDb = makeRms(duration, loud);
  return { duration, rmsDb, speech: detectSpeech(rmsDb), chunks, motion };
}

test('約60秒以内に収まり、時系列順・冒頭と最後を含む', () => {
  const v = fakeVideo();
  const units = buildUnits(v);
  assert.ok(!units.some(u => u.text.includes('ご視聴')), '無音部分の誤認識は除外');
  assert.ok(units.some(u => u.kind === 'action' && u.start > 195 && u.end < 235), '動きの多い場面が候補になる');
  const sel = selectUnits(units, v.duration);
  const total = sel.reduce((s, u) => s + u.duration, 0);
  assert.ok(total <= 60 && total >= 45, 'total=' + total);
  for (let i = 1; i < sel.length; i++) assert.ok(sel[i].start >= sel[i - 1].start);
  assert.ok(sel.some(u => u.intro));
  assert.ok(sel.some(u => u.ending));
  assert.ok(sel.some(u => u.keywords.length));
});

test('文字起こしなしでも構成できる', () => {
  const v = fakeVideo();
  const units = buildUnits({ ...v, chunks: null });
  const sel = selectUnits(units, v.duration);
  const total = sel.reduce((s, u) => s + u.duration, 0);
  assert.ok(total > 40 && total <= 60);
});

test('字幕の折り返しとページ分け', () => {
  const lines = wrapLines('まずはバックからブロッキングをしていきます、ここが大事です', 13);
  assert.ok(lines.every(l => l.length <= 13));
  assert.ok(!lines.some(l => /^[、。]/.test(l)));
  const pages = subtitlePages('まずはバックからブロッキングをしていきます、ここが大事なポイントになります', 6);
  assert.ok(pages.length >= 2);
  assert.ok(Math.abs(pages[pages.length - 1].end - 6) < 1e-9);
  assert.ok(pages.every(p => p.lines.length <= 2));
});

test('9:16の切り抜き範囲', () => {
  const c = cropRect(1920, 1080, 0.5);
  assert.equal(c.height, 1080);
  assert.equal(c.width, 606);
  assert.equal(c.left, Math.round((1920 - 606) / 2));
  const left = cropRect(1920, 1080, 0.1);
  assert.ok(left.left > 0 && left.left < c.left);
  const p = cropRect(1080, 1920, 0.2);
  assert.deepEqual(p, { left: 0, top: 0, width: 1080, height: 1920 });
});

test('タイムラインと字幕の時刻', () => {
  const tl = buildTimeline([
    { pieces: [{ start: 10, end: 12 }, { start: 12.5, end: 13.5 }], text: 'こんにちは', cx: 0.5 },
    { pieces: [{ start: 30, end: 31 }], text: '', cx: 0.5 },
  ]);
  assert.equal(tl[0].pieces[0].frames, 2 * FPS);
  assert.equal(tl[0].pieces[1].outStart, 2);
  assert.equal(tl[1].outStart, 3);
  assert.equal(tl[0].subtitles[0].end, 3);
  assert.equal(tl[1].subtitles.length, 0);
});

test('字幕の整形: 聞き間違いの修正とつなぎ言葉の除去', async () => {
  const { cleanSubtitle } = await import('../js/plan.js');
  assert.equal(cleanSubtitle('まずは、Aと耳後ろでブロッキングを取っていきます。'), 'まずは、耳後ろでブロッキングを取っていきます。');
  assert.equal(cleanSubtitle('バックは指1本分のスライスでカネルをゼロドに引き出します。'), 'バックは指一本分のスライスでパネルを0度に引き出します。');
  assert.equal(cleanSubtitle('ガイドに合わせて、下先を切り揃えます。'), 'ガイドに合わせて、毛先を切り揃えます。');
  assert.equal(cleanSubtitle('最後にセニングでローカーの調整して、カルサを出します。'), '最後にセニングで量感の調整して、軽さを出します。');
  assert.equal(cleanSubtitle('これで仕上がりです。マルミのあるシルエッドになりました。'), 'これで仕上がりです。丸みのあるシルエットになりました。');
  assert.equal(cleanSubtitle('えーと、スライドカットで量感を調整します'), 'スライドカットで量感を調整します');
  // 正しい言葉は変えない
  assert.equal(cleanSubtitle('ハネる毛先を、スライドで軽くします'), 'ハネる毛先を、スライドで軽くします');
});

test('言い直し: 合図の前に内容がある場合は、その発言だけを除外', () => {
  const flags = detectRetakes([
    { start: 6, end: 12, text: 'まずは耳後ろでブロッキングを取っていきます。' },
    { start: 13, end: 18, text: 'バックは指一本分のスライスですみません。いいなをします。' },
    { start: 19, end: 24, text: 'バックは指一本分のスライスで、パネルを0度に引き出します。' },
  ]);
  assert.equal(flags[0], null);
  assert.ok(flags[1]);
  assert.equal(flags[2], null);
});

test('プロンプトの文がそのまま出たものを見分ける', async () => {
  const { isPromptEcho } = await import('../js/plan.js');
  assert.ok(isPromptEcho('美容師のカット解説です。ブロッキング、スライス'));
  assert.ok(isPromptEcho('ブロッキング、スライス、パネル、ガイド、毛先、丸み'));
  assert.ok(!isPromptEcho('パネルを0度に引き出します'));
});

test('複数の文が入った塊を、無音の切れ目で文ごとに分ける', async () => {
  const { alignSentences } = await import('../js/plan.js');
  const regions = [{ start: 0.6, end: 5.4 }, { start: 6.7, end: 10.9 }, { start: 13.2, end: 15.9 }, { start: 16.3, end: 18.0 }, { start: 19.2, end: 24.2 }];
  const out = alignSentences([{ start: 0.6, end: 24.4, text: '今日は前下がりボブのカットを解説します。まずは耳後ろでブロッキングを取っていきます。バックは指一本分のスライスで、すみません。いい直します。バックは指一本分のスライスで、パネルを0度に引き出します。' }], regions);
  assert.equal(out.length, 5);
  const near = (a, b) => Math.abs(a - b) < 0.8;
  assert.ok(near(out[1].start, 6.7), String(out[1].start));
  assert.ok(near(out[2].start, 13.2), String(out[2].start));
  assert.ok(near(out[3].start, 16.3), String(out[3].start));
  assert.ok(near(out[4].start, 19.2), String(out[4].start));
  assert.ok(near(out[0].end, 5.4) && near(out[4].end, 24.2));
  // 言い直しの検出がこの分け方で働く
  const flags = detectRetakes(out);
  assert.deepEqual(flags.map(Boolean), [false, false, true, true, false]);
});

test('文の区切りは、話す速さが違っても無音の切れ目に合わせる', async () => {
  const { alignSentences } = await import('../js/plan.js');
  // 2文目のあとに長い無言の作業がある
  const regions = [{ start: 34.7, end: 37.65 }, { start: 40.3, end: 42.6 }, { start: 42.9, end: 44.7 }, { start: 54.9, end: 57.4 }, { start: 57.7, end: 58.9 }];
  const out = alignSentences([{ start: 34.5, end: 59.1, text: 'ガイドに合わせて、毛先を切り揃えます。サイドは前下がりのラインを意識して、45度でカットします。最後にセニングで量感を調整して、軽さを出します。' }], regions);
  assert.equal(out.length, 3);
  assert.ok(Math.abs(out[1].start - 40.3) < 0.01 && Math.abs(out[1].end - 44.7) < 0.01, JSON.stringify(out[1]));
  assert.ok(Math.abs(out[2].start - 54.9) < 0.01);
});

test('演出: 手元が下で動く動画では字幕を上に、ズームは間隔をあけて手元が切れない範囲で', async () => {
  const { buildTimeline, cropAt, subtitleAlpha, ZOOM_MIN, ZOOM_MAX } = await import('../js/plan.js');
  const clip = (s, e, text, motion, box) => ({ pieces: [{ start: s, end: e }], text, motion, cx: 0.5, box });
  const low = [0.35, 0.65, 0.62, 0.8];   // 手元が画面の下の方（縦動画）
  const clips = [
    clip(0, 3, '今日は前下がりボブのカットを解説します', 0.1, null),
    clip(5, 9, 'パネルを0度に引き出します', 0.6, low),
    clip(10, 13, '', 0.8, low),
    clip(20, 23, '', 0.8, low),
    clip(30, 34, '毛先を切りそろえます', 0.7, low),
    clip(40, 43, '', 0.9, [0.05, 0.95, 0.1, 0.9]), // 画面いっぱいに動く → ズームしない
  ];
  const tl = buildTimeline(clips, { srcW: 1080, srcH: 1920, zoom: true, subtitles: true });
  assert.equal(tl[1].subPos, 'top');
  assert.equal(tl[4].subPos, 'top');
  const zoomed = tl.filter(c => c.zoom);
  assert.ok(zoomed.length >= 1);
  for (let i = 1; i < tl.length; i++) assert.ok(!(tl[i].zoom && tl[i - 1].zoom), '続けてズームしない');
  for (const c of zoomed) {
    assert.ok(c.zoom.z >= ZOOM_MIN && c.zoom.z <= ZOOM_MAX, String(c.zoom.z));
    const r = c.zoom.rect, b = c.box;
    assert.ok(r.left <= b[0] * 1080 && r.left + r.width >= b[1] * 1080, '手元が横に切れない');
    assert.ok(r.top <= b[2] * 1920 && r.top + r.height >= b[3] * 1920, '手元が縦に切れない');
    assert.ok(Math.abs(r.width / r.height - 1080 / 1920) < 1e-6, '9:16 のまま');
  }
  for (let i = 1; i < zoomed.length; i++) assert.ok(zoomed[i].outStart - (zoomed[i - 1].outStart + zoomed[i - 1].outDuration) >= 10);
  assert.equal(tl[5].zoom, null);
  // ズームはゆっくり始まりゆっくり止まる（始まりは等倍）
  const z = zoomed[0];
  assert.deepEqual(cropAt(z, z.outStart), z.crop);
  assert.ok(Math.abs(cropAt(z, z.outStart + z.outDuration).width - z.zoom.rect.width) < 1e-6);
  // 字幕はフェードで出入りし、行末の句読点は付けない
  const p = tl[0].subtitles[0];
  assert.equal(subtitleAlpha(p, p.start), 0);
  assert.equal(subtitleAlpha(p, (p.start + p.end) / 2), 1);
  assert.ok(tl.every(c => c.subtitles.every(pg => pg.lines.length <= 2 && pg.lines.every(l => !/[、。]$/.test(l)))));
  // ズームOFF・字幕OFF
  const plain = buildTimeline(clips, { srcW: 1080, srcH: 1920, zoom: false, subtitles: false });
  assert.ok(plain.every(c => !c.zoom && !c.subtitles.length));
});

test('横長の動画: 切り抜き枠は手元が入るようにずらす', () => {
  // 手元が右端寄り（x 0.70〜0.86）。動きの中心だけだと枠からはみ出す
  const c = cropRect(1920, 1080, 0.78, [0.70, 0.86, 0.4, 0.8]);
  assert.ok(c.left <= 0.70 * 1920 && c.left + c.width >= 0.86 * 1920, JSON.stringify(c));
});

test('字幕の改行: 言葉の途中で切らず、1文字だけ残さない', async () => {
  const { subtitlePages } = await import('../js/plan.js');
  const cases = [
    'まずは、耳後ろでブロッキングを取っていきます。',
    'バックは、指一本分のスライスで、パネルを0度に引き出します。',
    'サイドは前下がりのラインを意識して、45度でカットします。',
    'サイドは前下がりのガイの意識して、45度でカットします。',
    '次はトップのレイヤー部分を、指二本分のパネルで90度に引き出して、グラデーションとつなげていきます。',
  ];
  const words = ['ブロッキング', 'スライス', 'パネル', '0度', '45度', '90度', 'レイヤー', 'グラデーション', '前下がり', '意識', '下がり'];
  for (const text of cases) {
    const pages = subtitlePages(text, 6);
    for (const p of pages) {
      assert.ok(p.lines.length <= 2);
      for (const l of p.lines) assert.ok(l.length >= 2 && l.length <= 14, `${l}（${text}）`);
    }
    const all = pages.flatMap(p => p.lines);
    for (let i = 1; i < all.length; i++) {
      for (const w of words) {
        for (let k = 1; k < w.length; k++) {
          assert.ok(!(all[i - 1].endsWith(w.slice(0, k)) && all[i].startsWith(w.slice(k))), `「${w}」が途中で切れている: ${all[i - 1]} / ${all[i]}`);
        }
      }
    }
  }
});
