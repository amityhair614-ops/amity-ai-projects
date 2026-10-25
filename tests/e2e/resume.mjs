// 途中から再開の通しテスト: 編集の途中でブラウザを強制終了し（Safari を閉じた・メモリ不足で落ちた状況の再現）、
// もう一度開いて「続きから再開」で MP4 を完成できるかを確かめる。
//
//   CHROME_PATH=/path/to/chrome node tests/e2e/resume.mjs SAMPLE_DIR sample.mov [オプション]
//     --kill-at=render:N   書き出しで N 区間を保存した後に強制終了（既定 render:2）
//     --kill-at=motion     手元の動きの解析の途中（途中経過を1回以上保存した後）
//     --kill-at=asr:N      文字起こしで N 区間を保存した後
//     --kill-at=assemble   仕上げ（区間をつなぐ）の途中
//     --kills=2            強制終了を何回くり返すか（書き出しのとき。2回目は N 区間さらに進んだ後）
//     --drop-source        再開の前に、端末内に保存した元の動画のコピーを消す（選び直しの流れを確かめる）
//     --target=秒          完成動画の長さ
//     --no-asr             字幕OFF
//     --reference=FILE     途中で止めずに書き出した MP4。映像のコマが一致するかを比べる
//     --select-all         構成の確認画面で、使える場面をすべて選ぶ（長い動画を書き出す量・時間・メモリを確かめる。
//                          ロング動画の画面は未実装なので、縦 1080×1920 のまま長く書き出す）
//
// 文字起こしは run.mjs と同じく、SAMPLE_DIR/<名前>-transcript.json を返す偽のワーカーに差し替える。
// 事前に `python3 -m http.server 8123` をリポジトリ直下で起動しておく。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const dir = process.argv[2];
const sample = process.argv[3];
const arg = name => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
const killAt = arg('kill-at') || 'render:2';
const kills = Number(arg('kills') || 1);
const target = arg('target');
const noAsr = process.argv.includes('--no-asr');
const dropSource = process.argv.includes('--drop-source');
const reference = arg('reference');
const selectAll = process.argv.includes('--select-all');
const base = sample.replace(/\.[^.]+$/, '');
const tFile = fs.existsSync(path.join(dir, `${base}-transcript.json`)) ? `${base}-transcript.json` : 'sample-transcript.json';
const transcript = JSON.parse(fs.readFileSync(path.join(dir, tFile), 'utf8'));
const tag = `rs-${base}-${killAt.replace(':', '')}${process.argv.includes('--select-all') ? '-all' : ''}${kills > 1 ? '-x' + kills : ''}${dropSource ? '-drop' : ''}${noAsr ? '-noasr' : ''}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'amity-profile-'));
const URL0 = process.env.APP_URL || 'http://127.0.0.1:8123/';

const fakeWorker = `
const T = ${JSON.stringify(transcript)}.filter(c => c.start < c.end);
self.onmessage = e => {
  const m = e.data;
  if (m.type === 'load') {
    self.postMessage({ type: 'loaded', device: 'wasm' });
  } else if (m.type === 'run') {
    const end = m.offset + m.audio.length / 16000;
    const chunks = T.filter(c => c.start < end && c.end > m.offset)
      .map(c => ({ s: c.asrStart ?? c.start, e: c.asrEnd ?? c.end, text: c.text }))
      .map(c => ({ start: Math.max(0, c.s - m.offset), end: Math.min(end, c.e) - m.offset, text: c.text }));
    setTimeout(() => self.postMessage({ type: 'result', id: m.id, chunks }), ${killAt.startsWith('asr') ? 4000 : 300});
  }
};`;

// ブラウザのページ（renderer）のメモリのピーク
const peaks = {};
let phase = '';
function sampleMemory() {
  let out = '';
  try { out = execSync(`ps -eo rss=,args= | grep -F -- "${profile}" | grep -v grep`, { encoding: 'utf8' }); } catch { return; }
  let sum = 0;
  for (const line of out.trim().split('\n')) if (/--type=renderer/.test(line)) sum += Number(line.trim().split(/\s+/)[0]) / 1024;
  const key = phase + (sub ? ':' + sub : '');
  peaks[key] = Math.max(peaks[key] || 0, Math.round(sum));
}
// 表示中の進み具合の文言（数字を除く）を、メモリを測る段階の名前にする
let sub = '', curPage = null;
const memTimer = setInterval(async () => {
  try {
    if (curPage && !curPage.isClosed()) {
      const t = await curPage.evaluate(() => {
        const r = document.getElementById('renderText').textContent;
        return r || document.getElementById('progressText').textContent;
      });
      sub = t.replace(/[0-9.%/ ]+/g, '').replace(/[（(].*$/, '').replace(/…+$/, '').slice(0, 20);
    }
  } catch {}
  sampleMemory();
}, 500);

async function launch() {
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  await ctx.route('**/js/transcribe-worker.js', r => r.fulfill({ contentType: 'text/javascript', body: fakeWorker }));
  ctx.on('close', () => console.log('[context close]'));
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror] ' + e.message));
  page.on('crash', () => console.log('[crash] ページがクラッシュしました'));
  page.on('close', () => console.log('[close] ページが閉じられました'));
  page.on('console', m => { if (m.type() === 'error' || (process.env.DEBUG_LOG && m.text().startsWith('[amity]'))) console.log('[console] ' + m.text().slice(0, 300)); });
  await page.goto(URL0);
  curPage = page;
  return { ctx, page };
}

// Safari を閉じた・落ちた状況: ブラウザのプロセスを強制終了する（後片付けの処理は一切動かない）
function killBrowser() {
  // chrome のプロセスだけを止める（pkill -f だと、このコマンド自身にも当たる）
  for (const l of execSync('ps -eo pid=,args=', { encoding: 'utf8' }).split('\n')) {
    if (l.includes(profile) && /chrome/.test(l)) try { process.kill(+l.trim().split(/\s+/)[0], 'SIGKILL'); } catch {}
  }
  execSync('sleep 1');
}

const job = page => page.evaluate(() => new Promise(res => {
  const req = indexedDB.open('amity-jobs', 1);
  req.onsuccess = () => {
    const t = req.result.transaction('jobs', 'readonly').objectStore('jobs').getAll();
    t.onsuccess = () => { req.result.close(); res(t.result[0] || null); };
    t.onerror = () => res(null);
  };
  req.onerror = () => res(null);
}));

const summary = j => j && {
  stage: j.stage, audio: !!j.analysis?.audio, asr: j.analysis?.asr ? (j.analysis.asr.done ? 'done' : Object.keys(j.analysis.asr.results || {}).length) : null,
  motion: j.analysis?.motion?.done ? 'done' : j.analysis?.motion?.partial ? +j.analysis.motion.partial.nextT.toFixed(0) + 's' : null,
  render: j.render ? `${j.render.done.filter(Boolean).length}/${j.render.segments.length}` : null,
};

async function waitFor(page, cond, label, timeout = 1800000) {
  const t0 = Date.now();
  for (;;) {
    const j = await job(page).catch(() => null);
    if (cond(j)) return j;
    const errs = await page.evaluate(() => ['analyzeError', 'renderError'].map(id => document.getElementById(id)).filter(e => !e.hidden).map(e => e.textContent).join(' ')).catch(() => '');
    if (errs) throw new Error(`${label}: エラー表示 ${errs}`);
    if (Date.now() - t0 > timeout) throw new Error(`${label}: 時間切れ ${JSON.stringify(summary(j))}`);
    if (passed(j)) throw new Error(`${label}: 止める前にその段階が終わってしまいました ${JSON.stringify(summary(j))}`);
    await page.waitForTimeout(100);
  }
}

const [kStage, kN] = killAt.split(':');
// 止めたい段階がもう終わっている（短い動画で一瞬で終わった）か
const passed = j => !!j && (
  (kStage === 'motion' && j.analysis?.motion?.done) ||
  (kStage === 'asr' && j.analysis?.asr?.done) ||
  ((kStage === 'render' || kStage === 'assemble') && j.stage === 'done'));
const killCond = (n, extra = 0) => j => {
  if (!j) return false;
  if (kStage === 'render') return j.render && j.render.done.filter(Boolean).length >= n + extra;
  if (kStage === 'motion') return !!j.analysis?.motion?.partial;
  if (kStage === 'asr') return Object.keys(j.analysis?.asr?.results || {}).length >= n;
  if (kStage === 'assemble') return j.stage === 'assemble';
  return false;
};

const report = [];
try {
  // ---- 1回目: 最初から編集を始め、途中で強制終了する ----
  phase = '1回目';
  let { ctx, page } = await launch();
  await page.setInputFiles('#file', path.join(dir, sample));
  await page.waitForSelector('#stepAnalyze:not([hidden])', { timeout: 60000 });
  if (noAsr) await page.uncheck('#optAsr'); else await page.check('#optAsr');
  if (target) {
    if (['30', '45', '60'].includes(target)) await page.click(`input[name=dur][value="${target}"] + span`);
    else { await page.click('input[name=dur][value=custom] + span'); await page.fill('#durCustom', target); await page.dispatchEvent('#durCustom', 'change'); }
  }
  const t0 = Date.now();
  await page.click('#btnAnalyze');
  let n = Number(kN || 2);
  let j;
  if (kStage === 'render' || kStage === 'assemble') {
    await page.waitForSelector('#stepReview:not([hidden]), #analyzeError:not([hidden])', { timeout: 1800000 });
    report.push(`解析: ${((Date.now() - t0) / 1000).toFixed(1)}秒`);
    if (selectAll) {
      await page.evaluate(() => {
        const s = window.amityDebug;
        for (const u of s.units) if (!u.excluded && u.duration >= 0.5) s.selected.add(u.id);
      });
    }
    report.push('構成: ' + await page.evaluate(() => {
      const s = window.amityDebug;
      return `${s.selected.size}場面・${s.units.filter(u => s.selected.has(u.id)).reduce((a, u) => a + u.duration, 0).toFixed(1)}秒`;
    }));
    const tr = Date.now();
    await page.click('#btnRender');
    page.__renderStart = tr;
  }
  const noKill = kStage === 'none';
  if (!noKill) {
    j = await waitFor(page, killCond(n), '強制終了の条件');
    if (kStage === 'assemble') await page.waitForTimeout(1500); // 仕上げを少し進めてから止める
    const before = summary(await job(page));
    const s1 = (Date.now() - t0) / 1000;
    killBrowser();
    report.push(`1回目: ${s1.toFixed(1)}秒で強制終了（保存されていた状態: ${JSON.stringify(before)}）`);
  }

  for (let k = 2; ; k++) {
    // ---- もう一度開く（--kill-at=none のときは、止めずにそのまま完成を待つ）----
    phase = noKill ? '1回目' : `${k}回目`;
    let t1;
    if (noKill) {
      t1 = page.__renderStart || t0;
      await page.waitForSelector('#stepResult:not([hidden]), #renderError:not([hidden])', { timeout: 7200000 });
      report.push(`書き出し: ${((Date.now() - t1) / 1000).toFixed(1)}秒`);
    } else {
    ({ ctx, page } = await launch());
    await page.waitForSelector('#resumeCard:not([hidden])', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('#jobList .job').length > 0);
    const card = await page.$eval('#jobList', el => el.innerText);
    const recover = await page.$eval('#recover', el => (el.hidden ? '' : el.innerText)).catch(() => '');
    report.push(`${k}回目に開いたときの表示:\n  ` + card.replace(/\n/g, '\n  ') + (recover ? `\n  （前回止まった表示）${recover.replace(/\n/g, ' ')}` : ''));
    await page.screenshot({ path: path.join(dir, `${tag}-card${k}.png`), fullPage: true });
    if (dropSource && k === 2) {
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const base = await root.getDirectoryHandle('amity-jobs');
        for await (const [name, h] of base.entries()) if (h.kind === 'directory') await h.removeEntry('source').catch(() => {});
      });
    }
    t1 = Date.now();
    await page.click('#jobList .job-btns button');
    if (dropSource && k === 2) {
      await page.waitForSelector('#resumeNeedFile:not([hidden])', { timeout: 10000 });
      report.push('元の動画のコピーがないとき: ' + await page.$eval('#resumeNeedFile', el => el.textContent));
      await page.setInputFiles('#file', path.join(dir, sample));
    }
    if (k <= kills && kStage === 'render') {
      // もう一度、途中で強制終了する
      j = await waitFor(page, killCond(n, Number(kN || 2) * (k - 1)), `${k}回目の強制終了の条件`);
      report.push(`${k}回目: ${((Date.now() - t1) / 1000).toFixed(1)}秒で強制終了（${JSON.stringify(summary(j))}）`);
      killBrowser();
      continue;
    }
    if (kStage === 'motion' || kStage === 'asr') {
      // 解析の途中から再開した場合は、構成の確認画面から書き出す
      await page.waitForSelector('#stepReview:not([hidden]), #analyzeError:not([hidden])', { timeout: Number(process.env.WAIT_MS || 1800000) }).catch(async err => {
        console.log('画面の状態: ' + JSON.stringify(await page.evaluate(() => ({
          review: document.getElementById('stepReview').hidden, analyzeError: document.getElementById('analyzeError').textContent,
          steps: [...document.querySelectorAll('#steps li')].map(e => e.className + ':' + e.textContent),
          global: document.getElementById('globalError').textContent,
        }))));
        throw err;
      });
      const steps = await page.$$eval('#steps li', els => els.map(e => e.textContent).join(' | '));
      report.push('再開した解析の段階: ' + steps);
      await page.click('#btnRender');
    }
    await page.waitForSelector('#stepResult:not([hidden]), #renderError:not([hidden])', { timeout: 7200000 });
    }
    const err = await page.$eval('#renderError', el => (el.hidden ? '' : el.textContent));
    if (err) throw new Error('書き出しエラー: ' + err);
    const logs = await page.evaluate(() => JSON.parse(localStorage.getItem('amity.log.v1')).map(e => e.msg).filter(m => /再利用|再開|書き出し直|保存済み/.test(m)));
    report.push(`${noKill ? '' : k + '回目: 再開から完成まで ' + ((Date.now() - t1) / 1000).toFixed(1) + '秒 / '}${await page.$eval('#renderText', el => el.textContent)}`);
    report.push('記録: ' + [...new Set(logs)].join(' / '));
    const after = await job(page);
    report.push(`完成後の状態: ${JSON.stringify(summary(after))}・書き出しの回数 ${after.render.sessions}`);
    const files = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const base = await root.getDirectoryHandle('amity-jobs');
      const out = [];
      for await (const [name, h] of base.entries()) for await (const [f, fh] of h.entries()) out.push(`${f} ${((await fh.getFile()).size / 1e6).toFixed(1)}MB`);
      return out;
    });
    report.push('端末内の保存データ: ' + files.join(', '));
    const b64 = await page.evaluate(async () => {
      const buf = new Uint8Array(await window.amityDebug.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const outFile = path.join(dir, `out-${tag}.mp4`);
    fs.writeFileSync(outFile, Buffer.from(b64, 'base64'));
    const tl = await page.evaluate(() => window.amityDebug.timeline.map(c => ({ outStart: c.outStart, dur: c.outDuration, text: c.text, pieces: c.pieces.map(p => ({ srcStart: p.srcStart, frames: p.frames, outStart: p.outStart })) })));
    fs.writeFileSync(path.join(dir, `timeline-${tag}.json`), JSON.stringify(tl));
    await page.screenshot({ path: path.join(dir, `${tag}-result.png`), fullPage: true });
    report.push('出力: ' + outFile);
    report.push('ffprobe: ' + execSync(`ffprobe -v error -show_entries stream=codec_name,width,height,nb_frames,duration -of compact "${outFile}"`, { encoding: 'utf8' }).trim().replace(/\n/g, ' | '));
    const decodeErr = execSync(`ffmpeg -v error -i "${outFile}" -f null - 2>&1 || true`, { encoding: 'utf8' }).trim();
    report.push('デコードのエラー: ' + (decodeErr || 'なし'));
    if (reference) {
      const md5 = f => execSync(`ffmpeg -v error -i "${f}" -map 0:v -f framemd5 -`, { encoding: 'utf8' }).split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').pop().trim());
      const a = md5(reference), b = md5(outFile);
      const same = a.filter((h, i) => h === b[i]).length;
      report.push(`途中で止めずに書き出したMP4との比較: 映像のコマ ${same}/${Math.max(a.length, b.length)} が一致`);
    }
    await ctx.close();
    break;
  }
} finally {
  clearInterval(memTimer);
  killBrowser();
  console.log(report.join('\n'));
  console.log('ページ(renderer)のメモリのピーク(MB): ' + JSON.stringify(peaks));
  fs.rmSync(profile, { recursive: true, force: true });
}
