"""WebKit（Safari と同じエンジン。Linux の WebKitGTK）で、書き出しの途中にブラウザを強制終了し、
もう一度開いて「続きから再開」で完成できるかを確かめる。

  python3 tests/webkit/run.py FILES_DIR sample.mov [--kill=2] [--target=45] [--reselect]

必要なもの: webkit2gtk-driver（MiniBrowser）・xvfb・gstreamer1.0-libav など（README を参照）
FILES_DIR にテスト用の動画を置く。完成した MP4 は FILES_DIR/out-webkit-*.mp4 に保存される。

iPhone の Safari とは、映像のデコーダー（iPhone は VideoToolbox、こちらは GStreamer）や
端末内への保存の方式（こちらは createSyncAccessHandle が使えず createWritable を使う）が違う。
WebKit で動くことの確認であって、iPhone で動くことの確認ではない。
"""
import json, os, subprocess, sys, time, shutil, signal

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
FILES = os.path.abspath(sys.argv[1])
SAMPLE = sys.argv[2]
arg = lambda name, d=None: next((a.split('=', 1)[1] for a in sys.argv if a.startswith(f'--{name}=')), d)
KILL = int(arg('kill', '2'))
TARGET = arg('target', '45')
RESELECT = '--reselect' in sys.argv
MB = '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser'
FEATURES = '--features=+FileSystem,+AccessHandle,+StorageAPI,+StorageAPIEstimate,+FileSystemWritableStream'
WORK = os.path.join(FILES, '.webkit')
os.makedirs(WORK, exist_ok=True)
LOG = os.path.join(WORK, 'report.log')
HOME = os.path.join(WORK, 'home')  # ブラウザの保存データ（毎回まっさらにする）
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(HOME)
if os.path.exists(LOG):
    os.remove(LOG)

if not os.path.exists(os.path.join(WORK, 'cert.pem')):
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', os.path.join(WORK, 'key.pem'),
                    '-out', os.path.join(WORK, 'cert.pem'), '-days', '30', '-subj', '/CN=localhost'], check=True, capture_output=True)
server = subprocess.Popen([sys.executable, os.path.join(HERE, 'server.py'), REPO, WORK, FILES, LOG])
time.sleep(1)
env = {**os.environ, 'HOME': HOME, 'XDG_DATA_HOME': os.path.join(HOME, 'data'), 'XDG_CACHE_HOME': os.path.join(HOME, 'cache')}


launches = 0


def launch(url):
    # ブラウザのエラー出力は WORK/browser-N.log に残す（落ちたときの手がかり）
    global launches
    launches += 1
    log = open(os.path.join(WORK, f'browser-{launches}.log'), 'w')
    return subprocess.Popen(['xvfb-run', '-a', MB, '--ignore-tls-errors', FEATURES, url], env=env,
                            stdout=log, stderr=subprocess.STDOUT, start_new_session=True)


def kill(p):
    # 後片付けの処理を一切させずに止める（Safari が落ちた・閉じられたときに近い）
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    p.wait()
    subprocess.run('pkill -9 -f WebKitWebProcess; pkill -9 -f WebKitNetworkProcess; pkill -9 -f WebKitGPUProcess', shell=True)
    time.sleep(1)


last_progress = {}


def stalled(r):
    # 同じ進み具合が2分続いたら止まったとみなす
    key = (r.get('render'), r.get('progress'))
    now = time.time()
    if last_progress.get('key') != key:
        last_progress.update(key=key, since=now)
        return False
    return now - last_progress['since'] > 120


def wait_report(types, timeout=3600):
    t0 = time.time()
    seen = 0
    while time.time() - t0 < timeout:
        if os.path.exists(LOG):
            lines = open(LOG).read().splitlines()
            for line in lines[seen:]:
                r = json.loads(line.split(' ', 1)[1])
                print(f"[{r.get('phase')}] {r['type']}: " + json.dumps({k: v for k, v in r.items() if k not in ('type', 'phase')}, ensure_ascii=False)[:3000])
                if r['type'] in types or r['type'] == 'ERROR' or (r['type'] == 'progress' and os.environ.get('STOP_ON_STALL') and stalled(r)):
                    return r
            seen = len(lines)
        time.sleep(1)
    raise TimeoutError(types)


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,width,height,nb_frames,duration', '-of', 'compact', path],
                         capture_output=True, text=True).stdout.strip().replace('\n', ' | ')
    err = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-'], capture_output=True, text=True).stderr.strip()
    return out, err or 'なし'


try:
    base = 'https://localhost:8443/tests/webkit/harness.html'
    t0 = time.time()
    p = launch(f'{base}?phase=start&sample={SAMPLE}&target={TARGET}&kill={KILL}')
    r = wait_report(['KILL_READY', 'DONE'])
    if r['type'] == 'KILL_READY':
        kill(p)
        print(f'強制終了（{time.time() - t0:.1f}秒）')
        if RESELECT:
            # 元の動画のコピーを消して、選び直しの案内が出るかを確かめる（OPFS のファイルを探して消す）
            for root, dirs, files in os.walk(HOME):
                for f in files:
                    if f == 'source':
                        os.remove(os.path.join(root, f))
        p = launch(f'{base}?phase=resume' + ('&reselect=1' if RESELECT else ''))
        r = wait_report(['DONE'])
        kill(p)
    else:
        kill(p)
    if r['type'] == 'DONE':
        out = os.path.join(FILES, f"out-webkit-{r['phase']}.mp4")
        info, err = probe(out)
        print('出力:', out)
        print('ffprobe:', info)
        print('デコードのエラー:', err)
finally:
    server.terminate()
