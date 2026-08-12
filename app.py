#!/usr/bin/env python3
"""Launch the Matcha food-tree viewer in a pywebview window.

Serves the viewer/ directory over localhost and opens a native window.
If pywebview is not installed, falls back to opening the default browser.
"""

import argparse
import http.server
import os
import socketserver
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
VIEWER = os.path.join(HERE, "viewer")
PORT = 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=VIEWER, **kwargs)

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def start_server(port):
    class ReuseTCPServer(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        allow_reuse_port = True
        daemon_threads = True

    httpd = ReuseTCPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def main():
    ap = argparse.ArgumentParser(description="Matcha food-tree viewer")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--browser", action="store_true",
                    help="open in default browser instead of a pywebview window")
    args = ap.parse_args()

    if not os.path.exists(os.path.join(VIEWER, "food_tree.json")):
        # allow running food_tree.json next to the viewer too
        for cand in (os.path.join(HERE, "food_tree.json"),
                     os.path.join(VIEWER, "food_tree.json")):
            if os.path.exists(cand):
                break
        else:
            print("ERROR: food_tree.json not found. Run extract.py first.")
            raise SystemExit(1)

    start_server(args.port)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Serving viewer at {url}")

    if args.browser:
        webbrowser.open(url)
        input("Press Enter to stop server...")
        return

    try:
        import webview  # noqa: F401
        # pywebview needs a native toolkit backend on Linux
        backend_ok = False
        try:
            webview.create_window("Matcha Flavoured Food Tree", url,
                                  width=1400, height=900, min_size=(900, 600))
            webview.start()
            backend_ok = True
        except Exception as e:
            print(f"pywebview backend failed ({e}) -> falling back to browser.")
    except ImportError:
        print("pywebview not installed -> opening in default browser.")
        print("Install with: .venv/bin/pip install pywebview")
        print("(pywebview also needs a GTK or Qt backend on Linux, e.g. PyGObject+WebKit)")

    if "backend_ok" not in locals() or not backend_ok:
        webbrowser.open(url)
        input("Press Enter to stop server...")


if __name__ == "__main__":
    main()
