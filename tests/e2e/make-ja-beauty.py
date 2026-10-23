"""字幕の精度・タイミングを測るための、美容解説の日本語音声つきテスト動画を作る。

  python3 tests/e2e/make-ja-beauty.py OUT_DIR [--variant clean|salon]

pyopenjtalk-plus（日本語の音声合成）と ffmpeg が必要。
- 美容の専門用語・つなぎ言葉・言い直し・短い発言・無言のカット作業を含む
- 読点ごとの句を別々に合成してつなぐので、句ごとの正解時刻がわかる
- salon: 文と文の間が短く、やや早口で、ドライヤーのような雑音と音楽が入る
正解は OUT_DIR/<名前>-transcript.json（文ごと: start, end, text, retake, phrases）。
映像は合成（人物は映らない）。手元に見立てた図形が画面の下半分で動く。
"""
import argparse, json, os, subprocess, wave
import numpy as np
import pyopenjtalk

ap = argparse.ArgumentParser()
ap.add_argument('out')
ap.add_argument('--variant', choices=['clean', 'salon'], default='clean')
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)
RATE = 48000
salon = args.variant == 'salon'
SPEED = 1.15 if salon else 1.0
GAP_SENT = 0.35 if salon else 0.8   # 文と文の間
GAP_PHRASE = 0.12                   # 読点の間（自動カットでは切れない程度の短さ）

# (読み上げ文, 正解の字幕, 種類)。種類: 'say' 普通 / 'retake' 言い直し前 / 'cue' 言い直しの合図 / ('action', 秒)
SCRIPT = [
    ('皆さんこんにちは。', '皆さんこんにちは。', 'say'),
    ('今日は、ショートボブのカットを解説します。', '今日はショートボブのカットを解説します。', 'say'),
    ('まずは全体を、えーと、四つにブロッキングしていきます。', 'まずは全体を四つにブロッキングしていきます。', 'say'),
    ('襟足は、指一本分のスライスで、パネルを0度に引き出します。', '襟足は指一本分のスライスで、パネルを0度に引き出します。', 'say'),
    ('ここがガイドになるので、毛先をまっすぐ切りそろえます。', 'ここがガイドになるので、毛先をまっすぐ切りそろえます。', 'say'),
    (('action', 7.0), None, None),
    ('はい、オッケーです。', 'はい、オッケーです。', 'say'),
    ('サイドは、前下がりのラインを意識して、45度でカットします。', 'サイドは前下がりのラインを意識して、45度でカットします。', 'say'),
    ('もみあげは、短くなりすぎないように注意してください。', 'もみあげは短くなりすぎないように注意してください。', 'say'),
    ('トップは、レイヤーを入れて、丸みのあるシルエットを作ります。', 'トップはレイヤーを入れて、丸みのあるシルエットを作ります。', 'say'),
    (('action', 6.0), None, None),
    ('次にすきバサミで、', None, 'retake'),
    ('あ、すみません、言い直します。', None, 'cue'),
    ('次に、すきバサミで毛量調整をしていきます。', '次にすきバサミで毛量調整をしていきます。', 'say'),
    ('量感を見ながら、チョップカットで、毛先をなじませます。', '量感を見ながら、チョップカットで毛先をなじませます。', 'say'),
    (('action', 6.0), None, None),
    ('グラデーションがつながっているか、確認してください。', 'グラデーションがつながっているか、確認してください。', 'say'),
    ('これで仕上がりです。', 'これで仕上がりです。', 'say'),
    ('軽さのある、ショートボブになりました。', '軽さのある、ショートボブになりました。', 'say'),
]


def tts(text):
    x, sr = pyopenjtalk.tts(text, speed=SPEED)
    x = (x / 32768.0 * 0.6).astype(np.float32)
    if sr != RATE:
        x = np.interp(np.arange(0, len(x), sr / RATE), np.arange(len(x)), x).astype(np.float32)
    # 前後の無音を詰める（句の正確な開始・終了を正解にするため）
    on = np.where(np.abs(x) > 0.01)[0]
    return x[on[0]:on[-1] + 1] if len(on) else x


parts, truth, action = [], [], []
t = 0.7
for say, text, kind in SCRIPT:
    if isinstance(say, tuple):
        action.append((t, t + say[1]))
        t += say[1] + 0.4
        continue
    phrases = []
    for p in [q for q in say.replace('、', '、|').split('|') if q]:
        x = tts(p)
        parts.append((t, x))
        phrases.append({'start': round(t, 3), 'end': round(t + len(x) / RATE, 3), 'text': p})
        t += len(x) / RATE + GAP_PHRASE
    t -= GAP_PHRASE
    truth.append({'start': phrases[0]['start'], 'end': phrases[-1]['end'], 'text': text or say,
                  'retake': kind in ('retake', 'cue'), 'phrases': phrases})
    t += GAP_SENT
DURATION = round(t + 1.5, 2)

audio = np.zeros(int(DURATION * RATE), dtype=np.float32)
for start, x in parts:
    i = int(start * RATE)
    audio[i:i + len(x)] += x
rng = np.random.default_rng(3)
n = len(audio)
tt = np.arange(n) / RATE
if salon:
    # ドライヤーのような雑音（帯域を絞ったノイズ）と、小さな音楽（和音）
    noise = np.convolve(rng.standard_normal(n), np.ones(8) / 8, mode='same')
    audio += (noise * 0.03).astype(np.float32)
    chord = sum(np.sin(2 * np.pi * f * tt) for f in (220, 277.2, 329.6, 440)) / 4
    beat = 0.5 + 0.5 * np.sin(2 * np.pi * 1.6 * tt)
    audio += (chord * beat * 0.025).astype(np.float32)
else:
    audio += (rng.standard_normal(n) * 0.002).astype(np.float32)
for s, e in action:  # ハサミの音
    for k in np.arange(s, e, 0.6):
        i = int(k * RATE)
        audio[i:i + 400] += (rng.standard_normal(400) * 0.05 * np.hanning(400)).astype(np.float32)

name = f'beauty-{args.variant}'
wav = os.path.join(args.out, name + '.wav')
with wave.open(wav, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(RATE)
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    w.writeframes(np.repeat(pcm[:, None], 2, axis=1).tobytes())

# 映像: 1080×1920 の縦（回転情報つきの横長で記録）。作業中は手元の図形が大きく動く
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
                '-c:a', 'aac', '-b:a', '128k', '-shortest', tmp], check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-display_rotation', '90', '-i', tmp, '-c', 'copy', out], check=True)
os.remove(tmp)
with open(os.path.join(args.out, name + '-transcript.json'), 'w') as f:
    json.dump(truth, f, ensure_ascii=False, indent=1)
print(out, DURATION)
