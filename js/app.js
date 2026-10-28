import {
  checkSupport, openVideo, closeVideo, analyzeAudio, analyzeMotion, renderSegment, assembleOutput, getAudioMode, ASR_RATE,
  createRenderContext, RenderPaused,
} from './media.js';
import {
  openWritable, copyIn, readFile, removeFile, listFiles, storageInfo, requestPersist, isStorageFull,
  saveJob, loadJob, listJobs, deleteJob, getWriteMode,
} from './jobstore.js';
import {
  planSegments, renderBytes, spaceCheck, formatBytes, describeJob, jobIdFor, sameSource, MB,
} from './resume.js';
import {
  detectSpeech, transcriptionWindows, buildUnits, selectUnits, buildTimeline, formatTime, FRAME_SEC, trimUnit, untrimUnit,
  cleanSubtitle, alignSentences, refineSubtitleTiming, fineSpeech, setBreakTerms, openingLines, openingText, openingPlan,
  END_FADE, END_HOLD, extendEnding, outputLength, OPENING_DURATIONS,
} from './plan.js';
import { tokensToChunks, fixTerms, checkRanges, alignScript, assignScript } from './asrtext.js';
import {
  previousJob, log, setEnv, jobStart, jobStage, jobProgress, jobEnd, report, clearLogs, errorText,
} from './diag.js';
import { STEP, videoKey, nudge, collectEdits, applyEdits, resetEdits, shifted, formatClock } from './subedit.js';
import {
  FORMATS, EMPTY_BRIEF, normalizeBrief, hasText, briefPlan, applyBrief, applyStyle, targetRange, fitReport, fmt,
} from './brief.js';

const $ = id => document.getElementById(id);
const state = {};
// Safari で開いたか、ホーム画面に追加したアプリから開いたか。iPhone では2つの保存場所が別になる
const OPENED_FROM = (navigator.standalone || matchMedia('(display-mode: standalone)').matches) ? 'home' : 'safari';
const FROM_LABEL = { home: 'ホーム画面のアプリ', safari: 'Safari' };
// 端末内に保存するファイルの名前（作業ごとのフォルダの中）
const SOURCE_NAME = 'source';
const PCM_NAME = 'pcm.f32';
const OUTPUT_NAME = 'output.mp4';
// 画面に表示されるまで待つ
function waitVisible() {
  if (!document.hidden) return Promise.resolve();
  return new Promise(resolve => {
    const on = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', on); resolve(); } };
    document.addEventListener('visibilitychange', on);
  });
}
// ほかのアプリに切り替えた・画面を消した回数（書き出しが止められた可能性があるかを判断する）
let hiddenCount = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenCount++; log('画面を離れました（処理は一時停止します）'); }
  else log('画面に戻りました');
});
Object.defineProperty(state, 'hiddenCount', { get: () => hiddenCount, enumerable: false });
window.amityDebug = state; // 動作確認用

const STAGE_LABELS = {
  open: '動画を開く', audio: '音声を読み込み中', asr: '文字起こし中', motion: '手元の動きを解析中',
  plan: '構成を作成中', render: 'MP4を書き出し中',
};

function showError(el, err) {
  console.error(err);
  log('エラー', errorText(err));
  el.textContent = errorText(err);
  el.hidden = false;
}

function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  return (bytes / 1024 ** 2).toFixed(1) + ' MB';
}

function formatSec(sec) {
  const m = Math.floor(sec / 60);
  return (m ? m + '分' : '') + String(Math.round(sec % 60)).padStart(m ? 2 : 1, '0') + '秒';
}

async function keepAwake() {
  try { return await navigator.wakeLock?.request('screen'); } catch { return null; }
}

// 再生用の <video> は大きな動画だとメモリを使うので、処理中は外しておく
function unloadVideo(v) {
  v.pause();
  v.removeAttribute('src');
  v.load();
}

// ---------- 起動時: 環境の記録と、前回落ちたかどうかの表示 ----------
window.addEventListener('error', e => {
  log('ページのエラー', errorText(e.error || e.message));
  showError($('globalError'), e.error || e.message);
});
window.addEventListener('unhandledrejection', e => {
  log('処理されなかったエラー', errorText(e.reason));
  showError($('globalError'), e.reason);
});

setEnv('対応状況', {
  VideoDecoder: typeof VideoDecoder !== 'undefined',
  VideoEncoder: typeof VideoEncoder !== 'undefined',
  AudioDecoder: typeof AudioDecoder !== 'undefined',
  AudioEncoder: typeof AudioEncoder !== 'undefined',
  OffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
  WebGPU: 'gpu' in navigator,
  WakeLock: 'wakeLock' in navigator,
});

try {
  const saved = localStorage.getItem('amity.optAsr');
  $('optAsr').checked = saved === 'on';
} catch {}
try {
  $('optZoom').checked = localStorage.getItem('amity.optZoom') !== 'off';
  $('optSubs').checked = localStorage.getItem('amity.optSubs') !== 'off';
} catch {}
for (const [id, key] of [['optZoom', 'amity.optZoom'], ['optSubs', 'amity.optSubs']]) {
  $(id).addEventListener('change', () => {
    try { localStorage.setItem(key, $(id).checked ? 'on' : 'off'); } catch {}
  });
}
$('optAsr').addEventListener('change', () => {
  try { localStorage.setItem('amity.optAsr', $('optAsr').checked ? 'on' : 'off'); } catch {}
});
// 字幕AI（文字起こしのモデル）。初期は日本語専用の ReazonSpeech
try { $('optEngine').value = localStorage.getItem('amity.asrEngine') === 'whisper' ? 'whisper' : 'reazon'; } catch {}
$('optEngine').addEventListener('change', () => {
  try { localStorage.setItem('amity.asrEngine', $('optEngine').value); } catch {}
});

if (previousJob) {
  const j = previousJob;
  const label = j.label || STAGE_LABELS[j.stage] || j.stage || '開始直後';
  const file = j.info && j.info.file ? `（${j.info.file}）` : '';
  const lines = [
    `前回の処理は「${label}${j.progress ? ' ' + j.progress + '%' : ''}」の途中で止まりました${file}。`,
    'Safariを閉じたか、iPhoneのメモリが足りなくなってページが再読み込みされた可能性があります。',
    '保存してある所までは、下の「途中の編集」の「続きから再開」で続けられます。',
  ];
  if (j.stage === 'asr' && j.info?.engine === 'reazon') {
    // 日本語専用の字幕AIはメモリを多く使う。止まった場合は、次からは軽い Whisper base にする
    lines.push('字幕（文字起こし）の途中で止まったため、字幕AIを軽い「Whisper base」に切り替えました（精度は下がります）。');
    $('optEngine').value = 'whisper';
    try { localStorage.setItem('amity.asrEngine', 'whisper'); } catch {}
  } else if (j.stage === 'asr') {
    lines.push('字幕（文字起こし）の途中で止まったため、新しく編集するときの字幕をOFFにしました。続きから再開しても何度も止まる場合は「字幕なしで再開」をお試しください。');
    $('optAsr').checked = false;
    try { localStorage.setItem('amity.optAsr', 'off'); } catch {}
  } else {
    lines.push('ほかのアプリやSafariのタブを閉じてから、もう一度お試しください。字幕をOFFにすると使うメモリが減ります。');
  }
  $('recoverText').textContent = lines.join('\n');
  $('recover').hidden = false;
  log('前回の処理が途中で停止', j);
}
$('recoverClose').addEventListener('click', () => { $('recover').hidden = true; });

// ---------- 診断情報 ----------
$('diagWrap').addEventListener('toggle', () => { if ($('diagWrap').open) $('diagText').textContent = report(); });
$('diagCopy').addEventListener('click', async () => {
  const text = report();
  $('diagText').textContent = text;
  try {
    await navigator.clipboard.writeText(text);
    $('diagCopy').textContent = 'コピーしました';
  } catch {
    // コピーできない場合は選択状態にして、長押しでコピーしてもらう
    const range = document.createRange();
    range.selectNodeContents($('diagText'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    $('diagCopy').textContent = '選択しました（長押しでコピー）';
  }
  setTimeout(() => { $('diagCopy').textContent = '診断情報をコピー'; }, 2500);
});
$('diagClear').addEventListener('click', () => {
  clearLogs();
  $('diagText').textContent = report();
});

// ---------- 2. 完成イメージの入力（すべて任意） ----------
// 種類・長さ・スタイルは次の動画にも引き継ぐ。文章の入力は動画ごとに保存する
const PREFS_KEY = 'amity.prefs.v1';
const briefKey = () => (state.file && state.src ? 'amity.brief.v1:' + videoKey(state.file, state.src.duration) : null);
const TEXT_FIELDS = { title: 'bTitle', content: 'bContent', message: 'bMessage', flow: 'bFlow', mustKeep: 'bMust', items: 'bItems', script: 'bScript' };

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

function readBrief() {
  const b = {};
  for (const [k, id] of Object.entries(TEXT_FIELDS)) b[k] = $(id).value;
  b.format = document.querySelector('input[name=format]:checked')?.value;
  b.style = document.querySelector('input[name=style]:checked')?.value;
  const preset = document.querySelector('input[name=dur]:checked')?.value;
  const f = FORMATS[b.format] || FORMATS.short;
  if (preset === 'custom') {
    const v = parseFloat($('durCustom').value);
    b.targetSec = b.format === 'long' ? v * 60 : v;
  } else {
    b.targetSec = Number(preset) || f.defaultSec;
  }
  return normalizeBrief(b);
}

function renderPresets(format, targetSec) {
  const f = FORMATS[format];
  const long = format === 'long';
  const wrap = $('durPresets');
  wrap.innerHTML = '';
  const isPreset = f.presets.includes(targetSec);
  for (const sec of [...f.presets, 'custom']) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'dur';
    input.value = String(sec);
    input.checked = sec === 'custom' ? !isPreset : sec === targetSec;
    const span = document.createElement('span');
    span.textContent = sec === 'custom' ? '自由入力' : fmt(sec);
    label.append(input, span);
    wrap.appendChild(label);
    input.addEventListener('change', () => { syncCustom(); briefChanged(); });
  }
  $('durUnit').textContent = long ? '分' : '秒';
  $('durCustom').min = long ? f.min / 60 : f.min;
  $('durCustom').max = long ? f.max / 60 : f.max;
  $('durCustom').step = long ? 0.5 : 1;
  $('durRange').textContent = long ? `（${f.min / 60}〜${f.max / 60}分）` : `（${f.min}〜${f.max}秒）`;
  $('durCustom').value = long ? +(targetSec / 60).toFixed(1) : targetSec;
  syncCustom();
}

function syncCustom() {
  $('durCustomWrap').hidden = document.querySelector('input[name=dur]:checked')?.value !== 'custom';
}

function writeBrief(b) {
  for (const [k, id] of Object.entries(TEXT_FIELDS)) $(id).value = b[k] || '';
  for (const el of document.querySelectorAll('input[name=format]')) el.checked = el.value === b.format;
  for (const el of document.querySelectorAll('input[name=style]')) el.checked = el.value === b.style;
  renderPresets(b.format, b.targetSec);
}

let briefTimer = null;
function briefChanged() {
  clearTimeout(briefTimer);
  briefTimer = setTimeout(() => {
    const b = readBrief();
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ format: b.format, targetSec: b.targetSec, style: b.style }));
      const key = briefKey();
      if (key) {
        const text = {};
        for (const k of Object.keys(TEXT_FIELDS)) text[k] = b[k];
        if (hasText(b)) localStorage.setItem(key, JSON.stringify(text)); else localStorage.removeItem(key);
      }
    } catch {}
    // 構成を作った後に入力を変えたら、作り直せるようにする
    if (state.units) $('btnReplan').hidden = false;
  }, 300);
}

for (const id of Object.values(TEXT_FIELDS)) $(id).addEventListener('input', briefChanged);
$('durCustom').addEventListener('input', briefChanged);
$('durCustom').addEventListener('change', () => {
  // 範囲外の値は、範囲内に直して表示する
  const b = readBrief();
  $('durCustom').value = b.format === 'long' ? +(b.targetSec / 60).toFixed(1) : b.targetSec;
  briefChanged();
});
for (const el of document.querySelectorAll('input[name=format]')) {
  el.addEventListener('change', () => { renderPresets(el.value, FORMATS[el.value].defaultSec); briefChanged(); });
}
for (const el of document.querySelectorAll('input[name=style]')) el.addEventListener('change', briefChanged);
$('briefClear').addEventListener('click', () => {
  for (const id of Object.values(TEXT_FIELDS)) $(id).value = '';
  briefChanged();
});

function initBrief() {
  const prefs = loadJSON(PREFS_KEY) || {};
  const text = (briefKey() && loadJSON(briefKey())) || {};
  writeBrief(normalizeBrief({ ...EMPTY_BRIEF, ...prefs, ...text }));
}
writeBrief(normalizeBrief({ ...EMPTY_BRIEF, ...(loadJSON(PREFS_KEY) || {}) }));

// ---------- 1. 動画を選ぶ ----------
$('file').addEventListener('change', async () => {
  const file = $('file').files && $('file').files[0];
  if (!file) return;
  // 再開のために選び直してもらった動画なら、保存してある作業の続きをする
  const pending = state.pendingResume;
  await loadSource(file, { preview: !(pending && ['render', 'assemble'].includes(pending.stage)) });
  if (pending && state.src) {
    if (sameSource(pending, file, state.src.duration)) await continueJob(pending, { reselected: true });
    else showError($('fileError'), '保存してある編集とは別の動画のようです（大きさか長さが違います）。同じ動画を選ぶか、新しく編集してください。');
  }
});

// 動画を開いて、入力画面を出す。file は選んだ動画、または端末内に保存したコピー。
// preview: 確認用の再生欄に読み込むか（続きから書き出すときは、読み込んですぐ外すことになるので読み込まない。
// 読み込み中の動画をすぐ外すと、WebKit（Linux）で画面が止まることがあった）
async function loadSource(file, { preview = true } = {}) {
  for (const id of ['fileError', 'analyzeError', 'renderError', 'globalError']) $(id).hidden = true;
  $('stepReview').hidden = true;
  $('stepResult').hidden = true;
  $('stepBrief').hidden = true;
  $('steps').hidden = true;
  $('bar').hidden = true;
  $('progressText').textContent = '';
  unloadVideo($('clipPreview'));
  unloadVideo($('outVideo'));
  if (state.url) URL.revokeObjectURL(state.url);
  if (state.outUrl) URL.revokeObjectURL(state.outUrl);
  closeVideo(state.src);
  Object.keys(state).forEach(k => delete state[k]);
  state.file = file;
  state.url = URL.createObjectURL(file);

  if (preview) $('preview').src = state.url;
  $('name').textContent = file.name;
  $('size').textContent = formatSize(file.size);
  $('duration').textContent = '読み込み中…';
  $('dims').textContent = '-';
  $('fileInfo').hidden = false;
  log('動画を選択', { name: file.name, type: file.type, sizeMB: +(file.size / 1e6).toFixed(1) });

  try {
    state.src = await openVideo(file);
    const { width, height, duration, audio, info } = state.src;
    setEnv('動画', info);
    log('動画の情報', info);
    $('duration').textContent = formatSec(duration);
    $('dims').textContent = `${width}×${height}（${width >= height ? '横向き' : '縦向き'}）${audio ? '' : '・音声なし'}`;
    $('codec').textContent = info.video;
    initBrief();
    $('stepBrief').hidden = false;
    $('stepAnalyze').hidden = false;
    const missing = checkSupport();
    if (missing.length) {
      $('btnAnalyze').disabled = true;
      showError($('analyzeError'), `このブラウザは自動編集に必要な機能（${missing.join('、')}）に対応していません。iPhoneを最新のiOSに更新してから、Safariで開いてください。`);
    } else {
      $('btnAnalyze').disabled = false;
    }
  } catch (err) {
    $('duration').textContent = '-';
    showError($('fileError'), err);
    closeVideo(state.src);
    state.src = null;
  }
}

// ---------- 2. 解析 ----------
function setupSteps(list) {
  const ul = $('steps');
  ul.innerHTML = '';
  for (const s of list) {
    const li = document.createElement('li');
    li.dataset.key = s.key;
    li.innerHTML = `<span class="icon">・</span><span></span>`;
    li.lastChild.textContent = s.label;
    ul.appendChild(li);
  }
  ul.hidden = false;
  $('bar').hidden = false;
}

function setStep(key, status, note) {
  const li = $('steps').querySelector(`[data-key="${key}"]`);
  if (!li) return;
  li.className = status;
  li.firstChild.textContent = status === 'done' ? '✓' : status === 'active' ? '▶' : status === 'skip' ? '－' : status === 'warn' ? '!' : '・';
  if (note) li.lastChild.textContent = li.lastChild.textContent.replace(/（.*）$/, '') + `（${note}）`;
  if (status === 'active') jobStage(key, STAGE_LABELS[key]);
}

function setProgress(ratio, text) {
  $('bar').firstElementChild.style.width = Math.round(Math.min(1, ratio) * 100) + '%';
  if (text !== undefined) $('progressText').textContent = text;
  jobProgress(ratio);
}

const ASR_MODEL = 'onnx-community/whisper-base';
// 字幕AI。reazon: 日本語専用（ReazonSpeech k2 v2・約160MB）/ whisper: Whisper base（約80MB・従来）
const ENGINES = {
  // ReazonSpeech は長い区間の終わりの言葉を落とすことがあるため、話のまとまりごと（8秒まで）に分けて送る
  // 話の長さに比べて文字が少なすぎるとき（文の頭や終わりを落とした）は、前後の音声を広げて読み直し、文字の多い方を使う
  // それでも少ないときは、区間の中の話のまとまり（無音で区切られた部分）ごとに分けて読み直す（splitParts）
  reazon: { worker: 'js/reazon-worker.js', label: 'ReazonSpeech k2 v2（日本語専用）', window: 8, pads: [0.2, 0.6, 1.0], minRate: 4.5, splitParts: true },
  whisper: { worker: 'js/transcribe-worker.js', label: ASR_MODEL, window: 28, pads: [0.2] },
};
const charCount = chunks => chunks.reduce((n, c) => n + (c.raw || c.text || '').replace(/[、。\s]/g, '').length, 0);

// saved: 前回までに文字起こしした区間の結果（{ 区間の番号: chunks }）。onResult(i, chunks) で区間ごとに保存する
function transcribe(pcm, windows, terms = [], { saved = {}, onResult, engine = 'whisper' } = {}) {
  if (windows.every((_, k) => saved[k])) return Promise.resolve(windows.flatMap((_, k) => saved[k]));
  const E = ENGINES[engine] || ENGINES.whisper;
  return new Promise((resolve, reject) => {
    const worker = new Worker(E.worker, { type: 'module' });
    const files = new Map();
    const results = { ...saved };
    let i = 0, attempt = 0, best = null, split = null, triedSplit = false;
    // 今読む範囲: 区間全体（前後の広げ方は attempt 番目）か、分けて読み直しているときはその部分
    const region = () => {
      const w = windows[i];
      if (split) {
        // となりの部分と同じ文字を2回使わないよう、文字を受け取る範囲は部分と部分の間の真ん中まで
        const k = split.idx, p = w.parts[k], prev = w.parts[k - 1], nx = w.parts[k + 1];
        return { start: p.start, end: p.end, pad: 0.3, lo: prev ? Math.max(p.start - 0.3, (prev.end + p.start) / 2) : p.start - 0.3, hi: nx ? Math.min(p.end + 0.3, (p.end + nx.start) / 2) : p.end + 0.3 };
      }
      return { start: w.start, end: w.end, pad: E.pads[attempt], lo: w.start - 0.3, hi: w.end + 0.3 };
    };
    const low = (w, chunks) => E.minRate && w.speech > 1.5 && charCount(chunks) < E.minRate * w.speech;
    const collect = () => windows.flatMap((_, k) => results[k] || []);
    let finished = false;
    const finish = (fn, v) => {
      if (finished) return;
      finished = true;
      worker.terminate();
      $('btnSkipAsr').hidden = true;
      fn(v);
    };
    // 時間がかかりすぎる・止まって見えるときは、字幕なしで先へ進めるようにする
    $('btnSkipAsr').hidden = false;
    $('btnSkipAsr').onclick = () => { log('文字起こしをスキップ'); finish(reject, new Error('スキップしました')); };
    const next = () => {
      while (i < windows.length && results[i]) i++; // 保存済みの区間はやり直さない
      if (i >= windows.length) return finish(resolve, collect());
      const r = region();
      const from = Math.max(0, Math.floor((r.start - r.pad) * ASR_RATE));
      const to = Math.min(pcm.length, Math.ceil((r.end + r.pad) * ASR_RATE));
      const audio = pcm.slice(from, to);
      worker.postMessage({ type: 'run', id: i, audio, offset: from / ASR_RATE }, [audio.buffer]);
      setProgress(i / windows.length, `文字起こし中… ${i + 1} / ${windows.length}${attempt || split ? '（読み直し）' : ''}`);
    };
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'load-progress') {
        const p = m.p;
        if (p.status === 'progress' && p.total) {
          files.set(p.file, { loaded: p.loaded, total: p.total });
          let loaded = 0, total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          setProgress(loaded / total, `AIモデルをダウンロード中… ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`);
        }
      } else if (m.type === 'loaded') {
        state.asrDevice = m.device;
        log('文字起こしモデル準備完了', { device: m.device, sessions: m.sessions });
        setEnv('文字起こしモデル', `${E.label}（${m.device}）${m.sessions}`);
        next();
      } else if (m.type === 'result') {
        const w = windows[m.id];
        const fixes = m.chunks.flatMap(c => c.fixes || []);
        log(`文字起こし ${m.id + 1}/${windows.length}`, {
          chunks: m.chunks.length,
          fixes: fixes.map(f => f.error ? '確認できず: ' + f.error : `${f.from}→${f.to} ${f.ok ? '採用' : '見送り'}(${f.delta})`),
        });
        const r = region();
        const offset = Math.max(0, r.start - r.pad);
        const chunks = [];
        for (const c of m.chunks) {
          const start = offset + c.start, end = Math.min(offset + c.end, w.end + 0.2);
          const text = cleanSubtitle(c.text);
          // つなぎ言葉だけの発言（えーと 等）も残す。場面の候補では「つなぎ言葉のみ」として除外される
          // （残さないと、文字起こしのない声として構成に入ってしまう）
          // 1文字ごとの時刻（ReazonSpeech）は、元の動画の時刻に直して残す
          // 広げた前後の部分（ほかの区間の言葉）は使わない
          const tokens = c.tokens ? c.tokens.map(k => ({ ...k, t: +(offset + k.t).toFixed(3) })).filter(k => k.t >= r.lo && k.t < r.hi) : undefined;
          const rawText = tokens ? tokens.map(k => k.s).join('') : (c.raw ?? c.text);
          if (end > start && (text || (rawText || '').trim())) chunks.push({ start, end, text: tokens ? rawText : text, raw: rawText, timed: c.timed, tokens });
        }
        if (split) {
          // 部分ごとに読み直している: 全部の部分を読んだら、区間全体で読んだ結果と文字の多い方を使う
          split.chunks.push(...chunks);
          split.idx++;
          if (split.idx < w.parts.length) { next(); return; }
          if (charCount(split.chunks) > charCount(best)) {
            log(`文字起こし ${m.id + 1}: 部分ごとに読み直した結果を使います（${charCount(best)}→${charCount(split.chunks)}文字）`);
            best = split.chunks;
          }
          split = null;
        } else {
          if (!best || charCount(chunks) > charCount(best)) best = chunks;
          // 話の長さに比べて文字が少なすぎる: 前後を広げて読み直す（最大2回）。それでも少なければ部分ごとに読み直す
          if (low(w, best) && attempt + 1 < E.pads.length) {
            log(`文字起こし ${m.id + 1}: 話の長さ${w.speech.toFixed(1)}秒に対して${charCount(chunks)}文字のため、前後を広げて読み直します`);
            attempt++;
            next();
            return;
          }
          if (low(w, best) && E.splitParts && !triedSplit && (w.parts || []).length > 1) {
            log(`文字起こし ${m.id + 1}: まだ文字が少ないため、${w.parts.length}つの部分に分けて読み直します`);
            triedSplit = true;
            split = { idx: 0, chunks: [] };
            next();
            return;
          }
        }
        results[m.id] = best;
        attempt = 0;
        best = null;
        triedSplit = false;
        Promise.resolve(onResult?.(m.id, results[m.id])).catch(err => log('文字起こしの途中結果を保存できませんでした', errorText(err))).then(() => { i++; next(); });
      } else if (m.type === 'error') {
        finish(reject, new Error(m.message));
      }
    };
    worker.onerror = e => finish(reject, new Error(e.message || '文字起こしの準備に失敗しました（ネットワークを確認してください）'));
    setProgress(0, 'AIモデルを準備中…');
    worker.postMessage({ type: 'load', model: ASR_MODEL, terms });
  });
}

// 「自動編集を開始」: 新しい作業として最初から解析する（同じ動画の前の作業は消す。元の動画のコピーは使い回す）
$('btnAnalyze').addEventListener('click', async () => {
  const src = state.src;
  if (!src) return;
  const id = state.job?.id && state.sourceFromStore ? state.job.id : jobIdFor(state.file);
  const old = await loadJob(id).catch(() => null);
  const keepSource = !!old?.sourceSaved && state.sourceFromStore;
  if (old) {
    for (const f of await listFiles(id)) if (!(keepSource && f.name === SOURCE_NAME)) await removeFile(id, f.name);
  }
  const job = {
    id, version: 1, createdAt: Date.now(), stage: 'analyze',
    file: { name: state.file.name, size: state.file.size, type: state.file.type }, duration: src.duration,
    useAsr: $('optAsr').checked && !!src.audio, asrEngine: $('optEngine').value === 'whisper' ? 'whisper' : 'reazon', brief: readBrief(),
    sourceSaved: keepSource, analysis: { warnings: [] }, review: null, render: null, output: null, from: OPENED_FROM,
  };
  await runAnalysis(job);
});

// 端末内に保存する作業の記録。保存に失敗しても編集は続ける（再開できないだけ）
// 保存した作業の一覧を localStorage にも控えておく（IndexedDB から読めなかったときに、理由を表示するため）
const JOB_INDEX_KEY = 'amity.jobindex.v1';
function indexJob(job, saveError) {
  try {
    const idx = loadJSON(JOB_INDEX_KEY) || {};
    if (job === null) { delete idx[saveError]; }
    else {
      const prev = idx[job.id] || {};
      idx[job.id] = {
        id: job.id, name: job.file.name, size: job.file.size, duration: job.duration, stage: job.stage, from: job.from || OPENED_FROM,
        saved: job.render ? `${job.render.done.filter(Boolean).length}/${job.render.segments.length}` : null,
        updatedAt: Date.now(), saveError: saveError || null, lastSaved: saveError ? prev.lastSaved || null : Date.now(),
      };
    }
    localStorage.setItem(JOB_INDEX_KEY, JSON.stringify(idx));
  } catch {}
}

async function persistJob(job) {
  state.job = job;
  try {
    await saveJob(job);
    state.saveWarned = false;
    indexJob(job);
  } catch (err) {
    indexJob(job, errorText(err));
    if (!state.saveWarned) log('途中経過を保存できませんでした', { error: errorText(err), stage: job.stage, saved: job.render ? job.render.done.filter(Boolean).length : null });
    if (!state.saveWarned) {
      state.saveWarned = true;
      showNotice(isStorageFull(err)
        ? '空き容量が足りないため、途中経過を保存できませんでした。編集は続けますが、途中で止まると最初からになります。'
        : '途中経過を保存できませんでした（' + errorText(err) + '）。編集は続けますが、途中で止まると最初からになります。');
    }
  }
}

// 解析: 段階ごとに結果を保存しながら進める。保存済みの段階はやり直さない
async function runAnalysis(job) {
  const src = state.src;
  const brief = normalizeBrief(job.brief);
  writeBrief(brief);
  const bp = briefPlan(brief);
  const A = job.analysis;
  $('btnReplan').hidden = true;
  $('analyzeError').hidden = true;
  $('globalError').hidden = true;
  $('stepReview').hidden = true;
  $('stepResult').hidden = true;
  $('btnAnalyze').disabled = true;
  $('file').disabled = true;
  $('resumeCard').hidden = true; // 処理中は「途中の編集」を押せないようにする（終わったら表示し直す）
  unloadVideo($('preview'));
  unloadVideo($('clipPreview'));
  setupSteps([
    { key: 'store', label: '途中から再開できるよう、元の動画を端末内に保存する' },
    { key: 'audio', label: '音声を読み込み、無音を探す' },
    { key: 'asr', label: '文字起こし（字幕・言い直し）' },
    { key: 'motion', label: '手元の動きを解析する' },
    { key: 'plan', label: `約${fmt(brief.targetSec)}の構成を作る` },
  ]);
  jobStart('解析', {
    file: job.file.name, sizeMB: +(job.file.size / 1e6).toFixed(1), asr: job.useAsr, engine: job.useAsr ? (job.asrEngine || 'whisper') : null, video: src.info,
    brief: { format: brief.format, targetSec: brief.targetSec, style: brief.style, text: hasText(brief), must: bp.mustItems.length, asrTerms: bp.asrTerms.length },
    resume: !!(A.audio || A.motion),
  });
  const lock = await keepAwake();
  const t0 = performance.now();
  try {
    await persistJob(job);
    await requestPersist();

    // 0. 元の動画のコピー（Safari が閉じられても、選び直さずに再開できるように）
    if (job.sourceSaved) setStep('store', 'done', '保存済み');
    else await storeSource(job);

    // 1. 音声（失敗しても動きだけで続ける）
    let pcm = null;
    const needPcm = job.useAsr && !A.asr?.done && !A.asr?.failed;
    if (A.audio) {
      setStep('audio', 'done', '保存済みの結果を使用');
      state.rmsDb = A.audio.rmsDb;
      if (needPcm && A.audio.pcmSaved) {
        const f = await readFile(job.id, PCM_NAME);
        if (f) pcm = new Float32Array(await f.arrayBuffer());
      }
    }
    if ((!A.audio && src.audio) || (needPcm && !pcm && src.audio && A.audio && !A.audio.failed)) {
      setStep('audio', 'active');
      try {
        const a = await analyzeAudio(src, r => setProgress(r, `音声を読み込み中… ${Math.round(r * 100)}%`));
        pcm = a.pcm;
        state.rmsDb = a.rmsDb;
        A.audio = { rmsDb: a.rmsDb, mode: getAudioMode(), pcmSaved: false };
        // 文字起こし用の音声も保存しておく（文字起こしの途中で止まったとき、音声を読み直さずに済む）
        if (needPcm) {
          try {
            await copyIn(job.id, PCM_NAME, new Blob([pcm.buffer]));
            A.audio.pcmSaved = true;
          } catch (err) {
            log('文字起こし用の音声を保存できませんでした', errorText(err));
          }
        }
        await persistJob(job);
        setStep('audio', 'done');
      } catch (err) {
        log('音声の解析に失敗', errorText(err));
        A.audio = { failed: true, rmsDb: null };
        A.warnings.push('音声を読み込めなかったため、無音カットなし（手元の動きだけ）で構成しました（' + errorText(err) + '）。');
        await persistJob(job);
        setStep('audio', 'warn', '失敗');
      }
    } else if (!src.audio) {
      setStep('audio', 'skip', '音声なし');
    }
    if (!state.rmsDb) state.rmsDb = new Float32Array(Math.ceil(src.duration / FRAME_SEC));
    state.speech = state.rmsDb.some(v => v !== 0) ? detectSpeech(state.rmsDb) : { regions: [], voice: [], threshold: 0 };
    log('音声の解析完了', { mode: A.audio?.mode ?? getAudioMode(), speechRegions: state.speech.regions.length, sounds: state.speech.sounds?.length ?? 0 });

    // 2. 文字起こし（区間ごとに保存。失敗しても続ける）
    state.chunks = null;
    if (A.asr?.done) {
      state.chunks = A.asr.chunks;
      setStep('asr', 'done', '保存済みの結果を使用');
    } else if (job.useAsr && !A.asr?.failed && pcm && state.speech.regions.length) {
      setStep('asr', 'active');
      try {
        const engine = job.asrEngine || 'whisper';
        const windows = A.asr?.windows || transcriptionWindows(state.speech.regions, ENGINES[engine].window);
        A.asr = { windows, results: A.asr?.results || {}, done: false };
        const savedN = Object.keys(A.asr.results).length;
        if (savedN) log(`保存済みの文字起こしの区間を再利用: ${savedN}/${windows.length}`);
        const raw = await transcribe(pcm, windows, bp.asrTerms, {
          engine,
          saved: A.asr.results,
          onResult: async (i, chunks) => { A.asr.results[i] = chunks; await persistJob(job); },
        });
        const fine = fineSpeech(state.rmsDb, state.speech.threshold);
        // ReazonSpeech: 1文字ごとの時刻と声の切れ目で文に分け、用語の書き方を直す
        // Whisper: 文ごとの時刻を、無音の切れ目に合わせて割り当て直す
        // どちらも字幕の表示時刻は実際の声の出始め・終わりに合わせる
        const sentences = engine === 'reazon' && raw.some(c => c.tokens)
          ? tokensToChunks(raw, fine).map(c => fixTerms(c, [...bp.items, ...bp.asrTerms], bp.phrases))
          : alignSentences(raw, state.speech.regions);
        state.chunks = refineSubtitleTiming(sentences, fine);
        A.asr = { windows, done: true, chunks: state.chunks };
        await persistJob(job);
        await removeFile(job.id, PCM_NAME);
        setStep('asr', 'done');
      } catch (err) {
        log('文字起こしに失敗', errorText(err));
        A.asr = { ...(A.asr || {}), failed: true };
        A.warnings.push('文字起こしができなかったため、字幕なし・言い直し検出なしで構成しました（' + errorText(err) + '）。');
        await persistJob(job);
        setStep('asr', 'warn', '失敗・字幕なしで続行');
      }
    } else {
      setStep('asr', 'skip', A.asr?.failed ? '前回失敗' : job.useAsr ? (pcm ? '話し声なし' : '音声なし') : 'OFF');
    }
    pcm = null; // 文字起こし用の音声はここで手放す

    // 3. 手元の動き（約30秒ぶんごとに保存。失敗しても音声だけで続ける）
    if (A.motion?.done) {
      state.motion = A.motion.data;
      setStep('motion', A.motion.data ? 'done' : 'warn', '保存済みの結果を使用');
    } else {
      setStep('motion', 'active', A.motion?.partial ? '途中から再開' : undefined);
      try {
        state.motion = await analyzeMotion(src, r => setProgress(r, `手元の動きを解析中… ${Math.round(r * 100)}%`), 1, {
          resume: A.motion?.partial || null,
          onCheckpoint: async partial => { A.motion = { partial }; await persistJob(job); },
        });
        A.motion = { done: true, data: state.motion };
        await persistJob(job);
        setStep('motion', 'done');
      } catch (err) {
        log('動きの解析に失敗', errorText(err));
        state.motion = null;
        A.motion = { done: true, data: null };
        A.warnings.push('映像の動きを解析できなかったため、音声だけで構成しました（' + errorText(err) + '）。');
        await persistJob(job);
        setStep('motion', 'warn', '失敗');
      }
    }

    setStep('plan', 'active');
    state.warnings = A.warnings;
    makePlan(brief);
    if (!state.selected.size) throw new Error('使える場面が見つかりませんでした。音声と映像の両方を読み込めなかった可能性があります。');
    job.stage = 'review';
    job.review = { selected: [...state.selected], brief };
    await persistJob(job);
    setStep('plan', 'done');
    setProgress(1, `完了（${formatSec((performance.now() - t0) / 1000)}）`);
    jobEnd('done');
    showReview();
  } catch (err) {
    jobEnd('error', err);
    showError($('analyzeError'), err);
  } finally {
    $('btnAnalyze').disabled = false;
    $('file').disabled = false;
    $('preview').src = state.url;
    lock?.release?.();
    $('renderContext').textContent = `今は${FROM_LABEL[OPENED_FROM]}で開いています。再開するときも${FROM_LABEL[OPENED_FROM]}から開いてください（iPhoneでは保存場所が別です）。`;
refreshJobs();
storageInfo().then(info => setEnv('保存', { ...info, openedFrom: OPENED_FROM, idb: typeof indexedDB !== 'undefined' }));
  }
}

// 元の動画を端末内にコピーする。空きが足りない・失敗したときはコピーせずに進む（再開時に選び直してもらう）
async function storeSource(job) {
  setStep('store', 'active');
  const info = await storageInfo();
  const need = job.file.size + (job.useAsr ? job.duration * ASR_RATE * 4 : 0) + 100 * MB;
  const sc = spaceCheck(info, need);
  if (!sc.ok) {
    setStep('store', 'warn', `空きが足りないため保存しません（必要 約${formatBytes(need)}・空き 約${formatBytes(sc.free)}）。再開するときは同じ動画を選び直してください`);
    return;
  }
  try {
    await copyIn(job.id, SOURCE_NAME, state.file, r => setProgress(r, `元の動画を端末内に保存中… ${Math.round(r * 100)}%`));
    job.sourceSaved = true;
    await persistJob(job);
    setStep('store', 'done');
  } catch (err) {
    log('元の動画を保存できませんでした', errorText(err));
    setStep('store', 'warn', (isStorageFull(err) ? '空き容量が足りないため保存できませんでした' : '保存できませんでした') + '。再開するときは同じ動画を選び直してください');
  }
}

// 確認が必要な字幕（文字起こしの確からしさが低い言葉・入力された用語に直した所）に印をつける（u.check）
function markChecks(units, chunks) {
  if (!chunks) return;
  for (const u of units) {
    if (u.kind !== 'speech' || !u.text) continue;
    const words = [];
    for (const c of chunks) {
      if (c.end < (u.voiceStart ?? u.start) || c.start > (u.voiceEnd ?? u.end)) continue;
      for (const [a0, b0] of checkRanges(c)) {
        // 1〜2文字だけでは場所がわからないので、前後の文字も含めて示す（読点では止める）
        let a = a0, b = b0;
        while (a > 0 && a0 - a < 2 && !/[、。]/.test(c.text[a - 1])) a--;
        while (b < c.text.length && b - b0 < 2 && !/[、。]/.test(c.text[b])) b++;
        const w = c.text.slice(a, b);
        if (w && u.text.includes(w) && !words.includes(w)) words.push(w);
      }
    }
    u.check = words;
  }
}

// 原稿の文字を、場面ごとの字幕にする（原稿の句を、その句を話している場面に割り当てる）。
// 原稿にない発言（言い直し・余談の可能性）は候補として知らせる
function applyScriptAll() {
  if (!state.scriptAlign) return;
  const speech = state.units.filter(u => u.kind === 'speech' && !u.excluded);
  state.scriptMap = assignScript(state.scriptAlign, speech);
  for (const u of speech) applyScript(u);
}

function applyScript(u) {
  if (!state.scriptAlign || u.kind !== 'speech' || u.excluded) return;
  if (u.asrText === undefined) u.asrText = u.text;
  const sc = state.scriptMap?.get(u);
  const t = sc?.text || '';
  if (t) {
    u.text = t;
    u.times = sc.times; // 字幕のページを、原稿の文字を話した時刻で切り替える
    u.check = [];
    delete u.offScript;
  } else if (u.asrText) {
    u.offScript = true;
    if (!u.candidate) u.candidate = '原稿にない発言です（言い直しや余談の可能性があります。必要なら残してください）';
    if (u.score != null && !u.offScriptScored) { u.score -= 0.5; u.offScriptScored = true; }
  }
}

// 解析結果（音声・文字起こし・動き）と入力内容から構成を作る。入力を変えたときは解析し直さずにこれだけ行う
function makePlan(brief) {
  const src = state.src;
  const bp = briefPlan(brief);
  state.brief = bp.brief;
  state.units = buildUnits({
    duration: src.duration, rmsDb: state.rmsDb, speech: state.speech, chunks: state.chunks, motion: state.motion,
    pace: bp.brief.style === 'tempo' ? 'tempo' : 'natural',
  });
  state.trims = {};
  setBreakTerms(bp.items);
  markChecks(state.units, state.chunks);
  // 原稿があれば、字幕の文字を原稿にする（タイミングは文字起こしの時刻に合わせる）
  state.scriptAlign = null;
  if (bp.script && state.chunks?.length) {
    state.scriptAlign = alignScript(bp.script, state.chunks);
    applyScriptAll();
    log('原稿との照合', { matched: +(state.scriptAlign.matched * 100).toFixed(1) + '%', offScript: state.units.filter(u => u.offScript).length });
  }
  const { must } = applyBrief(state.units, bp);
  applyStyle(state.units, bp.brief.style);
  const { target, max } = targetRange(bp.brief.targetSec);
  const sel = selectUnits(state.units, src.duration, target, max, { buckets: bp.buckets });
  state.selected = new Set(sel.map(u => u.id));
  state.fit = fitReport({ targetSec: bp.brief.targetSec, selected: sel, units: state.units, sourceDuration: src.duration });
  // 入力内容がどう使われたか
  const used = [];
  if (bp.themeTerms.length || bp.messageTerms.length) {
    used.push(`入力から読み取った言葉: ${[...bp.messageTerms, ...bp.themeTerms].slice(0, 12).join('・')}`);
    const boosted = state.units.filter(u => u.reasons.some(r => r.startsWith('入力した内容') || r.startsWith('伝えたいこと'))).length;
    used.push(!state.chunks ? '→ 文字起こしがOFFのため、話の内容との照合はしていません。'
      : boosted ? `→ これらの言葉を話している${boosted}場面を優先しました。` : '→ 話の中に同じ言葉は見つかりませんでした。');
  }
  if (bp.mustItems.length && state.chunks) {
    for (const m of must) used.push(m.unit ? `必ず残す: 「${m.item}」→ ${formatTime(m.unit.start)}の発言「${m.unit.text.slice(0, 24)}」` : `必ず残す: 「${m.item}」→ 合う発言が見つかりませんでした`);
  }
  if (bp.buckets !== 5) used.push(`流れ（${bp.buckets}段階）に合わせて、動画全体から順に場面を選びました。`);
  // 用語の聞き取りの補正（入力した言葉に合わせて直した所。字幕に入力の文章を足すことはしない）
  const fixes = new Map();
  for (const c of state.chunks || []) for (const f of c.fixed || []) if (f.from !== f.to) fixes.set(`${f.from}→${f.to}`, (fixes.get(`${f.from}→${f.to}`) || 0) + 1);
  if (fixes.size) used.push(`入力した言葉に合わせて字幕を直しました（確認の印を付けています）: ${[...fixes].slice(0, 8).map(([k, n]) => n > 1 ? `${k}（${n}か所）` : k).join('、')}`);
  else if (state.chunks && (bp.phrases.length || bp.asrTerms.length)) used.push('入力した言葉で字幕を直した所はありませんでした。');
  if (state.opening === undefined && bp.brief.title) used.push('冒頭のテキストは、動画タイトルから作りました（下で文字・行・表示時間を直せます）。');
  state.briefUsed = used;
  state.briefWarnings = [];
  if (bp.mustItems.length && !state.chunks) state.briefWarnings.push('「必ず残したい説明や場面」は文字起こし（字幕）をONにしたときだけ照合できます。今回は照合していません。');
  if (bp.script && !state.chunks) state.briefWarnings.push('原稿は、文字起こし（字幕）をONにしたときだけ音声に合わせられます。今回は原稿を使っていません。');
  else if (state.scriptAlign && state.scriptAlign.matched < 0.5) state.briefWarnings.push(`原稿と話した内容の一致が${Math.round(state.scriptAlign.matched * 100)}%と低いため、字幕の位置がずれている可能性があります。別の動画の原稿でないか確かめてください。`);
  else if (must.some(m => !m.unit)) state.briefWarnings.push('「必ず残したい説明や場面」の一部に合う発言が見つかりませんでした。下の「ほかの候補」から選んでください。');
  log('構成', { targetSec: bp.brief.targetSec, planned: +state.fit.planned.toFixed(1), ok: state.fit.ok, must: must.map(m => !!m.unit), style: bp.brief.style });
  // 同じ動画で前に直した字幕があれば当てはめる
  const saved = loadSubEdits();
  state.subOffset = saved?.offset || 0;
  state.restoredEdits = applyEdits(state.units, saved);
}

$('openingText').addEventListener('input', () => { state.opening = $('openingText').value; saveReview(); });
$('optOpening').addEventListener('change', saveReview);
$('openingDur').addEventListener('change', saveReview);
const openingDur = () => OPENING_DURATIONS.includes(+$('openingDur').value) ? +$('openingDur').value : 2;
$('openingReset').addEventListener('click', () => {
  state.opening = openingLines(readBrief().title).join('\n');
  $('openingText').value = state.opening;
  saveReview();
});

$('btnReplan').addEventListener('click', () => {
  if (!state.units) return;
  makePlan(readBrief());
  $('btnReplan').hidden = true;
  showReview();
  saveReview();
});

// ---------- 3. 構成の確認 ----------
function clipRow(u) {
  const div = document.createElement('div');
  div.className = 'clip' + (state.selected.has(u.id) ? '' : ' off');
  const head = document.createElement('div');
  head.className = 'clip-head';
  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = state.selected.has(u.id);
  cb.addEventListener('change', () => {
    if (cb.checked) state.selected.add(u.id); else state.selected.delete(u.id);
    div.classList.toggle('off', !cb.checked);
    updateTotal();
    saveReview();
  });
  const time = document.createElement('span');
  time.textContent = `${formatTime(u.start)}〜${formatTime(u.end)}（${u.duration.toFixed(1)}秒）`;
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = u.kind === 'action' ? '作業' : '話し';
  label.append(cb, time, kind);
  if (u.mustKeep) {
    const tag = document.createElement('span');
    tag.className = 'must-tag';
    tag.textContent = '必ず残す';
    label.appendChild(tag);
  }
  const play = document.createElement('button');
  play.className = 'play';
  play.type = 'button';
  play.textContent = '▶';
  play.setAttribute('aria-label', 'この場面を再生');
  play.addEventListener('click', () => playRange(u.start, u.end));
  head.append(label, play);
  div.appendChild(head);
  // 取り除いた部分は下の枠（元に戻すボタンつき）に出すので、理由の行には重ねて出さない
  const reasons = [u.excluded, ...u.reasons.filter(r => !r.endsWith('を取り除きました'))].filter(Boolean);
  if (reasons.length) {
    const r = document.createElement('div');
    r.className = 'reasons';
    r.textContent = reasons.join(' / ');
    div.appendChild(r);
  }
  // 話した内容から判断した、言い直し・くり返しの扱い（取り除いた部分は元に戻せる。確かでないものは候補として出す）
  if (u.trimmed || u.trimOption || u.candidate) div.appendChild(contentTools(u));
  if (u.kind === 'speech' && state.chunks) div.appendChild(subtitleEditor(u));
  return div;
}

function contentTools(u) {
  const box = document.createElement('div');
  box.className = 'cand';
  const note = document.createElement('span');
  note.textContent = u.trimmed ? `${u.trimmed.reason}を取り除きました` : `候補: ${u.candidate}`;
  box.appendChild(note);
  const act = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link-btn';
    b.textContent = label;
    b.addEventListener('click', () => {
      const untouched = u.text === u.aiText; // 字幕を手直ししていなければ、AIの字幕として扱う
      fn();
      if (state.scriptAlign) { u.asrText = u.text; applyScriptAll(); }
      if (untouched) u.aiText = u.text;
      state.trims[u.id] = u.trimmed ? 'on' : 'off';
      saveReview();
      showReview();
    });
    box.appendChild(b);
  };
  if (u.trimmed) act('元に戻す', () => untrimUnit(u));
  else if (u.trimOption) act('この部分を取り除く', () => trimUnit(u, u.trimOption));
  return box;
}

// 字幕の手直し: 文字はタップして直す。表示の開始・終了は 0.1 秒ずつ動かし、その部分の音声を再生して確かめる
function subtitleEditor(u) {
  const box = document.createElement('div');
  box.className = 'sub-edit';
  const ta = document.createElement('textarea');
  ta.rows = 2;
  ta.value = u.text;
  ta.placeholder = '（字幕なし）';
  ta.setAttribute('aria-label', '字幕の文字');
  ta.addEventListener('input', () => { u.text = ta.value; saveSubEdits(); showCheck(); });
  box.appendChild(ta);
  // 文字起こしが自信のない言葉・入力された用語に直した所を知らせる（直したら消える）
  const check = document.createElement('p');
  check.className = 'sub-check';
  const showCheck = () => {
    const words = (u.check || []).filter(w => u.text === u.aiText && u.text.includes(w));
    check.textContent = words.length ? `確認してください: ${words.map(w => `「${w}」`).join('')}` : '';
    check.hidden = !words.length;
    box.classList.toggle('needs-check', !!words.length);
  };
  box.appendChild(check);
  showCheck();
  if (u.subStart == null) return box;

  const row = document.createElement('div');
  row.className = 'sub-time';
  const btn = (label, aria, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', fn);
    return b;
  };
  const startEl = document.createElement('span');
  const endEl = document.createElement('span');
  startEl.className = endEl.className = 'clock';
  const show = () => {
    startEl.textContent = formatClock(u.subStart);
    endEl.textContent = formatClock(u.subEnd);
    box.classList.toggle('edited', !!u.subEdited || u.text !== u.aiText);
  };
  const move = (which, d) => () => { nudge(u, which, d); show(); saveSubEdits(); };
  const group = (title, which, el) => {
    const g = document.createElement('div');
    g.className = 'sub-adj';
    const t = document.createElement('span');
    t.className = 'sub-label';
    t.textContent = title;
    g.append(t, btn('−', `${title}を0.1秒早く`, move(which, -STEP)), el, btn('＋', `${title}を0.1秒遅く`, move(which, STEP)));
    return g;
  };
  row.append(
    group('出る', 'start', startEl),
    group('消える', 'end', endEl),
    btn('▶ 音声', 'この字幕の部分を再生', () => playRange(u.subStart + state.subOffset - 0.2, u.subEnd + state.subOffset + 0.2)),
  );
  box.appendChild(row);
  show();
  return box;
}

// ---------- 字幕の修正の保存 ----------
function loadSubEdits() {
  try { return JSON.parse(localStorage.getItem(videoKey(state.file, state.src.duration)) || 'null'); } catch { return null; }
}

let saveTimer = null;
function saveSubEdits() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const data = collectEdits(state.units, state.subOffset);
      localStorage.setItem(videoKey(state.file, state.src.duration), JSON.stringify(data));
      $('subSaved').textContent = `修正を保存しました（${Object.keys(data.edits).length}か所${data.offset ? '・全体 ' + (data.offset > 0 ? '+' : '') + data.offset.toFixed(1) + '秒' : ''}）`;
    } catch {
      $('subSaved').textContent = '修正を保存できませんでした（このままMP4には反映されます）';
    }
  }, 300);
}

function showOffset() {
  const o = state.subOffset || 0;
  $('subOffset').textContent = (o > 0 ? '+' : o < 0 ? '−' : '±') + Math.abs(o).toFixed(1) + '秒';
}

$('subOffMinus').addEventListener('click', () => { state.subOffset = Math.round(((state.subOffset || 0) - STEP) * 10) / 10; showOffset(); saveSubEdits(); });
$('subOffPlus').addEventListener('click', () => { state.subOffset = Math.round(((state.subOffset || 0) + STEP) * 10) / 10; showOffset(); saveSubEdits(); });
$('subReset').addEventListener('click', () => {
  if (!confirm('字幕の修正をすべて取り消して、AIの結果に戻しますか？')) return;
  resetEdits(state.units);
  state.subOffset = 0;
  try { localStorage.removeItem(videoKey(state.file, state.src.duration)); } catch {}
  $('subSaved').textContent = '修正を取り消しました';
  showReview();
});

// 確認用の再生は、押されたときに初めて動画を読み込む
let stopAt = null;
function playRange(start, end) {
  const v = $('clipPreview');
  v.hidden = false;
  if (!v.getAttribute('src')) v.src = state.url;
  if (stopAt) v.removeEventListener('timeupdate', stopAt);
  stopAt = () => {
    if (v.currentTime >= end) { v.pause(); v.removeEventListener('timeupdate', stopAt); stopAt = null; }
  };
  v.addEventListener('timeupdate', stopAt);
  v.currentTime = Math.max(0, start);
  v.play().catch(() => {});
  v.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateTotal() {
  const total = outputLength(state.units.filter(u => state.selected.has(u.id)));
  const target = state.brief?.targetSec ?? 60;
  const el = $('total');
  const { lo, max } = targetRange(target);
  el.textContent = `合計 ${total.toFixed(1)}秒（${state.selected.size}場面）・目標 ${fmt(target)}（目安 ${fmt(lo)}〜${fmt(max)}）` + (total > max + 0.5 ? ' ― 目安より長くなっています' : '');
  el.classList.toggle('over', total > max + 0.5);
  $('btnRender').disabled = state.selected.size === 0;
}

function styleSummary(timeline, useSubs, useZoom, overlay) {
  const parts = [];
  parts.push(overlay?.opening ? `冒頭テキスト: 「${overlay.opening.lines.join(' ')}」約${(overlay.opening.end - overlay.opening.start).toFixed(1)}秒` : '冒頭テキスト: なし');
  if (useSubs) {
    const all = timeline.filter(c => c.subtitles.length).length;
    parts.push(`字幕: ${all}場面（画面の下）`);
  } else {
    parts.push('字幕: なし');
  }
  if (useZoom) {
    const z = timeline.filter(c => c.zoom);
    parts.push(z.length ? `ズーム: ${z.length}か所（${z.map(c => formatTime(c.outStart) + ' ' + c.zoom.z.toFixed(2) + '倍').join('、')}）` : 'ズーム: 合う場面がなかったため なし');
  } else {
    parts.push('ズーム: なし');
  }
  parts.push(`最後: ${END_FADE}秒で黒くフェードアウト＋${END_HOLD}秒 黒い画面`);
  return parts.join(' / ');
}

function showReview() {
  const units = state.units;
  const chosen = units.filter(u => state.selected.has(u.id));
  const others = units.filter(u => !state.selected.has(u.id) && !u.excluded && u.duration >= 0.5);
  const retakes = units.filter(u => u.excluded);
  const fill = (el, list) => { el.innerHTML = ''; list.forEach(u => el.appendChild(clipRow(u))); };
  fill($('clips'), chosen);
  fill($('others'), others);
  fill($('retakes'), retakes);
  $('otherSummary').textContent = `ほかの候補（${others.length}件）`;
  $('otherWrap').hidden = !others.length;
  $('retakeSummary').textContent = `言い直し・不要として除外した場面（${retakes.length}件）`;
  $('retakeWrap').hidden = !retakes.length;

  const speechSec = state.speech.regions.reduce((s, r) => s + r.end - r.start, 0);
  const parts = [
    `元の動画 ${formatSec(state.src.duration)} のうち、話している部分は約${formatSec(speechSec)}でした。`,
    `その中から${chosen.length}場面を選びました。`,
  ];
  // 文の中の長い間を縮めた数（すべての無音を消すのではなく、自然な長さを残している）
  const shortened = chosen.reduce((n, u) => n + Math.max(0, u.pieces.length - 1), 0);
  if (shortened) parts.push(`話の途中の長い間${shortened}か所を、自然な長さ（約${state.brief?.style === 'tempo' ? '0.25〜0.35' : '0.3〜0.45'}秒）に縮めました。`);
  if (state.chunks) {
    parts.push(`文字起こし: ${state.chunks.length}件。`);
    if (state.scriptAlign) parts.push(`字幕は入力した原稿の文字を使い、音声に合わせました（一致 ${Math.round(state.scriptAlign.matched * 100)}%）。`);
    else {
      const n = chosen.filter(u => u.check?.length && u.text === u.aiText).length;
      if (n) parts.push(`字幕のうち${n}場面に、聞き取りに自信のない言葉があります（オレンジ色の枠）。`);
    }
  } else parts.push('字幕なしで構成しました。');
  if (!state.src.audio) parts.push('音声がないため、手元の動きだけで選びました。');
  $('summary').textContent = parts.join('');
  $('subTools').hidden = !state.chunks;
  showOffset();
  // 冒頭のテキスト（動画タイトルから作った案。直せる）
  if (state.opening === undefined) state.opening = state.job?.review?.opening ?? openingLines(state.brief?.title).join('\n');
  $('openingText').value = state.opening;
  if (state.job?.review?.openingOn !== undefined) $('optOpening').checked = state.job.review.openingOn;
  if (state.job?.review?.openingDur) $('openingDur').value = String(state.job.review.openingDur);
  $('openingNote').textContent = state.brief?.title ? '' : '（動画タイトルを入力すると、案を作ります）';
  $('subSaved').textContent = state.restoredEdits ? `前回の字幕の修正を読み込みました（${state.restoredEdits}か所）` : '';
  $('optSubs').disabled = !state.chunks;
  $('optSubsNote').textContent = state.chunks ? '' : '（文字起こしをしていないため使えません）';
  const warns = [...(state.warnings || []), ...(state.briefWarnings || [])];
  $('warnings').textContent = warns.join('\n');
  $('warnings').hidden = !warns.length;
  const fit = state.fit;
  if (fit) {
    $('fit').className = 'fit ' + (fit.ok ? 'ok' : 'ng');
    $('fit').textContent = fit.ok
      ? `目標 ${fmt(fit.targetSec)} → 完成予定 約${fmt(fit.planned)}`
      : `目標 ${fmt(fit.targetSec)} → 完成予定 約${fmt(fit.planned)}\n${fit.reason}`;
    $('fit').hidden = false;
  }
  $('briefUsed').textContent = (state.briefUsed || []).join('\n');
  $('briefUsed').hidden = !(state.briefUsed || []).length;
  updateTotal();
  $('stepReview').hidden = false;
  $('stepReview').scrollIntoView({ behavior: 'smooth' });
}

// 選んだ場面の話し声の大きさから、音量の補正量を決める
function computeGainDb(clips) {
  const { rmsDb, speech } = state;
  if (!rmsDb || !state.src.audio || !speech.regions.length) return 0;
  let sum = 0, n = 0;
  for (const c of clips) for (const p of c.pieces) {
    for (let f = Math.floor(p.start / FRAME_SEC); f < Math.ceil(p.end / FRAME_SEC) && f < rmsDb.length; f++) {
      if (rmsDb[f] > speech.threshold) { sum += Math.pow(10, rmsDb[f] / 10); n++; }
    }
  }
  if (!n) return 0;
  const level = 10 * Math.log10(sum / n);
  return Math.max(-6, Math.min(12, -20 - level));
}

// ---------- 4. 書き出し ----------
// 構成の確認画面で選んだ場面を保存する（再開したときに同じ選択に戻す）
let reviewTimer = null;
function saveReview() {
  const job = state.job;
  if (!job || job.stage !== 'review') return;
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(() => {
    job.review = { selected: [...state.selected], brief: readBrief(), trims: { ...state.trims }, opening: state.opening, openingOn: $('optOpening').checked, openingDur: openingDur() };
    job.brief = job.review.brief;
    persistJob(job);
  }, 300);
}

// 「この内容でMP4を書き出す」: 書き出す内容（タイムライン）を決めて保存し、区間ごとに書き出す
$('btnRender').addEventListener('click', async () => {
  const clips = state.units.filter(u => state.selected.has(u.id));
  if (!clips.length || !state.job) return;
  const useSubs = !!state.chunks && $('optSubs').checked;
  const useZoom = $('optZoom').checked;
  setBreakTerms(briefPlan(readBrief()).items);
  // 最後の場面は、話し終わりの後を少し延ばしてからフェードアウトする（声にフェードがかからないように）
  const shaped = extendEnding(clips.map(u => ({ ...u, text: state.chunks ? u.text : '', ...shifted(u, state.subOffset) })), state.speech?.voice, state.src.duration);
  const timeline = buildTimeline(shaped, {
    srcW: state.src.width, srcH: state.src.height, zoom: useZoom, subtitles: useSubs, style: state.brief?.style,
  });
  const outSec = timeline.reduce((s, c) => s + c.outDuration, 0);
  // 冒頭のテキスト（標準2秒・選べる）と最後のフェードアウト（0.9秒＋黒い画面0.3秒）
  const lines = $('optOpening').checked ? openingText(state.opening ?? '') : [];
  const overlay = { opening: openingPlan(lines, openingDur(), timeline[0]), total: outSec };
  // 保存できる容量を確かめる（区間のファイルと完成したMP4が一時的に両方必要）
  const need = renderBytes(outSec).total;
  const sc = spaceCheck(await storageInfo(), need);
  if (!sc.ok) {
    showError($('renderError'), `端末内に保存できる容量が足りません（必要 約${formatBytes(need)}・空き 約${formatBytes(sc.free)}）。iPhoneの空き容量を増やすか、上の「途中の編集」から使わない保存データを削除してから、もう一度お試しください。`);
    return;
  }
  const job = state.job;
  for (const f of await listFiles(job.id)) if (/^seg-|^output/.test(f.name)) await removeFile(job.id, f.name);
  const segments = planSegments(timeline);
  job.stage = 'render';
  job.review = { selected: [...state.selected], brief: readBrief(), trims: { ...state.trims }, opening: state.opening, openingOn: $('optOpening').checked, openingDur: openingDur() };
  job.render = {
    timeline, segments, done: segments.map(() => false), gainDb: computeGainDb(clips), overlay, endFade: END_FADE, endHold: END_HOLD,
    styleNote: styleSummary(timeline, useSubs, useZoom, overlay), outSec, startedAt: Date.now(), elapsed: 0, sessions: 0,
  };
  job.output = null;
  log('演出', job.render.styleNote);
  log('書き出しの区間', { segments: segments.length, outSec: +outSec.toFixed(1), needMB: Math.round(need / MB), knownSpace: sc.known });
  await persistJob(job);
  await runRender(job);
});

// 区間ごとの書き出しと仕上げ。保存済みの区間はやり直さない
async function runRender(job) {
  const R = job.render;
  $('renderError').hidden = true;
  $('globalError').hidden = true;
  $('stepResult').hidden = true;
  $('btnRender').disabled = true;
  $('btnAnalyze').disabled = true;
  $('file').disabled = true;
  $('resumeCard').hidden = true;
  $('renderBar').hidden = false;
  unloadVideo($('preview'));
  unloadVideo($('clipPreview'));
  unloadVideo($('outVideo'));
  if (state.outUrl) { URL.revokeObjectURL(state.outUrl); state.outUrl = null; }
  state.blob = null;
  state.timeline = R.timeline;
  state.styleNote = R.styleNote;
  const bar = $('renderBar').firstElementChild;
  // 保存済みのはずの区間が消えていないか確かめる（消えていたら、その区間だけ書き出し直す）
  for (const seg of R.segments) {
    if (!R.done[seg.index]) continue;
    const f = await readFile(job.id, `seg-${seg.index}.mp4`);
    if (!f || !f.size) { R.done[seg.index] = false; log(`保存した区間 ${seg.index + 1} が見つからないため書き出し直します`); }
  }
  const total = R.segments.reduce((s, x) => s + x.frames, 0);
  const doneFrames = () => R.segments.filter((x, i) => R.done[i]).reduce((s, x) => s + x.frames, 0);
  const reused = R.done.filter(Boolean).length;
  R.sessions = (R.sessions || 0) + 1;
  jobStart('書き出し', {
    file: job.file.name, segments: R.segments.length, reused, session: R.sessions, video: state.src.info, audioMode: getAudioMode(),
    decoder: state.src.decoderConfig?.codec, openedFrom: OPENED_FROM, writeMode: getWriteMode(), sourceFromStore: !!state.sourceFromStore,
  });
  jobStage('render', STAGE_LABELS.render);
  if (reused) log(`保存済みの区間を再利用: ${reused}/${R.segments.length}`);
  const lock = await keepAwake();
  const t0 = performance.now();
  const show = (ratio, text) => {
    bar.style.width = Math.round(ratio * 100) + '%';
    $('renderText').textContent = text;
    jobProgress(ratio);
  };
  try {
    // 1. 映像を区間ごとに書き出して保存する
    const rc = createRenderContext(state.src);
    // 失敗したときのやり直し方（1回目: 同じ設定で作り直したデコーダー、2回目: 低遅延モードなし・1つ前のキーフレームから）
    const DECODE_MODES = [{}, {}, { lowLatency: false, earlierKey: true }];
    R.failures = R.failures || [];
    for (const seg of R.segments) {
      if (R.done[seg.index]) continue;
      const name = `seg-${seg.index}.mp4`;
      for (let attempt = 0; ; ) {
        await waitVisible(); // 画面に出ていない間は始めない（iPhone は裏でデコーダーを止める）
        const hiddenBefore = state.hiddenCount;
        await removeFile(job.id, name);
        const w = await openWritable(job.id, name);
        try {
          await renderSegment(state.src, R.timeline, seg, w.stream, {
            rc, decode: DECODE_MODES[attempt], overlay: R.overlay,
            shouldPause: () => document.hidden,
            onProgress: r => {
              const all = (doneFrames() + r * seg.frames) / total;
              show(all * 0.92, `MP4を書き出し中… ${Math.round(all * 92)}%（区間 ${seg.index + 1}/${R.segments.length}・書き終えた区間は端末内に保存済み）`);
            },
          });
          break;
        } catch (err) {
          await w.dispose();
          await removeFile(job.id, name);
          // 画面を離れた: 失敗ではない。戻ってきたら、この区間を最初から書き出し直す
          if (err instanceof RenderPaused || (state.hiddenCount !== hiddenBefore && !isStorageFull(err))) {
            log(`区間 ${seg.index + 1} を一時停止（画面を離れたため）。戻ったら書き出し直します`, err instanceof RenderPaused ? undefined : errorText(err));
            show(doneFrames() / total * 0.92, '一時停止中…（画面に戻ると、この区間から書き出しを続けます）');
            continue;
          }
          // 原因を調べられるよう、失敗した区間・コマの位置・入力の形式・デコーダーの状態を記録する
          const failure = { at: new Date().toISOString(), attempt, error: errorText(err), detail: err.detail || null, codec: state.src.info.video, decoder: state.src.decoderConfig?.codec };
          R.failures.push(failure);
          if (R.failures.length > 20) R.failures.splice(0, R.failures.length - 20);
          log(`区間 ${seg.index + 1} の書き出しに失敗（${attempt + 1}回目）`, failure);
          await persistJob(job);
          if (isStorageFull(err) || attempt >= DECODE_MODES.length - 1) throw Object.assign(err, { segment: seg.index });
          attempt++;
          await new Promise(r => setTimeout(r, 500)); // 使い終わったデコーダー・エンコーダーが解放されるのを少し待つ
        }
      }
      R.done[seg.index] = true;
      await persistJob(job);
    }
    // 2. 区間をつないで音声を入れ、完成したMP4にする
    job.stage = 'assemble';
    await persistJob(job);
    show(0.92, 'MP4を仕上げ中…（区間をつないで音声を入れています）');
    for (;;) {
      await waitVisible();
      const hiddenBefore = state.hiddenCount;
      await removeFile(job.id, OUTPUT_NAME);
      const w = await openWritable(job.id, OUTPUT_NAME);
      try {
        await assembleOutput(state.src, R.timeline, R.segments, i => readFile(job.id, `seg-${i}.mp4`), w.stream, {
          gainDb: R.gainDb, endFade: R.endFade || 0, endHold: R.endHold || 0,
          onProgress: r => show(0.92 + 0.08 * r, `MP4を仕上げ中… ${Math.round(92 + 8 * r)}%`),
        });
        break;
      } catch (err) {
        await w.dispose();
        await removeFile(job.id, OUTPUT_NAME);
        // 画面を離れていた間に音声のエンコーダーが止められた: 戻ってから仕上げだけやり直す（区間は残っている）
        if (state.hiddenCount !== hiddenBefore && !isStorageFull(err) && err.name !== 'SegmentMismatch') {
          log('仕上げを一時停止（画面を離れたため）。戻ったらやり直します', errorText(err));
          continue;
        }
        R.failures = [...(R.failures || []), { at: new Date().toISOString(), stage: 'assemble', error: errorText(err) }].slice(-20);
        log('仕上げに失敗', errorText(err));
        throw err;
      }
    }
    const out = await readFile(job.id, OUTPUT_NAME);
    for (const seg of R.segments) await removeFile(job.id, `seg-${seg.index}.mp4`);
    R.elapsed = (R.elapsed || 0) + (performance.now() - t0) / 1000;
    job.stage = 'done';
    job.output = { size: out.size, finishedAt: Date.now() };
    await persistJob(job);
    show(1, `書き出し完了（${formatSec((performance.now() - t0) / 1000)}${R.sessions > 1 ? `・${R.sessions}回に分けて処理、保存済みの区間 ${reused}個を再利用` : ''}）`);
    jobEnd('done');
    log('書き出し完了', { sizeMB: +(out.size / 1e6).toFixed(1), sec: Math.round((performance.now() - t0) / 1000), sessions: R.sessions, reused });
    showResult(out, R.timeline);
  } catch (err) {
    jobEnd('error', err);
    R.elapsed = (R.elapsed || 0) + (performance.now() - t0) / 1000;
    await persistJob(job);
    if (isStorageFull(err)) {
      showError($('renderError'), `端末内の空き容量が足りなくなったため、書き出しを一時停止しました。書き終えた区間（${R.done.filter(Boolean).length}/${R.segments.length}）は保存してあります。iPhoneの空き容量を増やしてから、上の「途中の編集」の「続きから再開」を押してください。`);
    } else if (err.name === 'SegmentMismatch') {
      // 区間ごとの映像の形式が違う端末では、区間に分けずに書き出し直す（途中から再開はできない）
      log('区間をつなげないため、区間に分けずに書き出し直します', errorText(err));
      for (const seg of R.segments) await removeFile(job.id, `seg-${seg.index}.mp4`);
      R.segments = planSegments(R.timeline, Infinity);
      R.done = R.segments.map(() => false);
      R.single = true;
      job.stage = 'render';
      await persistJob(job);
      return runRender(job);
    } else {
      const seg = err.segment != null ? `区間 ${err.segment + 1}/${R.segments.length} の` : '';
      showError($('renderError'), `${seg}書き出しに失敗しました（${errorText(err)}）。\n書き終えた区間（${R.done.filter(Boolean).length}/${R.segments.length}）と編集の設定は端末内に保存してあります。上の「途中の編集」の「続きから再開」で、失敗した区間からやり直せます。\n何度も同じ所で失敗する場合は、下の「診断情報」をコピーして送ってください（失敗した区間・コマの位置・動画の形式を記録しています）。`);
    }
    $('renderText').textContent = '';
  } finally {
    $('btnRender').disabled = false;
    $('btnAnalyze').disabled = false;
    $('file').disabled = false;
    $('preview').src = state.url;
    lock?.release?.();
    refreshJobs();
  }
}

function showResult(file, timeline) {
  const last = timeline[timeline.length - 1];
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  state.outName = `amity-short-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.mp4`;
  state.blob = file;
  state.outUrl = URL.createObjectURL(file);
  $('outVideo').src = state.outUrl;
  $('outDuration').textContent = formatSec(last.outStart + last.outDuration);
  $('outSize').textContent = formatSize(file.size);
  $('outStyle').textContent = state.styleNote || '-';
  $('btnDownload').href = state.outUrl;
  $('btnDownload').download = state.outName;
  $('stepResult').hidden = false;
  $('stepResult').scrollIntoView({ behavior: 'smooth' });
}

$('btnSave').addEventListener('click', async () => {
  if (!state.blob) return;
  // 端末内に保存した完成ファイル。中身はディスク上にあり、メモリに読み込まずに共有メニューへ渡す
  const file = new File([state.blob], state.outName, { type: 'video/mp4' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      log('共有メニューから保存');
    } catch (err) {
      if (err.name !== 'AbortError') {
        log('共有に失敗。ダウンロードに切り替え', errorText(err));
        $('btnDownload').click();
      }
    }
  } else {
    $('btnDownload').click();
  }
});

// ---------- 途中の編集（端末内に保存した作業）の表示と再開 ----------

function showNotice(msg) {
  $('notice').textContent = msg;
  $('notice').hidden = !msg;
}

// 保存してある作業の続きをする。reselected: 元の動画を選び直してもらった（すでに開いてある）
async function continueJob(job, { reselected = false } = {}) {
  state.pendingResume = null;
  $('resumeNeedFile').hidden = true;
  if (!reselected) {
    const f = job.sourceSaved ? await readFile(job.id, SOURCE_NAME) : null;
    if (!f || f.size !== job.file.size) {
      // 元の動画のコピーがない（保存しなかった・消えた）: 同じ動画を選び直してもらう
      state.pendingResume = job;
      job.sourceSaved = false;
      $('resumeNeedFile').textContent = `続きから再開するには、同じ動画（${job.file.name}・${formatSize(job.file.size)}）を「1. 動画を選ぶ」でもう一度選んでください。保存済みの解析・書き出しの結果はそのまま使います。`;
      $('resumeNeedFile').hidden = false;
      $('file').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    await loadSource(new File([f], job.file.name, { type: job.file.type || 'video/quicktime' }), { preview: !['render', 'assemble'].includes(job.stage) });
    if (!state.src) return;
    state.sourceFromStore = true;
  }
  log('保存してある作業を再開', { stage: job.stage, id: job.id });
  state.job = job;
  if (job.stage === 'analyze') return runAnalysis(job);

  // 解析は終わっている: 保存した結果から構成を作り直し、選んだ場面を戻す
  const A = job.analysis;
  state.rmsDb = A.audio?.rmsDb || new Float32Array(Math.ceil(state.src.duration / FRAME_SEC));
  state.speech = A.audio?.rmsDb ? detectSpeech(state.rmsDb) : { regions: [], voice: [], threshold: 0 };
  state.chunks = A.asr?.done ? A.asr.chunks : null;
  state.motion = A.motion?.data || null;
  state.warnings = A.warnings || [];
  const brief = normalizeBrief(job.review?.brief || job.brief);
  writeBrief(brief);
  makePlan(brief);
  if (job.review?.selected) {
    const ids = new Set(state.units.map(u => u.id));
    state.selected = new Set(job.review.selected.filter(id => ids.has(id)));
  }
  // 確認画面で「元に戻す」「取り除く」を選んだ場面を戻す
  for (const [id, v] of Object.entries(job.review?.trims || {})) {
    const u = state.units.find(x => x.id === id);
    if (!u) continue;
    const untouched = u.text === u.aiText;
    if (v === 'off' && u.trimmed) untrimUnit(u);
    if (v === 'on' && !u.trimmed && u.trimOption) trimUnit(u, u.trimOption);
    if (untouched) u.aiText = u.text;
    state.trims[id] = v;
  }
  showReview();
  if (job.stage === 'render' || job.stage === 'assemble') return runRender(job);
  if (job.stage === 'done') {
    const out = await readFile(job.id, OUTPUT_NAME);
    if (out && out.size) { state.styleNote = job.render?.styleNote; showResult(out, job.render.timeline); return; }
    showError($('renderError'), '完成した動画の保存データが見つかりませんでした（端末の空き容量不足などで消えた可能性があります）。構成はそのままなので、もう一度「この内容でMP4を書き出す」を押してください。');
    job.stage = 'review';
    job.output = null;
    await persistJob(job);
  }
}

// 画面上部の「途中の編集」を作る
async function refreshJobs() {
  let jobs = [], readError = null;
  try { jobs = (await listJobs()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); } catch (err) {
    readError = errorText(err);
    log('保存データを読み込めませんでした', readError);
  }
  const list = $('jobList');
  list.innerHTML = '';
  $('resumeContext').textContent = `今は${FROM_LABEL[OPENED_FROM]}で開いています。iPhoneでは、Safariとホーム画面に追加したアプリは保存場所が別なので、` +
    '途中から再開するときは、編集を始めたときと同じ方法（Safari／ホーム画面のアイコン）で開いてください。';
  // 控えの一覧にあるのに読めない作業: 理由を表示する（勝手に消さない）
  const idx = loadJSON(JOB_INDEX_KEY) || {};
  const missing = Object.values(idx).filter(e => !jobs.some(j => j.id === e.id));
  if (missing.length) log('復元できなかった作業', missing.map(e => ({ name: e.name, stage: e.stage, saved: e.saved, saveError: e.saveError, readError })));
  for (const e of missing) {
    const item = document.createElement('div');
    item.className = 'job';
    const head = document.createElement('div');
    head.className = 'job-head';
    head.textContent = `${e.name}（${formatSec(e.duration || 0)}）・続きから再開できません`;
    const meta = document.createElement('div');
    meta.className = 'job-meta';
    meta.textContent = readError
      ? `保存データを読み込めませんでした（${readError}）。`
      : e.saveError
        ? `途中経過の保存に失敗していました（${e.saveError}）。`
        : '保存データが見つかりませんでした（iPhoneの空き容量不足や「履歴とWebサイトデータを消去」で消えた可能性があります）。';
    meta.textContent += ' 元の動画からもう一度編集してください。';
    const btns = document.createElement('div');
    btns.className = 'job-btns';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small secondary';
    b.textContent = 'この表示を消す';
    b.addEventListener('click', () => { indexJob(null, e.id); refreshJobs(); });
    btns.appendChild(b);
    item.append(head, meta, btns);
    list.appendChild(item);
  }
  $('resumeCard').hidden = !jobs.length && !missing.length;
  if (!jobs.length) return;
  // 途中の編集が保存してあるときは、そちらの表示（端末内に保存した確かな状態）を使う。
  // 「前回止まった段階」の記録（localStorage）は、強制終了の直前の分が残らないことがあるため
  if (previousJob && jobs.some(j => j.stage !== 'done')) $('recover').hidden = true;
  const busy = $('btnAnalyze').disabled && !$('stepAnalyze').hidden || $('btnRender').disabled && !$('stepReview').hidden;
  for (const job of jobs) {
    const d = describeJob(job);
    const files = await listFiles(job.id);
    const bytes = files.reduce((s, f) => s + f.size, 0);
    const item = document.createElement('div');
    item.className = 'job';
    const head = document.createElement('div');
    head.className = 'job-head';
    const when = new Date(job.updatedAt || job.createdAt);
    head.textContent = `${job.file.name}（${formatSec(job.duration)}）・${d.stage}${job.stage === 'done' ? '' : ` ${d.percent}%`}`;
    const meta = document.createElement('div');
    meta.className = 'job-meta';
    meta.textContent = `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')} 保存・端末内の使用量 約${formatBytes(bytes)}${job.sourceSaved ? '' : '・元の動画は保存していません（再開時に選び直し）'}`;
    const lines = document.createElement('ul');
    lines.className = 'job-lines';
    for (const l of d.lines) { const li = document.createElement('li'); li.textContent = l; lines.appendChild(li); }
    const btns = document.createElement('div');
    btns.className = 'job-btns';
    const mk = (label, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small ' + cls;
      b.textContent = label;
      b.disabled = busy;
      b.addEventListener('click', fn);
      btns.appendChild(b);
      return b;
    };
    if (job.stage === 'done') mk('完成した動画を開く', '', () => continueJob(job));
    else mk('続きから再開', '', () => continueJob(job));
    if (job.stage === 'analyze' && job.useAsr && !job.analysis?.asr?.done) {
      // 文字起こしの途中で何度も止まる（メモリ不足）ときのため
      mk('字幕なしで再開', 'secondary', () => {
        job.useAsr = false;
        job.analysis.asr = { ...(job.analysis.asr || {}), failed: true };
        job.analysis.warnings = [...(job.analysis.warnings || []), '字幕なしで再開したため、字幕・言い直し検出なしで構成しました。'];
        continueJob(job);
      });
    }
    mk('保存データを削除', 'secondary', async () => {
      if (!confirm(`「${job.file.name}」の途中の編集と保存データ（約${formatBytes(bytes)}）を削除しますか？\n元の動画（写真アプリ）は消えません。`)) return;
      await deleteJob(job.id);
      indexJob(null, job.id);
      if (state.job?.id === job.id) state.job = null;
      refreshJobs();
    });
    item.append(head, meta, lines, btns);
    list.appendChild(item);
  }
  const info = await storageInfo();
  $('storageText').textContent = info.usage != null
    ? `このサイトの保存データ: 約${formatBytes(info.usage)}（保存できる上限の目安 約${formatBytes(info.quota)}）${info.persisted ? '・消されにくい設定が有効' : ''}`
    : '';
}

refreshJobs();

// 完成した動画をiPhoneに保存した後に、端末内の保存データ（元の動画のコピー・完成したMP4）を消す
$('btnCleanup').addEventListener('click', async () => {
  const job = state.job;
  if (!job) return;
  if (!confirm('端末内に保存してある、この編集のデータ（元の動画のコピー・完成したMP4）を削除しますか？\n「iPhoneに保存」を済ませてから押してください。元の動画（写真アプリ）は消えません。')) return;
  unloadVideo($('outVideo'));
  if (state.outUrl) { URL.revokeObjectURL(state.outUrl); state.outUrl = null; }
  state.blob = null;
  await deleteJob(job.id);
  indexJob(null, job.id);
  state.job = null;
  $('stepResult').hidden = true;
  showNotice('端末内の保存データを削除しました。');
  refreshJobs();
});
