"""書き出した動画の画質（細かい模様がどれだけ残っているか）を、元の動画を理想的に縮小した場合と比べる。

  python3 tests/e2e/eval-quality.py OUT.mp4 SOURCE.mov

細かさ = 画面の中央（字幕・冒頭の文字・最後のフェードを避ける）の、3×3の平均との差の大きさ。
元の動画は ffmpeg で回転を反映し、Lanczos で 1080×1920 に縮小したものを基準（100%）にする。
縦横比が 9:16 の縦動画で、模様が画面全体で同じような素材（tests/e2e の hair4k）を想定している。
"""
import sys, subprocess, json
import numpy as np

out, src = sys.argv[1], sys.argv[2]

def dur(f):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True).stdout)

def frame(f, t, vf):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', f, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], capture_output=True).stdout
    return np.frombuffer(r, np.uint8).reshape(1920, 1080).astype(np.float32)

def detail(g):
    c = g[400:1350, 120:960]
    blur = (c[:-2, :-2] + c[:-2, 1:-1] + c[:-2, 2:] + c[1:-1, :-2] + c[1:-1, 1:-1] + c[1:-1, 2:] + c[2:, :-2] + c[2:, 1:-1] + c[2:, 2:]) / 9
    return float(np.abs(c[1:-1, 1:-1] - blur).mean())

do, ds = dur(out), dur(src)
ts = np.linspace(2.8, do - 1.6, 8)
o = [detail(frame(out, t, 'scale=1080:1920')) for t in ts]
r = [detail(frame(src, t, 'scale=1080:1920:flags=lanczos')) for t in np.linspace(1, ds - 1, 8)]
br = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=bit_rate,profile', '-of', 'json', out], capture_output=True, text=True).stdout
info = json.loads(br)['streams'][0]
print(f'細かさ: 書き出し {np.mean(o):.2f} / 元の動画を縮小した基準 {np.mean(r):.2f} → {np.mean(o) / np.mean(r) * 100:.0f}%（映像 {int(info.get("bit_rate", 0)) / 1e6:.1f}Mbps・{info.get("profile")}）')
