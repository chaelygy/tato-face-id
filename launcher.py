"""
Face Recognition System - Smart Auto Launcher
Menjalankan Backend Python + Cloudflare Tunnel + Auto Sync ke Vercel/GitHub
"""

import os
import sys
import time
import re
import socket
import subprocess
import threading
import signal
import webbrowser

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
APP_JS_PATH = os.path.join(BASE_DIR, "static", "app.js")
ROOT_APP_JS_PATH = os.path.join(BASE_DIR, "app.js")
CLOUDFLARED_EXE = os.path.join(BASE_DIR, "cloudflared.exe")

def is_port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1.0)
        return s.connect_ex(('127.0.0.1', port)) == 0

def copy_to_clipboard(text):
    try:
        process = subprocess.Popen('clip', stdin=subprocess.PIPE, shell=True)
        process.communicate(input=text.strip().encode('utf-8'))
        return True
    except Exception:
        return False

def get_current_appjs_url():
    if not os.path.exists(APP_JS_PATH):
        return None
    try:
        with open(APP_JS_PATH, 'r', encoding='utf-8') as f:
            content = f.read()
        match = re.search(r"const\s+CLOUD_BACKEND_URL\s*=\s*['\"]([^'\"]+)['\"]", content)
        return match.group(1) if match else None
    except Exception:
        return None

def update_appjs_and_push(new_url):
    old_url = get_current_appjs_url()
    if old_url == new_url:
        print("[Vercel Sync] URL tunnel sama dengan di static/app.js. Tidak perlu push.")
        return

    print(f"\n[Vercel Sync] Memperbarui URL di static/app.js...")
    print(f"  â€¢ URL Lama: {old_url}")
    print(f"  â€¢ URL Baru: {new_url}")

    try:
        with open(APP_JS_PATH, 'r', encoding='utf-8') as f:
            content = f.read()

        updated_content = re.sub(
            r"const\s+CLOUD_BACKEND_URL\s*=\s*['\"][^'\"]+['\"];",
            f"const CLOUD_BACKEND_URL = '{new_url}';",
            content
        )

        with open(APP_JS_PATH, 'w', encoding='utf-8') as f:
            f.write(updated_content)

        if os.path.exists(ROOT_APP_JS_PATH):
            with open(ROOT_APP_JS_PATH, 'w', encoding='utf-8') as f:
                f.write(updated_content)

        print("[Vercel Sync] Berhasil memperbarui static/app.js dan app.js.")
        print("[Vercel Sync] Mengirim update ke GitHub agar Vercel otomatis update...")

        # Push to GitHub jika ini git repository
        if os.path.exists(os.path.join(BASE_DIR, ".git")):
            files_to_add = ["static/app.js"]
            if os.path.exists(ROOT_APP_JS_PATH):
                files_to_add.append("app.js")
            subprocess.run(["git", "add"] + files_to_add, cwd=BASE_DIR, check=True)
            subprocess.run(["git", "commit", "-m", f"Auto-update Cloudflare Tunnel URL: {new_url}"], cwd=BASE_DIR, check=True)
            push_res = subprocess.run(["git", "push", "origin", "main"], cwd=BASE_DIR)
            
            if push_res.returncode == 0:
                print("[Vercel Sync] [SUKSES] Berhasil push ke GitHub! Vercel akan otomatis update dalam 15-20 detik.")
            else:
                print("[Vercel Sync] [INFO] Push ke GitHub gagal atau tidak ada perubahan.")
        else:
            print("[Vercel Sync] Bukan git repository lokal, sinkronisasi file lokal selesai.")
    except Exception as e:
        print(f"[Vercel Sync] Catatan: {e}")

def main():
    os.system("color 0A" if os.name == "nt" else "")
    print("=" * 65)
    print("       SISTEM PENGENALAN WAJAH (KESYA EDITION) - SMART AUTO LAUNCHER")
    print("=" * 65)

    processes = []

    def cleanup(sig=None, frame=None):
        print("\n\n[INFO] Menghentikan semua proses server...")
        for p in processes:
            try:
                p.terminate()
            except Exception:
                pass
        sys.exit(0)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    # 1. Start Python Flask app if not already running on port 5000
    if is_port_in_use(5000):
        print("\n[1/2] Backend AI Python sudah aktif di http://127.0.0.1:5000 (OK).")
    else:
        print("\n[1/2] Menyalakan Backend AI Python (app.py)...")
        p_app = subprocess.Popen(
            [sys.executable, "app.py"],
            cwd=BASE_DIR
        )
        processes.append(p_app)
        
        # Tunggu sampai port 5000 aktif
        print("      Menunggu backend siap...")
        for _ in range(30):
            if is_port_in_use(5000):
                print("      [OK] Backend AI Python aktif di port 5000!")
                break
            time.sleep(1)

    # Otomatis buka web di browser bawaan
    try:
        print("      [BROWSER] Membuka antarmuka web di browser: http://localhost:5000")
        webbrowser.open("http://localhost:5000")
    except Exception:
        pass

    # 2. Start Cloudflare Tunnel
    if not os.path.exists(CLOUDFLARED_EXE):
        print(f"\n[ERROR] File cloudflared.exe tidak ditemukan di: {CLOUDFLARED_EXE}")
        cleanup()
        return

    print("\n[2/2] Membuka Cloudflare Tunnel ke internet...")
    p_tunnel = subprocess.Popen(
        [CLOUDFLARED_EXE, "tunnel", "--url", "http://localhost:5000"],
        cwd=BASE_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1
    )
    processes.append(p_tunnel)

    detected_url = None
    url_regex = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")

    # Read output to detect URL
    for line in iter(p_tunnel.stdout.readline, ''):
        if not line:
            break
        # print("TUNNEL:", line.strip())
        match = url_regex.search(line)
        if match:
            detected_url = match.group(0)
            break

    if detected_url:
        copy_to_clipboard(detected_url)

        print("\n" + "=" * 65)
        print("  [ONLINE] SERVER FACE RECOGNITION BERHASIL TERHUBUNG!")
        print("=" * 65)
        print(f"  â€¢ URL Publik Tunnel : {detected_url}")
        print("  â€¢ Status Clipboard  : URL berhasil disalin otomatis! (Tinggal Ctrl+V)")
        print("=" * 65)

        # Update static/app.js dan push ke GitHub di thread terpisah agar cepat
        t = threading.Thread(target=update_appjs_and_push, args=(detected_url,))
        t.daemon = True
        t.start()

    else:
        print("\n[WARN] Belum menemukan URL trycloudflare. Tunnel tetap berjalan.")

    print("\n[INFO] Server sedang berjalan aktif.")
    print("[INFO] Jangan tutup jendela ini selama Anda menggunakan web.")
    print("[INFO] Tekan Ctrl + C di jendela ini untuk menghentikan server kapan saja.\n")

    # Keep alive and print remaining logs
    try:
        for line in iter(p_tunnel.stdout.readline, ''):
            # Print important status or errors if any
            if "ERR" in line or "failed" in line:
                print(f"[TUNNEL] {line.strip()}")
            time.sleep(0.01)
    except KeyboardInterrupt:
        cleanup()

if __name__ == "__main__":
    main()

