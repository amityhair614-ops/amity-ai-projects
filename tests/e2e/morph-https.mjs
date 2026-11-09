// https のページで、字幕の言葉の区切りの辞書（kuromoji）を読み込めるかを確かめる（Cloudflare Pages と同じ https の条件）。
//   node tests/e2e/morph-https.mjs https://127.0.0.1:8443/   （CHROME_PATH・自分で作った証明書の https サーバーが必要）
// CDN（jsdelivr）への要求は手元の node_modules/kuromoji から返す。同じサイトに辞書を読みに来たら、辞書の URL が壊れている

import { chromium } from 'playwright-core';
import path from 'node:path';
const url = process.argv[2];
const kuro = path.join(path.dirname(new URL(import.meta.url).pathname), '../../node_modules/kuromoji');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ ignoreHTTPSErrors: true });
const errors = [], sameOrigin = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => { const u = r.url(); if (u.startsWith(url) && u.includes('cdn.jsdelivr.net')) sameOrigin.push(u.slice(url.length)); });
await page.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/kuromoji@0\.1\.2\/(.*)$/, (route, req) => {
  const rel = new URL(req.url()).pathname.replace(/^\/npm\/kuromoji@0\.1\.2\//, '');
  route.fulfill({ path: path.join(kuro, rel), contentType: rel.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } });
});
await page.goto(url);
const r = await page.evaluate(async () => {
  const m = await import('/js/morph.js');
  const t0 = performance.now();
  try {
    await Promise.race([m.loadTokenizer(), new Promise((_, rej) => setTimeout(() => rej(new Error('20秒たっても終わらない')), 20000))]);
    return { ok: true, sec: ((performance.now() - t0) / 1000).toFixed(1), sample: m.phraseUnits('セルフカットでボブを切っていく際').map(u => u.text).join('/') };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
console.log(url, JSON.stringify(r));
console.log('  ページのエラー:', errors.length ? errors.join(' | ') : 'なし');
console.log('  同じサイトに辞書を読みに来た要求:', sameOrigin.length ? sameOrigin.slice(0, 2).join(' , ') + ` ほか（計${sameOrigin.length}件）` : 'なし');
await browser.close();
