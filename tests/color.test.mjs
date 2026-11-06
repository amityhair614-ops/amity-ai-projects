// 色の扱い: 書き出す動画の色の印と、HDR（HLG）の素材を SDR に戻す計算
import test from 'node:test';
import assert from 'node:assert/strict';
import { toneMapPixel, hdrKind, outputColorSpace, HLG_REF } from '../js/color.js';

const lin = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const M709TO2020 = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]];
const hlg = e => { const a = 0.17883277, b = 0.28466892, c = 0.55991073; e = Math.min(1, Math.max(0, e)); return e <= 1 / 12 ? Math.sqrt(3 * e) : a * Math.log(12 * e - b) + c; };
// iPhone が SDR に書き出す色（sRGB の値）から、同じ所の HLG の値を作る（iPhone の変換に合わせた倍率 HLG_REF）
const toHlg = rgb => { const l = rgb.map(lin); return M709TO2020.map(r => hlg((r[0] * l[0] + r[1] * l[1] + r[2] * l[2]) * HLG_REF)); };

test('書き出す動画の色の印は、iPhone の SDR の動画と同じ BT.709（sRGB の印にしない）', () => {
  assert.deepEqual(outputColorSpace, { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false });
});

test('HDR の素材だけを変換する（HLG・PQ）。SDR の素材はそのまま', () => {
  assert.equal(hdrKind({ primaries: 'bt2020', transfer: 'hlg', matrix: 'bt2020-ncl' }), 'hlg');
  assert.equal(hdrKind({ transfer: 'pq' }), 'pq');
  assert.equal(hdrKind({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' }), null);
  assert.equal(hdrKind(null), null);
});

test('HLG の値を SDR に戻すと、元の色（髪・背景・肌）にほぼ戻る（白っぽく・薄くならない）', () => {
  for (const c of [[107, 61, 46], [199, 189, 180], [150, 110, 90], [60, 40, 30]]) {
    const rgb = c.map(v => v / 255);
    const back = toneMapPixel(toHlg(rgb), 'hlg').map(v => v * 255);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(back[k] - c[k]) <= 6, `${c} → ${back.map(v => v.toFixed(0))}`);
  }
  // HDR の値のまま描くと（今までの書き出し）、髪の緑・青が持ち上がって、黄色っぽく薄い色になる
  const raw = toHlg([107 / 255, 61 / 255, 46 / 255]).map(v => v * 255);
  assert.ok(raw[1] - 61 > 8 && raw[2] - 46 > 8, raw.map(v => v.toFixed(0)).join(','));
});
