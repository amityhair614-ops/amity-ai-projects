"""完成した動画を、手動編集のお手本と同じ物差しで測る（完成時間・言い直し・間・説明の保持・字幕・最後のフェード）。

  python3 tests/e2e/eval-finish.py OUT.mp4 TRANSCRIPT.json MODEL_DIR [--timeline=timeline.json] [--subs=subs.json]

- TRANSCRIPT.json: 元の動画で話した文の正解（[{text, retake}]。retake=true は取り除くべき言い直し）
- MODEL_DIR: ReazonSpeech（sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01）。完成動画の音声を文字起こしして、
  どの文が残ったかを調べる（pip の sherpa-onnx が必要）
- --timeline: run.mjs が書き出す timeline-*.json（字幕のページと時刻）。字幕の正確さとタイミングを測る
- --subs: 字幕を目で読み取った一覧（[[開始, 終了, 文字]]）。アプリ以外で作った動画（手動編集など）を測るとき
"""
import sys, json, subprocess, wave, unicodedata, re, os
import numpy as np

args = [a for a in sys.argv[1:] if not a.startswith('--')]
opt = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
out, tr_path, mdir = args
tr = json.load(open(tr_path))
tmp = out + '.16k.wav'
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', out, '-ac', '1', '-ar', '16000', tmp], check=True)
w = wave.open(tmp); sr = 16000
x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
os.remove(tmp)
dur = len(x) / sr

def norm(t):
    t = unicodedata.normalize('NFKC', t)
    t = re.sub(r'[、。,.!?！？「」\s・]', '', t)
    t = t.replace('百', '100').replace('下さい', 'ください')
    return ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in t)  # カタカナ→ひらがな（書き方の違いを数えない）

def ed(a, b):
    p = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        c = [i]
        for j, cb in enumerate(b, 1): c.append(min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (ca != cb)))
        p = c
    return p[-1]

def best_sub(a, b):
    """a が b のどこかの部分とどれだけ一致するか（0〜1）。b の前後はただで飛ばせる"""
    if not a: return 1.0
    p = [0] * (len(b) + 1)
    for i, ca in enumerate(a, 1):
        c = [i]
        for j, cb in enumerate(b, 1): c.append(min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (ca != cb)))
        p = c
    return max(0.0, 1 - min(p) / len(a))

# 1. 文字起こし（話の切れ目ごと。前後を少し広げる）
import sherpa_onnx
rec = sherpa_onnx.OfflineRecognizer.from_transducer(
    encoder=f'{mdir}/encoder-epoch-99-avg-1.int8.onnx', decoder=f'{mdir}/decoder-epoch-99-avg-1.int8.onnx',
    joiner=f'{mdir}/joiner-epoch-99-avg-1.int8.onnx', tokens=f'{mdir}/tokens.txt', num_threads=4)
hop = 320
e = np.array([20 * np.log10(np.sqrt(np.mean(x[i:i + hop] ** 2)) + 1e-9) for i in range(0, len(x) - hop, hop)])
floor = np.percentile(e, 10)
on = e > max(floor + 12, np.percentile(e, 30))
segs, i, n = [], 0, len(on)
while i < n:
    if not on[i]: i += 1; continue
    j = i
    while True:
        while j < n and on[j]: j += 1
        k = j
        while k < n and not on[k]: k += 1
        if k < n and (k - j) * 0.02 < 0.6 and (k - i) * 0.02 < 8: j = k; continue
        break
    segs.append((max(0, i * 0.02 - 0.4), min(dur, j * 0.02 + 0.4))); i = j
asr, toks = '', []
# 区間の前後の広げ方を変えて3回読み、いちばん文字の多い結果を使う（このモデルは文の頭や終わりを落とすことがあるため）
for a, b in segs:
    best = None
    for pad in (0.0, 0.4, 0.8):
        a1, b1 = max(0, a - pad), min(dur, b + pad)
        s = rec.create_stream(); s.accept_waveform(sr, x[int(a1 * sr):int(b1 * sr)]); rec.decode_stream(s)
        r = [(a1 + t, k) for t, k in zip(s.result.timestamps, s.result.tokens) if a - 0.3 <= a1 + t <= b + 0.3]
        if best is None or len(r) > len(best): best = r
    asr += ''.join(k for _, k in best)
    toks += best
A = norm(asr)

# 2. 言い直しが残っていないか・必要な説明が残っているか
keep = [t for t in tr if not t.get('retake')]
retakes = [t for t in tr if t.get('retake')]
kept = [(t['text'], best_sub(norm(t['text']), A)) for t in keep]
kept_ok = [k for k in kept if k[1] >= 0.6]
retake_left = [(t['text'], best_sub(norm(t['text']), A)) for t in retakes]

# 3. 間（無音）の長さ
gaps, i = [], 0
quiet = e < floor + 10
while i < n:
    if quiet[i]:
        j = i
        while j < n and quiet[j]: j += 1
        if i > 0 and j < n: gaps.append((j - i) * 0.02)
        i = j
    else: i += 1
g = [d for d in gaps if d >= 0.12]

# 4. 最後のフェード（映像の明るさ）
def luma(t):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(max(0, t)), '-i', out, '-frames:v', '1', '-vf', 'scale=64:-1,format=gray', '-f', 'rawvideo', '-'], capture_output=True)
    return float(np.frombuffer(r.stdout, np.uint8).mean()) if r.stdout else -1
fade = [round(luma(dur - k), 1) for k in (1.2, 0.6, 0.3, 0.05)]

print(f'完成時間: {dur:.1f}秒')
print(f'言い直し（取り除くべき {len(retakes)} 件）: ' + ' / '.join(f'「{t}」{"残っている" if s >= 0.6 else "取り除けた"}({s:.2f})' for t, s in retake_left))
print(f'必要な説明の保持（完成動画の文字起こしで判定）: {len(kept_ok)}/{len(keep)} 文')
for t, s in kept:
    if s < 0.6: print(f'  見つからない文: {t}（一致 {s:.2f}）')
# 書き出しのタイムライン（元の動画のどこを使ったか）がある場合は、それで正確に判定する
if 'timeline' in opt and all('start' in t for t in tr):
    used = [(p['srcStart'], p['srcStart'] + p['frames'] / 30) for c in json.load(open(opt['timeline'])) for p in c['pieces']]
    def cover(t):
        span = t['end'] - t['start']
        got = sum(max(0, min(b, t['end']) - max(a, t['start'])) for a, b in used)
        return got / span if span > 0 else 0
    tk = [(t['text'], cover(t)) for t in keep]
    print(f'必要な説明の保持（元の動画の使った範囲で判定）: {sum(c >= 0.8 for _, c in tk)}/{len(keep)} 文')
    for t, c in tk:
        if c < 0.8: print(f'  抜けた文: {t}（使った割合 {c:.2f}）')
    for t in retakes:
        print(f'  言い直し「{t["text"]}」: 使った割合 {cover(t):.2f}（0なら取り除けた）')
print(f'間（0.12秒以上の無音 {len(g)}か所）: 中央値 {np.median(g):.2f}秒 / 90% {np.percentile(g, 90):.2f}秒 / 最長 {max(g):.2f}秒 / 0.6秒以上 {sum(d >= 0.6 for d in g)}か所 / 1秒以上 {sum(d >= 1.0 for d in g)}か所')
print(f'最後の明るさ（終わりの1.2/0.6/0.3/0.05秒前）: {fade}')

# 5. 字幕の正確さとタイミング
pages = []
if 'timeline' in opt:
    for c in json.load(open(opt['timeline'])):
        pages += [(p['s'], p['e'], p['t']) for p in c.get('pages', [])]
elif 'subs' in opt:
    pages = [tuple(p) for p in json.load(open(opt['subs']))]
if pages:
    ref = norm(''.join(t for t, s in kept if s >= 0.6))
    hyp = norm(''.join(p[2] for p in pages))
    print(f'字幕の正確さ: 誤り {ed(ref, hyp)}/{len(ref)}文字（誤り率 {ed(ref, hyp) / max(1, len(ref)) * 100:.1f}%）。正解は「残った文」のお手本の字幕')
    # タイミング: ページの表示開始と、その近く（±0.8秒）の「声の出始め」（0.15秒以上の無音のあとの声）との差
    eh = np.array([20 * np.log10(np.sqrt(np.mean(x[i:i + 160] ** 2)) + 1e-9) for i in range(0, len(x) - 160, 160)])
    von = eh > np.percentile(eh, 10) + 14
    onsets, i, m = [], 0, len(von)
    while i < m:
        if not von[i]:
            j = i
            while j < m and not von[j]: j += 1
            if (j - i) * 0.01 >= 0.15 and j < m and von[j:j + 10].mean() > 0.7: onsets.append(j * 0.01)
            i = j
        else: i += 1
    d = []
    for s0, e0, text in pages:
        near = [o for o in onsets if abs(o - s0) < 0.8]
        if near: d.append(min(near, key=lambda o: abs(o - s0)) - s0)
    if d:
        a = np.abs(d)
        print(f'字幕のタイミング（声の出始め − ページの表示開始。{len(d)}ページ）: 平均 {np.mean(d):+.2f}秒 / ずれの中央値 {np.median(a):.2f}秒 / 90% {np.percentile(a, 90):.2f}秒 / 最大 {a.max():.2f}秒（表示は声の0.1秒前からの設定）')
print('完成動画の文字起こし: ' + asr)
