# 正解の文（手動編集の字幕など）を基に、文字起こしの結果を文ごとに採点する（読みで比べる・書き方の違いは別に数える）。
#   python3 tools/analysis/score.py truth.json 名前=結果.json ... [--wav src=path.wav ...]
# - truth.json: [{ id, src, start, end, text }]（src は素材の名前。話した内容そのものなので、リポジトリには入れない）
# - 結果.json: { chars: { src: [[文字, 素材の中の時刻], ...] } }（dump2chars.py で、アプリの解析の結果から作る）
# - --wav: 素材の音声（16kHz・モノラル）。あれば、文の声の出始めと最初の文字の時刻の差も出す
# 必要: pip install pykakasi numpy
import json, sys, re, wave, numpy as np, pykakasi

kk = pykakasi.kakasi()
PUN = re.compile(r'[、。，．,.\s・!！?？]')
def reading(t):
    t = PUN.sub('', t)
    for d, r in (('1', 'いち'), ('2', 'に'), ('3', 'さん'), ('4', 'よん')): t = t.replace(d, r)
    return ''.join(x['kana'] for x in kk.convert(t)).replace('ヅ', 'ズ').replace('ヂ', 'ジ')
def ops(a, b):
    n, m = len(a), len(b); d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1): d[i][0] = i
    for j in range(m + 1): d[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1): d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] != b[j - 1]))
    i, j, s, de, ins = n, m, 0, 0, 0
    while i or j:
        if i and j and d[i][j] == d[i - 1][j - 1] + (a[i - 1] != b[j - 1]): s += a[i - 1] != b[j - 1]; i -= 1; j -= 1
        elif i and d[i][j] == d[i - 1][j] + 1: de += 1; i -= 1
        else: ins += 1; j -= 1
    return s, de, ins

args = [x for x in sys.argv[1:]]
wavs = {}
if '--wav' in args:
    k = args.index('--wav'); wavs = dict(x.split('=', 1) for x in args[k + 1:]); args = args[:k]
truth = json.load(open(args[0]))
cache = {}
def onset(src, a, b):
    if src not in wavs: return None
    if src not in cache:
        w = wave.open(wavs[src]); x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        e = np.array([20 * np.log10(np.sqrt(np.mean(x[i:i + 320] ** 2)) + 1e-9) for i in range(0, len(x) - 320, 320)])
        cache[src] = (e, np.percentile(e, 15) + 14)
    e, thr = cache[src]
    for i in range(int(max(0, a - 0.15) / 0.02), int(b / 0.02)):
        if i < len(e) and e[i] > thr: return i * 0.02
    return a
res = {}
for arg in args[1:]:
    name, path = arg.split('=', 1); H = json.load(open(path))['chars']; rows = []
    for k, T in enumerate(truth):
        prev = truth[k - 1] if k and truth[k - 1]['src'] == T['src'] else None
        nxt = truth[k + 1] if k + 1 < len(truth) and truth[k + 1]['src'] == T['src'] else None
        lo = (prev['end'] + T['start']) / 2 if prev else T['start'] - 0.6
        hi = (T['end'] + nxt['start']) / 2 if nxt else T['end'] + 0.6
        cs = [(c, t) for c, t in H.get(T['src'], []) if lo <= t < hi and not re.match(r'^<.*>$', c)]
        hyp = ''.join(c for c, _ in cs)
        R = reading(T['text']); s, de, ins = ops(R, reading(hyp))
        surf = ops(PUN.sub('', T['text']), PUN.sub('', hyp))
        on = onset(T['src'], T['start'], T['end'])
        dt = round(cs[0][1] - on, 2) if cs and on is not None else None
        rows.append({'id': T.get('id', f'T{k + 1}'), 'hyp': hyp, 'n': len(R), 'sub': s, 'del': de, 'ins': ins, 'surf': sum(surf), 'dt': dt,
                     'lost': de >= 0.6 * len(R), 'partial': 0.2 * len(R) <= de < 0.6 * len(R)})
    res[name] = rows
print('文ごと（正解 / 各方式の文字起こし）')
for k, T in enumerate(truth):
    print(f" {T.get('id', 'T%d' % (k + 1)):>3} {T['text']}")
    for name, rows in res.items():
        r = rows[k]; mark = ' [抜け]' if r['lost'] else ' [一部抜け]' if r['partial'] else ''
        print(f"      {name:10s} {r['hyp'] or '（なし）'} {mark} 読みの誤り 置換{r['sub']}・抜け{r['del']}・余分{r['ins']} / 書き方を含む誤り{r['surf']}  最初の文字の時刻 {r['dt']}")
print(f"\n合計（{len(truth)}文・正解の読み {sum(len(reading(T['text'])) for T in truth)} 文字）")
for name, rows in res.items():
    dts = sorted(abs(r['dt']) for r in rows if r['dt'] is not None)
    tm = f"・最初の文字の時刻のずれ 中央{dts[len(dts) // 2]:.2f}秒 最大{dts[-1]:.2f}秒" if dts else ''
    print(f"  {name:10s} 文の抜け {sum(r['lost'] for r in rows)}・一部抜け {sum(r['partial'] for r in rows)}・読みの置換 {sum(r['sub'] for r in rows)}・読みの抜け {sum(r['del'] for r in rows)}・余分 {sum(r['ins'] for r in rows)}・書き方を含む誤り {sum(r['surf'] for r in rows)}・誤りのある文 {sum(1 for r in rows if r['surf'])}/{len(rows)}{tm}")
