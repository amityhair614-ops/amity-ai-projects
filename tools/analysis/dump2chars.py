# 解析の結果（tests/e2e/run.mjs --dump-analysis）を、score.py の形（素材ごとの [文字, 素材の中の時刻]）にする
#   python3 dump2chars.py analysis.json out.json [素材名,...]   （素材名: 既定は s1,s2,...）
import json, sys
d = json.load(open(sys.argv[1])); names = sys.argv[3].split(',') if len(sys.argv) > 3 else None
lay = d['lay']; names = names or [f's{i+1}' for i in range(len(lay))]
out = {'chars': {n: [] for n in names}}
for c in d['chunks']:
    for k in c.get('tokens') or []:
        t = k['t']; i = max(j for j, s in enumerate(lay) if s['offset'] <= t + 0.5)
        out['chars'][names[i]].append([k['s'], round(t - lay[i]['offset'], 3)])
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False)
print({n: len(v) for n, v in out['chars'].items()})
