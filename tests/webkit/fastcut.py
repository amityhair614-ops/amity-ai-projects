"""WebKit（Linux の WebKitGTK・Safari と同じエンジン）で、高速書き出しが動くか・つなぎ目の確かめが通るかを試す。

  python3 tests/webkit/fastcut.py FILES_DIR s1.mov,s2.mov 'RANGES_JSON' [avc|hevc]

FILES_DIR の動画を https://localhost:8443/__files/ で配信し、tests/webkit/fastcut.html を MiniBrowser で開く。
完成した映像は FILES_DIR/webkit-fast.mp4 に書く。iPhone の Safari での確認ではない（デコーダー・エンコーダーは GStreamer）。
"""
import json, os, subprocess, sys, time, signal, shutil, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
FILES, NAMES, RANGES = os.path.abspath(sys.argv[1]), sys.argv[2], sys.argv[3]
CODEC = sys.argv[4] if len(sys.argv) > 4 else 'avc'
WORK = os.path.join(REPO, '.webkit-morph')
os.makedirs(WORK, exist_ok=True)
LOG = os.path.join(WORK, 'fastcut.log')
if os.path.exists(LOG): os.remove(LOG)
if not os.path.exists(os.path.join(WORK, 'cert.pem')):
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', os.path.join(WORK, 'key.pem'),
                    '-out', os.path.join(WORK, 'cert.pem'), '-days', '30', '-subj', '/CN=localhost'], check=True, capture_output=True)
HOME = os.path.join(WORK, 'home')
shutil.rmtree(HOME, ignore_errors=True); os.makedirs(HOME)
server = subprocess.Popen([sys.executable, os.path.join(HERE, 'server.py'), REPO, WORK, FILES, LOG])
time.sleep(1)
MB = '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser'
url = 'https://localhost:8443/tests/webkit/fastcut.html?' + urllib.parse.urlencode({'files': NAMES, 'ranges': RANGES, 'codec': CODEC})
env = {**os.environ, 'HOME': HOME, 'XDG_DATA_HOME': os.path.join(HOME, 'data'), 'XDG_CACHE_HOME': os.path.join(HOME, 'cache')}
p = subprocess.Popen(['xvfb-run', '-a', MB, '--ignore-tls-errors', url], env=env, stdout=open(os.path.join(WORK, 'browser.log'), 'w'), stderr=subprocess.STDOUT, start_new_session=True)
result = None
try:
    t0 = time.time()
    while time.time() - t0 < 300 and not result:
        if os.path.exists(LOG):
            for line in open(LOG).read().splitlines():
                r = json.loads(line.split(' ', 1)[1])
                if r['type'] != 'DONE': print(r)
                else: result = r
        time.sleep(1)
finally:
    try: os.killpg(p.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    subprocess.run('pkill -9 -f WebKitWebProcess; pkill -9 -f WebKitNetworkProcess; pkill -9 -f WebKitGPUProcess', shell=True)
    server.terminate()
print('結果:', json.dumps(result, ensure_ascii=False) if result else '時間内に終わりませんでした')
sys.exit(0 if result and result.get('ok') else 1)
