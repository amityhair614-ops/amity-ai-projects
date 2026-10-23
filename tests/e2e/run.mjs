// 通しテスト: 本物のブラウザでページを開き、動画を選んで解析→書き出しまで行う。
//
//   CHROME_PATH=/path/to/chrome node tests/e2e/run.mjs SAMPLE_DIR [sample.mp4] [--no-asr]
//
// 事前に `python3 -m http.server 8123` をリポジトリ直下で起動しておく。
// H.264 を扱えるブラウザが必要（Chrome for Testing など。Playwright 同梱の Chromium は不可）。
// 文字起こし（Whisper）はネットワークからモデルを取得するため、ここでは
// sample-transcript.json を返す偽のワーカーに差し替える。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const sample = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'sample-1280x720.mp4';
const noAsr = process.argv.includes('--no-asr');
const transcript = JSON.parse(fs.readFileSync(path.join(dir, 'sample-transcript.json'), 'utf8'));
const tag = path.basename(sample, '.mp4') + (noAsr ? '-noasr' : '');

const fakeWorker = `
const T = ${JSON.stringify(transcript)};
self.onmessage = e => {
  const m = e.data;
  if (m.type === 'load') {
    self.postMessage({ type: 'load-progress', p: { status: 'progress', file: 'model.onnx', loaded: 5e7, total: 1e8 } });
    self.postMessage({ type: 'loaded', device: 'wasm' });
  } else if (m.type === 'run') {
    const end = m.offset + m.audio.length / 16000;
    const chunks = T.filter(c => c.start < end && c.end > m.offset)
      .map(c => ({ start: Math.max(0, c.start - m.offset), end: Math.min(end, c.end) - m.offset, text: c.text }));
    self.postMessage({ type: 'result', id: m.id, chunks });
  }
};`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
await page.route('**/js/transcribe-worker.js', r => r.fulfill({ contentType: 'text/javascript', body: fakeWorker }));

try {
  await page.goto('http://127.0.0.1:8123/');
  await page.setInputFiles('#file', path.join(dir, sample));
  await page.waitForSelector('#stepAnalyze:not([hidden])', { timeout: 30000 });
  if (noAsr) await page.uncheck('#optAsr');
  const t0 = Date.now();
  await page.click('#btnAnalyze');
  await page.waitForSelector('#stepReview:not([hidden]), #analyzeError:not([hidden])', { timeout: 600000 });
  const analyzeErr = await page.$eval('#analyzeError', el => (el.hidden ? null : el.textContent));
  if (analyzeErr) throw new Error('解析エラー: ' + analyzeErr);
  console.log(`解析: ${((Date.now() - t0) / 1000).toFixed(1)}秒`);

  const plan = await page.evaluate(() => {
    const s = window.amityDebug;
    return {
      summary: document.getElementById('summary').textContent,
      total: document.getElementById('total').textContent,
      regions: s.speech.regions.map(r => [+r.start.toFixed(2), +r.end.toFixed(2)]),
      units: s.units.map(u => ({
        id: u.id, kind: u.kind, start: +u.start.toFixed(2), end: +u.end.toFixed(2), dur: +u.duration.toFixed(2),
        text: u.text, excluded: u.excluded || null, score: +u.score.toFixed(2), cx: +u.cx.toFixed(2),
        selected: s.selected.has(u.id), reasons: u.reasons,
      })),
    };
  });
  fs.writeFileSync(path.join(dir, `plan-${tag}.json`), JSON.stringify(plan, null, 1));
  console.log(plan.summary);
  console.log(plan.total);
  for (const u of plan.units) {
    console.log(`${u.selected ? '■' : '□'} ${u.kind.padEnd(6)} ${u.start.toFixed(1).padStart(6)}-${u.end.toFixed(1).padStart(6)} score=${u.score} ${u.excluded ? '[除外:' + u.excluded + '] ' : ''}${u.text}`);
  }
  await page.screenshot({ path: path.join(dir, `review-${tag}.png`), fullPage: true });

  const t1 = Date.now();
  await page.click('#btnRender');
  await page.waitForSelector('#stepResult:not([hidden]), #renderError:not([hidden])', { timeout: 600000 });
  const renderErr = await page.$eval('#renderError', el => (el.hidden ? null : el.textContent));
  if (renderErr) throw new Error('書き出しエラー: ' + renderErr);
  console.log(`書き出し: ${((Date.now() - t1) / 1000).toFixed(1)}秒`);
  const b64 = await page.evaluate(async () => {
    const buf = new Uint8Array(await window.amityDebug.blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const outFile = path.join(dir, `out-${tag}.mp4`);
  fs.writeFileSync(outFile, Buffer.from(b64, 'base64'));
  await page.screenshot({ path: path.join(dir, `result-${tag}.png`), fullPage: true });
  console.log('出力:', outFile);
} finally {
  const errs = logs.filter(l => /error|pageerror/i.test(l));
  if (errs.length) console.log('ブラウザのエラー:\n' + errs.join('\n'));
  await browser.close();
}
