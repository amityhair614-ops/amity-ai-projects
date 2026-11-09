"""WebKit（Linux の WebKitGTK・Safari と同じエンジン）で、https のページから字幕の辞書（kuromoji）を読み込めるかを確かめる。

  python3 tests/webkit/morph.py [REPO_DIR]

REPO_DIR（既定: このリポジトリ）を https://localhost:8443/ で配信し、tests/webkit/morph.html を MiniBrowser で開く。
辞書は CDN の代わりに REPO_DIR/node_modules/kuromoji/ から読む（npm install が必要）。iPhone の Safari での確認ではない。
"""
import json, os, subprocess, sys, time, signal, shutil
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(HERE))
WORK = os.path.join(REPO, '.webkit-morph')
os.makedirs(WORK, exist_ok=True)
LOG = os.path.join(WORK, 'report.log')
if os.path.exists(LOG): os.remove(LOG)
if not os.path.exists(os.path.join(WORK, 'cert.pem')):
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', os.path.join(WORK, 'key.pem'),
                    '-out', os.path.join(WORK, 'cert.pem'), '-days', '30', '-subj', '/CN=localhost'], check=True, capture_output=True)
HOME = os.path.join(WORK, 'home')
shutil.rmtree(HOME, ignore_errors=True); os.makedirs(HOME)
server = subprocess.Popen([sys.executable, os.path.join(HERE, 'server.py'), REPO, WORK, WORK, LOG])
time.sleep(1)
MB = '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser'
url = 'https://localhost:8443/tests/webkit/morph.html?base=' + 'https://localhost:8443/node_modules/kuromoji/'
env = {**os.environ, 'HOME': HOME, 'XDG_DATA_HOME': os.path.join(HOME, 'data'), 'XDG_CACHE_HOME': os.path.join(HOME, 'cache')}
p = subprocess.Popen(['xvfb-run', '-a', MB, '--ignore-tls-errors', url], env=env, stdout=open(os.path.join(WORK, 'browser.log'), 'w'), stderr=subprocess.STDOUT, start_new_session=True)
result = None
try:
    t0 = time.time()
    while time.time() - t0 < 90 and not result:
        if os.path.exists(LOG):
            for line in open(LOG).read().splitlines():
                r = json.loads(line.split(' ', 1)[1])
                if r['type'] == 'pageerror': print('ページのエラー:', r)
                if r['type'] == 'DONE': result = r
        time.sleep(1)
finally:
    try: os.killpg(p.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    subprocess.run('pkill -9 -f WebKitWebProcess; pkill -9 -f WebKitNetworkProcess; pkill -9 -f WebKitGPUProcess', shell=True)
    server.terminate()
print('結果:', json.dumps(result, ensure_ascii=False) if result else '時間切れ（結果が届かない）')
sys.exit(0 if result and result.get('ok') else 1)
