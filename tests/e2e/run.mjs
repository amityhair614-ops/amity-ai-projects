// 通しテスト: 本物のブラウザでページを開き、動画を選んで解析→書き出しまで行う。
//
//   CHROME_PATH=/path/to/chrome node tests/e2e/run.mjs SAMPLE_DIR [sample.mp4|mov] [オプション]
//     --no-asr        字幕OFF
//     --fail-asr      文字起こしが失敗する場合（字幕なしで続行できるか）
//     --webaudio      音声を Web Audio 方式で読む（WebCodecs で読めなかった場合の代替経路）
//     --reload-at=段階 その段階の途中でページを再読み込みし、前回の段階が表示されるかを確かめる（audio/motion/render）
//     --real-asr=DIR  偽のワーカーではなく本物の Whisper で文字起こしする。DIR は whisper-base のモデル
//                     （config.json と onnx/ がある場所）。Transformers.js と ONNX Runtime は node_modules から配信する
//     --zoom / --no-zoom / --no-subs  書き出し時の設定
//     --target=秒     完成動画の長さ（30/45/60 はボタン、それ以外は自由入力）
//     --style=tempo   編集スタイル
//     --brief         タイトル・内容・伝えたいこと・流れ・必ず残したい場面を入力する
//     --title=… / --content=… / --items=…  動画タイトル・動画の説明（内容）・使用アイテムを入力する
//     --replan=秒     構成の確認画面で長さを変えて「構成し直す」を押す
//
// 事前に `python3 -m http.server 8123` をリポジトリ直下で起動しておく。
// H.264 を扱えるブラウザが必要（Chrome for Testing、または H.264 に対応した Playwright 同梱の Chromium）。
// APP_URL で開くページを変えられる（前の版と比べるとき）。
// 文字起こし（Whisper）はネットワークからモデルを取得するため、ここでは
// sample-transcript.json を返す偽のワーカーに差し替える。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const dir = process.argv[2];
const sample = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'sample-1280x720.mp4';
const noAsr = process.argv.includes('--no-asr');
const failAsr = process.argv.includes('--fail-asr');
const webaudio = process.argv.includes('--webaudio');
const reloadAt = (process.argv.find(a => a.startsWith('--reload-at=')) || '').split('=')[1];
const realAsr = (process.argv.find(a => a.startsWith('--real-asr=')) || '').split('=')[1];
// --reazon=URL: 本物の ReazonSpeech で文字起こしする。URL はモデルのファイル（encoder-…onnx 等）を CORS つきで配信する場所
// （例: python3 tests/webkit/cors-server.py DIR 8124 → http://127.0.0.1:8124/）。ONNX Runtime は ORT_DIST（1.22.0 の dist）から配信する
const reazon = (process.argv.find(a => a.startsWith('--reazon=')) || '').slice('--reazon='.length);
const titleArg = (process.argv.find(a => a.startsWith('--title=')) || '').slice('--title='.length);
const itemsArg = (process.argv.find(a => a.startsWith('--items=')) || '').slice('--items='.length);
const contentArg = (process.argv.find(a => a.startsWith('--content=')) || '').slice('--content='.length);
const scriptArg = (process.argv.find(a => a.startsWith('--script=')) || '').slice('--script='.length);
const zoom = process.argv.includes('--zoom') ? true : process.argv.includes('--no-zoom') ? false : null;
const noSubs = process.argv.includes('--no-subs');
const arg = name => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1];
const target = arg('target');
const style = arg('style');
const withBrief = process.argv.includes('--brief');
const replan = arg('replan');
const base = path.basename(sample).replace(/\.(mp4|mov)$/, '');
const tFile = fs.existsSync(path.join(dir, `${base}-transcript.json`)) ? `${base}-transcript.json` : 'sample-transcript.json';
const transcript = JSON.parse(fs.readFileSync(path.join(dir, tFile), 'utf8'));
const tag = base + (noAsr ? '-noasr' : '') + (failAsr ? '-failasr' : '') + (webaudio ? '-webaudio' : '') + (realAsr ? '-realasr' : '') + (reazon ? '-reazon' : '') + (scriptArg ? '-script' : '') + (process.env.TAG || '')
  + (zoom === true ? '-zoom' : zoom === false ? '-nozoom' : '') + (noSubs ? '-nosubs' : '')
  + (target ? '-t' + target : '') + (style ? '-' + style : '') + (withBrief ? '-brief' : '') + (replan ? '-replan' + replan : '');

// ブラウザのプロセスごとのメモリ（RSS）を0.5秒ごとに測り、段階ごとのピークを記録する
const mem = { stage: '開始', peaks: {} };
function sampleMemory() {
  let out = '';
  try { out = execSync('ps -eo rss=,args= | grep -E "chrome(-linux64)?/chrome" | grep -v grep', { encoding: 'utf8' }); } catch { return; }
  const sums = {};
  for (const line of out.trim().split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const type = (m[2].match(/--type=([\w-]+)/) || [, 'browser'])[1];
    sums[type] = (sums[type] || 0) + Number(m[1]) / 1024;
  }
  const st = (mem.peaks[mem.sub || mem.stage] ||= {});
  for (const [k, v] of Object.entries(sums)) st[k] = Math.max(st[k] || 0, Math.round(v));
}
let page = null;
const memTimer = setInterval(async () => {
  // 表示中の進み具合（数字を除いた文言）を段階名として使う
  if (page && mem.stage !== '開始') {
    try {
      const t = await page.$eval('#progressText', el => el.textContent);
      const r = await page.$eval('#renderText', el => el.textContent).catch(() => '');
      const label = (mem.stage === '書き出し' ? r : t).replace(/[0-9.%/ ]+/g, '').replace(/…+$/, '');
      if (label) mem.sub = mem.stage + ':' + label;
    } catch {}
  }
  sampleMemory();
}, 500);

const fakeWorker = `
// asrStart / asrEnd があれば、Whisper のように少しずれた時刻を返す（make-ja-natural.py）
const T = ${JSON.stringify(transcript)}.filter(c => c.start < c.end);
self.onmessage = e => {
  const m = e.data;
  if (m.type === 'load') {
    if (${failAsr}) { self.postMessage({ type: 'error', message: 'テスト用の失敗（モデルを読み込めない）' }); return; }
    self.postMessage({ type: 'load-progress', p: { status: 'progress', file: 'model.onnx', loaded: 5e7, total: 1e8 } });
    self.postMessage({ type: 'loaded', device: 'wasm' });
  } else if (m.type === 'run') {
    const end = m.offset + m.audio.length / 16000;
    // 区間をまたぐ文は、本物の Whisper と同じく、その区間で話している句だけを返す（phrases がある正解のとき）
    const chunks = T.filter(c => c.start < end && c.end > m.offset).map(c => {
      if (!c.phrases) return { s: c.asrStart ?? c.start, e: c.asrEnd ?? c.end, text: c.text };
      const ps = c.phrases.filter(p => (p.start + p.end) / 2 >= m.offset && (p.start + p.end) / 2 < end);
      if (!ps.length) return null;
      const first = ps[0] === c.phrases[0], last = ps[ps.length - 1] === c.phrases[c.phrases.length - 1];
      const text = ps.length === c.phrases.length ? c.text : ps.map(p => p.text).join('');
      return { s: first ? (c.asrStart ?? c.start) : ps[0].start, e: last ? (c.asrEnd ?? c.end) : ps[ps.length - 1].end, text };
    }).filter(Boolean)
      .map(c => ({ start: Math.max(0, c.s - m.offset), end: Math.min(end, c.e) - m.offset, text: c.text }));
    setTimeout(() => self.postMessage({ type: 'result', id: m.id, chunks }), ${reloadAt === 'asr' ? 1500 : 0});
  }
};`;

// GPU を有効にする（GPU なしだと、コマを描くたびにメモリが増える Chrome 側の現象が出て、実機と違う測定になる）
const asrRequests = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
// 書き出し前の確認（字幕の要確認が残っているとき）は、内容を記録してから「はい」を選ぶ
page.on('dialog', async d => { console.log('[確認ダイアログ] ' + d.message().replace(/\n/g, ' / ')); await d.accept(); });
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
if (realAsr) {
  // ワーカー内の通信も差し替えられるよう、コンテキスト単位で設定する
  const nm = path.join(path.dirname(new URL(import.meta.url).pathname), 'node_modules');
  const tfDist = path.join(nm, '@huggingface/transformers/dist');
  const ortDist = path.join(nm, 'onnxruntime-web/dist');
  const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
  const serve = (route, file) => fs.existsSync(file)
    ? route.fulfill({ path: file, contentType: types[path.extname(file)] || 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } })
    : route.fulfill({ status: 404, body: 'not found', headers: { 'access-control-allow-origin': '*' } });
  await page.context().route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@[^/]+(\/.*)?$/, (route, request) => {
    const sub = new URL(request.url()).pathname.split('/').slice(4).join('/');
    serve(route, path.join(tfDist, sub ? sub.replace(/^dist\//, '') : 'transformers.min.js'));
  });
  await page.context().route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@[^/]+\/dist\/.*$/, (route, request) => {
    serve(route, path.join(ortDist, path.basename(new URL(request.url()).pathname)));
  });
  await page.context().route(/^https:\/\/huggingface\.co\/.*$/, (route, request) => {
    const m = new URL(request.url()).pathname.match(/^\/[^/]+\/[^/]+\/resolve\/[^/]+\/(.*)$/);
    asrRequests.push(new URL(request.url()).pathname);
    serve(route, m ? path.join(realAsr, m[1]) : '/nonexistent');
  });
} else if (reazon) {
  const ortDist = process.env.ORT_DIST;
  await page.context().route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@1\.22\.0\/dist\/.*$/, (route, request) => {
    const f = path.basename(new URL(request.url()).pathname);
    route.fulfill({ path: path.join(ortDist, f), contentType: f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
  });
  // 大きなモデルは Playwright 経由で返すとページが落ちるため、手元のサーバーに転送する
  await page.context().route(/^https:\/\/huggingface\.co\/.*$/, (route, request) => {
    asrRequests.push(new URL(request.url()).pathname);
    route.fulfill({ status: 302, headers: { location: reazon + path.basename(new URL(request.url()).pathname), 'access-control-allow-origin': '*' } });
  });
} else {
  await page.route('**/js/transcribe-worker.js', r => r.fulfill({ contentType: 'text/javascript', body: fakeWorker }));
  await page.route('**/js/reazon-worker.js', r => r.fulfill({ contentType: 'text/javascript', body: fakeWorker }));
}

// iPhone の画面幅で字幕を手直しする（文字の修正・0.1秒の調整・全体のずらし・保存）
let editExpect = null;
async function editTest() {
  const ed = page.locator('#clips .sub-edit').first();
  const ta = ed.locator('textarea');
  const before = await ta.inputValue();
  const after = before.replace(/。?$/, '（修正）');
  await ta.fill(after);
  const startBtn = ed.locator('.sub-adj').first().locator('button').nth(1);
  const clock = ed.locator('.clock').first();
  const t0 = await clock.textContent();
  for (let i = 0; i < 3; i++) await startBtn.click();
  const t1 = await clock.textContent();
  await page.click('#subOffPlus');
  await page.click('#subOffPlus');
  await page.waitForTimeout(500);
  const saved = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('amity.subs.v1:')).map(([, v]) => JSON.parse(v))[0]);
  console.log(`手直し: 「${before}」→「${after}」 / 出る ${t0} → ${t1} / 全体 ${await page.$eval('#subOffset', el => el.textContent)}`);
  console.log(`保存: ${await page.$eval('#subSaved', el => el.textContent)} ${JSON.stringify(saved)}`);
  await ed.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(dir, `edit-${tag}.png`) });
  editExpect = { text: after.replace(/[、。]/g, '') };
}

// 書き出した動画（カット後）の上で、字幕の表示時刻と、実際に話している時刻の差を測る
async function evaluateOutputTiming() {
  const { srcToOut, moraCount } = await import('../../js/plan.js');
  const tl = await page.evaluate(() => window.amityDebug.timeline.map(c => ({
    text: c.text, outStart: c.outStart, outDuration: c.outDuration,
    pieces: c.pieces.map(p => ({ srcStart: p.srcStart, frames: p.frames, outStart: p.outStart })),
    pages: c.subtitles.map(p => ({ start: p.start, end: p.end, text: p.lines.join('') })),
  })));
  const starts = [], ends = [], bounds = [];
  const said = transcript.filter(c => !c.retake);
  for (const clip of tl.filter(c => c.pages.length)) {
    let tr = null, sim = 0;
    for (const t of said) { const v = parseFloat(charAgreement(t.text, clip.text)); if (v > sim) { sim = v; tr = t; } }
    if (!tr || sim < 40) continue;
    const inClip = t => t >= clip.pieces[0].srcStart - 0.05 && t <= clip.pieces.at(-1).srcStart + clip.pieces.at(-1).frames / 30 + 0.05;
    if (inClip(tr.start)) starts.push(clip.pages[0].start - srcToOut(clip, tr.start));
    if (inClip(tr.end)) ends.push(clip.pages.at(-1).end - srcToOut(clip, tr.end));
    // 文の中のページの切り替え: ページの最初の文字が話される時刻（正解の句の中を読みの長さで按分した推定）との差
    const norm = t => t.replace(/[、。\s]/g, '');
    const truthText = norm(tr.phrases.map(p => p.text).join(''));
    const spokenAt = offset => {
      let acc = 0;
      for (const p of tr.phrases) {
        const pt = norm(p.text);
        if (offset < acc + pt.length) {
          const w = moraCount(pt.slice(0, offset - acc)) / (moraCount(pt) || 1);
          return p.start + w * (p.end - p.start);
        }
        acc += pt.length;
      }
      return tr.end;
    };
    let cursor = 0;
    for (const [k, pg] of clip.pages.entries()) {
      const at = truthText.indexOf(norm(pg.text).slice(0, 3), cursor);
      if (at < 0) continue;
      cursor = at + 1;
      if (k === 0) continue;
      const expect = srcToOut(clip, spokenAt(at));
      bounds.push(pg.start + 0.1 - expect);
      if (process.env.DEBUG_PAGES) console.log(`  ページ「${pg.text}」 表示 ${(pg.start + 0.1).toFixed(2)} / 話し始め(推定) ${expect.toFixed(2)}`);
    }
  }
  const st = a => { const s = a.map(Math.abs).sort((x, y) => x - y); return s.length ? `中央値 ${s[Math.floor(s.length / 2)].toFixed(2)}s 最大 ${s.at(-1).toFixed(2)}s（${s.length}件）` : 'なし'; };
  console.log(`カット後の字幕の時刻: 出始め−声の出始め ${st(starts.map(x => x + 0.1))} / 消える−話し終わり ${st(ends.map(x => x - 0.25))}`);
  console.log(`  （表示は声の0.1秒前から、話し終わりの0.25秒後までの設定。上の差はその設定からのずれ）`);
  console.log(`  文の途中のページ切り替え−そのページの言葉の話し始め(推定): ${st(bounds)}`);
}

// 完成動画の長さを選ぶ（30/45/60 はボタン、それ以外は自由入力）
async function setTarget(sec) {
  if (!sec) return;
  if (['30', '45', '60'].includes(sec)) await page.click(`input[name=dur][value="${sec}"] + span`);
  else {
    await page.click('input[name=dur][value=custom] + span');
    await page.fill('#durCustom', sec);
    await page.dispatchEvent('#durCustom', 'change');
  }
}

// 正解と認識結果の文字の一致率（編集距離から。句読点・空白は除く）
function charAgreement(a, b) {
  const clean = t => t.replace(/[\s、。，．,.！？!?]/g, '');
  a = clean(a); b = clean(b);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return (Math.max(0, 1 - d[a.length][b.length] / a.length) * 100).toFixed(1) + '%';
}

// 処理の途中でページを再読み込みし（iPhone がメモリ不足でページを落とした状況の再現）、
// 次に開いたときに止まった段階が表示されることを確かめて終了する
async function reloadDuring(stage) {
  await page.waitForFunction(st => {
    try { const j = JSON.parse(localStorage.getItem('amity.job.v1')); return j && j.status === 'running' && j.stage === st && (st === 'asr' || j.progress > 0); } catch { return false; }
  }, stage, { timeout: 600000, polling: 50 });
  await page.reload();
  // 途中の編集が保存してあれば「途中の編集」の表示、なければ「前回止まった」表示が出る
  await page.waitForSelector('#recover:not([hidden]), #resumeCard:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(500);
  const text = await page.$eval('#resumeCard', el => (el.hidden ? '' : el.innerText)) || await page.$eval('#recoverText', el => el.textContent);
  const asr = await page.$eval('#optAsr', el => el.checked);
  console.log(`再読み込み後の表示: ${text}`);
  console.log(`字幕の設定: ${asr ? 'ON' : 'OFF'}`);
  await page.click('#diagWrap summary');
  await page.waitForFunction(() => document.getElementById('diagText').textContent.length > 0);
  const diag = await page.$eval('#diagText', el => el.textContent);
  console.log('診断情報（先頭）:\n' + diag.split('\n').slice(0, 14).join('\n'));
  await page.screenshot({ path: path.join(dir, `recover-${stage}.png`) });
  throw new Error('RELOAD_CHECK_DONE');
}

try {
  await page.goto((process.env.APP_URL || 'http://127.0.0.1:8123/') + (webaudio ? '?audio=webaudio' : ''));
  await page.setInputFiles('#file', path.join(dir, sample));
  await page.waitForSelector('#stepAnalyze:not([hidden]), #fileError:not([hidden])', { timeout: 60000 });
  const fileErr = await page.$eval('#fileError', el => (el.hidden ? null : el.textContent));
  if (fileErr) {
    console.log('動画を開けない（画面の表示）: ' + fileErr);
    console.log('診断情報の動画欄: ' + (await page.evaluate(() => JSON.parse(localStorage.getItem('amity.log.v1')).slice(-2).map(e => e.msg + ' ' + JSON.stringify(e.data ?? '')).join(' / '))));
    await page.screenshot({ path: path.join(dir, `fileerror-${tag}.png`) });
    throw new Error('RELOAD_CHECK_DONE');
  }
  if (noAsr) await page.uncheck('#optAsr'); else await page.check('#optAsr');
  await page.waitForSelector('#stepBrief:not([hidden])');
  await setTarget(target);
  if (style) await page.click(`input[name=style][value=${style}] + span`);
  // 偽の文字起こし（Whisper の形の結果）は Whisper の区切り方で返す
  if (await page.$('#optEngine')) await page.selectOption('#optEngine', reazon ? 'reazon' : 'whisper');
  if (titleArg) await page.fill('#bTitle', titleArg);
  if (itemsArg) await page.fill('#bItems', itemsArg);
  if (contentArg) await page.fill('#bContent', contentArg);
  if (scriptArg) await page.fill('#bScript', fs.readFileSync(scriptArg, 'utf8'));
  if (withBrief) {
    await page.fill('#bTitle', 'ボブのカット解説');
    await page.fill('#bContent', 'ブロッキングから仕上がりまで、ボブの切り方を解説します');
    await page.fill('#bMessage', 'パネルを45度で引き出すこと');
    await page.fill('#bFlow', '冒頭、ブロッキング、カット、セニング、仕上がり');
    await page.fill('#bMust', 'ここがこのカットの一番大事なポイント\n毛先をセニングして軽さを出す');
  }
  await page.screenshot({ path: path.join(dir, `brief-${tag}.png`), fullPage: true });
  const t0 = Date.now();
  mem.stage = '解析';
  await page.click('#btnAnalyze');
  if (reloadAt && reloadAt !== 'render') await reloadDuring(reloadAt);
  await page.waitForSelector('#stepReview:not([hidden]), #analyzeError:not([hidden])', { timeout: 600000 });
  const analyzeErr = await page.$eval('#analyzeError', el => (el.hidden ? null : el.textContent));
  if (analyzeErr) throw new Error('解析エラー: ' + analyzeErr);
  const warn = await page.$eval('#warnings', el => (el.hidden ? '' : el.textContent));
  if (warn) console.log('注意表示: ' + warn);
  const steps = await page.$$eval('#steps li', els => els.map(e => e.className + ':' + e.textContent).join(' | '));
  console.log('段階: ' + steps);
  console.log(`解析: ${((Date.now() - t0) / 1000).toFixed(1)}秒`);

  if (realAsr || reazon) {
    console.log('モデルの読み込み: ' + asrRequests.filter(p => /onnx|json/.test(p)).map(p => p.split('/').pop()).join(', '));
    const chunks = await page.evaluate(() => window.amityDebug.chunks || []);
    console.log('--- 文字起こし（本物のモデル） ---');
    for (const c of chunks) console.log(`  ${c.start.toFixed(1)}-${c.end.toFixed(1)} ${c.text}${c.raw && c.raw !== c.text ? '  ← 元: ' + c.raw : ''}`);
    const truthText = transcript.filter(c => !c.retake).map(c => c.text).join('');
    const got = chunks.map(c => c.text).join('');
    console.log('文字の一致率（正解との比較・目安）: ' + charAgreement(truthText, got));
    if (transcript[0]?.phrases) {
      // 話した内容（言い直し前の発言も含む）と、文字起こし全体の一致率
      const said = transcript.map(c => c.retake ? c.phrases.map(p => p.text).join('') : c.text).join('');
      console.log('話した内容との一致率（言い直しも含む）: ' + charAgreement(said, got));
      const fixes = await page.evaluate(() => JSON.parse(localStorage.getItem('amity.log.v1')).filter(e => e.msg.startsWith('文字起こし ') && e.data).flatMap(e => e.data.fixes || []));
      console.log('用語の修正: ' + (fixes.join(' / ') || 'なし'));
      // 字幕の時刻: 正解の各文に、文字が最も似ている字幕を対応づけて、開始・終了の差を測る
      const errs = [];
      for (const tr of transcript.filter(c => !c.retake)) {
        let best = null, bestSim = 0;
        for (const c of chunks) {
          const sim = parseFloat(charAgreement(tr.text, c.text));
          if (sim > bestSim) { bestSim = sim; best = c; }
        }
        if (best && bestSim >= 40) errs.push({ text: tr.text, ds: (best.subStart ?? best.start) - tr.start, de: (best.subEnd ?? best.end) - tr.end });
        else console.log(`  対応する字幕なし: ${tr.text}`);
      }
      const abs = a => a.map(Math.abs).sort((x, y) => x - y);
      const med = a => a[Math.floor(a.length / 2)];
      const S = abs(errs.map(e => e.ds)), Ee = abs(errs.map(e => e.de));
      console.log(`字幕の時刻の差（元の動画上）: 開始 中央値 ${med(S).toFixed(2)}s 最大 ${S.at(-1).toFixed(2)}s / 終了 中央値 ${med(Ee).toFixed(2)}s 最大 ${Ee.at(-1).toFixed(2)}s（${errs.length}文）`);
      for (const e of errs) if (Math.abs(e.ds) > 0.3 || Math.abs(e.de) > 0.3) console.log(`  ずれ ${e.ds.toFixed(2)} / ${e.de.toFixed(2)}  ${e.text}`);
    }
    console.log('時刻トークン: ' + (await page.evaluate(() => JSON.parse(localStorage.getItem('amity.log.v1')).filter(e => e.msg.startsWith('文字起こし ') && e.data).map(e => JSON.stringify(e.data.times)).join(' / '))));
  }
  const plan = await page.evaluate(() => {
    const s = window.amityDebug;
    return {
      brief: s.brief, fit: s.fit,
      summary: document.getElementById('summary').textContent,
      total: document.getElementById('total').textContent,
      regions: s.speech.regions.map(r => [+r.start.toFixed(2), +r.end.toFixed(2)]),
      chunks: (s.chunks || []).map(c => ({ start: +c.start.toFixed(2), end: +c.end.toFixed(2), text: c.text, times: (c.times || []).map(t => +t.toFixed(2)), doubts: c.doubts || [] })),
      units: s.units.map(u => ({
        id: u.id, kind: u.kind, start: +u.start.toFixed(2), end: +u.end.toFixed(2), dur: +u.duration.toFixed(2),
        text: u.text, excluded: u.excluded || null, score: +u.score.toFixed(2), cx: +u.cx.toFixed(2),
        selected: s.selected.has(u.id), reasons: u.reasons, mustKeep: u.mustKeep || null,
        candidate: u.candidate || null, doubts: u.doubts || [], trimOption: !!u.trimOption,
      })),
    };
  });
  fs.writeFileSync(path.join(dir, `plan-${tag}.json`), JSON.stringify(plan, null, 1));
  // --dump-analysis=FILE: 解析の結果（音量・声の区間・文字起こし・動き）を保存する。構成の回帰テスト（tests/fixtures）に使う
  const dumpPath = arg('dump-analysis');
  if (dumpPath) {
    const a = await page.evaluate(() => {
      const s = window.amityDebug;
      return { duration: s.src.duration, rmsDb: Array.from(s.rmsDb, v => +v.toFixed(1)), speech: s.speech, chunks: s.chunks, motion: s.motion, ...(s.asrVerify ? { verify: s.asrVerify } : {}) };
    });
    fs.writeFileSync(dumpPath, JSON.stringify(a));
    console.log('解析の結果を保存: ' + dumpPath);
    if (process.argv.includes('--plan-only')) { await browser.close(); process.exit(0); }
  }
  console.log(plan.summary);
  console.log(plan.total);
  console.log('完成時間: ' + (await page.$eval('#fit', el => (el.hidden ? '(表示なし)' : el.textContent))));
  const used = await page.$eval('#briefUsed', el => (el.hidden ? '' : el.textContent));
  if (used) console.log('入力の反映:\n' + used);
  if (replan) {
    await setTarget(replan);
    await page.waitForSelector('#btnReplan:not([hidden])');
    await page.click('#btnReplan');
    console.log(`構成し直し（${replan}秒）: ${await page.$eval('#total', el => el.textContent)} / ${await page.$eval('#fit', el => el.textContent)}`);
  }
  for (const u of plan.units) {
    console.log(`${u.selected ? '■' : '□'} ${u.kind.padEnd(6)} ${u.start.toFixed(1).padStart(6)}-${u.end.toFixed(1).padStart(6)} score=${u.score} ${u.mustKeep ? '[必ず残す] ' : ''}${u.excluded ? '[除外:' + u.excluded + '] ' : ''}${u.text}${u.doubts?.length ? '  [要確認: ' + u.doubts.join('・') + ']' : ''}${u.candidate ? '  [候補: ' + u.candidate + ']' : ''}`);
  }
  await page.screenshot({ path: path.join(dir, `review-${tag}.png`), fullPage: true });

  const t1 = Date.now();
  if (process.argv.includes('--edit-test')) await editTest();
  if (zoom === true) await page.check('#optZoom');
  if (zoom === false) await page.uncheck('#optZoom');
  if (noSubs) await page.uncheck('#optSubs');
  mem.stage = '書き出し';
  await page.click('#btnRender');
  if (reloadAt === 'render') await reloadDuring('render');
  await page.waitForSelector('#stepResult:not([hidden]), #renderError:not([hidden])', { timeout: +(process.env.RENDER_TIMEOUT || 600000) });
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
  try {
    const probe = execSync(`ffprobe -v error -show_entries stream=codec_name,width,height:format=duration -of compact "${outFile}"`, { encoding: 'utf8' });
    console.log('ffprobe: ' + probe.trim().replace(/\n/g, ' | '));
  } catch {}
  if ((realAsr || reazon) && transcript[0]?.phrases) await evaluateOutputTiming();
  if (editExpect) {
    const subs = await page.evaluate(() => window.amityDebug.timeline.flatMap(c => c.subtitles.map(p => p.lines.join(''))).join(''));
    const first = await page.evaluate(() => window.amityDebug.timeline.find(c => c.subtitles.length).subtitles.map(p => `${p.start.toFixed(2)}-${p.end.toFixed(2)} ${p.lines.join('／')}`).join(' | '));
    console.log('手直しした場面の字幕: ' + first);
    console.log(`MP4の字幕に手直しが反映: ${subs.replace(/[、。]/g, '').includes(editExpect.text) ? 'はい' : 'いいえ'}`);
  }
  console.log('演出: ' + (await page.$eval('#outStyle', el => el.textContent)));
  const tl = await page.evaluate(() => window.amityDebug.timeline.map(c => ({ outStart: +c.outStart.toFixed(2), dur: +c.outDuration.toFixed(2), pos: c.subPos, zoom: c.zoom && { z: c.zoom.z, rect: c.zoom.rect }, crop: c.crop, inCrop: c.inCrop, text: c.text, pieces: c.pieces.map(p => ({ srcStart: p.srcStart, frames: p.frames, outStart: p.outStart })), subs: c.subtitles.map(p => p.lines.join('／')), pages: c.subtitles.map(p => ({ s: +p.start.toFixed(2), e: +p.end.toFixed(2), t: p.lines.join('') })) })));
  fs.writeFileSync(path.join(dir, `timeline-${tag}.json`), JSON.stringify(tl, null, 1));
} catch (err) {
  if (err.message !== 'RELOAD_CHECK_DONE') throw err;
} finally {
  clearInterval(memTimer);
  console.log('ページ(renderer)のメモリのピーク(MB):');
  for (const [k, v] of Object.entries(mem.peaks)) console.log(`  ${k}: ${v.renderer ?? '-'}`);
  const errs = logs.filter(l => /error|pageerror/i.test(l));
  if (errs.length) console.log('ブラウザのエラー:\n' + errs.join('\n'));
  await browser.close();
}
