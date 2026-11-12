# 書き出した動画（AI編集・手動編集）の画面の字幕のページを見つける（字幕の帯の白い文字の形が変わった所で分ける）。
#   python3 tools/analysis/subpages.py video.mov [--band 0.865] [--height 64] [--out pages.json] [--sheet subs]
# - --band: 字幕の帯の上の位置（画面の高さに対する割合）。--height: 帯の高さ（512×910 にしたときの画素）
# - 出すもの: ページごとの [始まり, 終わり]（秒）。--sheet を付けると、ページの切り抜きを並べた画像（PNG）も作る（文字は目で読む）
# 必要: ffmpeg・pip install numpy pillow
import argparse, json, subprocess, numpy as np
ap = argparse.ArgumentParser(); ap.add_argument('video'); ap.add_argument('--band', type=float, default=0.865)
ap.add_argument('--height', type=int, default=64); ap.add_argument('--out'); ap.add_argument('--sheet')
a = ap.parse_args()
W, H = 512, 910; y0 = int(H * a.band) // 2 * 2; y1 = y0 + a.height
raw = subprocess.run(['ffmpeg', '-v', 'quiet', '-i', a.video, '-r', '30', '-vf', f'scale={W}:{H},crop={W}:{y1 - y0}:0:{y0},format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
F = np.frombuffer(raw, np.uint8).reshape(-1, y1 - y0, W); m = F > 235
pages, start = [], 0
for i in range(1, len(m)):
    if np.mean(m[i] != m[i - 1]) > 0.008: pages.append((start, i)); start = i
pages.append((start, len(m)))
pages = [(s, e) for s, e in pages if e - s >= 2 and m[(s + e) // 2].sum() > 40]
out = []
for s, e in pages:
    if out and np.mean(m[(s + e) // 2] != m[(out[-1][0] + out[-1][1]) // 2]) < 0.004 and s - out[-1][1] <= 3: out[-1] = (out[-1][0], e)
    else: out.append((s, e))
print(len(out), 'ページ')
for k, (s, e) in enumerate(out): print(f'{k + 1:2d} {s / 30:6.2f}-{e / 30:6.2f}')
if a.out: json.dump([[round(s / 30, 3), round(e / 30, 3)] for s, e in out], open(a.out, 'w'))
if a.sheet:
    from PIL import Image, ImageDraw
    rows = [Image.fromarray(F[(s + e) // 2]).convert('RGB').resize((W * 2, (y1 - y0) * 2)) for s, e in out]
    for part in range(0, len(rows), 12):
        grp = rows[part:part + 12]; sheet = Image.new('RGB', (W * 2 + 170, len(grp) * (y1 - y0) * 2), 'white'); d = ImageDraw.Draw(sheet)
        for i, im in enumerate(grp):
            sheet.paste(im, (170, i * (y1 - y0) * 2)); s, e = out[part + i]; d.text((4, i * (y1 - y0) * 2 + 20), f'{part + i + 1:2d} {s / 30:5.2f}-{e / 30:5.2f}', fill='black')
        sheet.save(f'{a.sheet}_{part // 12}.png')
