// 画質の計測ページ（quality-bench.html）を Chromium で開き、結果を表示する（開発用）
//   APP_URL=http://127.0.0.1:8123/ node tests/e2e/quality-bench.mjs 元の動画のURL [開始秒] [コマ数] [設定名,…]
import { chromium } from 'playwright-core';

const [src, t = '3', n = '60', only = ''] = process.argv.slice(2);
const base = process.env.APP_URL || 'http://127.0.0.1:8123/';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') console.error(m.text()); });
await page.goto(`${base}tests/e2e/quality-bench.html?src=${encodeURIComponent(src)}&t=${t}&n=${n}${only ? '&only=' + only : ''}`);
await page.waitForFunction(() => window.benchResults, null, { timeout: 1800000, polling: 1000 });
console.log(JSON.stringify(await page.evaluate(() => window.benchResults), null, 1));
await browser.close();
