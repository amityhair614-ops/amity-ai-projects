// 書き出す音声のつなぎ方（ブラウザAPIを使わない計算だけ。Node でテストできる）
//
// カットのつなぎ目で音を一度0にすると、部屋の雑音まで消えて「プツッ」と途切れて聞こえる。
// そこで、前のピースの音を少し長めに読み、次のピースの頭と重ねて入れ替える（クロスフェード）。
// - 元の動画で離れた所をつなぐとき: 等パワー（中央で音量が下がらない）で 40ms
// - 元の動画で続いているとき（コマ数の丸めの境目）: 直線で 10ms（同じ音なので音量は変わらない）
// - 動画の最初と最後だけは、ごく短くフェードイン・フェードアウトする

export const XFADE_SEC = 0.04;
export const XFADE_CONTIGUOUS_SEC = 0.01;
export const FADE_IN_SEC = 0.02;
export const FADE_OUT_SEC = 0.08;

// 音量をそろえ、大きすぎる音だけをやわらかく抑える
export function applyGain(data, gain) {
  for (const ch of data) {
    for (let i = 0; i < ch.length; i++) {
      let y = ch[i] * gain;
      const a = Math.abs(y);
      if (a > 0.9) y = Math.sign(y) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1));
      ch[i] = y;
    }
  }
}

// cur の頭 n サンプルに、前のピースの続き tail を重ねて入れ替える
export function crossfade(cur, tail, n, equalPower) {
  n = Math.min(n, cur[0].length, tail[0].length);
  for (let c = 0; c < cur.length; c++) {
    const d = cur[c], t = tail[Math.min(c, tail.length - 1)];
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n;
      const fin = equalPower ? Math.sin(x * Math.PI / 2) : x;
      const fout = equalPower ? Math.cos(x * Math.PI / 2) : 1 - x;
      d[i] = d[i] * fin + t[i] * fout;
    }
  }
}

export function fadeIn(data, n) {
  for (const ch of data) for (let i = 0; i < Math.min(n, ch.length); i++) ch[i] *= i / n;
}

export function fadeOut(data, n) {
  for (const ch of data) {
    const L = ch.length;
    for (let i = 0; i < Math.min(n, L); i++) ch[L - 1 - i] *= i / n;
  }
}

// ピースごとの音声を順に受け取り、つなぎ目を重ねて返す。
// add(data, sr, { len, contiguous, last }): data は len サンプル＋つなぎ用に少し長めに読んだ音声。
// 返り値は、ちょうど len サンプルの音声（映像のコマ数と同じ長さ）
export class AudioStitcher {
  constructor() {
    this.tail = null;
    this.first = true;
  }

  // 次のピースのために、どれだけ長めに読めばよいか（秒）
  static extra() {
    return XFADE_SEC;
  }

  add(data, sr, { len, contiguous = false, last = false }) {
    const out = data.map(ch => ch.slice(0, len));
    if (out[0].length < len) for (let c = 0; c < out.length; c++) { const z = new Float32Array(len); z.set(out[c]); out[c] = z; }
    if (this.first) fadeIn(out, Math.round(FADE_IN_SEC * sr));
    else if (this.tail) crossfade(out, this.tail, Math.round((contiguous ? XFADE_CONTIGUOUS_SEC : XFADE_SEC) * sr), !contiguous);
    this.first = false;
    this.tail = data.map(ch => ch.slice(len, len + Math.round(XFADE_SEC * sr)));
    if (!this.tail[0].length) this.tail = null;
    if (last) fadeOut(out, Math.round(FADE_OUT_SEC * sr));
    return out;
  }
}

// 最後のフェードアウト: 完成動画の最後の sec 秒で、音量をなめらかに 0 にする（映像が黒くなるのと同じ曲線）。
// data は出力の時刻 outStart から始まる音声。total は完成動画の長さ
// hold: 最後の hold 秒は無音（映像が真っ黒のまま終わる時間）
export function applyEndFade(data, sr, outStart, total, sec, hold = 0) {
  const h = Math.min(hold, total * 0.1);
  const d = Math.min(sec, total * 0.2);
  if (d <= 0) return;
  const from = total - h - d;
  for (const ch of data) {
    for (let i = 0; i < ch.length; i++) {
      const t = outStart + i / sr;
      if (t < from) continue;
      const x = Math.min(1, (t - from) / d);
      ch[i] *= 1 - x * x * (3 - 2 * x);
    }
  }
}

// ---------- BGM ----------
// BGM は、話し声の邪魔にならないよう、ごく小さく、やわらかく重ねる（初期の音量 2%。0〜10%で選べる）。
// - 話している間は、さらに小さくする（40%に下げる。声の大きさを20msごとに見て、ゆっくり下げ・ゆっくり戻す）
// - 冒頭はフェードイン（2秒）、最後はフェードアウト（2.5秒。映像の最後のフェードとも重なる）
// - 曲の音をやわらかくする（soft）: 高い音を抑え（4kHz より上をなだらかに下げる）、ドラムのような急に大きくなる音を
//   曲の平均の大きさの2倍までに抑える。やさしいピアノや静かなアンビエントの曲はほとんど変わらず、強いリズムの曲は角が取れる
// 選んだ曲は使う人が用意したもの（利用許諾のある曲）だけ。アプリが曲を足すことはしない
export const BGM = { volume: 0.02, max: 0.1, duck: 0.4, fadeIn: 2.0, fadeOut: 2.5, voiceDb: -38, attack: 0.15, release: 0.6, lowpass: 4000, peak: 2 };

// data: 話し声（チャンネルごと・この部分の長さ）。music: 同じ長さのBGM（2チャンネル）。t0: この部分の完成動画での時刻。
// opt: { volume, soft（既定 true）, state（呼び出しをまたいで使う。下げ具合・フィルターの状態） }
export function mixBgm(data, sr, music, t0, total, opt) {
  const vol = Math.max(0, Math.min(BGM.max, opt.volume ?? BGM.volume));
  if (!vol || !music) return data;
  const st = opt.state || (opt.state = { duck: 1, lp: [[0, 0], [0, 0]], env: 0, avg: 0 });
  const soft = opt.soft !== false;
  if (soft) softenMusic(music, sr, st);
  const len = data[0].length, block = Math.max(1, Math.round(sr * 0.02));
  const up = 1 - Math.exp(-0.02 / BGM.release), down = 1 - Math.exp(-0.02 / BGM.attack);
  for (let b = 0; b < len; b += block) {
    const e = Math.min(len, b + block);
    let sum = 0;
    for (let i = b; i < e; i++) for (const ch of data) sum += ch[i] * ch[i];
    const db = 10 * Math.log10(sum / ((e - b) * data.length) + 1e-12);
    const target = db > BGM.voiceDb ? BGM.duck : 1;
    st.duck += (target - st.duck) * (target < st.duck ? down : up);
    for (let i = b; i < e; i++) {
      const t = t0 + i / sr;
      const fade = Math.min(1, t / BGM.fadeIn, Math.max(0, (total - t) / BGM.fadeOut));
      // フェードは直線ではなく、なめらかな曲線（聞こえ始め・聞こえ終わりが自然）
      const g = vol * st.duck * Math.sin(Math.max(0, fade) * Math.PI / 2) ** 2;
      if (data.length === 1) data[0][i] += g * 0.5 * (music[0][i] + music[1][i]);
      else for (let c = 0; c < data.length; c++) data[c][i] += g * music[Math.min(c, 1)][i];
    }
  }
  return data;
}

// 曲の音をやわらかくする（その場で書き換える）: 2段のなだらかな高音カットと、急に大きくなる音（ドラムなど）の抑え
export function softenMusic(music, sr, st) {
  const a = 1 - Math.exp(-2 * Math.PI * BGM.lowpass / sr);
  const att = 1 - Math.exp(-1 / (0.005 * sr)), rel = 1 - Math.exp(-1 / (0.3 * sr)), slow = 1 - Math.exp(-1 / (2 * sr));
  const n = music[0].length;
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (let c = 0; c < 2; c++) {
      const f = st.lp[c];
      f[0] += a * (music[c][i] - f[0]);
      f[1] += a * (f[0] - f[1]);
      music[c][i] = f[1];
      peak = Math.max(peak, Math.abs(f[1]));
    }
    st.env += (peak - st.env) * (peak > st.env ? att : rel);
    st.avg += (peak - st.avg) * slow;
    const lim = BGM.peak * Math.max(st.avg, 1e-4);
    if (st.env > lim) { const g = lim / st.env; music[0][i] *= g; music[1][i] *= g; }
  }
  return music;
}

// 曲の雰囲気の目安（選んだときに知らせるため）: 急に大きくなる音（ドラムなど）の多さと、高い音の多さ（明るさ）。
// mono: 曲の最初の30秒ほど（1チャンネル）。返り値: { onsets（1秒あたり）, zcr（おおよその中心の周波数 Hz）, punchy, bright }
export function bgmCharacter(mono, sr) {
  const hop = Math.round(sr * 0.02);
  const db = [];
  for (let i = 0; i + hop <= mono.length; i += hop) {
    let s = 0;
    for (let k = i; k < i + hop; k++) s += mono[k] * mono[k];
    db.push(10 * Math.log10(s / hop + 1e-10));
  }
  // 直前60msの一番小さい所から、20msで8dB以上大きくなった所（打楽器の打つ音）
  let onsets = 0, last = -Infinity;
  for (let i = 3; i < db.length; i++) {
    const base = Math.min(db[i - 1], db[i - 2], db[i - 3]);
    if (db[i] - base > 8 && db[i] > -50 && i - last > 5) { onsets++; last = i; }
  }
  const rate = onsets / Math.max(1, db.length * 0.02);
  let z = 0;
  for (let i = 1; i < mono.length; i++) if ((mono[i] >= 0) !== (mono[i - 1] >= 0)) z++;
  const zcr = z / Math.max(1, mono.length) * sr / 2;
  // 打つ音が多い・高い音（シンバル・ハイハットなど）が多い曲は「にぎやか」（話し声がメインの動画には向かない目安）
  return { onsets: +rate.toFixed(2), zcr: Math.round(zcr), punchy: rate > 3, bright: zcr > 1000, lively: rate > 3 || zcr > 1000 };
}
