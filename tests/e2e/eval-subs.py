"""書き出した動画の字幕の正確さを、元の動画の正解の文と比べる（問題の箇所も一覧にする）。

  python3 tests/e2e/eval-subs.py TIMELINE.json TRANSCRIPT.json

- TIMELINE.json: run.mjs が書き出す timeline-*.json（場面ごとの元の動画の範囲 pieces と、字幕のページ pages）
- TRANSCRIPT.json: 元の動画で話した文の正解（[{start, end, text, retake}]。時刻は元の動画）

完成動画に使った元の動画の範囲で、文の80%以上を使った文（言い直しは除く）を正解とし、字幕のページの文字と比べる
（句読点・カタカナ/ひらがなの違いは数えない）。eval-finish.py の字幕の正確さと違い、完成動画をもう一度
文字起こしして「残った文」を判定しないため、文字起こしの聞き落としに左右されない。
"""
import json, re, sys, unicodedata

tl_path, tr_path = sys.argv[1:3]
tl = json.load(open(tl_path))
tr = json.load(open(tr_path))
FPS = 30
used = [(p['srcStart'], p['srcStart'] + p['frames'] / FPS) for c in tl for p in c['pieces']]


def cover(s):
    got = sum(max(0, min(b, s['end']) - max(a, s['start'])) for a, b in used)
    return got / max(1e-6, s['end'] - s['start'])


def norm(t):
    t = unicodedata.normalize('NFKC', t)
    t = re.sub(r'[、。,.!?！？「」\s・／]', '', t)
    t = t.replace('百', '100').replace('下さい', 'ください')
    return ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in t)


def align(a, b):
    n, m = len(a), len(b)
    D = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1): D[i][0] = i
    for j in range(m + 1): D[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            D[i][j] = min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (a[i - 1] != b[j - 1]))
    ops, i, j = [], n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and D[i][j] == D[i - 1][j - 1] + (a[i - 1] != b[j - 1]):
            ops.append(('=' if a[i - 1] == b[j - 1] else '~', i - 1, j - 1)); i -= 1; j -= 1
        elif j > 0 and D[i][j] == D[i][j - 1] + 1:
            ops.append(('+', None, j - 1)); j -= 1
        else:
            ops.append(('-', i - 1, None)); i -= 1
    return D[n][m], ops[::-1]


keep = [s for s in tr if not s.get('retake') and cover(s) >= 0.8]
ref = ''.join(norm(s['text']) for s in keep)
pages = [(c['outStart'], p) for c in tl for p in c.get('pages', [])]
hyp_chars, hyp_time = [], []
for _, p in pages:
    for ch in norm(p['t']):
        hyp_chars.append(ch); hyp_time.append(p['s'])
dist, ops = align(ref, ''.join(hyp_chars))
print(f'字幕の正確さ（使った範囲の正解 {len(keep)}文・{len(ref)}文字）: 誤り {dist}文字（誤り率 {dist / max(1, len(ref)) * 100:.1f}%）')
# 問題の箇所: 続いた誤りをまとめて、完成動画の時刻とともに表示する
issues, cur = [], None
for op, i, j in ops:
    if op == '=':
        if cur: issues.append(cur); cur = None
        continue
    if not cur: cur = {'ref': '', 'hyp': '', 't': hyp_time[j] if j is not None else None}
    if i is not None: cur['ref'] += ref[i]
    if j is not None: cur['hyp'] += hyp_chars[j]
    if cur['t'] is None and j is not None: cur['t'] = hyp_time[j]
if cur: issues.append(cur)
for x in issues:
    t = f"{x['t']:5.1f}秒" if x['t'] is not None else '  ―  '
    print(f"  {t}: 正解「{x['ref']}」→ 字幕「{x['hyp']}」")
