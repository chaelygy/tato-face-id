/**
 * =====================================================================
 *  TATO FACE SCAN &bull; STEALTH ONYX EDITION - Engine
 *  Executive Minimalist Face Scanner Logic
 * =====================================================================
 */

const CLOUD_BACKEND_URL = 'https://columns-temple-thousands-benchmark.trycloudflare.com';

const isFileProtocol = window.location.protocol === 'file:';
const isLocal = Boolean(
    window.location.hostname === 'localhost' || 
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '' ||
    isFileProtocol
);

let defaultApi = 'http://localhost:5000';
if (!isLocal) {
    defaultApi = CLOUD_BACKEND_URL;
} else if (!isFileProtocol && window.location.origin && window.location.origin !== 'null') {
    defaultApi = window.location.origin;
} else {
    defaultApi = 'http://localhost:5000';
}

const customApi = localStorage.getItem('faceid_backend_url');
let API_BASE = (customApi ? customApi.replace(/\/$/, '') : defaultApi);
const WEBCAM_INTERVAL_MS = 150;
const TARGET_FRAME_WIDTH = 640;
const JPEG_QUALITY = 0.76;

function configureServerUrl() {
    const current = localStorage.getItem('faceid_backend_url') || API_BASE;
    const input = prompt(
        "TATO FACE SCAN &bull; Konfigurasi Server Gateway:\n" +
        "• Local: http://localhost:5000\n" +
        "• Tunnel: https://xxxx.trycloudflare.com\n\n" +
        "URL Saat Ini:",
        current
    );
    if (input !== null) {
        const clean = input.trim().replace(/\/$/, '');
        if (clean) {
            localStorage.setItem('faceid_backend_url', clean);
        } else {
            localStorage.removeItem('faceid_backend_url');
        }
        window.location.reload();
    }
}

// System State
let currentMode = 'webcam';
let webcamStream = null;
let webcamActive = false;
let captureInterval = null;
let isProcessing = false;
let registeredPersons = [];

const elements = {
    navStatus: document.getElementById('navStatus'),
    statPersons: document.getElementById('statPersons'),
    btnWebcam: document.getElementById('btnWebcam'),
    btnUpload: document.getElementById('btnUpload'),
    panelTitle: document.getElementById('panelTitle'),
    webcamControls: document.getElementById('webcamControls'),
    webcamWrapper: document.getElementById('webcamWrapper'),
    uploadWrapper: document.getElementById('uploadWrapper'),
    webcamVideo: document.getElementById('webcamVideo'),
    overlayCanvas: document.getElementById('overlayCanvas'),
    scanLine: document.getElementById('scanLine'),
    videoPlaceholder: document.getElementById('videoPlaceholder'),
    btnStartCam: document.getElementById('btnStartCam'),
    btnStopCam: document.getElementById('btnStopCam'),
    uploadZone: document.getElementById('uploadZone'),
    fileInput: document.getElementById('fileInput'),
    uploadedPreview: document.getElementById('uploadedPreview'),
    uploadedImage: document.getElementById('uploadedImage'),
    uploadOverlayCanvas: document.getElementById('uploadOverlayCanvas'),
    faceCount: document.getElementById('faceCount'),
    perfTime: document.getElementById('perfTime'),
    processingIndicator: document.getElementById('processingIndicator'),
    resultsList: document.getElementById('resultsList'),
    btnRefreshDb: document.getElementById('btnRefreshDb'),
    personsList: document.getElementById('personsList'),
    searchPersons: document.getElementById('searchPersons')
};

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    checkServerHealth();
    loadPersons();
    setupEventListeners();
    setInterval(checkServerHealth, 10000);
});

function setupEventListeners() {
    if (elements.searchPersons) {
        elements.searchPersons.addEventListener('input', (e) => filterPersons(e.target.value));
    }

    if (elements.uploadZone) {
        elements.uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            elements.uploadZone.classList.add('drag-over');
        });
        elements.uploadZone.addEventListener('dragleave', () => {
            elements.uploadZone.classList.remove('drag-over');
        });
        elements.uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            elements.uploadZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) {
                processUploadedFile(e.dataTransfer.files[0]);
            }
        });
    }

    window.addEventListener('resize', () => {
        if (webcamActive) syncCanvasSize();
    });
}

async function checkServerHealth() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(`${API_BASE}/api/health`, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (res.ok) {
            const data = await res.json();
            updateServerStatus(true, `SECURE [${data.persons_count || data.registered_persons_count || '24'} ID]`);
            if (elements.statPersons && (data.persons_count || data.registered_persons_count)) {
                elements.statPersons.textContent = data.persons_count || data.registered_persons_count;
            }
        } else {
            updateServerStatus(false, 'GATEWAY ERR');
        }
    } catch (err) {
        updateServerStatus(false, 'OFFLINE (SETUP)');
    }
}

function updateServerStatus(online, text) {
    if (!elements.navStatus) return;
    const dot = elements.navStatus.querySelector('.stealth-dot');
    const label = elements.navStatus.querySelector('.stealth-txt');
    if (dot) {
        dot.className = `stealth-dot ${online ? 'online' : 'offline'}`;
    }
    if (label) label.textContent = text;
}

async function loadPersons() {
    try {
        const res = await fetch(`${API_BASE}/api/persons`);
        if (res.ok) {
            const data = await res.json();
            registeredPersons = data.persons || [];
            renderPersonsList(registeredPersons);
            if (elements.statPersons) elements.statPersons.textContent = registeredPersons.length;
        }
    } catch (err) {
        console.warn('Could not load persons vault:', err);
    }
}

function renderPersonsList(persons) {
    if (!elements.personsList) return;
    if (persons.length === 0) {
        elements.personsList.innerHTML = `<div class="stealth-loading-txt">TIDAK ADA REKORD IDENTITAS</div>`;
        return;
    }
    elements.personsList.innerHTML = persons.map(p => `
        <div class="vault-node" title="${escapeHtml(p.name)}">
            <span class="vault-node-dot"></span>
            <span class="vault-node-name">${escapeHtml(p.name)}</span>
        </div>
    `).join('');
}

function filterPersons(query) {
    const q = query.toLowerCase().trim();
    const filtered = registeredPersons.filter(p => p.name.toLowerCase().includes(q));
    renderPersonsList(filtered);
}

function switchMode(mode) {
    if (currentMode === mode) return;
    currentMode = mode;

    if (mode === 'webcam') {
        elements.btnWebcam.classList.add('active');
        elements.btnUpload.classList.remove('active');
        elements.webcamWrapper.classList.remove('hidden');
        elements.uploadWrapper.classList.add('hidden');
        elements.webcamControls.classList.remove('hidden');
        elements.panelTitle.textContent = 'Sensor Kamera Real-Time';
    } else {
        elements.btnUpload.classList.add('active');
        elements.btnWebcam.classList.remove('active');
        elements.webcamWrapper.classList.add('hidden');
        elements.uploadWrapper.classList.remove('hidden');
        elements.webcamControls.classList.add('hidden');
        elements.panelTitle.textContent = 'Pindai Arsip Foto';
        if (webcamActive) stopWebcam();
    }
    clearResults();
}

async function startWebcam() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: 'user'
            },
            audio: false
        });

        webcamStream = stream;
        elements.webcamVideo.srcObject = stream;
        elements.webcamVideo.onloadedmetadata = () => {
            elements.webcamVideo.play();
            webcamActive = true;
            syncCanvasSize();
            elements.videoPlaceholder.classList.add('hidden');
            elements.scanLine.classList.remove('hidden');
            elements.btnStartCam.classList.add('hidden');
            elements.btnStopCam.classList.remove('hidden');
            startCaptureLoop();
        };
    } catch (err) {
        alert('Gagal mengakses sensor kamera: ' + err.message);
    }
}

let captureTimer = null;

function scheduleNextCapture(delay = WEBCAM_INTERVAL_MS) {
    if (!webcamActive) return;
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = setTimeout(captureAndSendFrame, delay);
}

function stopWebcam() {
    webcamActive = false;
    if (captureInterval) clearInterval(captureInterval);
    if (captureTimer) clearTimeout(captureTimer);
    if (webcamStream) {
        webcamStream.getTracks().forEach(track => track.stop());
        webcamStream = null;
    }
    if (elements.webcamVideo) elements.webcamVideo.srcObject = null;
    if (elements.videoPlaceholder) elements.videoPlaceholder.classList.remove('hidden');
    if (elements.scanLine) elements.scanLine.classList.add('hidden');
    if (elements.btnStartCam) elements.btnStartCam.classList.remove('hidden');
    if (elements.btnStopCam) elements.btnStopCam.classList.add('hidden');

    const ctx = elements.overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, elements.overlayCanvas.width, elements.overlayCanvas.height);
    clearResults();
}

function syncCanvasSize() {
    const video = elements.webcamVideo;
    if (video.videoWidth && video.videoHeight) {
        elements.overlayCanvas.width = video.videoWidth;
        elements.overlayCanvas.height = video.videoHeight;
    }
}

function startCaptureLoop() {
    if (captureInterval) clearInterval(captureInterval);
    if (captureTimer) clearTimeout(captureTimer);
    captureAndSendFrame();
}

async function captureAndSendFrame() {
    if (!webcamActive || isProcessing) {
        if (webcamActive && !isProcessing) scheduleNextCapture(100);
        return;
    }
    const video = elements.webcamVideo;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        scheduleNextCapture(100);
        return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // Kompresi resolusi: turunkan ke max 640px untuk payload ultra-ringan (~25KB vs ~400KB)
    let sendW = vw;
    let sendH = vh;
    let scaleFactor = 1.0;

    if (vw > TARGET_FRAME_WIDTH) {
        scaleFactor = vw / TARGET_FRAME_WIDTH;
        sendW = TARGET_FRAME_WIDTH;
        sendH = Math.round(vh / scaleFactor);
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = sendW;
    tempCanvas.height = sendH;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(video, 0, 0, sendW, sendH);

    const imageData = tempCanvas.toDataURL('image/jpeg', JPEG_QUALITY);
    await sendForRecognition(imageData, 'webcam', scaleFactor);
}

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (file) processUploadedFile(file);
}

function processUploadedFile(file) {
    if (!file.type.startsWith('image/')) {
        alert('Format file tidak didukung. Harap gunakan gambar (JPG, PNG, WEBP).');
        return;
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
        const fullImageData = e.target.result;
        elements.uploadedImage.src = fullImageData;
        elements.uploadZone.classList.add('hidden');
        elements.uploadedPreview.classList.remove('hidden');

        elements.uploadedImage.onload = async () => {
            const img = elements.uploadedImage;
            const nw = img.naturalWidth;
            const nh = img.naturalHeight;
            elements.uploadOverlayCanvas.width = nw;
            elements.uploadOverlayCanvas.height = nh;

            // Optimasi kompresi gambar upload jika resolusi tinggi (> 1200px)
            let sendData = fullImageData;
            let scaleFactor = 1.0;
            const MAX_UPLOAD_DIM = 1200;
            if (nw > MAX_UPLOAD_DIM || nh > MAX_UPLOAD_DIM) {
                const maxD = Math.max(nw, nh);
                scaleFactor = maxD / MAX_UPLOAD_DIM;
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(nw / scaleFactor);
                canvas.height = Math.round(nh / scaleFactor);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                sendData = canvas.toDataURL('image/jpeg', 0.85);
            }

            await sendForRecognition(sendData, 'upload', scaleFactor);
        };
    };
    reader.readAsDataURL(file);
}

function removeUpload() {
    elements.uploadedImage.src = '';
    elements.uploadedPreview.classList.add('hidden');
    elements.uploadZone.classList.remove('hidden');
    elements.fileInput.value = '';
    const ctx = elements.uploadOverlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, elements.uploadOverlayCanvas.width, elements.uploadOverlayCanvas.height);
    clearResults();
}

async function sendForRecognition(imageData, source, scaleFactor = 1.0) {
    if (isProcessing) return;
    isProcessing = true;
    if (elements.processingIndicator) elements.processingIndicator.classList.remove('hidden');

    try {
        const res = await fetch(`${API_BASE}/api/recognize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: imageData })
        });

        const data = await res.json();
        if (data.error) {
            console.error('Inference error:', data.error);
        } else {
            // Re-scale koordinat bounding box ke ukuran kanvas tampilan asli
            const mappedFaces = (data.faces || []).map(face => ({
                ...face,
                bbox: {
                    x: Math.round(face.bbox.x * scaleFactor),
                    y: Math.round(face.bbox.y * scaleFactor),
                    w: Math.round(face.bbox.w * scaleFactor),
                    h: Math.round(face.bbox.h * scaleFactor)
                }
            }));

            displayResults(mappedFaces, data.processing_time_ms);
            if (source === 'webcam') {
                drawBoundingBoxes(elements.overlayCanvas, mappedFaces, true);
            } else {
                drawBoundingBoxes(elements.uploadOverlayCanvas, mappedFaces, false);
            }
        }
    } catch (err) {
        console.error('Network gateway error:', err);
    } finally {
        isProcessing = false;
        if (elements.processingIndicator) elements.processingIndicator.classList.add('hidden');
        if (source === 'webcam' && webcamActive) {
            scheduleNextCapture(WEBCAM_INTERVAL_MS);
        }
    }
}

// Bounding box: Sleek Onyx & Titanium Gold
function drawBoundingBoxes(canvas, faces, isMirrored) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    faces.forEach((face, i) => {
        let { x, y, w: bw, h: bh } = face.bbox;
        if (isMirrored) {
            x = w - x - bw;
        }

        const isRecognized = face.name !== 'Unknown';
        const color = isRecognized ? '#e5c07b' : '#71717a';
        const glowColor = isRecognized ? 'rgba(229, 192, 123, 0.4)' : 'rgba(113, 113, 122, 0.25)';

        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 12;

        // Clean stealth corner pins
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        const cornerLen = Math.min(bw, bh) * 0.2;

        // Top-left
        ctx.beginPath();
        ctx.moveTo(x, y + cornerLen);
        ctx.lineTo(x, y);
        ctx.lineTo(x + cornerLen, y);
        ctx.stroke();

        // Top-right
        ctx.beginPath();
        ctx.moveTo(x + bw - cornerLen, y);
        ctx.lineTo(x + bw, y);
        ctx.lineTo(x + bw, y + cornerLen);
        ctx.stroke();

        // Bottom-left
        ctx.beginPath();
        ctx.moveTo(x, y + bh - cornerLen);
        ctx.lineTo(x, y + bh);
        ctx.lineTo(x + cornerLen, y + bh);
        ctx.stroke();

        // Bottom-right
        ctx.beginPath();
        ctx.moveTo(x + bw - cornerLen, y + bh);
        ctx.lineTo(x + bw, y + bh);
        ctx.lineTo(x + bw, y + bh - cornerLen);
        ctx.stroke();

        // Fine 1px bounding frame
        ctx.shadowBlur = 0;
        ctx.strokeStyle = isRecognized ? 'rgba(229, 192, 123, 0.25)' : 'rgba(113, 113, 122, 0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, bw, bh);

        // Stealth Minimalist Tag
        const tagText = isRecognized 
            ? `${face.name.toUpperCase()} // ${face.confidence}%` 
            : 'UNREGISTERED SUBJECT';
        
        ctx.font = `700 ${Math.max(12, bw * 0.052)}px "Space Mono", monospace`;
        const textMetrics = ctx.measureText(tagText);
        const tagW = textMetrics.width + 18;
        const tagH = Math.max(24, bw * 0.075);
        const tagY = y - tagH - 6;

        // Dark matte tag box
        ctx.fillStyle = '#09090d';
        ctx.fillRect(x, tagY, tagW, tagH);
        ctx.strokeStyle = isRecognized ? '#e5c07b' : '#52525b';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, tagY, tagW, tagH);

        // Tag label
        ctx.fillStyle = isRecognized ? '#e5c07b' : '#a1a1aa';
        ctx.textBaseline = 'middle';
        ctx.fillText(tagText, x + 9, tagY + tagH / 2);

        // Sub coordinate indicator
        ctx.font = `400 10px "Space Mono", monospace`;
        ctx.fillStyle = '#71717a';
        ctx.fillText(`LOC: [${Math.round(x)}, ${Math.round(y)}]`, x, y + bh + 14);
    });
}

function displayResults(faces, processingTime) {
    if (elements.faceCount) elements.faceCount.textContent = `${faces.length} Wajah Terdeteksi`;
    if (elements.perfTime) elements.perfTime.textContent = `${Math.round(processingTime)} ms`;

    if (!elements.resultsList) return;
    if (faces.length === 0) {
        elements.resultsList.innerHTML = `
            <div class="stealth-empty-box">
                <div class="stealth-target-icon">&#8857;</div>
                <h3>TIDAK ADA SUBJEK TERDETEKSI</h3>
                <p>Sensor pemindai sedang memantau area. Pastikan wajah subjek berada dalam jangkauan kamera.</p>
            </div>
        `;
        return;
    }

    const sorted = [...faces].sort((a, b) => {
        if (a.name === 'Unknown' && b.name !== 'Unknown') return 1;
        if (a.name !== 'Unknown' && b.name === 'Unknown') return -1;
        return b.confidence - a.confidence;
    });

    elements.resultsList.innerHTML = sorted.map((face, idx) => {
        const isRecognized = face.name !== 'Unknown';
        const cardClass = isRecognized ? 'recognized' : 'unknown';
        const initials = isRecognized ? getInitials(face.name) : '??';
        const statusText = isRecognized ? 'TERVERIFIKASI' : 'TIDAK TERDAFTAR';

        return `
            <div class="stealth-card ${cardClass}">
                <div class="card-top">
                    <div class="card-meta-user">
                        <div class="card-avatar-monolith">${initials}</div>
                        <div>
                            <div class="card-name">${escapeHtml(face.name)}</div>
                            <span style="font-size: 0.62rem; color: #52525b; font-family: 'Space Mono';">DOSSIER_ID_${String(idx + 1).padStart(2, '0')}</span>
                        </div>
                    </div>
                    <span class="card-status-badge">${statusText}</span>
                </div>
                <div class="card-metrics-strip">
                    <span class="metric-accuracy-val">AKURASI: ${face.confidence}%</span>
                    <span class="metric-distance-val">DIST: ${face.distance}</span>
                </div>
                ${isRecognized ? `
                    <div class="card-stealth-bar-container">
                        <div class="card-stealth-bar" style="width: ${face.confidence}%"></div>
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

function clearResults() {
    if (elements.faceCount) elements.faceCount.textContent = '0 Wajah Terdeteksi';
    if (elements.perfTime) elements.perfTime.textContent = '0 ms';
    if (elements.resultsList) {
        elements.resultsList.innerHTML = `
            <div class="stealth-empty-box" id="emptyState">
                <div class="stealth-target-icon">&#8857;</div>
                <h3>MENUNGGU SUBJEK PEMINDAIAN</h3>
                <p>Posisikan wajah di depan lensa atau unggah foto untuk mengeksekusi pencocokan biometrik.</p>
            </div>
        `;
    }
}

function getInitials(name) {
    return name.split(' ')
        .filter(w => w.length > 0)
        .map(w => w[0].toUpperCase())
        .slice(0, 2)
        .join('');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
