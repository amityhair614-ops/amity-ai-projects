// 診断情報と、処理中にページが落ちた（再読み込みされた）ことの検知。
// iPhone の Safari はメモリが足りなくなると、エラーを出さずにページを再読み込みする。
// そのため処理の段階を localStorage に書きながら進め、次に開いたときに「途中で止まった」ことを表示する。

const JOB_KEY = 'amity.job.v1';
const LOG_KEY = 'amity.log.v1';
const MAX_LOG = 150;

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても処理は続ける */ }
}

const logs = load(LOG_KEY, []);
const env = {};
let job = null;
let lastSaved = 0;

// ページを開いた時点で、前回の処理が「実行中」のまま残っていれば途中で落ちたということ
export const previousJob = (() => {
  const j = load(JOB_KEY, null);
  if (j && j.status === 'running') {
    j.status = 'interrupted';
    save(JOB_KEY, j);
    return j;
  }
  return null;
})();

export function log(msg, data) {
  const entry = { t: new Date().toISOString().slice(11, 23), msg };
  if (data !== undefined) entry.data = data;
  logs.push(entry);
  if (logs.length > MAX_LOG) logs.splice(0, logs.length - MAX_LOG);
  save(LOG_KEY, logs);
  console.log('[amity]', msg, data ?? '');
}

export function setEnv(key, value) {
  env[key] = value;
}

export function jobStart(kind, info) {
  job = { kind, status: 'running', stage: '', label: '', progress: 0, startedAt: new Date().toISOString(), info };
  save(JOB_KEY, job);
  log(`処理開始: ${kind}`, info);
}

export function jobStage(stage, label) {
  if (!job) return;
  job.stage = stage;
  job.label = label;
  job.progress = 0;
  save(JOB_KEY, job);
  log(`段階: ${label}`);
}

// 進み具合は頻繁に変わるので、1秒に1回まで保存する
export function jobProgress(ratio) {
  if (!job) return;
  job.progress = Math.round(ratio * 100);
  const now = Date.now();
  if (now - lastSaved > 1000) { lastSaved = now; save(JOB_KEY, job); }
}

export function jobEnd(status, error) {
  if (!job) return;
  job.status = status;
  job.endedAt = new Date().toISOString();
  if (error) job.error = String(error && error.message ? error.message : error);
  save(JOB_KEY, job);
  log(`処理終了: ${status}`, job.error);
  job = null;
}

export function clearLogs() {
  logs.length = 0;
  save(LOG_KEY, logs);
  try { localStorage.removeItem(JOB_KEY); } catch {}
}

export function errorText(err) {
  if (!err) return '不明なエラー';
  const name = err.name && err.name !== 'Error' ? `${err.name}: ` : '';
  return name + (err.message || String(err));
}

export function report() {
  const lines = [];
  lines.push('Amity AI動画編集 診断情報');
  lines.push('日時: ' + new Date().toLocaleString('ja-JP'));
  lines.push('ブラウザ: ' + navigator.userAgent);
  lines.push(`画面: ${screen.width}×${screen.height} @${devicePixelRatio}x`);
  if (navigator.deviceMemory) lines.push('端末メモリ(目安): ' + navigator.deviceMemory + 'GB');
  if (performance.memory) lines.push(`JSヒープ: ${Math.round(performance.memory.usedJSHeapSize / 1e6)}MB / 上限 ${Math.round(performance.memory.jsHeapSizeLimit / 1e6)}MB`);
  const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
  if (nav) lines.push('ページの開き方: ' + nav.type);
  for (const [k, v] of Object.entries(env)) lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const j = load(JOB_KEY, null);
  if (j) lines.push('最後の処理: ' + JSON.stringify(j));
  lines.push('--- ログ（新しい順） ---');
  for (const e of [...logs].reverse()) lines.push(`${e.t} ${e.msg}${e.data !== undefined ? ' ' + JSON.stringify(e.data) : ''}`);
  return lines.join('\n');
}
