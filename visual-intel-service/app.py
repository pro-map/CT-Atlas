from __future__ import annotations

import base64
import hashlib
import hmac
import math
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

import cv2
import imagehash
import numpy as np
import pytesseract
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from PIL import ExifTags, Image, ImageOps

SERVICE_VERSION = "ct-atlas-visual-intel-v2"
MAX_FILES = 10
MAX_TOTAL_BYTES = 30 * 1024 * 1024
MAX_IMAGE_SIDE = 2200
MAX_VIDEO_FRAMES = 8

api = FastAPI(title="CT Atlas Facial Intelligence", version=SERVICE_VERSION)

# Face detection: YuNet (OpenCV model zoo, opencv/opencv_zoo, face_detection_yunet_2023mar.onnx). It replaces
# the Haar frontal+profile cascades, which reported hands, arms, torsos and textures as faces. The model file
# is pinned by checksum; if it is missing or altered the service falls back to a strict frontal-only Haar
# cascade (and says so in /health). YuNet is a detector only: it produces no identity and no embedding.
YUNET_NAME = "yunet_2023mar"
YUNET_MODEL = Path(__file__).resolve().parent / "models" / "face_detection_yunet_2023mar.onnx"
YUNET_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
FACE_SCORE_THRESHOLD = float(os.getenv("CT_ATLAS_FACE_SCORE_THRESHOLD", "0.75"))
MIN_FACE_SIDE = 20  # pixels, in the analysed pyramid level
PYRAMID_BAND_MAX = 200  # a pyramid level owns faces whose box is at most this many pixels there
PYRAMID_MIN_SIDE = 200  # the pyramid stops once the next level would be smaller than this
OVERSIZED_FACE_SCORE = 0.85  # score required from boxes larger than the band (only the last level accepts them)
_DETECTOR_LOCK = threading.RLock()
_DETECTOR: dict[str, Any] = {"loaded": False, "detector": None, "name": "", "error": ""}


def _check_key(value: str | None) -> None:
    expected = os.getenv("CT_ATLAS_VISUAL_SHARED_SECRET", "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="Visual service secret is not configured.")
    if not hmac.compare_digest(str(value or ""), expected):
        raise HTTPException(status_code=401, detail="Unauthorized visual request.")


def _clean(value: Any, limit: int = 4000) -> str:
    return " ".join(str(value or "").split())[:limit]


def _resize_for_analysis(frame: np.ndarray) -> tuple[np.ndarray, float]:
    h, w = frame.shape[:2]
    largest = max(h, w)
    if largest <= MAX_IMAGE_SIDE:
        return frame, 1.0
    scale = MAX_IMAGE_SIDE / float(largest)
    return cv2.resize(frame, (max(1, int(w * scale)), max(1, int(h * scale)))), scale


def _load_detector() -> tuple[Any, str]:
    """YuNet (OpenCV's face detector, ~230 KB, no embeddings) when its pinned model file is intact,
    otherwise a strict frontal-only Haar cascade. Loaded once."""
    with _DETECTOR_LOCK:
        if _DETECTOR["loaded"]:
            return _DETECTOR["detector"], _DETECTOR["name"]
        detector: Any = None
        name = "opencv_haar_fallback"
        try:
            model_bytes = YUNET_MODEL.read_bytes()
            if hashlib.sha256(model_bytes).hexdigest() != YUNET_SHA256:
                raise ValueError("face detection model checksum mismatch")
            detector = cv2.FaceDetectorYN.create(str(YUNET_MODEL), "", (320, 320), FACE_SCORE_THRESHOLD, 0.3, 5000)
            name = YUNET_NAME
        except Exception as exc:  # missing/corrupt model or an OpenCV build without FaceDetectorYN
            _DETECTOR["error"] = _clean(exc, 200)
            cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
            detector = None if cascade.empty() else cascade
        _DETECTOR.update({"detector": detector, "name": name, "loaded": True})
        return detector, name


def _plausible_face(x: float, y: float, w: float, h: float, landmarks: np.ndarray) -> bool:
    """A real face has its five landmarks (eyes, nose, mouth corners) in a face-shaped layout, in any
    orientation. Arms, hands, torsos and textures that fool a detector rarely satisfy all of this."""
    if min(w, h) < MIN_FACE_SIDE or not 0.6 <= h / w <= 2.2:
        return False
    right_eye, left_eye, nose, mouth_right, mouth_left = landmarks
    eyes_mid = (right_eye + left_eye) / 2.0
    mouth_mid = (mouth_right + mouth_left) / 2.0
    axis = mouth_mid - eyes_mid
    axis_len = float(np.linalg.norm(axis))
    eye_dist = float(np.linalg.norm(right_eye - left_eye))
    if axis_len < 1.0 or eye_dist < 1.0:
        return False
    margin = 0.3 * max(w, h)
    for px, py in landmarks:
        if px < x - margin or px > x + w + margin or py < y - margin or py > y + h + margin:
            return False
    # The eyes come closer together as the head turns, so this ratio is only bounded loosely.
    if not 0.4 <= axis_len / eye_dist <= 8.0:
        return False
    nose_position = float(np.dot(nose - eyes_mid, axis) / (axis_len * axis_len))
    return 0.1 <= nose_position <= 0.95


def _yunet_detections(image: np.ndarray) -> list[tuple[float, float, float, float, float, np.ndarray]]:
    """Raw YuNet output for one image: (x, y, w, h, score, 5 landmarks)."""
    detector, _ = _load_detector()
    height, width = image.shape[:2]
    with _DETECTOR_LOCK:
        detector.setInputSize((width, height))
        _, rows = detector.detect(image)
    return [
        (float(row[0]), float(row[1]), float(row[2]), float(row[3]), float(row[14]), np.array(row[4:14], dtype=float).reshape(5, 2))
        for row in ([] if rows is None else rows)
    ]


def _overlap(a: tuple[Any, ...], b: tuple[Any, ...]) -> tuple[float, float]:
    """(intersection / union, intersection / smaller box) of two boxes given as (x, y, w, h, ...)."""
    ax, ay, aw, ah = a[:4]
    bx, by, bw, bh = b[:4]
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if x2 <= x1 or y2 <= y1:
        return 0.0, 0.0
    inter = (x2 - x1) * (y2 - y1)
    union = aw * ah + bw * bh - inter
    smaller = min(aw * ah, bw * bh)
    return (inter / union if union else 0.0), (inter / smaller if smaller else 0.0)


def _merge_detections(detections: list[tuple[int, int, int, int, float | None]]) -> list[tuple[int, int, int, int, float | None]]:
    """The same face seen at two pyramid levels, or a box lying inside a better one, is reported once."""
    kept: list[tuple[int, int, int, int, float | None]] = []
    ranked = sorted(detections, key=lambda d: ((d[4] if d[4] is not None else 0.0), d[2] * d[3]), reverse=True)
    for det in ranked:
        if all(iou < 0.3 and inside < 0.7 for iou, inside in (_overlap(det, other) for other in kept)):
            kept.append(det)
    return kept


def _detect_boxes(frame: np.ndarray) -> list[tuple[int, int, int, int, float | None]]:
    """(x, y, w, h, score) face boxes in the pixels of `frame`. The score is None for the fallback cascade."""
    detector, name = _load_detector()
    height, width = frame.shape[:2]
    if detector is None:
        return []

    if name != YUNET_NAME:
        gray = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
        with _DETECTOR_LOCK:
            found = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=8, minSize=(48, 48))
        return _merge_detections([(int(bx), int(by), int(bw), int(bh), None) for bx, by, bw, bh in found])

    # YuNet is calibrated for faces up to a few hundred pixels. Fed a large frame at native size it MISSES big
    # faces (their score falls to ~0.6 above ~550 px) and scores big look-alikes (a round emblem on a uniform)
    # above the threshold. So the frame is analysed as a pyramid (1, 1/2, 1/4, ...): a level only owns the faces
    # whose box is at most PYRAMID_BAND_MAX px there (the last level owns everything), which means every face
    # is judged at a size the model handles and a look-alike that only fires at one oversized scale is dropped.
    candidates: list[tuple[int, int, int, int, float | None]] = []
    scale = 1.0
    while True:
        if scale == 1.0:
            level = frame
        else:
            level = cv2.resize(frame, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv2.INTER_AREA)
        is_last = min(width, height) * scale * 0.5 < PYRAMID_MIN_SIDE
        for x, y, bw, bh, score, landmarks in _yunet_detections(level):
            oversized = max(bw, bh) > PYRAMID_BAND_MAX
            if oversized and not is_last:
                continue
            # Small faces and oversized boxes are where false positives live: ask for more confidence.
            needed = OVERSIZED_FACE_SCORE if (oversized or min(bw, bh) < 32) else FACE_SCORE_THRESHOLD
            if score < needed or not _plausible_face(x, y, bw, bh, landmarks):
                continue
            x0, y0 = max(0, round(x / scale)), max(0, round(y / scale))
            x1, y1 = min(width, round((x + bw) / scale)), min(height, round((y + bh) / scale))
            if x1 - x0 >= 2 and y1 - y0 >= 2:
                candidates.append((x0, y0, x1 - x0, y1 - y0, score))
        if is_last:
            break
        scale *= 0.5
    return _merge_detections(candidates)


def _detect_faces(frame: np.ndarray) -> list[dict[str, Any]]:
    work, scale = _resize_for_analysis(frame)
    boxes = sorted(_detect_boxes(work), key=lambda b: b[2] * b[3], reverse=True)[:40]
    inv = 1.0 / scale
    h, w = frame.shape[:2]
    results: list[dict[str, Any]] = []

    for index, (x, y, fw, fh, score) in enumerate(boxes, start=1):
        x0 = max(0, int(x * inv))
        y0 = max(0, int(y * inv))
        x1 = min(w, int((x + fw) * inv))
        y1 = min(h, int((y + fh) * inv))
        crop = frame[y0:y1, x0:x1]
        if crop.size == 0:
            continue
        crop_gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        sharpness = float(cv2.Laplacian(crop_gray, cv2.CV_64F).var())
        brightness = float(crop_gray.mean())
        contrast = float(crop_gray.std())
        ratio = ((x1 - x0) * (y1 - y0)) / float(max(1, w * h))
        quality_score = min(
            100.0,
            (min(sharpness / 180.0, 1.0) * 45.0)
            + (min(ratio / 0.08, 1.0) * 35.0)
            + (min(contrast / 55.0, 1.0) * 20.0),
        )
        quality = "HIGH" if quality_score >= 70 else ("MEDIUM" if quality_score >= 42 else "LOW")
        results.append(
            {
                "face_id": index,
                "box": {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0},
                # None when the fallback cascade produced the box: it has no confidence to report.
                "detection_score": None if score is None else round(float(score), 3),
                "size_ratio": round(ratio, 4),
                "sharpness": round(sharpness, 1),
                "brightness": round(brightness, 1),
                "contrast": round(contrast, 1),
                "quality_score": round(quality_score, 1),
                "quality": quality,
            }
        )
    return results


def _annotated_data_uri(frame: np.ndarray, faces: list[dict[str, Any]]) -> str:
    preview = frame.copy()
    for face in faces:
        box = face["box"]
        x, y, w, h = box["x"], box["y"], box["w"], box["h"]
        cv2.rectangle(preview, (x, y), (x + w, y + h), (255, 255, 255), 2)
        cv2.putText(
            preview,
            f"F{face['face_id']} {face['quality']}",
            (x, max(18, y - 6)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.52,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )
    h, w = preview.shape[:2]
    if max(h, w) > 1280:
        scale = 1280.0 / max(h, w)
        preview = cv2.resize(preview, (int(w * scale), int(h * scale)))
    ok, encoded = cv2.imencode(".jpg", preview, [int(cv2.IMWRITE_JPEG_QUALITY), 76])
    if not ok:
        return ""
    return "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")


def _phash(frame: np.ndarray) -> str:
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    return str(imagehash.phash(Image.fromarray(rgb)))


def _ocr(frame: np.ndarray) -> str:
    try:
        work, _ = _resize_for_analysis(frame)
        rgb = cv2.cvtColor(work, cv2.COLOR_BGR2RGB)
        text = pytesseract.image_to_string(rgb, config="--psm 11", timeout=6)
        return _clean(text, 4000)
    except Exception:
        return ""


def _rational(value: Any) -> float | None:
    try:
        return float(value)
    except Exception:
        try:
            return float(value.numerator) / float(value.denominator)
        except Exception:
            return None


def _gps_to_decimal(values: Any, ref: Any) -> float | None:
    try:
        deg, minute, sec = (_rational(v) for v in values)
        if deg is None or minute is None or sec is None:
            return None
        result = deg + minute / 60.0 + sec / 3600.0
        if str(ref).upper() in {"S", "W"}:
            result *= -1
        return round(result, 6)
    except Exception:
        return None


def _extract_exif(raw: bytes) -> dict[str, Any]:
    try:
        image = Image.open(__import__("io").BytesIO(raw))
        exif = image.getexif()
        if not exif:
            return {}
        result: dict[str, Any] = {}
        gps_raw = None
        for key, value in exif.items():
            name = ExifTags.TAGS.get(key, str(key))
            if name == "GPSInfo":
                gps_raw = value
                continue
            if name in {
                "DateTime",
                "DateTimeOriginal",
                "Make",
                "Model",
                "Software",
                "Artist",
                "Copyright",
                "ImageDescription",
                "Orientation",
            }:
                result[name] = _clean(value, 500)
        try:
            gps_ifd = exif.get_ifd(ExifTags.IFD.GPSInfo)
        except Exception:
            gps_ifd = gps_raw if isinstance(gps_raw, dict) else {}
        if gps_ifd:
            gps = {ExifTags.GPSTAGS.get(k, str(k)): v for k, v in gps_ifd.items()}
            lat = _gps_to_decimal(gps.get("GPSLatitude"), gps.get("GPSLatitudeRef"))
            lon = _gps_to_decimal(gps.get("GPSLongitude"), gps.get("GPSLongitudeRef"))
            if lat is not None and lon is not None:
                result["GPS"] = {"latitude": lat, "longitude": lon}
        return result
    except Exception:
        return {}


def _decode_image(raw: bytes) -> np.ndarray:
    arr = np.frombuffer(raw, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("Unable to decode image.")
    return frame


def _analyze_frame(frame: np.ndarray, label: str, timestamp: float | None = None, do_ocr: bool = True) -> dict[str, Any]:
    faces = _detect_faces(frame)
    return {
        "label": label,
        "face_detector": _load_detector()[1],
        "timestamp_seconds": round(timestamp, 2) if timestamp is not None else None,
        "width": int(frame.shape[1]),
        "height": int(frame.shape[0]),
        "faces": faces,
        "face_count": len(faces),
        "ocr_text": _ocr(frame) if do_ocr else "",
        "phash": _phash(frame),
        "annotated_preview": _annotated_data_uri(frame, faces),
    }


def _analyze_image(name: str, raw: bytes) -> dict[str, Any]:
    frame = _decode_image(raw)
    item = _analyze_frame(frame, name)
    item.update(
        {
            "kind": "image",
            "filename": name,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "exif": _extract_exif(raw),
        }
    )
    return item


def _analyze_video(name: str, raw: bytes, suffix: str) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile(suffix=suffix or ".mp4") as temp:
        temp.write(raw)
        temp.flush()
        cap = cv2.VideoCapture(temp.name)
        if not cap.isOpened():
            raise ValueError("Unable to decode video.")
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        duration = (frame_count / fps) if fps > 0 and frame_count > 0 else 0.0
        positions = np.linspace(0, max(frame_count - 1, 0), num=min(MAX_VIDEO_FRAMES, max(1, frame_count)), dtype=int)
        frames: list[dict[str, Any]] = []
        for idx, pos in enumerate(sorted(set(int(v) for v in positions))):
            cap.set(cv2.CAP_PROP_POS_FRAMES, pos)
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            timestamp = (pos / fps) if fps > 0 else None
            frames.append(_analyze_frame(frame, f"{name} · frame {pos}", timestamp, do_ocr=(idx < 4)))
        cap.release()
        return {
            "kind": "video",
            "filename": name,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "fps": round(fps, 3),
            "frame_count": frame_count,
            "duration_seconds": round(duration, 2),
            "sampled_frames": frames,
            "face_count": sum(int(frame.get("face_count") or 0) for frame in frames),
        }


def _hex_distance(a: str, b: str) -> int:
    try:
        return (int(a, 16) ^ int(b, 16)).bit_count()
    except Exception:
        return 999


def _similarity_pairs(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    nodes: list[tuple[str, str]] = []
    for item in items:
        if item.get("kind") == "image" and item.get("phash"):
            nodes.append((item["filename"], item["phash"]))
        for frame in item.get("sampled_frames") or []:
            if frame.get("phash"):
                nodes.append((frame["label"], frame["phash"]))
    pairs = []
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            distance = _hex_distance(nodes[i][1], nodes[j][1])
            if distance <= 8:
                pairs.append(
                    {
                        "a": nodes[i][0],
                        "b": nodes[j][0],
                        "phash_distance": distance,
                        "similarity": "VERY_HIGH" if distance <= 2 else ("HIGH" if distance <= 5 else "MODERATE"),
                    }
                )
    return sorted(pairs, key=lambda p: p["phash_distance"])[:100]


@api.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "ct-atlas-facial-intelligence",
        "version": SERVICE_VERSION,
        "face_detection": _load_detector()[1],
        "face_detection_error": _DETECTOR["error"],
        "ocr": "tesseract",
        "visual_similarity": "perceptual_hash",
        "identity_recognition": False,
    }


@api.post("/analyze")
async def analyze(
    files: list[UploadFile] = File(...),
    x_ct_atlas_visual_key: str | None = Header(default=None),
) -> dict[str, Any]:
    _check_key(x_ct_atlas_visual_key)
    if not files or len(files) > MAX_FILES:
        raise HTTPException(status_code=400, detail=f"Upload 1 to {MAX_FILES} files.")

    payloads: list[tuple[UploadFile, bytes]] = []
    total = 0
    for upload in files:
        raw = await upload.read()
        total += len(raw)
        if total > MAX_TOTAL_BYTES:
            raise HTTPException(status_code=413, detail="Combined upload exceeds 30 MB.")
        payloads.append((upload, raw))

    results: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for upload, raw in payloads:
        name = Path(upload.filename or "file").name
        content_type = (upload.content_type or "").lower()
        suffix = Path(name).suffix.lower()
        try:
            if content_type.startswith("image/") or suffix in {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}:
                results.append(_analyze_image(name, raw))
            elif content_type.startswith("video/") or suffix in {".mp4", ".mov", ".m4v", ".avi", ".webm", ".mkv"}:
                results.append(_analyze_video(name, raw, suffix))
            else:
                errors.append({"filename": name, "error": "Unsupported file type."})
        except Exception as exc:
            errors.append({"filename": name, "error": _clean(exc, 500)})

    return {
        "ok": bool(results),
        "version": SERVICE_VERSION,
        "face_detector": _load_detector()[1],
        "analysis_scope": {
            "face_detection": True,
            "face_quality": True,
            "ocr": True,
            "exif_gps_when_publicly_embedded": True,
            "video_frame_sampling": True,
            "perceptual_similarity": True,
            "identity_recognition": False,
            "biometric_embeddings": False,
        },
        "files": results,
        "similarity_pairs": _similarity_pairs(results),
        "errors": errors,
        "notice": (
            "Face boxes and visual similarities are descriptive signals only. "
            "The service does not identify people, create biometric embeddings, "
            "or conclude that two faces depict the same person."
        ),
    }
