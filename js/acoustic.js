// 音の特徴から、文字起こしAIが見落とす言い直し（言いかけてやめた短い発言）を見つける。
// ブラウザAPIを使わないので Node でテストできる。
//
// 言い直しの形: 長めの無音（0.8秒以上）のあとに短い発言（1.6秒以下）があり、少し間をおいて話し直している。
// そのうえで、短い発言の終わりの音（約0.45秒）が、話し直した部分の最初の2.5秒のどこかとよく似ている
// （「特に、むす…」→「ギリギリむすべる…」のように、言いかけた言葉をもう一度言っている）。
// 文字起こしでは別の字になる（「蒸す」と「結べる」）ことがあるので、音どうしを比べる。
//
// score は似ていなさ（0〜2。小さいほど似ている）。固定テスト素材4本では、手動編集が削った言いかけは 0.15・0.29、
// 残した発言（「もしボブを」「それがあるので」）は 0.42・0.48 だった。似ている度合いだけでは普通の話し方（0.3〜0.43）と
// 分けられないので、必ず上の形（長い無音のあとの短い発言）と組み合わせる
export const RESTART = { preSilence: 0.8, maxLen: 1.6, joinGap: 0.25, tail: 0.45, look: 2.5, auto: 0.32, candidate: 0.4 };

const SR = 16000, HOP = 160, WIN = 400, NFFT = 512, BANDS = 40;

let tables = null;
function getTables() {
  if (tables) return tables;
  const win = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1));
  const mel = f => 1127 * Math.log(1 + f / 700), inv = m => 700 * (Math.exp(m / 1127) - 1);
  const lo = mel(100), hi = mel(7000);
  const edges = Array.from({ length: BANDS + 2 }, (_, i) => inv(lo + ((hi - lo) * i) / (BANDS + 1)));
  const fb = [];
  for (let b = 0; b < BANDS; b++) {
    const w = new Float64Array(NFFT / 2 + 1);
    for (let k = 0; k <= NFFT / 2; k++) {
      const f = (k * SR) / NFFT;
      w[k] = Math.max(0, Math.min((f - edges[b]) / (edges[b + 1] - edges[b]), (edges[b + 2] - f) / (edges[b + 2] - edges[b + 1])));
    }
    fb.push(w);
  }
  const cos = new Float64Array(NFFT / 2), sin = new Float64Array(NFFT / 2);
  for (let i = 0; i < NFFT / 2; i++) { cos[i] = Math.cos((-2 * Math.PI * i) / NFFT); sin[i] = Math.sin((-2 * Math.PI * i) / NFFT); }
  tables = { win, fb, cos, sin };
  return tables;
}

function fft(re, im, t) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let s = 0; s < n; s += len) {
      for (let k = 0; k < half; k++) {
        const wr = t.cos[k * step], wi = t.sin[k * step];
        const a = s + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

// pcm（16kHz）の [start, end] 秒の、10msごとの対数メル（40帯域）。返り値は行（コマ）ごとの配列
export function logMel(pcm, start, end) {
  const t = getTables();
  const out = [];
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  for (let s = Math.max(0, Math.round(start * SR)); s + WIN <= Math.min(pcm.length, Math.round(end * SR) + WIN); s += HOP) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < WIN; i++) re[i] = pcm[s + i] * t.win[i];
    fft(re, im, t);
    const row = new Float64Array(BANDS);
    for (let b = 0; b < BANDS; b++) {
      let e = 0;
      const w = t.fb[b];
      for (let k = 0; k <= NFFT / 2; k++) if (w[k]) e += w[k] * (re[k] * re[k] + im[k] * im[k]);
      row[b] = Math.log(e + 1e-8);
    }
    out.push(row);
  }
  return out;
}

// 平均を引いて長さを1にそろえた特徴（話し方の大きさ・録音の違いを除く）
function normalize(rows) {
  if (!rows.length) return rows;
  const mean = new Float64Array(BANDS);
  for (const r of rows) for (let b = 0; b < BANDS; b++) mean[b] += r[b] / rows.length;
  return rows.map(r => {
    const v = r.map((x, b) => x - mean[b]);
    const n = Math.hypot(...v) || 1;
    return v.map(x => x / n);
  });
}

// a（短い音）が b（長い音）のどこかの部分とどれだけ似ているか（部分系列のDTW。1コマあたりの「1−コサイン類似度」）
export function subsequenceDistance(a, b) {
  a = normalize(a); b = normalize(b);
  const n = a.length, m = b.length;
  if (!n || m < n) return Infinity;
  let prev = new Float64Array(m), cur = new Float64Array(m);
  const cost = (i, j) => { let d = 0; for (let k = 0; k < BANDS; k++) d += a[i][k] * b[j][k]; return 1 - d; };
  for (let j = 0; j < m; j++) prev[j] = cost(0, j);
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let best = prev[j];
      if (j > 0 && prev[j - 1] < best) best = prev[j - 1];
      if (j > 1 && prev[j - 2] < best) best = prev[j - 2];
      cur[j] = best + cost(i, j);
    }
    [prev, cur] = [cur, prev];
  }
  return Math.min(...prev) / n;
}

// 細かい声の区間 fine（時刻順）から、言い直しの形をしている短い発言を探し、音の似ている度合いを測る。
// 返り値: [{ start, end, next, score, level: 'auto' | 'candidate' }]（next は話し直した所の始まり）
export function findRestarts(pcm, fine, opts = RESTART) {
  const ph = [];
  for (const f of fine || []) {
    const last = ph[ph.length - 1];
    if (last && f.start - last.end < opts.joinGap) last.end = f.end;
    else ph.push({ start: f.start, end: f.end });
  }
  const out = [];
  for (let k = 1; k + 1 < ph.length; k++) {
    const A = ph[k], B = ph[k + 1];
    if (A.start - ph[k - 1].end < opts.preSilence || A.end - A.start > opts.maxLen || B.start - A.end > 1.5) continue;
    const tail = logMel(pcm, Math.max(A.start, A.end - opts.tail), A.end);
    const head = logMel(pcm, B.start, Math.min(B.end, B.start + opts.look));
    const score = subsequenceDistance(tail, head);
    if (!(score <= opts.candidate)) continue;
    out.push({ start: A.start, end: A.end, next: B.start, score: +score.toFixed(3), level: score <= opts.auto ? 'auto' : 'candidate' });
  }
  return out;
}
