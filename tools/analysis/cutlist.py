# 編集した動画（手動編集・AI編集）の音声が、元の動画のどこを使っているかを求める（カットの一覧）。
#   python3 tools/analysis/cutlist.py --sources a.wav,b.wav,... edited.wav [--lay analysis.json] [--out cuts.json]
# - 音声は 16kHz・モノラルの wav（ffmpeg -i x.mov -ac 1 -ar 16000 x.wav）
# - 1. 編集した音声を0.1秒ずつ、元の音声のどこかに対応づける（相互相関）。同じ元の動画で時刻の差がほぼ一定の所をまとめる
#   2. つなぎ目の位置を、音の周波数の形（対数スペクトル）の一致で 0.02秒単位に求める（位相のずれに強い）
# - --lay: アプリの解析の結果（tests/e2e/run.mjs --dump-analysis）。元の動画をつないだ時刻（kept）も出す（cuteval.mjs の入力）
# 出すもの: { cuts: [{ src（--sources の番号）, o0, o1（編集した動画の時刻）, s0, s1（元の動画の時刻）}], kept: [{ start, end }] }
import argparse, json, wave, numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--sources', required=True)
ap.add_argument('edited')
ap.add_argument('--lay')
ap.add_argument('--out')
ap.add_argument('--min-corr', type=float, default=0.7)
a = ap.parse_args()

SR = 16000
def rd(p):
    w = wave.open(p); assert w.getframerate() == SR and w.getnchannels() == 1, p + ': 16kHz・モノラルにしてください'
    return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768

srcs = [rd(p) for p in a.sources.split(',')]
E = rd(a.edited)
W, STEP = int(0.3 * SR), 0.1
pre = []
for x in srcs:
    n = len(x) + W
    pre.append((np.fft.rfft(x, 2 * n), np.sqrt(np.convolve(x ** 2, np.ones(W), 'valid')) + 1e-6, n))
rows = []
for t0 in np.arange(0, len(E) / SR - 0.3, STEP):
    seg = E[int(t0 * SR):int(t0 * SR) + W]
    if np.sqrt(np.mean(seg ** 2)) < 0.003: rows.append((t0, None, None, 0)); continue
    best = (0, None, None)
    for si, (F, e, n) in enumerate(pre):
        c = np.fft.irfft(F * np.fft.rfft(seg[::-1], 2 * n), 2 * n)[W - 1:W - 1 + len(e)]
        cc = c / (e * np.sqrt(np.sum(seg ** 2))); j = int(np.argmax(cc))
        if cc[j] > best[0]: best = (float(cc[j]), si, j / SR)
    rows.append((t0, best[1], best[2], best[0]))
segs = []
for t0, s, ts, c in rows:
    if s is None or c < a.min_corr: continue
    off = ts - t0
    if segs and segs[-1]['s'] == s and abs(segs[-1]['off'] - off) < 0.05 and t0 - segs[-1]['o1'] <= 0.45:
        segs[-1]['o1'] = t0 + 0.3; segs[-1]['n'] += 1
    else: segs.append({'s': s, 'off': off, 'o0': t0, 'o1': t0 + 0.3, 'n': 1})
segs = [g for g in segs if g['n'] >= 2]

# つなぎ目を細かく求める
HOP, NF = 320, 512
def spec(x):
    n = (len(x) - NF) // HOP; win = np.hanning(NF)
    fr = np.stack([x[i * HOP:i * HOP + NF] * win for i in range(n)])
    m = np.abs(np.fft.rfft(fr, axis=1))[:, 4:160]
    return 20 * np.log10(m + 1e-6), 20 * np.log10(np.sqrt(np.mean(fr ** 2, axis=1)) + 1e-9)
S = [spec(x)[0] for x in srcs]
A, Ae = spec(E)
def sim(fi, s, off):
    j = fi + int(round(off * SR / HOP))
    if j < 0 or j >= len(S[s]) or fi >= len(A): return 0
    x = A[fi] - A[fi].mean(); y = S[s][j] - S[s][j].mean(); return float(x @ y / (np.linalg.norm(x) * np.linalg.norm(y) + 1e-9))
m = []
for g in segs:
    if m and m[-1]['s'] == g['s'] and abs(m[-1]['off'] - g['off']) < 0.03: m[-1]['o1'] = g['o1']
    else: m.append(dict(g))
bounds = []
for i in range(len(m) - 1):
    p, q = m[i], m[i + 1]
    lo, hi = max(p['o0'], q['o0'] - 0.6), min(q['o1'], p['o1'] + 0.6)
    fis = list(range(int(lo * SR / HOP), int(hi * SR / HOP)))
    loud = [f < len(Ae) and Ae[f] > -45 for f in fis]
    sp = [sim(f, p['s'], p['off']) if l else 0 for f, l in zip(fis, loud)]
    sq = [sim(f, q['s'], q['off']) if l else 0 for f, l in zip(fis, loud)]
    sc = np.array([sum(sp[:k]) + sum(sq[k:]) for k in range(len(fis))]) if fis else np.array([0])
    ks = np.flatnonzero(sc >= sc.max() - 1e-6); k = int(ks[len(ks) // 2])
    bounds.append(fis[k] * HOP / SR if fis else (p['o1'] + q['o0']) / 2)
cuts = []
for i, g in enumerate(m):
    s0 = bounds[i - 1] if i else g['o0']; s1 = bounds[i] if i < len(bounds) else g['o1']
    cuts.append({'src': g['s'], 'o0': round(s0, 2), 'o1': round(s1, 2), 's0': round(s0 + g['off'], 2), 's1': round(s1 + g['off'], 2)})
out = {'cuts': cuts}
if a.lay:
    lay = json.load(open(a.lay)).get('lay') or [{'offset': 0}]
    out['kept'] = [{'src': c['src'], 'start': round(lay[c['src']]['offset'] + c['s0'], 3), 'end': round(lay[c['src']]['offset'] + c['s1'], 3)} for c in cuts]
print(f'{len(E) / SR:.2f}秒・{len(cuts)}か所')
for c in cuts: print(f"  編集 {c['o0']:6.2f}-{c['o1']:6.2f}  ← 元の{c['src'] + 1}本目 {c['s0']:6.2f}-{c['s1']:6.2f}")
if a.out: json.dump(out, open(a.out, 'w'), indent=1)
