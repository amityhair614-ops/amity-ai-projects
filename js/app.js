import { checkSupport, openVideo, analyzeAudio, analyzeMotion, renderShort, ASR_RATE } from './media.js';
import {
  detectSpeech, transcriptionWindows, buildUnits, selectUnits, buildTimeline, formatTime, FRAME_SEC,
} from './plan.js';

const $ = id => document.getElementById(id);
const state = {};
window.amityDebug = state; // 動作確認用

function showError(el, err) {
  console.error(err);
  el.textContent = (err && err.message) || String(err);
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

// ---------- 1. 動画を選ぶ ----------
$('file').addEventListener('change', async () => {
  const file = $('file').files && $('file').files[0];
  if (!file) return;
  for (const id of ['fileError', 'analyzeError', 'renderError']) $(id).hidden = true;
  $('stepReview').hidden = true;
  $('stepResult').hidden = true;
  $('steps').hidden = true;
  $('bar').hidden = true;
  $('progressText').textContent = '';
  if (state.url) URL.revokeObjectURL(state.url);
  Object.keys(state).forEach(k => delete state[k]);
  state.file = file;
  state.url = URL.createObjectURL(file);

  $('preview').src = state.url;
  $('clipPreview').src = state.url;
  $('name').textContent = file.name;
  $('size').textContent = formatSize(file.size);
  $('duration').textContent = '読み込み中…';
  $('dims').textContent = '-';
  $('fileInfo').hidden = false;

  try {
    state.src = await openVideo(file);
    const { width, height, duration, audio } = state.src;
    $('duration').textContent = formatSec(duration);
    $('dims').textContent = `${width}×${height}（${width >= height ? '横向き' : '縦向き'}）${audio ? '' : '・音声なし'}`;
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

function setStep(key, status) {
  const li = $('steps').querySelector(`[data-key="${key}"]`);
  if (!li) return;
  li.className = status;
  li.firstChild.textContent = status === 'done' ? '✓' : status === 'active' ? '▶' : status === 'skip' ? '－' : '・';
}

function setProgress(ratio, text) {
  $('bar').firstElementChild.style.width = Math.round(Math.min(1, ratio) * 100) + '%';
  if (text !== undefined) $('progressText').textContent = text;
}

function transcribe(pcm, windows, model) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('js/transcribe-worker.js', { type: 'module' });
    const files = new Map();
    const chunks = [];
    let i = 0;
    const finish = (fn, v) => { worker.terminate(); fn(v); };
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
        next();
      } else if (m.type === 'result') {
        const w = windows[m.id];
        const offset = Math.max(0, w.start - 0.2);
        for (const c of m.chunks) {
          const start = offset + c.start, end = Math.min(offset + c.end, w.end + 0.2);
          if (end > start && c.text.trim()) chunks.push({ start, end, text: c.text.trim() });
        }
        i++;
        next();
      } else if (m.type === 'error') {
        finish(reject, new Error(m.message));
      }
    };
    worker.onerror = e => finish(reject, new Error(e.message || '文字起こしの準備に失敗しました'));
    setProgress(0, 'AIモデルを準備中…');
    worker.postMessage({ type: 'load', model });
  });
}

$('btnAnalyze').addEventListener('click', async () => {
  const src = state.src;
  if (!src) return;
  const useAsr = $('optAsr').checked && !!src.audio;
  $('analyzeError').hidden = true;
  $('stepReview').hidden = true;
  $('stepResult').hidden = true;
  $('btnAnalyze').disabled = true;
  $('file').disabled = true;
  setupSteps([
    { key: 'audio', label: '音声を読み込み、無音を探す' },
    { key: 'motion', label: '手元の動きを解析する' },
    { key: 'asr', label: '文字起こし（字幕・言い直し）' },
    { key: 'plan', label: '約60秒の構成を作る' },
  ]);
  const lock = await keepAwake();
  const t0 = performance.now();
  try {
    setStep('audio', 'active');
    if (src.audio) {
      const a = await analyzeAudio(src, r => setProgress(r, `音声を読み込み中… ${Math.round(r * 100)}%`));
      state.rmsDb = a.rmsDb;
      state.pcm = a.pcm;
      state.speech = detectSpeech(a.rmsDb);
    } else {
      state.rmsDb = new Float32Array(Math.ceil(src.duration / FRAME_SEC));
      state.speech = { regions: [], threshold: 0 };
    }
    setStep('audio', 'done');

    setStep('motion', 'active');
    state.motion = await analyzeMotion(src, r => setProgress(r, `手元の動きを解析中… ${Math.round(r * 100)}%`));
    setStep('motion', 'done');

    state.chunks = null;
    state.asrWarning = null;
    if (useAsr && state.speech.regions.length) {
      setStep('asr', 'active');
      try {
        state.chunks = await transcribe(state.pcm, transcriptionWindows(state.speech.regions), $('optModel').value);
        setStep('asr', 'done');
      } catch (err) {
        console.error(err);
        state.asrWarning = '文字起こしができなかったため、字幕なし・言い直し検出なしで構成しました（理由: ' + (err.message || err) + '）';
        setStep('asr', 'skip');
      }
    } else {
      setStep('asr', 'skip');
    }

    setStep('plan', 'active');
    state.units = buildUnits({
      duration: src.duration, rmsDb: state.rmsDb, speech: state.speech, chunks: state.chunks, motion: state.motion,
    });
    state.selected = new Set(selectUnits(state.units, src.duration).map(u => u.id));
    setStep('plan', 'done');
    setProgress(1, `完了（${formatSec((performance.now() - t0) / 1000)}）`);
    showReview();
  } catch (err) {
    showError($('analyzeError'), err);
  } finally {
    $('btnAnalyze').disabled = false;
    $('file').disabled = false;
    lock?.release?.();
  }
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
  if (u.kind === 'speech' && state.chunks) {
    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.value = u.text;
    ta.placeholder = '（字幕なし）';
    ta.setAttribute('aria-label', '字幕');
    ta.addEventListener('input', () => { u.text = ta.value; });
    div.appendChild(ta);
  }
  return div;
}

function playRange(start, end) {
  const v = $('clipPreview');
  v.currentTime = start;
  v.play();
  const stop = () => {
    if (v.currentTime >= end) { v.pause(); v.removeEventListener('timeupdate', stop); }
  };
  v.addEventListener('timeupdate', stop);
  v.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateTotal() {
  const total = state.units.filter(u => state.selected.has(u.id)).reduce((s, u) => s + u.duration, 0);
  const el = $('total');
  el.textContent = `合計 ${total.toFixed(1)}秒（${state.selected.size}場面）` + (total > 60 ? ' ― 60秒を超えています' : '');
  el.classList.toggle('over', total > 60);
  $('btnRender').disabled = state.selected.size === 0;
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
  if (state.chunks) parts.push(`文字起こし: ${state.chunks.length}件（${state.asrDevice === 'webgpu' ? 'GPU' : 'CPU'}で処理）。`);
  if (state.asrWarning) parts.push(state.asrWarning);
  if (!state.src.audio) parts.push('音声がないため、手元の動きだけで選びました。');
  $('summary').textContent = parts.join('');
  updateTotal();
  $('stepReview').hidden = false;
  $('stepReview').scrollIntoView({ behavior: 'smooth' });
}

// 選んだ場面の話し声の大きさから、音量の補正量を決める
function computeGainDb(clips) {
  const { rmsDb, speech } = state;
  if (!rmsDb || !state.src.audio) return 0;
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
  $('stepResult').hidden = true;
  $('btnRender').disabled = true;
  $('btnAnalyze').disabled = true;
  $('renderBar').hidden = false;
  const bar = $('renderBar').firstElementChild;
  const lock = await keepAwake();
  const t0 = performance.now();
  try {
    const timeline = buildTimeline(clips.map(u => ({ ...u, text: state.chunks ? u.text : '' })));
    state.timeline = timeline;
    const blob = await renderShort(state.src, timeline, {
      gainDb: computeGainDb(clips),
      onProgress: r => {
        bar.style.width = Math.round(r * 100) + '%';
        $('renderText').textContent = `MP4を書き出し中… ${Math.round(r * 100)}%`;
      },
    });
    $('renderText').textContent = `書き出し完了（${formatSec((performance.now() - t0) / 1000)}）`;
    showResult(blob, timeline);
  } catch (err) {
    showError($('renderError'), err);
    $('renderText').textContent = '';
  } finally {
    $('btnRender').disabled = false;
    $('btnAnalyze').disabled = false;
    lock?.release?.();
  }
});

function showResult(blob, timeline) {
  if (state.outUrl) URL.revokeObjectURL(state.outUrl);
  const last = timeline[timeline.length - 1];
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  state.outName = `amity-short-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.mp4`;
  state.blob = blob;
  state.outUrl = URL.createObjectURL(blob);
  $('outVideo').src = state.outUrl;
  $('outDuration').textContent = formatSec(last.outStart + last.outDuration);
  $('outSize').textContent = formatSize(blob.size);
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
    } catch (err) {
      if (err.name !== 'AbortError') $('btnDownload').click();
    }
  } else {
    $('btnDownload').click();
  }
});
