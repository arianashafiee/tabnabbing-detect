# tools/open_demo_tabs.py
# Usage:  python3 tools/open_demo_tabs.py --port 8000
# Why: cross-platform launcher that ensures the local server is up before opening Chrome.

import argparse, os, sys, time, threading, subprocess, shutil, urllib.request, socket
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

DEMO_REL = Path("demo/index.html")
URLS = [
    "/demo/index.html",
    "/demo/low-subtle.html",
    "/demo/medium-adjacent.html",
    "/demo/high-full-rebrand.html",
    "/demo/area-percent.html?p=25&mode=blur",
    "/demo/dynamic-noise.html",
    "/demo/cc-attack.html?auto=0",          # prevent auto-run; requires button + tab-away/return
]

def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0

def wait_http_ok(url, timeout=8.0):
    start = time.time()
    last_err = None
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(url, timeout=1.5) as r:
                if r.status == 200:
                    return True
        except Exception as e:
            last_err = e
        time.sleep(0.25)
    if last_err: print(f"[warn] server probe failed last error: {last_err}")
    return False

def find_demo_root() -> Path:
    # Prefer: project root that contains demo/
    here = Path(__file__).resolve().parent.parent  # assume tools/ sibling of demo/
    if (here / DEMO_REL).exists():
        return here
    # Fallback: cwd
    cwd = Path.cwd()
    if (cwd / DEMO_REL).exists():
        return cwd
    raise SystemExit("demo/ not found. Ensure this script sits under project root alongside demo/.")

def serve_forever(root: Path, port: int):
    os.chdir(str(root))  # serve the folder that contains demo/
    httpd = ThreadingHTTPServer(("0.0.0.0", port), SimpleHTTPRequestHandler)
    print(f"[server] serving {root} at http://localhost:{port}/  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()

def mac_chrome_cmd(urls):
    # Prefer direct binary; fallback to `open -a` if binary missing.
    app_bin = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    if app_bin.exists():
        return [str(app_bin), "--new-window", *urls]
    return ["/usr/bin/open", "-a", "Google Chrome", *urls]  # no custom flags supported here

def win_chrome_cmd(urls):
    # Try PATH first
    if shutil.which("chrome"):
        return ["chrome", "--new-window", *urls]
    # Common install paths
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ]
    for p in candidates:
        if p and os.path.exists(p):
            return [p, "--new-window", *urls]
    return None

def linux_chrome_cmd(urls):
    for bin_name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser"):
        if shutil.which(bin_name):
            return [bin_name, "--new-window", *urls]
    return None

def chrome_command(urls):
    if sys.platform == "darwin":
        return mac_chrome_cmd(urls)
    if os.name == "nt":
        cmd = win_chrome_cmd(urls)
        if cmd: return cmd
    # Linux or WSL
    cmd = linux_chrome_cmd(urls)
    if cmd: return cmd
    # Last resort: default browser (less ideal; may not be Chrome)
    print("[warn] Chrome not found on PATH; opening via default browser.")
    if sys.platform == "darwin":
        return ["/usr/bin/open", *urls]
    if os.name == "nt":
        return ["start", *urls]  # shell=True required
    return ["xdg-open", urls[0]]  # opens first tab only

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000, help="port to serve demo on")
    args = ap.parse_args()

    if port_in_use(args.port):
        raise SystemExit(f"Port {args.port} is in use. Pick another with --port.")

    root = find_demo_root()

    # Start server thread
    t = threading.Thread(target=serve_forever, args=(root, args.port), daemon=True)
    t.start()

    if not wait_http_ok(f"http://localhost:{args.port}/demo/index.html", timeout=10):
        raise SystemExit("Server did not become ready in time.")

    urls = [f"http://localhost:{args.port}{u}" for u in URLS]
    cmd = chrome_command(urls)

    print("[open] Launching Chrome with tabs:")
    for u in urls: print("  -", u)

    # On Windows "start" is a shell builtin; need shell=True
    use_shell = (os.name == "nt" and cmd and cmd[0].lower() == "start")
    try:
        subprocess.Popen(cmd, shell=use_shell)
    except FileNotFoundError:
        raise SystemExit("Failed to launch Chrome. Ensure Chrome is installed and on PATH.")

    print("\n[info] Keep this terminal open. Press Ctrl+C to stop the server.\n")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\n[server] shutting down...")

if __name__ == "__main__":
    main()
