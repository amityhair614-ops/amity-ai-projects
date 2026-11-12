"""言い直し・くり返しの判断を確かめるための、正解のラベルつきテスト動画を作る。

  python3 tests/e2e/make-ja-retakes.py OUT_DIR [--seed N]

台本の書き方（SCRIPT）:
- [[...]] は取り除くべき句（冒頭の訂正の言葉・文の中のくり返し）。'|' は考えながら話す長い間
- 種類: keep（残す）/ retake（訂正の前の発言。文ごと取り除く）/ repeat（同じ説明の1回目。文ごと取り除く）/
  filler（つなぎ言葉だけ。取り除く）/ similar（同じ用語を使った別の技術の説明。残す）/ ('action', 秒)
- asr: 偽の文字起こしが返す文（文字起こしの間違いを含める。なければ話した文のまま）

正解は OUT_DIR/retakes-transcript.json。句ごとに del（取り除くべきか）と cat（種類）がある。
映像・音声の作り方は make-ja-natural.py と同じ（弱い語尾・息・部屋の雑音・ハサミの音）。
"""
import argparse, json, os, re, subprocess, wave
import numpy as np
import pyopenjtalk

ap = argparse.ArgumentParser()
ap.add_argument('out')
ap.add_argument('--seed', type=int, default=5)
ap.add_argument('--set', type=int, default=1, help='台本の種類（1 または 2。2 は言い方・文字起こしの間違いを変えた別の台本）')
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)
RATE = 48000
rng = np.random.default_rng(args.seed)

SCRIPT = [
    ('皆さんこんにちは。', 'keep', None),
    ('今日は、耳後ろの、軽さの出し方を解説します。', 'keep', None),
    ('まずは、ここを軽くします。', 'retake', None),
    ('[[いや、]][[ここじゃなくて、]]耳後ろを、軽くします。', 'keep', None),
    (('action', 5.0), None, None),
    ('パネルを45度に引き出して、カットします。', 'repeat', None),
    ('パネルを45度に引き出して、カットします。', 'keep', None),
    ('サイドは、パネルを45度に引き出して、カットします。', 'similar', None),
    ('バックも、パネルを45度に引き出して、カットします。', 'similar', 'バックも、パネルを45度に引き出してカットします。'),
    ('[[このパネルを、]]このパネルを、90度で引き出します。', 'keep', None),
    (('action', 5.0), None, None),
    ('えーと、', 'filler', None),
    ('毛先を、5ミリだけ切ります。', 'keep', None),
    ('毛先を、1センチ切ります。', 'similar', None),
    ('次は、トップを、すきバサミで軽くします。', 'keep', '次は、トップを、好きバサミで軽くします。'),
    ('すきバサミの刃は、浅めに入れてください。', 'keep', None),
    ('ここが一番、大事なポイントです。', 'repeat', None),
    ('ここが一番、大事なポイントです。', 'keep', 'ここが一番大事なポイントです。'),
    ('襟足は、指一本分の、スライスで取ります。', 'keep', '襟足は指一本分のスライスで取ります。'),
    ('えりあしは、指二本分のスライスで、取り直します。', 'similar', 'えりあしは指二本分のスライスで取り直します。'),
    (('action', 4.0), None, None),
    ('仕上がりは、|軽さのあるシルエットになりました。', 'keep', None),
]


# 2つ目の台本: 訂正の言い方・文の途中の訂正・文字起こしの間違いを含むくり返し・用語だけが違う説明を増やす
SCRIPT2 = [
    ('はい、では始めていきます。', 'keep', None),
    ('最初に、前髪から切ります。', 'retake', None),
    ('[[あ、違う、]]襟足から、切っていきます。', 'keep', 'あ、違う、襟足から切っていきます。'),
    ('襟足は、0度で引き出して、まっすぐ切ります。', 'keep', None),
    ('襟足は、45度で引き出して、まっすぐ切ります。', 'similar', None),
    (('action', 5.0), None, None),
    ('右サイドは、前下がりに切ります。', 'keep', None),
    ('左サイドも、前下がりに切ります。', 'similar', None),
    ('トップは、前上がりに切ります。', 'similar', None),
    ('ここで、毛量を、半分くらいに減らします。', 'repeat', 'ここで、猛量を半分くらいに減らします。'),
    ('ここで、毛量を、半分くらいに減らします。', 'keep', None),
    ('[[ブラシで、]][[ではなくて、]]コームで、とかします。', 'keep', None),
    ('スライスは、[[一センチ、]][[すみません、]]二センチの幅で取ります。', 'keep', None),
    (('action', 5.0), None, None),
    ('[[ここで、]]ここで、ドライヤーで乾かします。', 'keep', None),
    ('乾かしてから、もう一度、長さを確認します。', 'keep', None),
    ('最後に、もう一度、長さを確認します。', 'similar', None),
    ('レイヤーを入れると、動きが出ます。', 'keep', 'レーヤーを入れると、動きが出ます。'),
    ('グラデーションを入れると、重さが残ります。', 'similar', None),
    ('これで完成です。', 'keep', None),
]
if args.set == 2:
    SCRIPT = SCRIPT2


def tts(text, speed):
    x, sr = pyopenjtalk.tts(text, speed=speed)
    x = (x / 32768.0 * 0.6).astype(np.float32)
    if sr != RATE:
        x = np.interp(np.arange(0, len(x), sr / RATE), np.arange(len(x)), x).astype(np.float32)
    on = np.where(np.abs(x) > 0.004)[0]
    x = x[on[0]:on[-1] + 1] if len(on) else x
    n = min(len(x) // 3, int(0.18 * RATE))
    if n > 0:
        x[-n:] *= np.geomspace(1.0, 0.125, n).astype(np.float32)
    return x


def breath(n):
    b = np.convolve(rng.standard_normal(n), np.ones(24) / 24, mode='same')
    return (b * np.hanning(n) * 0.012).astype(np.float32)


parts, truth, action, snips = [], [], [], []
t = 0.9
for say, kind, asr in SCRIPT:
    if isinstance(say, tuple):
        action.append((t, t + say[1]))
        k = t + 0.3
        while k < t + say[1] - 0.2:
            snips.append((k, 0.22 + 0.1 * rng.random()))
            k += 0.2 + 0.4 * rng.random()
        t += say[1] + 0.3 + 0.8 * rng.random()
        continue
    speed = 0.95 + 0.15 * rng.random()
    vol = 10 ** ((rng.random() * 8 - 4) / 20)
    if rng.random() < 0.5:
        parts.append((t - 0.35, breath(int(0.25 * RATE))))
    phrases = []
    for si, seg in enumerate(say.split('|')):
        # [[...]] の印をつけたまま、読点ごとの句に分ける
        tokens = re.findall(r'\[\[.*?\]\]|[^\[]+', seg)
        ps = []
        for tok in tokens:
            dele = tok.startswith('[[')
            body = tok[2:-2] if dele else tok
            for q in [q for q in body.replace('、', '、^').split('^') if q]:
                ps.append((q, dele))
        for pi, (p, dele) in enumerate(ps):
            x = tts(p, speed) * vol
            parts.append((t, x))
            whole_del = kind in ('retake', 'repeat', 'filler')
            phrases.append({'start': round(t, 3), 'end': round(t + len(x) / RATE, 3), 'text': p,
                            'del': dele or whole_del, 'cat': kind if whole_del else ('stutter' if dele and pi + 1 < len(ps) and ps[pi + 1][0] == p else 'cue' if dele else kind)})
            t += len(x) / RATE
            if pi < len(ps) - 1:
                t += (0.22 + 0.15 * rng.random()) if dele else (0.06 + 0.22 * rng.random())  # 訂正の言葉の後は少し間があく
        if si < len(say.split('|')) - 1:
            t += 0.6 + 1.0 * rng.random()
    spoken = ''.join(p['text'] for p in phrases)
    truth.append({'start': phrases[0]['start'], 'end': phrases[-1]['end'], 'text': asr or spoken, 'spoken': spoken,
                  'kind': kind, 'retake': kind in ('retake', 'repeat', 'filler'), 'phrases': phrases})
    t += 0.5 + 1.6 * rng.random() if kind != 'filler' else 0.5
DURATION = round(t + 1.2, 2)

for i, tr in enumerate(truth):
    nxt = truth[i + 1]['start'] if i + 1 < len(truth) else DURATION
    prv = truth[i - 1]['end'] if i else 0
    tr['asrStart'] = round(max(prv, tr['start'] - 0.05 - 0.3 * rng.random()), 2)
    tr['asrEnd'] = round(min(nxt - 0.02, tr['end'] + 0.4 * rng.random()), 2)

n = int(DURATION * RATE)
audio = np.zeros(n, dtype=np.float32)
for start, x in parts:
    i = int(start * RATE)
    audio[i:i + len(x)] += x[:max(0, n - i)]
tt = np.arange(n) / RATE
audio += (rng.standard_normal(n) * 0.0025).astype(np.float32)
audio += (0.002 * np.sin(2 * np.pi * 120 * tt)).astype(np.float32)
for s, a in snips:
    i, m = int(s * RATE), int(0.015 * RATE)
    audio[i:i + m] += (rng.standard_normal(m) * a * np.hanning(m)).astype(np.float32)

name = 'retakes' if args.set == 1 else f'retakes{args.set}'
wav = os.path.join(args.out, name + '.wav')
with wave.open(wav, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(RATE)
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    w.writeframes(np.repeat(pcm[:, None], 2, axis=1).tobytes())

W, H = 1920, 1080
DW, DH = H, W
moving = '+'.join(f'between(t,{s:.2f},{e:.2f})' for s, e in action)
amp = f'if({moving},1,0.01)'
dx = f'({DW*0.5:.0f}+{DW*0.22:.0f}*{amp}*sin(t*5))'
dy = f'({DH*0.68:.0f}+{DH*0.08:.0f}*{amp}*cos(t*7))'
box = DW // 8
rx, ry = f'{DH}-{dy}-{box}/2', f'{dx}-{box}/6'
font = '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf'
vf = (f"[0][1]overlay=x='{rx}':y='{ry}'"
      f",drawtext=fontfile={font}:text='%{{pts\\:hms}}':x=20:y=20:fontsize=54:fontcolor=white[v]")
tmp = os.path.join(args.out, name + '.tmp.mov')
out = os.path.join(args.out, name + '.mov')
subprocess.run(['ffmpeg', '-v', 'error', '-y',
                '-f', 'lavfi', '-i', f'color=c=0x6b5a50:s={W}x{H}:r=30:d={DURATION}',
                '-f', 'lavfi', '-i', f'color=c=0xd8d8e0:s={box}x{box // 3}:r=30:d={DURATION}',
                '-i', wav, '-filter_complex', vf, '-map', '[v]', '-map', '2:a',
                '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30',
                '-c:a', 'aac', '-b:a', '160k', '-shortest', tmp], check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-display_rotation', '90', '-i', tmp, '-c', 'copy', out], check=True)
os.remove(tmp)
with open(os.path.join(args.out, name + '-transcript.json'), 'w') as f:
    json.dump(truth, f, ensure_ascii=False, indent=1)
print(out, DURATION)
