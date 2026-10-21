"""
==========================================================
  FACE RECOGNITION BACKEND SERVER
  Framework: Flask
  Model: DeepFace - Facenet512
  
  Endpoints:
  - GET  /                → Halaman utama (serve frontend)
  - POST /api/recognize   → Menerima frame gambar, mengenali wajah
  - GET  /api/status      → Status server & info model
  - GET  /api/persons     → Daftar orang yang terdaftar
==========================================================
"""

import os
import sys
import pickle
import base64
import time
import numpy as np
import cv2
from io import BytesIO
from PIL import Image
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from deepface import DeepFace

# Force UTF-8 untuk Windows console
os.environ["PYTHONIOENCODING"] = "utf-8"
if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# ===================== KONFIGURASI =====================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENCODING_FILE = os.path.join(BASE_DIR, "face_encodings.pkl")
STATIC_DIR = os.path.join(BASE_DIR, "static")
MODEL_NAME = "Facenet512"
DETECTOR_BACKEND = "retinaface"

# Threshold fallback jika tidak ada di file pickle
DEFAULT_THRESHOLD = 0.30

# Confidence mapping: cosine_distance -> persentase kecocokan
# Distance 0.0 = 100%, distance = threshold = cutoff
# =======================================================

app = Flask(__name__, static_folder=STATIC_DIR)
CORS(app)

# Global variables
face_data = None
model_loaded = False
last_loaded_mtime = 0
face_matrix = None
face_labels = None
face_unique_names = None


def load_face_data():
    """Memuat data encoding wajah dari file pickle dan menyiapkan matriks KNN."""
    global face_data, model_loaded, last_loaded_mtime
    global face_matrix, face_labels, face_unique_names
    
    if not os.path.exists(ENCODING_FILE):
        print(f"[WARNING] File encoding belum ada: {ENCODING_FILE}")
        print("Training sedang berjalan atau belum dijalankan.")
        return False

    try:
        mtime = os.path.getmtime(ENCODING_FILE)
        with open(ENCODING_FILE, "rb") as f:
            data = pickle.load(f)
        
        face_data = data
        last_loaded_mtime = mtime
        
        # Buat stacked normalized matrix dari seluruh embedding untuk Vectorized KNN Top-3
        all_embs = face_data.get("all_embeddings", {})
        matrix_list = []
        labels_list = []
        for name, embs in all_embs.items():
            for e in embs:
                e_norm = e / (np.linalg.norm(e) + 1e-10)
                matrix_list.append(e_norm)
                labels_list.append(name)
        
        if matrix_list:
            face_matrix = np.array(matrix_list, dtype=np.float32)
            face_labels = np.array(labels_list)
            face_unique_names = np.unique(face_labels)
            total_vectors = len(matrix_list)
        else:
            face_matrix = None
            face_labels = None
            face_unique_names = np.array([])
            total_vectors = 0

        print(f"[INFO] Data wajah dimuat:")
        print(f"  - Total orang   : {face_data.get('total_persons', 0)}")
        print(f"  - Total vektor  : {total_vectors} embedding aktif")
        print(f"  - Model         : {face_data.get('model_name', MODEL_NAME)}")
        print(f"  - Threshold     : {face_data.get('threshold', DEFAULT_THRESHOLD):.4f}")
        print(f"  - Orang         : {', '.join(face_data.get('person_names', []))}")
        
        # Pre-warm model dengan dummy image jika belum di-warm
        if not model_loaded:
            print("[INFO] Pre-warming model DeepFace...")
            try:
                dummy = np.zeros((160, 160, 3), dtype=np.uint8)
                dummy[50:110, 50:110] = 128
                DeepFace.represent(
                    img_path=dummy,
                    model_name=MODEL_NAME,
                    detector_backend="skip",
                    enforce_detection=False
                )
                print("[INFO] Model DeepFace siap!")
            except Exception as e:
                print(f"[WARNING] Pre-warming: {e}")
        
        model_loaded = True
        return True
    except Exception as e:
        print(f"[ERROR] Gagal memuat data wajah: {e}")
        return False


def ensure_latest_data():
    """Memeriksa apakah ada checkpoint baru di disk dan memuat ulang secara otomatis."""
    global last_loaded_mtime
    if os.path.exists(ENCODING_FILE):
        try:
            mtime = os.path.getmtime(ENCODING_FILE)
            if mtime > last_loaded_mtime:
                load_face_data()
        except Exception:
            pass


def cosine_distance(a, b):
    """Menghitung cosine distance antara dua vektor."""
    a_norm = a / (np.linalg.norm(a) + 1e-10)
    b_norm = b / (np.linalg.norm(b) + 1e-10)
    return float(1.0 - np.dot(a_norm, b_norm))


def distance_to_confidence(distance, threshold):
    """
    Mengkonversi cosine distance ke persentase confidence.
    Jika wajah teridentifikasi (distance < threshold), persentase langsung berada di atas 90% (91.0% - 99.6%)
    sesuai instruksi pengguna.
    """
    if distance >= threshold:
        return 0.0
    
    # Rasio kedekatan: 0.0 (jarak = 0, identik) -> 1.0, jarak = threshold -> 0.0
    closeness = max(0.0, min(1.0, 1.0 - (distance / threshold)))
    
    # Mapping non-linear ke rentang 91.0% s/d 99.6%
    # Semakin kecil distance, semakin mendekati 99.6%
    confidence = 91.0 + (closeness ** 0.65) * 8.6
    
    return round(float(min(99.6, max(91.0, confidence))), 1)


def recognize_face_embedding(embedding):
    """
    Mengenali wajah berdasarkan embedding 512D menggunakan Vectorized KNN Top-3.
    Mencari kecocokan paling akurat ke seluruh foto tiap orang secara serentak.
    
    Returns: (name, confidence, distance) atau ("Unknown", 0.0, best_distance)
    """
    if face_data is None or face_matrix is None or len(face_matrix) == 0:
        return "Unknown", 0.0, 999.0

    threshold = face_data.get("threshold", DEFAULT_THRESHOLD)
    
    # Normalisasi query embedding
    emb_norm = embedding / (np.linalg.norm(embedding) + 1e-10)
    
    # 1. Hitung cosine similarity ke SELURUH 700+ foto dalam dataset sekaligus via matrix dot product
    similarities = np.dot(face_matrix, emb_norm)
    distances = 1.0 - similarities

    # 2. Cari skor terbaik untuk setiap orang menggunakan Top-3 foto terdekat
    best_name = "Unknown"
    best_distance = float("inf")

    for name in face_unique_names:
        person_dists = np.sort(distances[face_labels == name])
        top_k = min(3, len(person_dists))
        avg_dist = float(np.mean(person_dists[:top_k]))

        if avg_dist < best_distance:
            best_distance = avg_dist
            best_name = name

    # 3. Validasi Threshold: jika jarak >= threshold, tolak sebagai Unknown
    if best_distance >= threshold:
        return "Unknown", 0.0, round(float(best_distance), 4)

    # 4. Konversi ke Confidence: jika cocok, persentase selalu di atas 90% (91% - 99.6%)
    confidence = distance_to_confidence(best_distance, threshold)
    return best_name, confidence, round(float(best_distance), 4)


def process_image(img_array):
    """
    Memproses gambar: deteksi wajah dan kenali setiap wajah.
    
    Returns: list of dict dengan info setiap wajah terdeteksi.
    """
    results = []
    
    try:
        # Deteksi dan ekstrak embedding wajah
        representations = DeepFace.represent(
            img_path=img_array,
            model_name=MODEL_NAME,
            detector_backend=DETECTOR_BACKEND,
            enforce_detection=False,
            align=True
        )

        for rep in representations:
            embedding = np.array(rep["embedding"])
            
            # Ambil koordinat wajah
            facial_area = rep.get("facial_area", {})
            x = facial_area.get("x", 0)
            y = facial_area.get("y", 0)
            w = facial_area.get("w", 0)
            h = facial_area.get("h", 0)
            
            # Kenali wajah
            name, confidence, distance = recognize_face_embedding(embedding)
            
            # Hanya masukkan jika confidence > 0 atau ada wajah terdeteksi
            face_info = {
                "name": name,
                "confidence": round(confidence, 1),
                "distance": round(float(distance), 4),
                "bbox": {
                    "x": int(x),
                    "y": int(y),
                    "w": int(w),
                    "h": int(h)
                }
            }
            results.append(face_info)

    except Exception as e:
        print(f"[ERROR] Gagal memproses gambar: {e}")
    
    return results


# ===================== ROUTES =====================

@app.route("/")
def index():
    """Serve halaman utama."""
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/<path:filename>")
def serve_static(filename):
    """Serve file static."""
    return send_from_directory(STATIC_DIR, filename)


@app.route("/api/status", methods=["GET"])
@app.route("/api/health", methods=["GET"])
def status():
    """Cek status server."""
    ensure_latest_data()
    total = face_data["total_persons"] if face_data else 0
    return jsonify({
        "status": "online",
        "model_loaded": model_loaded,
        "model_name": MODEL_NAME,
        "model": MODEL_NAME,
        "detector": DETECTOR_BACKEND,
        "total_persons": total,
        "persons_count": total,
        "registered_persons_count": total,
        "threshold": face_data["threshold"] if face_data else DEFAULT_THRESHOLD,
        "persons": face_data["person_names"] if face_data else []
    })


@app.route("/api/persons", methods=["GET"])
def get_persons():
    """Daftar orang yang terdaftar."""
    ensure_latest_data()
    if face_data is None:
        return jsonify({"persons": [], "total": 0})
    
    persons_info = []
    for name in face_data["person_names"]:
        stats = face_data.get("stats", {}).get(name, {})
        persons_info.append({
            "name": name,
            "photos": stats.get("successful_encodings", 0)
        })
    
    return jsonify({
        "persons": persons_info,
        "total": face_data["total_persons"]
    })


@app.route("/api/recognize", methods=["POST"])
def recognize():
    """
    Menerima gambar (base64 atau file upload) dan mengenali wajah.
    
    Body (JSON):  { "image": "data:image/jpeg;base64,..." }
    Body (Form):  file upload dengan key "image"
    """
    start_time = time.time()
    ensure_latest_data()

    if not model_loaded:
        return jsonify({
            "error": "Model belum dimuat. Jalankan train.py terlebih dahulu.",
            "faces": []
        }), 503

    img_array = None

    try:
        # Mode 1: Base64 image (dari webcam)
        if request.is_json:
            data = request.get_json()
            image_data = data.get("image", "")
            
            # Hapus header data URI jika ada
            if "," in image_data:
                image_data = image_data.split(",")[1]
            
            # Decode base64
            img_bytes = base64.b64decode(image_data)
            img_pil = Image.open(BytesIO(img_bytes)).convert("RGB")
            img_array = np.array(img_pil)
            # Convert RGB to BGR for OpenCV compatibility
            img_array = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)

        # Mode 2: File upload
        elif "image" in request.files:
            file = request.files["image"]
            img_pil = Image.open(file.stream).convert("RGB")
            img_array = np.array(img_pil)
            img_array = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)

        else:
            return jsonify({
                "error": "Tidak ada gambar yang diterima.",
                "faces": []
            }), 400

    except Exception as e:
        return jsonify({
            "error": f"Gagal membaca gambar: {str(e)}",
            "faces": []
        }), 400

    # Proses recognition
    faces = process_image(img_array)
    
    elapsed = time.time() - start_time

    return jsonify({
        "faces": faces,
        "count": len(faces),
        "processing_time_ms": round(elapsed * 1000, 1)
    })


# ===================== MAIN =====================

if __name__ == "__main__":
    print("\n" + "=" * 60)
    print("  FACE RECOGNITION SERVER")
    print("=" * 60 + "\n")
    
    if not load_face_data():
        print("\n[FATAL] Tidak dapat memuat data wajah.")
        print("Pastikan Anda sudah menjalankan: python train.py")
        sys.exit(1)
    
    port = int(os.environ.get("PORT", 5000))
    print(f"\n[INFO] Server berjalan di http://0.0.0.0:{port}")
    print(f"[INFO] Tekan Ctrl+C untuk menghentikan server.\n")
    
    app.run(
        host="0.0.0.0",
        port=port,
        debug=False,
        threaded=True
    )
