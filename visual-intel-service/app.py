from __future__ import annotations

import base64
import hashlib
import hmac
import math
import os
import tempfile
from pathlib import Path
from typing import Any

import cv2
import imagehash
import numpy as np
import pytesseract
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from PIL import ExifTags, Image, ImageOps

SERVICE_VERSION = "ct-atlas-visual-intel-v1"
MAX_FILES = 10
MAX_TOTAL_BYTES = 30 * 1024 * 1024
MAX_IMAGE_SIDE = 2200
MAX_VIDEO_FRAMES = 8

api = FastAPI(title="CT Atlas Facial Intelligence", version=SERVICE_VERSION)

FRONTAL = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
PROFILE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")


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


def _iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if x2 <= x1 or y2 <= y1:
        return 0.0
    inter = (x2 - x1) * (y2 - y1)
    union = aw * ah + bw * bh - inter
    return inter / union if union else 0.0


def _dedupe_boxes(boxes: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    kept: list[tuple[int, int, int, int]] = []
    for box in sorted(boxes, key=lambda b: b[2] * b[3], reverse=True):
        if all(_iou(box, other) < 0.35 for other in kept):
            kept.append(box)
    return kept[:40]


def _detect_faces(frame: np.ndarray) -> list[dict[str, Any]]:
    work, scale = _resize_for_analysis(frame)
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)

    boxes: list[tuple[int, int, int, int]] = []
    for detector in (FRONTAL, PROFILE):
        if detector.empty():
            continue
        found = detector.detectMultiScale(
            gray,
            scaleFactor=1.08,
            minNeighbors=5,
            minSize=(36, 36),
        )
        boxes.extend(tuple(int(v) for v in row) for row in found)

    boxes = _dedupe_boxes(boxes)
    inv = 1.0 / scale
    h, w = frame.shape[:2]
    results: list[dict[str, Any]] = []

    for index, (x, y, fw, fh) in enumerate(boxes, start=1):
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
        "face_detection": "opencv_haar",
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
