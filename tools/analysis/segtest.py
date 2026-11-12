# 区切り方を変えて ReazonSpeech（アプリと同じ int8 のモデル）で読み、素材ごとの文字と時刻を出す（短い窓の試験）。
#   python3 tools/analysis/segtest.py --model DIR out.json a.wav b.wav ... [--max 8] [--join 0.3] [--thr 10] [--pad 0.4] [--min-seg 1.5]
# - DIR: sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01（encoder/decoder/joiner-epoch-99-avg-1.int8.onnx・tokens.txt）
# - 区切り方はアプリの shortAsrWindows（js/plan.js）と同じ: 音量の下から15%の値 + thr dB を超える所を声とし、join 秒未満の間・
#   min-seg 秒未満の短い区間は max 秒までつなぐ。max を超える所は一番静かな所で分ける。前後に pad 秒（となりと重ならない）
# - 出すもの: { chars: { 素材名: [[文字, 時刻]] }, segs: { 素材名: [[始まり, 終わり]] } }（score.py の入力）
# 必要: pip install sherpa-onnx numpy
import argparse, json, os, wave, numpy as np, sherpa_onnx
ap = argparse.ArgumentParser(); ap.add_argument('--model', required=True); ap.add_argument('out'); ap.add_argument('wavs', nargs='+')
for k, v in (('max', 8), ('join', 0.3), ('thr', 10), ('pad', 0.4), ('min-seg', 1.5)): ap.add_argument('--' + k, type=float, default=v)
a = ap.parse_args(); M = a.model.rstrip('/') + '/'
rec = sherpa_onnx.OfflineRecognizer.from_transducer(encoder=M + 'encoder-epoch-99-avg-1.int8.onnx', decoder=M + 'decoder-epoch-99-avg-1.int8.onnx', joiner=M + 'joiner-epoch-99-avg-1.int8.onnx', tokens=M + 'tokens.txt', num_threads=1)
F = 0.02
def segments(x):
    hop = int(16000 * F); e = np.array([20 * np.log10(np.sqrt(np.mean(x[i:i + hop] ** 2)) + 1e-9) for i in range(0, len(x) - hop, hop)])
    on = e > np.percentile(e, 15) + a.thr; regs = []; i = 0
    while i < len(on):
        if not on[i]: i += 1; continue
        j = i
        while j < len(on) and on[j]: j += 1
        if regs and (i - regs[-1][1]) * F < 0.25: regs[-1][1] = j
        else: regs.append([i, j])
        i = j
    regs = [r for r in regs if (r[1] - r[0]) * F >= 0.12]; groups = []
    for s, t in regs:
        if groups and (t - groups[-1][0]) * F <= a.max and ((s - groups[-1][1]) * F < a.join or (groups[-1][1] - groups[-1][0]) * F < a.min_seg or (t - s) * F < a.min_seg): groups[-1][1] = t
        else: groups.append([s, t])
    res = []
    for s, t in groups:
        while (t - s) * F > a.max:
            lo, hi = s + int(a.max * 0.5 / F), s + int(a.max / F); k = lo + int(np.argmin(e[lo:hi])); res.append([s, k]); s = k
        res.append([s, t])
    out = []
    for k, (s, t) in enumerate(res):
        p, q = s * F - a.pad, t * F + a.pad + 0.05
        if k: p = max(p, (res[k - 1][1] * F + s * F) / 2)
        if k + 1 < len(res): q = min(q, (t * F + res[k + 1][0] * F) / 2)
        out.append((max(0, p), min(len(x) / 16000, q)))
    return out
out = {'chars': {}, 'segs': {}}
for path in a.wavs:
    name = os.path.splitext(os.path.basename(path))[0]
    w = wave.open(path); x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    chars = []; segs = segments(x)
    for s, t in segs:
        st = rec.create_stream(); st.accept_waveform(16000, x[int(s * 16000):int(t * 16000)]); rec.decode_stream(st)
        chars += [[c, round(s + tt, 2)] for c, tt in zip(st.result.tokens, st.result.timestamps)]
    out['chars'][name] = chars; out['segs'][name] = [[round(s, 2), round(t, 2)] for s, t in segs]
    print(name, len(segs), '区間', len(chars), '文字')
json.dump(out, open(a.out, 'w'), ensure_ascii=False)
