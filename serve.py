#!/usr/bin/env python3
"""Local server for development.

python3 -m http.server lets the browser cache modules, which means an edit can
sit invisible behind a stale copy. This sends the same no-cache policy the
deployed site uses, so what you see locally is what a visitor gets.

    python3 serve.py [port]
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    server = ThreadingHTTPServer(("", port), partial(NoCacheHandler, directory="."))
    print(f"Keep It Offline on http://localhost:{port}  (Ctrl-C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
