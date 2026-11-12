// テスト環境（/test/）だけで出す表示: iPhone の Safari で、音声認識のスレッド数・書き出しの速さ・エラーを確かめる。
// 今の公開ページ（/）では読み込まない（app.js の TEST_MODE のときだけ）。
//
// 出すもの:
// - 配信の状態（クロスオリジン分離・SharedArrayBuffer・コア数・音声認識で使うスレッド数）
// - 外部ファイル（ONNX Runtime・音声認識のモデル・字幕の辞書）を、分離したページで読み込めるか
// - 音声認識の時間・使ったスレッド数、書き出しの時間・方式（高速か）・写したコマ・エンコードし直したコマ、エラー
// - 1・2・4スレッドの比べ（解析した動画の最初の90秒の音声で。文字起こしの結果が同じかも確かめる）
// - 結果のコピー（そのまま送れる文）

const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const HF = 'https://huggingface.co/csukuangfj/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01/resolve/main/';
const DICT = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';

const el = (tag, attrs = {}, text = '') => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
};
const sec = v => (v == null ? '-' : `${(+v).toFixed(1)}秒`);

export function mountTestPanel({ state, timings, asrLoadOpts, worker, v2 = false }) {
  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.message || e.error?.message || e.error || 'エラー').slice(0, 160)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason?.message || e.reason || 'エラー').slice(0, 160)));

  const box = el('section', { id: 'testPanel', 'aria-label': 'テスト環境の計測' });
  box.style.cssText = 'margin:8px 0 16px;padding:10px 12px;border:2px dashed #e08a00;border-radius:10px;background:#fff8ec;color:#222;font-size:13px;line-height:1.5';
  box.append(el('h2', { style: 'margin:0 0 4px;font-size:15px' }, 'テスト環境（本番とは別・計測用）'));
  const note = el('p', { style: 'margin:0 0 6px' }, '速さ・スレッド数・エラーを確かめるためのページです。使い方は今までと同じです。下の「結果をコピー」で、そのまま送れる文をコピーできます。');
  const env = el('pre', { style: 'white-space:pre-wrap;margin:6px 0;font-size:12px' });
  const live = el('pre', { style: 'white-space:pre-wrap;margin:6px 0;font-size:12px' });
  const checks = el('pre', { style: 'white-space:pre-wrap;margin:6px 0;font-size:12px' });
  const bench = el('pre', { style: 'white-space:pre-wrap;margin:6px 0;font-size:12px' });
  const btns = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' });
  const mk = (label, fn) => { const b = el('button', { type: 'button', class: 'btn secondary small' }, label); b.style.cssText = 'padding:6px 10px;font-size:13px'; b.addEventListener('click', fn); btns.append(b); return b; };
  box.append(note, env, btns, checks, bench, live);
  (document.querySelector('main') || document.body).prepend(box);

  // 配信の状態
  const iso = !!self.crossOriginIsolated, sab = typeof SharedArrayBuffer !== 'undefined';
  const hw = navigator.hardwareConcurrency || null;
  const auto = iso && sab ? Math.max(1, Math.min(4, (hw || 2) - 1)) : 1;
  const opts = asrLoadOpts();
  const envText = [
    `クロスオリジン分離: ${iso ? 'はい' : 'いいえ'}・SharedArrayBuffer: ${sab ? 'あり' : 'なし'}・コア数: ${hw ?? '不明'}`,
    `音声認識のスレッド: 自動なら ${auto}${opts.threads ? `（このページでは ${opts.threads} を指定）` : ''}・ONNX Runtime の場所: ${opts.ortLocal ? 'このサイト' : 'CDN'}`,
    `改善版（v2: 短い窓＋長い窓の音声認識・手動編集に近いカット・1文ずつの字幕）: ${v2 ? 'ON（今までの方式と比べるときは、住所の最後に ?v2=0 を付けて開く）' : 'OFF（?v2=0 で開いています）'}`,
    `ブラウザ: ${navigator.userAgent}`,
  ].join('\n');
  env.textContent = envText;

  // 外部ファイルを読み込めるか（分離したページでは、相手のサーバーが許可しないと読めない）
  let checkText = '';
  const checkBtn = mk('外部ファイルの読み込みを確かめる', async () => {
    checkBtn.disabled = true;
    const items = [
      ['ONNX Runtime（CDN）', ORT_CDN + 'ort.wasm.min.mjs', 'GET'],
      ['ONNX Runtime の本体（CDN）', ORT_CDN + 'ort-wasm-simd-threaded.wasm', 'HEAD'],
      ['ONNX Runtime（このサイト）', new URL('vendor/ort/ort.wasm.min.mjs', location.href).href, 'GET'],
      ['音声認識のモデル（一覧）', HF + 'tokens.txt', 'GET'],
      ['音声認識のモデル（本体）', HF + 'encoder-epoch-99-avg-1.int8.onnx', 'HEAD'],
      ['字幕の辞書', DICT + 'unk_char.dat.gz', 'GET'],
    ];
    const rows = [];
    for (const [name, url, method] of items) {
      const t0 = performance.now();
      try {
        const r = await fetch(url, { method, mode: 'cors', cache: 'no-store' });
        if (method === 'GET') await r.arrayBuffer();
        rows.push(`${r.ok ? '○' : '×'} ${name}: ${r.status}（${Math.round(performance.now() - t0)}ミリ秒）`);
      } catch (e) {
        rows.push(`× ${name}: 読み込めません（${e?.message || e}）`);
      }
    }
    checkText = '外部ファイルの読み込み:\n' + rows.join('\n');
    checks.textContent = checkText;
    checkBtn.disabled = false;
  });

  // 1・2・4スレッドの比べ（解析のあと。1回ずつモデルを読み込み、終わったら手放す）
  let benchText = '';
  const benchBtn = mk('音声認識の速さを比べる（1・2・4スレッド）', async () => {
    const pcm = state.testPcm;
    if (!pcm) { bench.textContent = '先に動画を選んで「自動編集を開始」で解析してください（解析した音声の最初の90秒で比べます）。'; return; }
    benchBtn.disabled = true;
    const rows = [], texts = {};
    const list = iso && sab ? [1, 2, 4] : [1];
    if (list.length === 1) rows.push('（クロスオリジン分離されていないため、1スレッドだけ測ります）');
    for (const n of list) {
      bench.textContent = `音声認識の比べ: ${n}スレッドで計測中…（1回40秒〜数分かかることがあります。この間は画面を離れないでください）\n` + rows.join('\n');
      try {
        const r = await runBench(worker, pcm, n, opts.ortLocal);
        texts[n] = r.text;
        const same = n === 1 || texts[1] == null ? '' : r.text === texts[1] ? '・文字起こしは1スレッドと同じ' : `・文字起こしが1スレッドと違う（${r.text.length}文字 / ${texts[1].length}文字）`;
        rows.push(`${n}スレッド（実際 ${r.threads.threads}${r.threads.fallback ? '・1に戻した: ' + r.threads.fallback.slice(0, 60) : ''}）: 文字起こし ${sec(r.sec)}・モデルの準備 ${sec(r.loadSec)}・${(pcm.length / 16000).toFixed(0)}秒の音声${same}`);
      } catch (e) {
        rows.push(`${n}スレッド: 失敗（${e?.message || e}）`);
      }
    }
    benchText = '音声認識の比べ:\n' + rows.join('\n');
    bench.textContent = benchText;
    benchBtn.disabled = false;
  });

  mk('結果をコピー', async () => {
    const text = ['【Amity AI テスト環境の結果】', envText, liveText(), checkText, benchText].filter(Boolean).join('\n\n');
    try { await navigator.clipboard.writeText(text); live.textContent = liveText() + '\n（コピーしました）'; } catch { live.textContent = liveText() + '\n（コピーできませんでした。この欄を長押しして選んでください）'; }
  });

  // その場の計測（1秒ごとに更新）
  const liveText = () => {
    const R = state.job?.render, F = R?.fast, st = F?.stats;
    const wall = state.tSelected ? (Date.now() - state.tSelected) / 1000 : null;
    const th = state.asrThreads;
    const mem = performance.memory ? `${Math.round(performance.memory.usedJSHeapSize / 1e6)}MB（JavaScript のみ）` : 'Safari では取得できません（目安: 音声認識の準備で約600MB増え、解析が終わると手放します）';
    const shown = [...document.querySelectorAll('#renderError:not([hidden]), #globalError:not([hidden]), #fileError:not([hidden])')].map(x => x.textContent.slice(0, 120));
    return [
      `音声認識: 文字起こし ${sec(timings.asr)}（モデルの準備 ${sec(timings.asrLoad)}・確かめ ${sec(timings.verify)}）・使ったスレッド ${th ? `${th.threads}${th.fallback ? '（複数スレッドに失敗して1に戻した）' : ''}` : '-'}`,
      `解析ぜんぶ: 音声 ${sec(timings.audio)}・手元の動き ${sec(timings.motion)}・構成 ${sec(timings.plan)}`,
      `動画の書き出し: ${sec(timings.render != null ? timings.render + (timings.assemble || 0) : null)}・方式 ${R?.method === 'fast' ? '高速' : R?.method === 'normal' ? `今まで（高速を使わなかった理由: ${F?.failed || F?.off || '-'}）` : F?.off ? `今まで（${F.off}）` : '-'}`,
      st ? `高速書き出し: 写したコマ ${st.copiedFrames}・エンコードし直したコマ ${st.reencodedFrames}・埋めたコマ ${st.filledFrames || 0}・つなぎ目の確かめ ${F.verify ? `${F.verify.checked}か所・最低 ${F.verify.minPsnr}dB` : '-'}・映像 ${st.codec}` : '高速書き出し: -',
      `動画を選んでから: ${wall ? `${Math.round(wall)}秒` : '-'}`,
      `メモリ: ${mem}`,
      `エラー: ${errors.length + shown.length ? [...errors.slice(-3), ...shown].join(' / ') : 'なし'}`,
    ].join('\n');
  };
  const tick = () => { live.textContent = liveText(); };
  tick();
  setInterval(tick, 1000);
}

// スレッド数 n で、音声を30秒ずつ文字にする時間を測る（新しいワーカーで読み込み、終わったら手放す）
function runBench(script, pcm, n, ortLocal) {
  return new Promise((resolve, reject) => {
    const w = new Worker(script, { type: 'module' });
    const parts = [];
    for (let a = 0; a + 16000 * 3 <= pcm.length; a += 30 * 16000) parts.push(pcm.slice(a, Math.min(pcm.length, a + 30 * 16000)));
    let i = 0, t0 = 0, info = null, loadSec = null, text = '';
    const done = (fn, v) => { w.terminate(); fn(v); };
    w.onmessage = e => {
      const m = e.data;
      if (m.type === 'loaded') { info = m.threads; loadSec = m.loadSec; t0 = performance.now(); next(); }
      else if (m.type === 'result') { text += m.chunks.map(c => c.text).join(''); i++; next(); }
      else if (m.type === 'error') done(reject, new Error(m.message));
    };
    w.onerror = e => done(reject, new Error(e.message || 'ワーカーを起動できませんでした'));
    const next = () => {
      if (i >= parts.length) return done(resolve, { sec: (performance.now() - t0) / 1000, loadSec, threads: info || { threads: n }, text });
      const audio = parts[i];
      w.postMessage({ type: 'run', id: i, audio }, [audio.buffer]);
    };
    w.postMessage({ type: 'load', threads: n, ortLocal });
  });
}
