"""自動カットの自然さを測るための、実際の撮影に近い話し方のテスト動画を作る。

  python3 tests/e2e/make-ja-natural.py OUT_DIR [--seed N]

make-ja-beauty.py との違い（iPhone で撮った美容師の解説に近づける）:
- 文の途中に「考えながら切る」長い間（0.6〜1.6秒）が入る。句の間・文の間の長さもばらばら
- 語尾が弱く消えていく（ます・です の「す」など）。正解の時刻は、弱い語尾まで含めて記録する
- 文の前に小さな息の音。文ごとに声の大きさが違う（±5dB）。部屋の雑音とエアコンのような低い音
- 作業中のハサミの音は大きく、不規則（0.2〜0.6秒おき）。話している途中にもハサミの音が入る
- つなぎ言葉だけの発言（えーと）、言い直し、前の文に続く文（「なので、…」）
- 偽の文字起こし用に、Whisper のように少しずれた時刻（asrStart, asrEnd）も記録する
正解は OUT_DIR/natural-transcript.json（文ごと: start, end, text, kind, retake, phrases, asrStart, asrEnd）。
"""
import argparse, json, os, subprocess, wave
import numpy as np
import pyopenjtalk

ap = argparse.ArgumentParser()
ap.add_argument('out')
ap.add_argument('--seed', type=int, default=7)
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)
RATE = 48000
rng = np.random.default_rng(args.seed)

# (読み上げ文, 正解の字幕, 種類)。'|' は文の途中の長い間（考えながら話す）
SCRIPT = [
    ('皆さんこんにちは。', None, 'say'),
    ('今日は、前下がりのショートボブを、|切っていきます。', '今日は前下がりのショートボブを切っていきます。', 'say'),
    ('まずは、全体を四つに、ブロッキングします。', '全体を四つにブロッキングします。', 'say'),
    ('えーと、', None, 'filler'),
    ('襟足は、指一本分のスライスで、|パネルを0度に引き出します。', '襟足は指一本分のスライスで、パネルを0度に引き出します。', 'say'),
    (('action', 6.5), None, None),
    ('ここがガイドになるので、|毛先を、まっすぐ切りそろえます。', 'ここがガイドになるので、毛先をまっすぐ切りそろえます。', 'say'),
    ('なので、ここは慎重に切ってください。', 'なので、ここは慎重に切ってください。', 'say'),
    (('action', 5.0), None, None),
    ('サイドは、前下がりのラインを意識して、45度でカットします。', 'サイドは前下がりのラインを意識して、45度でカットします。', 'say'),
    ('次にすきバサミで、', None, 'retake'),
    ('あ、すみません、言い直します。', None, 'cue'),
    ('次に、すきバサミで、|毛量調整をしていきます。', '次にすきバサミで毛量調整をしていきます。', 'say'),
    (('action', 7.0), None, None),
    ('量感を見ながら、チョップカットで、毛先をなじませます。', '量感を見ながら、チョップカットで毛先をなじませます。', 'say'),
    ('これで仕上がりです。', 'これで仕上がりです。', 'say'),
    ('軽さのある、ショートボブになりました。', '軽さのある、ショートボブになりました。', 'say'),
]


def tts(text, speed):
    x, sr = pyopenjtalk.tts(text, speed=speed)
    x = (x / 32768.0 * 0.6).astype(np.float32)
    if sr != RATE:
        x = np.interp(np.arange(0, len(x), sr / RATE), np.arange(len(x)), x).astype(np.float32)
    on = np.where(np.abs(x) > 0.004)[0]
    x = x[on[0]:on[-1] + 1] if len(on) else x
    # 語尾を弱くする（最後の 0.18 秒で -18dB まで下がる。実際の話し方の「消えていく語尾」）
    n = min(len(x) // 3, int(0.18 * RATE))
    if n > 0:
        x[-n:] *= np.geomspace(1.0, 0.125, n).astype(np.float32)
    return x


def breath(n):
    b = np.convolve(rng.standard_normal(n), np.ones(24) / 24, mode='same')
    return (b * np.hanning(n) * 0.012).astype(np.float32)


parts, truth, action, snips = [], [], [], []
t = 0.9
for say, text, kind in SCRIPT:
    if isinstance(say, tuple):
        action.append((t, t + say[1]))
        k = t + 0.3
        while k < t + say[1] - 0.2:
            snips.append((k, 0.22 + 0.1 * rng.random()))
            k += 0.2 + 0.4 * rng.random()
        t += say[1] + 0.3 + 0.8 * rng.random()
        continue
    speed = 0.95 + 0.15 * rng.random()
    vol = 10 ** ((rng.random() * 10 - 5) / 20)
    if rng.random() < 0.6:
        parts.append((t - 0.35, breath(int(0.25 * RATE))))
    phrases = []
    segs = say.split('|')
    for si, seg in enumerate(segs):
        ps = [q for q in seg.replace('、', '、^').split('^') if q]
        for pi, p in enumerate(ps):
            x = tts(p, speed) * vol
            parts.append((t, x))
            phrases.append({'start': round(t, 3), 'end': round(t + len(x) / RATE, 3), 'text': p})
            t += len(x) / RATE
            if pi < len(ps) - 1:
                t += 0.06 + 0.22 * rng.random()  # 読点の間
        if si < len(segs) - 1:
            t += 0.6 + 1.0 * rng.random()       # 考えながら話す長い間
    truth.append({'start': phrases[0]['start'], 'end': phrases[-1]['end'], 'text': text or say.replace('|', ''),
                  'kind': kind, 'retake': kind in ('retake', 'cue', 'filler'), 'phrases': phrases})
    # 話していないときのハサミの音（話の合間に少し切る）
    gap = 0.4 + 2.6 * rng.random() if kind != 'filler' else 0.5
    if gap > 1.8:
        snips.append((t + 0.7, 0.2))
    t += gap
DURATION = round(t + 1.2, 2)

# 話している途中のハサミの音（作業しながら説明する）
for tr in truth[4:6]:
    snips.append(((tr['start'] + tr['end']) / 2, 0.12))

# Whisper のように少しずれた時刻（出始めは早め、終わりは遅め。次の文とは重ならない）
for i, tr in enumerate(truth):
    nxt = truth[i + 1]['start'] if i + 1 < len(truth) else DURATION
    prv = truth[i - 1]['end'] if i else 0
    tr['asrStart'] = round(max(prv, tr['start'] - 0.05 - 0.35 * rng.random()), 2)
    tr['asrEnd'] = round(min(nxt - 0.02, tr['end'] + 0.5 * rng.random()), 2)

n = int(DURATION * RATE)
audio = np.zeros(n, dtype=np.float32)
for start, x in parts:
    i = int(start * RATE)
    audio[i:i + len(x)] += x[:max(0, n - i)]
tt = np.arange(n) / RATE
audio += (rng.standard_normal(n) * 0.0025).astype(np.float32)          # 部屋の雑音
audio += (0.002 * np.sin(2 * np.pi * 120 * tt)).astype(np.float32)      # エアコンのような低い音
for s, a in snips:
    i, m = int(s * RATE), int(0.015 * RATE)
    audio[i:i + m] += (rng.standard_normal(m) * a * np.hanning(m)).astype(np.float32)

name = 'natural'
wav = os.path.join(args.out, name + '.wav')
with wave.open(wav, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(RATE)
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    w.writeframes(np.repeat(pcm[:, None], 2, axis=1).tobytes())

# 映像: make-ja-beauty.py と同じ（縦 1080×1920・回転情報つき。作業中は手元の図形が大きく動く）
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
