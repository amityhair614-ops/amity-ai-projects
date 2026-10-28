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
  assert.deepEqual(w.map(({ start, end, speech }) => ({ start, end, speech })), [{ start: 0, end: 25, speech: 23 }, { start: 26, end: 40, speech: 14 }]);
  assert.equal(w[0].parts.length, 2);
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

test('約60秒（55〜65秒）に収まり、時系列順・冒頭と最後を含む', () => {
  const v = fakeVideo();
  const units = buildUnits(v);
  assert.ok(!units.some(u => u.text.includes('ご視聴')), '無音部分の誤認識は除外');
  assert.ok(units.some(u => u.kind === 'action' && u.start > 195 && u.end < 235), '動きの多い場面が候補になる');
  const sel = selectUnits(units, v.duration);
  const total = sel.reduce((s, u) => s + u.duration, 0);
  assert.ok(total <= 65 && total >= 55, 'total=' + total);
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
  assert.ok(total >= 55 && total <= 65, 'total=' + total);
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

test('字幕の整形: つなぎ言葉は取り除くが、言葉の置き換えはしない', async () => {
  const { cleanSubtitle } = await import('../js/plan.js');
  assert.equal(cleanSubtitle('まずは、Aと耳後ろでブロッキングを取っていきます。'), 'まずは、耳後ろでブロッキングを取っていきます。');
  assert.equal(cleanSubtitle('まずは全体をAと4つにブロッキングしていきます。'), 'まずは全体を4つにブロッキングしていきます。');
  assert.equal(cleanSubtitle('えーと、スライドカットで量感を調整します'), 'スライドカットで量感を調整します');
  // 聞き間違いらしい言葉も、ここでは置き換えない（音声で確かめてから直す）
  assert.equal(cleanSubtitle('バックは指1本分のスライスでカネルをゼロドに引き出します。'), 'バックは指1本分のスライスでカネルをゼロドに引き出します。');
});

test('専門用語の修正案: 辞書の書き間違い・同じ読み・似たカタカナ語', async () => {
  const { proposeCorrections, applyCorrection } = await import('../js/plan.js');
  const pick = t => proposeCorrections(t).map(c => `${c.from}→${c.to}:${c.kind}`);
  assert.deepEqual(pick('エリアシは指一本分のスライスで ハネルをゼロドに引き出します。'), ['エリアシ→襟足:reading', 'ハネル→パネル:variant', 'ゼロド→0度:variant']);
  assert.deepEqual(pick('次にスキーバサミで模様調整をしていきます。'), ['スキーバサミ→すきバサミ:variant', '模様調整→毛量調整:variant']);
  assert.deepEqual(pick('ブラデーションがつながっているか'), ['ブラデーション→グラデーション:variant']);
  assert.deepEqual(pick('クラデーシヨンがつながっているか'), ['クラデーシヨン→グラデーション:fuzzy']);
  // 正しい別の言葉は修正案にしない
  assert.deepEqual(pick('スライドカットで軽くします'), []);
  assert.deepEqual(pick('ショートボブのパネルを毛先から'), []);
  const c = proposeCorrections('両感を見ながら')[0];
  assert.equal(applyCorrection('両感を見ながら', c), '量感を見ながら');
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

test('演出: 字幕はいつも下（お手本と同じ）、ズームは間隔をあけて手元が切れない範囲で', async () => {
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
  const tl = buildTimeline(clips, { srcW: 2160, srcH: 3840, zoom: true, subtitles: true });
  assert.ok(tl.every(c => c.subPos === 'bottom'), '場面ごとに上下が入れ替わらない');
  const zoomed = tl.filter(c => c.zoom);
  assert.ok(zoomed.length >= 1);
  for (let i = 1; i < tl.length; i++) assert.ok(!(tl[i].zoom && tl[i - 1].zoom), '続けてズームしない');
  for (const c of zoomed) {
    assert.ok(c.zoom.z >= ZOOM_MIN && c.zoom.z <= ZOOM_MAX, String(c.zoom.z));
    const r = c.zoom.rect, b = c.box;
    assert.ok(r.left <= b[0] * 2160 && r.left + r.width >= b[1] * 2160, '手元が横に切れない');
    assert.ok(r.top <= b[2] * 3840 && r.top + r.height >= b[3] * 3840, '手元が縦に切れない');
    assert.ok(Math.abs(r.width / r.height - 1080 / 1920) < 1e-6, '9:16 のまま');
  }
  for (let i = 1; i < zoomed.length; i++) assert.ok(zoomed[i].outStart - (zoomed[i - 1].outStart + zoomed[i - 1].outDuration) >= 15);
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
  const { subtitlePages, SUB_MAX_CHARS } = await import('../js/plan.js');
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
      for (const l of p.lines) assert.ok(l.length >= 2 && l.length <= SUB_MAX_CHARS, `${l}（${text}）`);
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

test('16kHzへの変換: 声の帯域は保ち、高い音は折り返さない', async () => {
  const { Resampler } = await import('../js/resample.js');
  const run = (srIn, freq) => {
    const n = srIn; // 1秒
    const out = new Float32Array(16000);
    const r = new Resampler(srIn, 16000, (j, v) => { if (j < out.length) out[j] = v; });
    // AAC のように 1024 サンプルずつ届ける
    for (let s = 0; s < n; s += 1024) {
      const len = Math.min(1024, n - s);
      const block = new Float32Array(len);
      for (let i = 0; i < len; i++) block[i] = Math.sin(2 * Math.PI * freq * (s + i) / srIn);
      r.push(s, block);
    }
    r.flush();
    let e = 0;
    for (let j = 2000; j < 14000; j++) e += out[j] * out[j];
    return Math.sqrt(e / 12000);
  };
  for (const sr of [48000, 44100]) {
    assert.ok(Math.abs(run(sr, 1000) - Math.SQRT1_2) < 0.02, '1kHz はそのまま');
    assert.ok(run(sr, 12000) < 0.02, '12kHz は消える（単純な間引きだと 4kHz に折り返す）');
  }
});

test('字幕の時刻: Whisper の時刻を声の出始め・終わりに合わせる（前の字幕が次の発言まで残らない）', async () => {
  const { refineSubtitleTiming } = await import('../js/plan.js');
  // 細かい発話区間（サロン版で実際に検出されたもの）
  const fine = [[0.7, 1.75], [2.1, 2.4], [2.6, 4.4], [4.8, 6.4], [6.55, 6.95], [7.1, 7.9], [8.3, 9.25], [9.4, 10.4], [10.55, 11.4], [11.55, 12.0], [12.35, 13.6], [13.75, 15.3]]
    .map(([start, end]) => ({ start, end }));
  // Whisper の時刻（前後の文とつながっていて、開始が早め・終わりが遅め）
  const chunks = [[0.4, 4.4], [4.4, 8.4], [8.4, 12.4], [12.4, 15.4]].map(([start, end]) => ({ start, end, text: 'x' }));
  const out = refineSubtitleTiming(chunks, fine);
  const truth = [[0.7, 4.47], [4.82, 7.96], [8.31, 12.03], [12.38, 15.34]];
  out.forEach((c, i) => {
    assert.ok(Math.abs(c.subStart - truth[i][0]) < 0.15, `開始 ${c.subStart} / ${truth[i][0]}`);
    assert.ok(Math.abs(c.subEnd - truth[i][1]) < 0.15, `終了 ${c.subEnd} / ${truth[i][1]}`);
    if (i > 0) assert.ok(out[i - 1].subEnd < c.subStart);
    // 自動カットに使う時刻は変えない
    assert.equal(c.start, chunks[i].start);
    assert.equal(c.end, chunks[i].end);
  });
});

test('カット後の時刻への変換: 削った無音をまたいでもずれが積み重ならない', async () => {
  const { srcToOut, buildTimeline } = await import('../js/plan.js');
  const clips = [
    { pieces: [{ start: 10, end: 12 }, { start: 13, end: 15 }], text: '前半の説明です。後半の説明です。', subStart: 10.1, subEnd: 14.8,
      fine: [{ start: 10.1, end: 11.9 }, { start: 13.1, end: 14.8 }] },
    { pieces: [{ start: 40, end: 42 }], text: '別の場面です。', subStart: 40.2, subEnd: 41.5, fine: [{ start: 40.2, end: 41.5 }] },
  ];
  const tl = buildTimeline(clips, { subtitles: true });
  assert.ok(Math.abs(srcToOut(tl[0], 13.1) - 2.1) < 1e-6);
  assert.equal(srcToOut(tl[0], 12.5), 2); // 削った部分は次の場面の頭
  assert.ok(Math.abs(srcToOut(tl[1], 40.2) - 4.2) < 1e-6);
  const [p1, p2] = tl[0].subtitles;
  assert.ok(Math.abs(p1.start - 0.0) < 0.11 && Math.abs(p2.start - (2.1 - 0.1)) < 0.11, JSON.stringify(tl[0].subtitles));
  assert.ok(p1.end <= p2.start);
  const q = tl[1].subtitles[0];
  assert.ok(Math.abs(q.start - (4.2 - 0.1)) < 0.01 && Math.abs(q.end - (5.5 + 0.25)) < 0.01, JSON.stringify(q));
});

test('字幕の手直し: 0.1秒ずつ動かし、保存・読み込み・全体のずらしがMP4用の時刻に反映される', async () => {
  const { nudge, collectEdits, applyEdits, resetEdits, shifted, unitKey } = await import('../js/subedit.js');
  const { buildTimeline } = await import('../js/plan.js');
  const mk = () => [
    { kind: 'speech', start: 10, end: 13, pieces: [{ start: 10, end: 13 }], text: 'パネルを0度に引き出します', subStart: 10.2, subEnd: 12.8, fine: [{ start: 10.2, end: 12.8 }] },
    { kind: 'action', start: 20, end: 23, pieces: [{ start: 20, end: 23 }], text: '' },
  ];
  const units = mk();
  applyEdits(units, null); // AIの結果を覚える
  for (let i = 0; i < 3; i++) nudge(units[0], 'start', 0.1);
  nudge(units[0], 'end', -0.1);
  units[0].text = 'パネルを0度で引き出します';
  assert.ok(Math.abs(units[0].subStart - 10.5) < 1e-9 && Math.abs(units[0].subEnd - 12.7) < 1e-9);
  const saved = JSON.parse(JSON.stringify(collectEdits(units, 0.2)));
  assert.deepEqual(Object.keys(saved.edits), [unitKey(units[0])]);
  // もう一度解析した結果に、保存した修正を当てはめる
  const again = mk();
  assert.equal(applyEdits(again, saved), 1);
  assert.equal(again[0].text, 'パネルを0度で引き出します');
  assert.ok(Math.abs(again[0].subStart - 10.5) < 1e-9);
  // 全体のずらし（+0.2秒）を足して書き出し用のタイムラインを作る
  const tl = buildTimeline(again.map(u => ({ ...u, ...shifted(u, saved.offset) })), { subtitles: true });
  const p = tl[0].subtitles[0];
  assert.ok(Math.abs(p.start - (10.7 - 10 - 0.1)) < 1e-6, JSON.stringify(p));
  assert.equal(p.lines.join(''), 'パネルを0度で引き出します');
  // 動かせるのは場面の前後1秒まで・長さは0.3秒以上
  for (let i = 0; i < 50; i++) nudge(again[0], 'start', -0.1);
  assert.equal(again[0].subStart, 9);
  for (let i = 0; i < 50; i++) nudge(again[0], 'end', -0.1);
  assert.ok(Math.abs(again[0].subEnd - 9.3) < 1e-9);
  // 取り消すとAIの結果に戻る
  resetEdits(again);
  assert.equal(again[0].text, 'パネルを0度に引き出します');
  assert.equal(again[0].subStart, 10.2);
});

test('字幕AIの3通りの読み方: 区切りの違う窓で読み、落とした言葉をほかの結果で補う', async () => {
  const { asrWindows, mergeAsrPasses, fillDeletions, passDoubts } = await import('../js/plan.js');
  // 0.3秒より短い間では区切らない。A は30秒ごと、B は15秒ずらす、C は0.5秒以上の間で分けたまとまり
  const regions = [{ start: 0, end: 10 }, { start: 10.1, end: 25 }, { start: 26, end: 70 }];
  const w = asrWindows(regions, null, 30);
  const A = w.filter(x => x.pass === 'A'), B = w.filter(x => x.pass === 'B'), C = w.filter(x => x.pass === 'C');
  assert.ok(A.length >= 3 && B.length >= 3 && C.length >= 3);
  assert.equal(A[0].start, 0);
  assert.ok(Math.abs(B[0].end - 15) < 1e-6, 'B は15秒ずれる');
  assert.ok(C.every(x => x.end - x.start <= 30), JSON.stringify(C));
  assert.ok(!C.some(x => Math.abs(x.start - 10.1) < 1e-6), '0.1秒の間では分けない');
  // 落とした言葉を補う
  const tok = (s, t0) => [...s].map((c, i) => ({ s: c, t: t0 + i * 0.1, p: 1 }));
  const base = [...tok('それはどこなのか', 0), ...tok('この場所を', 3)];
  const other = [...tok('それはどこなのかトップの根元付近です', 0), ...tok('この場所を', 3)];
  assert.equal(fillDeletions(base, other).map(k => k.s).join(''), 'それはどこなのかトップの根元付近ですこの場所を');
  // 1文字だけの違い（言い方の違い・聞き間違い）は補わない（もとの結果のまま）
  assert.equal(fillDeletions(tok('かるくしない', 0), tok('かるくしなない', 0)).map(k => k.s).join(''), 'かるくしない');
  // 合わせた結果
  const ws = [{ start: 0, end: 10, pass: 'A' }, { start: 0, end: 10, pass: 'B' }, { start: 0, end: 10, pass: 'C' }];
  const r = mergeAsrPasses(ws, { 0: [{ tokens: tok('根元付近は軽く', 1) }], 1: [{ tokens: tok('根元付近は軽くしない', 1) }], 2: [{ tokens: tok('根元付近は軽く', 1) }] });
  assert.equal(r[0].text, '根元付近は軽くしない');
  for (let i = 1; i < r[0].tokens.length; i++) assert.ok(r[0].tokens[i].t > r[0].tokens[i - 1].t, '時刻は文字の順');
  // 読み方によって否定の言葉の有無が違う文は、要確認にする
  const passes = { A: tok('うまくカバーできます', 0), B: tok('うまくカバーできません', 0), C: tok('うまくカバーできます', 0) };
  assert.ok(passDoubts({ start: 0, end: 1.2, text: 'うまくカバーできます' }, passes).some(d => d.includes('否定')));
  assert.deepEqual(passDoubts({ start: 0, end: 1.2, text: 'うまくカバーできません' }, { A: tok('うまくカバーできません', 0) }), []);
});
