import json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
port = int(sys.argv[1])
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_GET(self):
        body = json.dumps({"data": [{"id": "muse-spark-1.3", "object": "model"}]}).encode()
        self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
        print("served GET", self.path, flush=True)
        threading.Thread(target=self.server.shutdown, daemon=True).start()
    def do_POST(self):
        print("POST arrived (unexpected)", self.path, flush=True)
        self.send_response(400); self.send_header("Content-Length","0"); self.end_headers()
srv = ThreadingHTTPServer(("127.0.0.1", port), H)
print("listening", port, flush=True)
srv.serve_forever()
print("stopped", flush=True)
