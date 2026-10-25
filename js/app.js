import {
  checkSupport, openVideo, closeVideo, analyzeAudio, analyzeMotion, renderShort, getAudioMode, ASR_RATE,
} from './media.js';
import {
  detectSpeech, transcriptionWindows, buildUnits, selectUnits, buildTimeline, formatTime, FRAME_SEC,
  cleanSubtitle, alignSentences, refineSubtitleTiming, fineSpeech,
} from './plan.js';
import {
  previousJob, log, setEnv, jobStart, jobStage, jobProgress, jobEnd, report, clearLogs, errorText,
} from './diag.js';
import { STEP, videoKey, nudge, collectEdits, applyEdits, resetEdits, shifted, formatClock } from './subedit.js';
import {
  FORMATS, EMPTY_BRIEF, normalizeBrief, hasText, briefPlan, applyBrief, applyStyle, targetRange, fitReport, fmt,
} from './brief.js';

const $ = id => document.getElementById(id);
const state = {};
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

if (previousJob) {
  const j = previousJob;
  const label = j.label || STAGE_LABELS[j.stage] || j.stage || '開始直後';
  const file = j.info && j.info.file ? `（${j.info.file}）` : '';
  const lines = [
    `前回の処理は「${label}${j.progress ? ' ' + j.progress + '%' : ''}」の途中で止まり、ページが再読み込みされました${file}。`,
    'iPhoneのメモリが足りなくなった可能性が高いです。',
  ];
  if (j.stage === 'asr') {
    lines.push('字幕（文字起こし）の途中で止まったため、字幕をOFFにしました。まずは字幕なしでお試しください。');
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
const TEXT_FIELDS = { title: 'bTitle', content: 'bContent', message: 'bMessage', flow: 'bFlow', mustKeep: 'bMust' };

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

  $('preview').src = state.url;
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
  }
});

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

function transcribe(pcm, windows, terms = []) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('js/transcribe-worker.js', { type: 'module' });
    const files = new Map();
    const chunks = [];
    let i = 0;
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
      if (i >= windows.length) return finish(resolve, chunks);
      const w = windows[i];
      const from = Math.max(0, Math.floor((w.start - 0.2) * ASR_RATE));
      const to = Math.min(pcm.length, Math.ceil((w.end + 0.2) * ASR_RATE));
      const audio = pcm.slice(from, to);
      worker.postMessage({ type: 'run', id: i, audio, offset: from / ASR_RATE }, [audio.buffer]);
      setProgress(i / windows.length, `文字起こし中… ${i + 1} / ${windows.length}`);
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
        setEnv('文字起こしモデル', `${ASR_MODEL}（${m.device}）${m.sessions}`);
        next();
      } else if (m.type === 'result') {
        const w = windows[m.id];
        const fixes = m.chunks.flatMap(c => c.fixes || []);
        log(`文字起こし ${m.id + 1}/${windows.length}`, {
          chunks: m.chunks.length,
          fixes: fixes.map(f => f.error ? '確認できず: ' + f.error : `${f.from}→${f.to} ${f.ok ? '採用' : '見送り'}(${f.delta})`),
        });
        const offset = Math.max(0, w.start - 0.2);
        for (const c of m.chunks) {
          const start = offset + c.start, end = Math.min(offset + c.end, w.end + 0.2);
          const text = cleanSubtitle(c.text);
          // つなぎ言葉だけの発言（えーと 等）も残す。場面の候補では「つなぎ言葉のみ」として除外される
          // （残さないと、文字起こしのない声として構成に入ってしまう）
          if (end > start && (text || (c.raw || c.text || '').trim())) chunks.push({ start, end, text, raw: c.raw ?? c.text, timed: c.timed });
        }
        i++;
        next();
      } else if (m.type === 'error') {
        finish(reject, new Error(m.message));
      }
    };
    worker.onerror = e => finish(reject, new Error(e.message || '文字起こしの準備に失敗しました（ネットワークを確認してください）'));
    setProgress(0, 'AIモデルを準備中…');
    worker.postMessage({ type: 'load', model: ASR_MODEL, terms });
  });
}

$('btnAnalyze').addEventListener('click', async () => {
  const src = state.src;
  if (!src) return;
  const useAsr = $('optAsr').checked && !!src.audio;
  const brief = readBrief();
  const bp = briefPlan(brief);
  $('btnReplan').hidden = true;
  $('analyzeError').hidden = true;
  $('globalError').hidden = true;
  $('stepReview').hidden = true;
  $('stepResult').hidden = true;
  $('btnAnalyze').disabled = true;
  $('file').disabled = true;
  unloadVideo($('preview'));
  unloadVideo($('clipPreview'));
  setupSteps([
    { key: 'audio', label: '音声を読み込み、無音を探す' },
    { key: 'asr', label: '文字起こし（字幕・言い直し）' },
    { key: 'motion', label: '手元の動きを解析する' },
    { key: 'plan', label: `約${fmt(brief.targetSec)}の構成を作る` },
  ]);
  jobStart('解析', {
    file: state.file.name, sizeMB: +(state.file.size / 1e6).toFixed(1), asr: useAsr, model: useAsr ? ASR_MODEL : null, video: src.info,
    brief: { format: brief.format, targetSec: brief.targetSec, style: brief.style, text: hasText(brief), must: bp.mustItems.length, asrTerms: bp.asrTerms.length },
  });
  const lock = await keepAwake();
  const t0 = performance.now();
  const warnings = [];
  try {
    // 音声（失敗しても動きだけで続ける）
    setStep('audio', 'active');
    let pcm = null;
    state.rmsDb = null;
    if (src.audio) {
      try {
        const a = await analyzeAudio(src, r => setProgress(r, `音声を読み込み中… ${Math.round(r * 100)}%`));
        state.rmsDb = a.rmsDb;
        pcm = a.pcm;
        state.speech = detectSpeech(a.rmsDb);
        log('音声の解析完了', { mode: getAudioMode(), speechRegions: state.speech.regions.length, sounds: state.speech.sounds?.length ?? 0 });
        setStep('audio', 'done');
      } catch (err) {
        log('音声の解析に失敗', errorText(err));
        warnings.push('音声を読み込めなかったため、無音カットなし（手元の動きだけ）で構成しました（' + errorText(err) + '）。');
        setStep('audio', 'warn', '失敗');
      }
    } else {
      setStep('audio', 'skip', '音声なし');
    }
    if (!state.rmsDb) {
      state.rmsDb = new Float32Array(Math.ceil(src.duration / FRAME_SEC));
      state.speech = { regions: [], threshold: 0 };
    }

    // 文字起こし（失敗しても続ける）
    state.chunks = null;
    if (useAsr && pcm && state.speech.regions.length) {
      setStep('asr', 'active');
      try {
        // 文ごとの時刻は、無音の切れ目に合わせて割り当て直す
        const sentences = alignSentences(await transcribe(pcm, transcriptionWindows(state.speech.regions), bp.asrTerms), state.speech.regions);
        // 字幕の表示時刻を、実際の声の出始め・終わりに合わせる（自動カットの区切りは変えない）
        state.chunks = refineSubtitleTiming(sentences, fineSpeech(state.rmsDb, state.speech.threshold));
        setStep('asr', 'done');
      } catch (err) {
        log('文字起こしに失敗', errorText(err));
        warnings.push('文字起こしができなかったため、字幕なし・言い直し検出なしで構成しました（' + errorText(err) + '）。');
        setStep('asr', 'warn', '失敗・字幕なしで続行');
      }
    } else {
      setStep('asr', 'skip', useAsr ? '話し声なし' : 'OFF');
    }
    pcm = null; // 文字起こし用の音声はここで手放す

    // 手元の動き（失敗しても音声だけで続ける）
    setStep('motion', 'active');
    try {
      state.motion = await analyzeMotion(src, r => setProgress(r, `手元の動きを解析中… ${Math.round(r * 100)}%`));
      setStep('motion', 'done');
    } catch (err) {
      log('動きの解析に失敗', errorText(err));
      state.motion = null;
      warnings.push('映像の動きを解析できなかったため、音声だけで構成しました（' + errorText(err) + '）。');
      setStep('motion', 'warn', '失敗');
    }

    setStep('plan', 'active');
    state.warnings = warnings;
    makePlan(brief);
    if (!state.selected.size) throw new Error('使える場面が見つかりませんでした。音声と映像の両方を読み込めなかった可能性があります。');
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
  }
});

// 解析結果（音声・文字起こし・動き）と入力内容から構成を作る。入力を変えたときは解析し直さずにこれだけ行う
function makePlan(brief) {
  const src = state.src;
  const bp = briefPlan(brief);
  state.brief = bp.brief;
  state.units = buildUnits({
    duration: src.duration, rmsDb: state.rmsDb, speech: state.speech, chunks: state.chunks, motion: state.motion,
    pace: bp.brief.style === 'tempo' ? 'tempo' : 'natural',
  });
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
  state.briefUsed = used;
  state.briefWarnings = [];
  if (bp.mustItems.length && !state.chunks) state.briefWarnings.push('「必ず残したい説明や場面」は文字起こし（字幕）をONにしたときだけ照合できます。今回は照合していません。');
  else if (must.some(m => !m.unit)) state.briefWarnings.push('「必ず残したい説明や場面」の一部に合う発言が見つかりませんでした。下の「ほかの候補」から選んでください。');
  log('構成', { targetSec: bp.brief.targetSec, planned: +state.fit.planned.toFixed(1), ok: state.fit.ok, must: must.map(m => !!m.unit), style: bp.brief.style });
  // 同じ動画で前に直した字幕があれば当てはめる
  const saved = loadSubEdits();
  state.subOffset = saved?.offset || 0;
  state.restoredEdits = applyEdits(state.units, saved);
}

$('btnReplan').addEventListener('click', () => {
  if (!state.units) return;
  makePlan(readBrief());
  $('btnReplan').hidden = true;
  showReview();
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
  const reasons = [u.excluded, ...u.reasons].filter(Boolean);
  if (reasons.length) {
    const r = document.createElement('div');
    r.className = 'reasons';
    r.textContent = reasons.join(' / ');
    div.appendChild(r);
  }
  if (u.kind === 'speech' && state.chunks) div.appendChild(subtitleEditor(u));
  return div;
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
  ta.addEventListener('input', () => { u.text = ta.value; saveSubEdits(); });
  box.appendChild(ta);
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
  const total = state.units.filter(u => state.selected.has(u.id)).reduce((s, u) => s + u.duration, 0);
  const target = state.brief?.targetSec ?? 60;
  const el = $('total');
  el.textContent = `合計 ${total.toFixed(1)}秒（${state.selected.size}場面）・目標 ${fmt(target)}` + (total > target + 0.5 ? ' ― 目標を超えています' : '');
  el.classList.toggle('over', total > target + 0.5);
  $('btnRender').disabled = state.selected.size === 0;
}

function styleSummary(timeline, useSubs, useZoom) {
  const parts = [];
  if (useSubs) {
    const top = timeline.filter(c => c.subtitles.length && c.subPos === 'top').length;
    const all = timeline.filter(c => c.subtitles.length).length;
    parts.push(`字幕: ${all}場面（${top ? `手元に重ならないよう${top}場面は上、ほかは下` : 'すべて下'}）`);
  } else {
    parts.push('字幕: なし');
  }
  if (useZoom) {
    const z = timeline.filter(c => c.zoom);
    parts.push(z.length ? `ズーム: ${z.length}か所（${z.map(c => formatTime(c.outStart) + ' ' + c.zoom.z.toFixed(2) + '倍').join('、')}）` : 'ズーム: 合う場面がなかったため なし');
  } else {
    parts.push('ズーム: なし');
  }
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
  if (shortened) parts.push(`話の途中の長い間${shortened}か所を、自然な長さ（約${state.brief?.style === 'tempo' ? '0.3〜0.45' : '0.4〜0.6'}秒）に縮めました。`);
  if (state.chunks) parts.push(`文字起こし: ${state.chunks.length}件。`);
  else parts.push('字幕なしで構成しました。');
  if (!state.src.audio) parts.push('音声がないため、手元の動きだけで選びました。');
  $('summary').textContent = parts.join('');
  $('subTools').hidden = !state.chunks;
  showOffset();
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
$('btnRender').addEventListener('click', async () => {
  const clips = state.units.filter(u => state.selected.has(u.id));
  if (!clips.length) return;
  $('renderError').hidden = true;
  $('globalError').hidden = true;
  $('stepResult').hidden = true;
  $('btnRender').disabled = true;
  $('btnAnalyze').disabled = true;
  $('file').disabled = true;
  $('renderBar').hidden = false;
  unloadVideo($('preview'));
  unloadVideo($('clipPreview'));
  unloadVideo($('outVideo'));
  if (state.outUrl) { URL.revokeObjectURL(state.outUrl); state.outUrl = null; }
  state.blob = null;
  const bar = $('renderBar').firstElementChild;
  jobStart('書き出し', { file: state.file.name, clips: clips.length, video: state.src.info, audioMode: getAudioMode() });
  jobStage('render', STAGE_LABELS.render);
  const lock = await keepAwake();
  const t0 = performance.now();
  try {
    const useSubs = !!state.chunks && $('optSubs').checked;
    const useZoom = $('optZoom').checked;
    const timeline = buildTimeline(clips.map(u => ({ ...u, text: state.chunks ? u.text : '', ...shifted(u, state.subOffset) })), {
      srcW: state.src.width, srcH: state.src.height, zoom: useZoom, subtitles: useSubs, style: state.brief?.style,
    });
    state.timeline = timeline;
    state.styleNote = styleSummary(timeline, useSubs, useZoom);
    log('演出', state.styleNote);
    const blob = await renderShort(state.src, timeline, {
      gainDb: computeGainDb(clips),
      onProgress: r => {
        bar.style.width = Math.round(r * 100) + '%';
        $('renderText').textContent = `MP4を書き出し中… ${Math.round(r * 100)}%`;
        jobProgress(r);
      },
    });
    $('renderText').textContent = `書き出し完了（${formatSec((performance.now() - t0) / 1000)}）`;
    jobEnd('done');
    log('書き出し完了', { sizeMB: +(blob.size / 1e6).toFixed(1), sec: Math.round((performance.now() - t0) / 1000) });
    showResult(blob, timeline);
  } catch (err) {
    jobEnd('error', err);
    showError($('renderError'), err);
    $('renderText').textContent = '';
  } finally {
    $('btnRender').disabled = false;
    $('btnAnalyze').disabled = false;
    $('file').disabled = false;
    $('preview').src = state.url;
    lock?.release?.();
  }
});

function showResult(blob, timeline) {
  const last = timeline[timeline.length - 1];
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  state.outName = `amity-short-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.mp4`;
  state.blob = blob;
  state.outUrl = URL.createObjectURL(blob);
  $('outVideo').src = state.outUrl;
  $('outDuration').textContent = formatSec(last.outStart + last.outDuration);
  $('outSize').textContent = formatSize(blob.size);
  $('outStyle').textContent = state.styleNote || '-';
  $('btnDownload').href = state.outUrl;
  $('btnDownload').download = state.outName;
  $('stepResult').hidden = false;
  $('stepResult').scrollIntoView({ behavior: 'smooth' });
}

$('btnSave').addEventListener('click', async () => {
  if (!state.blob) return;
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
