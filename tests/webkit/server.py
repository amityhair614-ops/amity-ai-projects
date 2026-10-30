"""WebKit の通しテスト用の HTTPS サーバー（WebKitGTK は http の localhost を安全な接続と見なさず、保存の機能が使えないため）。

  python3 tests/webkit/server.py REPO_DIR CERT_DIR FILES_DIR REPORT_LOG

リポジトリを配信し、/__files/ で FILES_DIR のテスト用ファイルを配信する。
/__report に POST された内容を REPORT_LOG に追記し、/__upload/NAME?off=N で FILES_DIR にファイルを書き込む。
"""
import http.server, ssl, sys, os, time
ROOT, CERT, FILES, LOG = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def translate_path(self, path):
        if path.startswith('/__files/'):
            return os.path.join(FILES, path[len('/__files/'):].split('?')[0])
        return super().translate_path(path)

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(n)
        if self.path.startswith('/__upload/'):
            name = self.path[len('/__upload/'):].split('?')[0]
            off = int(self.path.split('off=')[1]) if 'off=' in self.path else 0
            p = os.path.join(FILES, name)
            with open(p, 'r+b' if off and os.path.exists(p) else 'wb') as f:
                f.seek(off)
                f.write(body)
        else:
            with open(LOG, 'a') as f:
                f.write(time.strftime('%H:%M:%S ') + body.decode('utf8', 'replace') + '\n')
        self.send_response(200)
        self.send_header('Content-Length', '0')
        self.end_headers()


s = http.server.ThreadingHTTPServer(('127.0.0.1', 8443), H)
c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
c.load_cert_chain(CERT + '/cert.pem', CERT + '/key.pem')
s.socket = c.wrap_socket(s.socket, server_side=True)
s.serve_forever()
