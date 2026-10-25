"""書き出した動画の自動カットを、正解の発話時刻と実際の音声で評価する。

  python3 tests/e2e/eval-cuts.py OUT.mp4 TIMELINE.json TRANSCRIPT.json

TIMELINE.json は run.mjs が保存する timeline-*.json（場面ごとの pieces を含む）。
TRANSCRIPT.json は make-ja-natural.py / make-ja-beauty.py の正解（句ごとの時刻 phrases を含む）。

測るもの:
- 言葉の欠け: 句の頭・語尾が、残した範囲から 20ms 以上はみ出しているか
- 文の途中で切れていないか（文の一部の句だけが残っている）
- 書き出した動画での「間」: 文の中の句と句の間・文と文の間の長さ（長すぎる間・詰めすぎた間）
- つなぎ目の音: カットの境目で音が急に途切れていないか（周りの雑音より 20dB 以上下がる瞬間）
"""
import json, subprocess, sys
import numpy as np

out_mp4, tl_path, tr_path = sys.argv[1:4]
FPS = 30
tl = json.load(open(tl_path))
truth = json.load(open(tr_path))
pieces = [{'s': p['srcStart'], 'e': p['srcStart'] + p['frames'] / FPS, 'o': p['outStart']} for c in tl for p in c['pieces']]


def covered(a, b):
    return sum(max(0, min(b, p['e']) - max(a, p['s'])) for p in pieces)


def to_out(t):
    for p in pieces:
        if p['s'] - 1e-3 <= t <= p['e'] + 1e-3:
            return p['o'] + (t - p['s'])
    return None


head_clip, tail_clip, partial_sent, kept = [], [], [], []
for si, sent in enumerate(truth):
    states = []
    for ph in sent['phrases']:
        L = ph['end'] - ph['start']
        c = covered(ph['start'], ph['end'])
        if c < 0.02:
            states.append('out'); continue
        states.append('in')
        if covered(ph['start'], ph['start'] + 0.02) < 0.019:
            head_clip.append(ph['text'])
        if covered(ph['end'] - 0.02, ph['end']) < 0.019:
            tail_clip.append(ph['text'])
        if c >= L - 0.02:
            kept.append({'sent': si, 'kind': sent.get('kind', 'say'), 'text': ph['text'], 'start': ph['start'], 'end': ph['end'],
                         'os': to_out(ph['start']), 'oe': to_out(ph['end'])})
    if 'in' in states and 'out' in states:
        partial_sent.append(sent['text'])

# 書き出した動画で続けて聞こえる句と句の間
inner, between, src_inner, src_between, work = [], [], [], [], []
for a, b in zip(kept, kept[1:]):
    if a['oe'] is None or b['os'] is None:
        continue
    g = b['os'] - a['oe']
    if a['sent'] == b['sent']:
        inner.append(g); src_inner.append(b['start'] - a['end'])
    elif any(p['o'] >= a['oe'] - 0.05 and p['o'] + (p['e'] - p['s']) <= b['os'] + 0.05 and p['e'] - p['s'] >= 1.0 for p in pieces):
        work.append(g)  # 間に作業場面（話していない場面）をはさんでいる。これは「間」ではない
    else:
        between.append(g); src_between.append(b['start'] - a['end'])

# つなぎ目の音
pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', out_mp4, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
                     capture_output=True, check=True).stdout
x = np.frombuffer(pcm, dtype=np.float32)
SR = 48000
W = int(0.002 * SR)


def env(a, b):
    seg = x[max(0, int(a * SR)):max(0, int(b * SR))]
    n = len(seg) // W
    return np.sqrt((seg[:n * W].reshape(n, W) ** 2).mean(axis=1) + 1e-12) if n else np.array([1e-6])


dips, joins = [], 0
for p, q in zip(pieces, pieces[1:]):
    if abs(q['s'] - p['e']) < 1.5 / FPS:
        continue  # 元の動画でつながっている（カットしていない）
    joins += 1
    t = q['o']
    around = env(t - 0.3, t + 0.3)
    near = env(t - 0.03, t + 0.03)
    ref = np.median(around)
    dips.append(20 * np.log10(near.min() / ref))


def stat(a):
    if not a:
        return 'なし'
    a = np.array(a)
    return f'平均 {a.mean():.2f}s 中央値 {np.median(a):.2f}s 最小 {a.min():.2f}s 最大 {a.max():.2f}s（{len(a)}か所）'


dur = pieces[-1]['o'] + (pieces[-1]['e'] - pieces[-1]['s'])
said = sum(k['end'] - k['start'] for k in kept)
print(f'完成 {dur:.1f}秒 / 話している割合 {said / dur * 100:.0f}% / 句 {len(kept)}個 / カットのつなぎ目 {joins}か所')
print(f'言葉の頭が欠けた句: {len(head_clip)} {head_clip}')
print(f'語尾が欠けた句: {len(tail_clip)} {tail_clip}')
print(f'途中で切れた文: {len(partial_sent)} {partial_sent}')
print(f'文の中の間（書き出し後）: {stat(inner)}')
print(f'  元の動画: {stat(src_inner)}')
print(f'  詰めすぎ(<0.05s): {sum(g < 0.05 for g in inner)} / 長すぎ(>0.8s): {sum(g > 0.8 for g in inner)}')
print(f'文と文の間（書き出し後）: {stat(between)}')
print(f'  元の動画: {stat(src_between)}')
print(f'  詰めすぎ(<0.25s): {sum(g < 0.25 for g in between)} / 長すぎ(>1.2s): {sum(g > 1.2 for g in between)}')
print(f'作業場面をはさんだ文と文: {len(work)}か所')
d = np.array(dips) if dips else np.array([0.0])
print(f'つなぎ目の音の落ち込み（周りの雑音との差）: 中央値 {np.median(d):.1f}dB 最小 {d.min():.1f}dB / 途切れ(<-20dB) {int((d < -20).sum())}か所')
