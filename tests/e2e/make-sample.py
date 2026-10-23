"""通しテスト用の動画を作る（ffmpeg が必要）。

  python3 tests/e2e/make-sample.py OUT_DIR [横幅 縦幅]
  python3 tests/e2e/make-sample.py OUT_DIR 3840 2160 --duration 62 --codec hevc --format mov --rotate 90 --bitrate 24M

--rotate はiPhoneの縦撮影と同じく「横長で記録し、回転情報で縦に表示」する。
--duration を変えると、話す区間などの時刻もその長さに合わせて縮める。

話す区間（英語の合成音声。文字起こしは偽の日本語を使う）、無音、
手元の動きに見立てて激しく動く四角、を含む約3分の H.264/AAC MP4 と、
それに合わせた偽の文字起こし sample-transcript.json を作る。
"""
import argparse, json, os, subprocess

ap = argparse.ArgumentParser()
ap.add_argument('out')
ap.add_argument('width', nargs='?', type=int, default=1280)
ap.add_argument('height', nargs='?', type=int, default=720)
ap.add_argument('--duration', type=float, default=172)
ap.add_argument('--codec', choices=['h264', 'hevc'], default='h264')
ap.add_argument('--format', choices=['mp4', 'mov'], default='mp4')
ap.add_argument('--rotate', type=int, default=0)
ap.add_argument('--bitrate', default=None, help='例: 24M（指定するとノイズを加えて実機並みのサイズにする）')
args = ap.parse_args()
out, W, H = args.out, args.width, args.height
os.makedirs(out, exist_ok=True)
RATE = 48000

# (開始秒, 英語の読み上げ, 偽の日本語字幕)
SPEECH = [
    (2, 'Hello everyone. Today I will explain a bob cut.', '皆さんこんにちは、今日はボブのカットを解説します'),
    (12, 'First we divide the hair into blocks.', 'まずはバックからブロッキングを'),
    (16, 'First we divide the hair into blocks at the back.', 'まずはバックからブロッキングをしていきます'),
    (26, 'Pull the panel at forty five degrees.', 'パネルを45度で引き出します'),
    (60, 'Now the side section. Cut along the guide.', '次はサイドです、ガイドに合わせてカットします'),
    (75, 'Oops, I made a mistake. Let me say it again.', 'あ、間違えました、言い直します'),
    (90, 'Thin out the ends to make it lighter.', '毛先をセニングして軽さを出します'),
    (130, 'This is the important point of this cut.', 'ここがこのカットの一番大事なポイントです'),
    (160, 'And here is the finished style. Thank you.', 'これで仕上がりです、ありがとうございました'),
]
DURATION = args.duration
ACTION = [(36, 56), (100, 125), (140, 156)]  # 話さずに手元が大きく動く区間
HALLUCINATION = (110, 114, 'ご視聴ありがとうございました')  # 無音部分の誤認識
# 172秒を基準にした時刻を、指定の長さに縮める（読み上げが重ならないものだけ残す）
k = DURATION / 172
if k != 1:
    kept, last_end = [], -1
    for start, en, ja in SPEECH:
        st = round(start * k, 1)
        if st >= last_end + 0.8 and st < DURATION - 4:
            kept.append((st, en, ja))
            last_end = st + 3.2
    SPEECH = kept
    ACTION = [(round(a * k, 1), round(b * k, 1)) for a, b in ACTION]
    HALLUCINATION = (round(HALLUCINATION[0] * k, 1), round(HALLUCINATION[1] * k, 1), HALLUCINATION[2])

def run(args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

transcript = []
inputs, filters = [], []
for i, (start, en, ja) in enumerate(SPEECH):
    wav = os.path.join(out, f'speech{i}.wav')
    run(['ffmpeg', '-y', '-f', 'lavfi', '-i', f"flite=text='{en}':voice=slt", '-ar', str(RATE), '-ac', '1', wav])
    dur = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav]))
    transcript.append({'start': start, 'end': round(start + dur, 2), 'text': ja})
    inputs += ['-i', wav]
    ms = int(start * 1000)
    filters.append(f'[{i}]adelay={ms}|{ms},volume=2.5[s{i}]')
transcript.append({'start': HALLUCINATION[0], 'end': HALLUCINATION[1], 'text': HALLUCINATION[2]})
transcript.sort(key=lambda c: c['start'])

n = len(SPEECH)
noise = f'anoisesrc=d={DURATION}:c=pink:a=0.004:r={RATE}[noise]'
mix = ''.join(f'[s{i}]' for i in range(n)) + f'[noise]amix=inputs={n + 1}:normalize=0:duration=longest,atrim=0:{DURATION}[a]'
audio = os.path.join(out, 'audio.wav')
run(['ffmpeg', '-y', *inputs, '-filter_complex', ';'.join(filters + [noise, mix]), '-map', '[a]', '-ac', '2', '-ar', str(RATE), audio])

moving = '+'.join(f'between(t,{s},{e})' for s, e in ACTION)
bx = f"if({moving}, {W*0.35:.0f}+{W*0.25:.0f}*sin(t*7), {W*0.45:.0f})"
by = f"if({moving}, {H*0.45:.0f}+{H*0.2:.0f}*cos(t*5), {H*0.45:.0f})"
box = max(40, W // 10)
name = f'sample-{W}x{H}' + (f'-{args.codec}' if args.codec != 'h264' else '') + (f'-r{args.rotate}' if args.rotate else '')
video = os.path.join(out, f'{name}.{args.format}')
font = '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf'
if not os.path.exists(font):
    font = subprocess.check_output(['fc-match', '-f', '%{file}', 'IPAGothic']).decode()
vf = f"[0][1]overlay=x='{bx}':y='{by}'"
if args.bitrate:
    vf += ',noise=alls=12:allf=t'
vf += f",drawtext=fontfile={font}:text='%{{pts\\:hms}}':x=20:y=20:fontsize={max(24, H // 18)}:fontcolor=white[v]"
venc = ['-c:v', 'libx264', '-preset', 'veryfast'] if args.codec == 'h264' else ['-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-x265-params', 'log-level=error']
if args.bitrate:
    venc += ['-b:v', args.bitrate, '-maxrate', args.bitrate, '-bufsize', args.bitrate]
tmp = video + '.tmp.' + args.format if args.rotate else video
run(['ffmpeg', '-y',
     '-f', 'lavfi', '-i', f'color=c=0x4a5a6a:s={W}x{H}:r=30:d={DURATION}',
     '-f', 'lavfi', '-i', f'color=c=orange:s={box}x{box}:r=30:d={DURATION}',
     '-i', audio,
     '-filter_complex', vf,
     '-map', '[v]', '-map', '2:a', *venc, '-pix_fmt', 'yuv420p', '-g', '30',
     '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp])
if args.rotate:
    # 回転情報だけを付け直す（映像は横長のまま）
    run(['ffmpeg', '-y', '-display_rotation', str(args.rotate), '-i', tmp, '-c', 'copy', '-movflags', '+faststart', video])
    os.remove(tmp)
with open(os.path.join(out, 'sample-transcript.json' if k == 1 else f'{name}-transcript.json'), 'w') as f:
    json.dump(transcript, f, ensure_ascii=False, indent=1)
print(video)
