"""日本語の解説音声が入ったテスト動画を作る（字幕AIの確認用）。

  python3 tests/e2e/make-ja-sample.py OUT_DIR [--width 1920 --height 1080 --rotate 90 --bitrate 0]

pyopenjtalk-plus（日本語の音声合成）と ffmpeg が必要。
美容の専門用語・つなぎ言葉・言い直し・無言のカット作業を含む約80秒の動画と、
正解の字幕 OUT_DIR/ja-sample-transcript.json を作る。
映像は合成（人物は映らない）。手元に見立てた「ハサミ」の図形が画面の下半分で動く。
"""
import argparse, json, os, subprocess, wave
import numpy as np
import pyopenjtalk

ap = argparse.ArgumentParser()
ap.add_argument('out')
ap.add_argument('--width', type=int, default=1920)
ap.add_argument('--height', type=int, default=1080)
ap.add_argument('--rotate', type=int, default=90, help='iPhoneの縦撮影と同じく、横長で記録して回転情報で縦に表示する')
ap.add_argument('--bitrate', default=None)
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)
RATE = 48000

# (開始秒, 読み上げ文, 正解の字幕)。None の行は無言のカット作業（終了秒）
SCRIPT = [
    (0.6, '皆さんこんにちは。今日は前下がりボブのカットを解説します。', '皆さんこんにちは。今日は前下がりボブのカットを解説します。'),
    (6.5, 'まずは、えーと、耳後ろでブロッキングを取っていきます。', 'まずは耳後ろでブロッキングを取っていきます。'),
    (13.0, 'バックは、指一本分のスライスで', None),  # 言い直し前
    (16.2, 'すみません、言い直します。', None),
    (19.0, 'バックは、指一本分のスライスで、パネルを0度に引き出します。', 'バックは指一本分のスライスで、パネルを0度に引き出します。'),
    (26.0, None, 34.0),
    (34.5, 'ガイドに合わせて、毛先を切りそろえます。', 'ガイドに合わせて、毛先を切りそろえます。'),
    (40.0, 'サイドは前下がりのラインを意識して、45度でカットします。', 'サイドは前下がりのラインを意識して、45度でカットします。'),
    (47.0, None, 54.0),
    (54.5, '最後にセニングで量感を調整して、軽さを出します。', '最後にセニングで量感を調整して、軽さを出します。'),
    (61.0, None, 67.0),
    (67.5, 'これで仕上がりです。丸みのあるシルエットになりました。', 'これで仕上がりです。丸みのあるシルエットになりました。'),
]
DURATION = 76.0

audio = np.zeros(int(DURATION * RATE), dtype=np.float32)
rng = np.random.default_rng(1)
audio += (rng.standard_normal(len(audio)) * 0.002).astype(np.float32)  # 部屋の小さな雑音
truth, speech, action = [], [], []
for start, text, third in SCRIPT:
    if text is None:
        action.append((start, third))
        continue
    x, sr = pyopenjtalk.tts(text)
    x = (x / 32768.0 * 0.6).astype(np.float32)
    if sr != RATE:
        x = np.interp(np.arange(0, len(x), sr / RATE), np.arange(len(x)), x).astype(np.float32)
    i = int(start * RATE)
    audio[i:i + len(x)] += x[: len(audio) - i]
    end = round(start + len(x) / RATE, 2)
    speech.append((start, end))
    truth.append({'start': start, 'end': end, 'text': third if third else text, 'retake': third is None})
# 無言のカット作業中のハサミの音（小さなクリック）
for s, e in action:
    for t in np.arange(s, e, 0.6):
        i = int(t * RATE)
        audio[i:i + 400] += (rng.standard_normal(400) * 0.05 * np.hanning(400)).astype(np.float32)

wav = os.path.join(args.out, 'ja-audio.wav')
with wave.open(wav, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(RATE)
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    w.writeframes(np.repeat(pcm[:, None], 2, axis=1).tobytes())

# 映像: 表示（縦）座標で考え、記録は横長（rotate 90 のとき）
W, H = args.width, args.height
DW, DH = (H, W) if args.rotate in (90, -90, 270) else (W, H)
moving = '+'.join(f'between(t,{s},{e})' for s, e in action)
talking = '+'.join(f'between(t,{s},{e})' for s, e in speech)
# 表示座標での「ハサミ」の位置（下半分）。作業中は大きく動き、話している間はほとんど動かない
amp = f'if({moving},1,if({talking},0.02,0))'
dx = f'({DW*0.5:.0f}+{DW*0.22:.0f}*{amp}*sin(t*5))'
dy = f'({DH*0.68:.0f}+{DH*0.08:.0f}*{amp}*cos(t*7))'
box = max(40, DW // 8)
# 記録座標に変換（ffmpeg の rotation=90 は反時計回り: 表示X=記録y, 表示Y=記録幅-記録x）
if args.rotate in (90, -90, 270):
    rx, ry = (f'{DH}-{dy}-{box}/2', f'{dx}-{box}/6') if args.rotate == 90 else (f'{dy}-{box}/2', f'{DW}-{dx}-{box}/6')
else:
    rx, ry = f'{dx}-{box}/2', f'{dy}-{box}/2'
font = '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf'
vf = (f"[0][1]overlay=x='{rx}':y='{ry}'"
      + (',noise=alls=10:allf=t' if args.bitrate else '')
      + f",drawtext=fontfile={font}:text='%{{pts\\:hms}}':x=20:y=20:fontsize={max(24, H // 20)}:fontcolor=white[v]")
name = f'ja-sample-{W}x{H}' + (f'-r{args.rotate}' if args.rotate else '')
tmp = os.path.join(args.out, name + '.tmp.mov')
out = os.path.join(args.out, name + '.mov')
venc = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30']
if args.bitrate:
    venc += ['-b:v', args.bitrate, '-maxrate', args.bitrate, '-bufsize', args.bitrate]
subprocess.run(['ffmpeg', '-v', 'error', '-y',
                '-f', 'lavfi', '-i', f'color=c=0x6b5a50:s={W}x{H}:r=30:d={DURATION}',
                '-f', 'lavfi', '-i', f'color=c=0xd8d8e0:s={box}x{box // 3}:r=30:d={DURATION}',
                '-i', wav, '-filter_complex', vf, '-map', '[v]', '-map', '2:a', *venc,
                '-c:a', 'aac', '-b:a', '128k', '-shortest', tmp], check=True)
if args.rotate:
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-display_rotation', str(args.rotate), '-i', tmp, '-c', 'copy', out], check=True)
    os.remove(tmp)
else:
    os.rename(tmp, out)
with open(os.path.join(args.out, name + '-transcript.json'), 'w') as f:
    json.dump(truth, f, ensure_ascii=False, indent=1)
print(out)
