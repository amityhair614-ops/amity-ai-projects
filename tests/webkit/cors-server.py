import http.server, sys, os
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()
    def log_message(self, *a): pass
os.chdir(sys.argv[1])
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[2])), H).serve_forever()
