// 高速書き出し（試作・js/fastcut.js）を、ブラウザ（Chromium）で試す。
//   node tests/e2e/fastcut.mjs OUT_DIR timeline.json analysis.json s1.mov,s2.mov,…   （APP_URL・CHROME_PATH）
// timeline.json: run.mjs が書き出した構成（場面ごとのピース。つないだ時刻）。analysis.json: 動画ごとのつないだ時刻（lay）
// 同じカットを、元の映像のコマを写す方式で書き出して、時間・大きさ・メモリを記録する。結果は OUT_DIR/fast.mp4 と fast.json
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const [dir, tlFile, anFile, names] = process.argv.slice(2);
const files = names.split(',');
const tl = JSON.parse(fs.readFileSync(tlFile));
const lay = JSON.parse(fs.readFileSync(anFile)).lay || [{ offset: 0, duration: Infinity, end: Infinity }];
// ピース（つないだ時刻）→ 動画ごとの時刻の範囲。続いているピースはまとめる
const ranges = [];
for (const c of tl) for (const p of c.pieces) {
  const a = p.srcStart, b = p.srcStart + p.frames / 30;
  const k = lay.findIndex(l => a >= l.offset - 0.01 && a < l.end + 0.01);
  const r = { source: k, start: +(a - lay[k].offset).toFixed(4), end: +(Math.min(b, lay[k].end) - lay[k].offset).toFixed(4) };
  const last = ranges[ranges.length - 1];
  if (last && last.source === r.source && Math.abs(last.end - r.start) < 0.02) last.end = r.end; else ranges.push(r);
}
console.log(`範囲 ${ranges.length}（つないだピース ${tl.reduce((n, c) => n + c.pieces.length, 0)}）`);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ ignoreHTTPSErrors: true });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/__src/*', (route, req) => route.fulfill({ path: path.join(dir, decodeURIComponent(new URL(req.url()).pathname.split('/').pop())), contentType: 'video/mp4' }));
await page.goto(process.env.APP_URL || 'http://127.0.0.1:8123/');
const r = await page.evaluate(async ({ files, ranges, paramMode }) => {
  const { fastCut } = await import('/js/fastcut.js');
  const blobs = [];
  for (const f of files) blobs.push(new File([await (await fetch('/__src/' + encodeURIComponent(f))).blob()], f));
  const mem = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null);
  let peak = mem();
  const timer = setInterval(() => { peak = Math.max(peak, mem()); }, 200);
  try {
    const { mp4, stats } = await fastCut(blobs, ranges, { paramMode });
    clearInterval(timer);
    let s = '';
    for (let i = 0; i < mp4.length; i += 0x8000) s += String.fromCharCode(...mp4.subarray(i, i + 0x8000));
    return { ok: true, b64: btoa(s), stats: { ...stats, heapPeakMB: peak } };
  } catch (e) { clearInterval(timer); return { ok: false, error: String(e?.message || e), name: e?.name }; }
}, { files, ranges, paramMode: process.env.PARAM_MODE || 'inband' });
await browser.close();
if (!r.ok) { console.log('失敗:', r.name, r.error); process.exit(1); }
fs.writeFileSync(path.join(dir, process.env.OUT_NAME || 'fast.mp4'), Buffer.from(r.b64, 'base64'));
fs.writeFileSync(path.join(dir, 'fast.json'), JSON.stringify({ ranges, stats: r.stats }, null, 1));
console.log('結果:', JSON.stringify(r.stats));
if (errors.length) console.log('ページのエラー:', errors.join(' | '));
