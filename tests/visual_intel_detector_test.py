"""Regression tests for the Facial Intelligence face detector (visual-intel-service/app.py).

Why: the Haar cascades used before reported body parts and textures as faces. The detector is now YuNet with a
landmark-geometry check. The fixture is the NASA portrait of astronaut Eileen Collins (public domain), also
shipped with scikit-image; the negatives are regions of that same photo that contain no face, plus synthetic
skin-coloured shapes and textures.

Run:  python3 tests/visual_intel_detector_test.py
(also run inside the built container by .github/workflows/deploy-visual-intel.yml)
"""
import hashlib
import os
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
for candidate in (os.environ.get("VISUAL_SERVICE_DIR"), HERE.parent / "visual-intel-service", "/app"):
    if candidate and (Path(candidate) / "app.py").exists():
        sys.path.insert(0, str(candidate))
        SERVICE_DIR = Path(candidate)
        break
else:
    raise SystemExit("visual-intel-service/app.py not found")

import app  # noqa: E402

FIXTURE = HERE / "fixtures" / "astronaut.jpg"
# The face in the fixture (x, y, w, h), as found by the detector on the untouched photo and checked by eye.
FACE = (178, 63, 91, 113)


def load():
    frame = cv2.imread(str(FIXTURE))
    assert frame is not None, "fixture missing"
    return frame


def rotate(img, angle):
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    return cv2.warpAffine(img, m, (w, h), borderMode=cv2.BORDER_REPLICATE)


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1, x2, y2 = max(ax, bx), max(ay, by), min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if x2 <= x1 or y2 <= y1:
        return 0.0
    inter = (x2 - x1) * (y2 - y1)
    return inter / (aw * ah + bw * bh - inter)


def boxes(frame):
    return [(f["box"]["x"], f["box"]["y"], f["box"]["w"], f["box"]["h"]) for f in app._detect_faces(frame)]


class DetectorLoads(unittest.TestCase):
    def setUp(self):
        app._DETECTOR.update({"loaded": False, "detector": None, "name": "", "error": ""})

    def test_the_pinned_model_is_intact_and_used(self):
        self.assertEqual(hashlib.sha256(app.YUNET_MODEL.read_bytes()).hexdigest(), app.YUNET_SHA256)
        self.assertLess(app.YUNET_MODEL.stat().st_size, 400_000)
        detector, name = app._load_detector()
        self.assertEqual(name, "yunet_2023mar")
        self.assertIsNotNone(detector)
        self.assertEqual(app._DETECTOR["error"], "")

    def test_a_tampered_or_missing_model_falls_back_to_a_strict_frontal_cascade_and_says_so(self):
        original = app.YUNET_SHA256
        try:
            app.YUNET_SHA256 = "0" * 64
            detector, name = app._load_detector()
            self.assertEqual(name, "opencv_haar_fallback")
            self.assertIn("checksum", app._DETECTOR["error"])
            self.assertIsInstance(detector, cv2.CascadeClassifier)
            # It still works, and never returns more than a handful of boxes on a portrait.
            self.assertLessEqual(len(boxes(load())), 3)
        finally:
            app.YUNET_SHA256 = original

    def test_the_profile_cascade_that_reported_body_parts_is_gone(self):
        source = (SERVICE_DIR / "app.py").read_text(encoding="utf-8")
        self.assertNotIn("haarcascade_profileface", source)
        self.assertNotIn("PROFILE", source)

    def test_no_identity_or_embedding_is_produced(self):
        source = (SERVICE_DIR / "app.py").read_text(encoding="utf-8")
        for forbidden in ("FaceRecognizerSF", "face_recognition", "embedding_vector", "feature("):
            self.assertNotIn(forbidden, source)
        self.assertIn('"identity_recognition": False', source)
        self.assertIn('"biometric_embeddings": False', source)


class DetectsRealFaces(unittest.TestCase):
    def test_the_portrait_has_exactly_one_face_where_it_should_be(self):
        found = boxes(load())
        self.assertEqual(len(found), 1, found)
        self.assertGreater(iou(found[0], FACE), 0.7, found)

    def test_the_result_carries_score_quality_and_valid_boxes(self):
        frame = load()
        h, w = frame.shape[:2]
        for face in app._detect_faces(frame):
            self.assertGreaterEqual(face["detection_score"], app.FACE_SCORE_THRESHOLD)
            self.assertIn(face["quality"], {"HIGH", "MEDIUM", "LOW"})
            b = face["box"]
            self.assertTrue(0 <= b["x"] and 0 <= b["y"] and b["x"] + b["w"] <= w and b["y"] + b["h"] <= h)
        self.assertEqual([f["face_id"] for f in app._detect_faces(frame)], [1])

    def test_the_same_face_is_found_once_when_the_photo_is_transformed(self):
        base = load()
        variants = {
            "rotated 20": rotate(base, 20),
            "rotated 45": rotate(base, 45),
            "rotated 90": rotate(base, 90),
            "rotated 180": rotate(base, 180),
            "small (x0.3)": cv2.resize(base, None, fx=0.3, fy=0.3),
            "blurred": cv2.GaussianBlur(base, (0, 0), 3),
            "JPEG quality 20": cv2.imdecode(cv2.imencode(".jpg", base, [cv2.IMWRITE_JPEG_QUALITY, 20])[1], 1),
            "mirrored": cv2.flip(base, 1),
            "squeezed": cv2.resize(base, None, fx=0.6, fy=1.0),
            "large (x2)": cv2.resize(base, None, fx=2.0, fy=2.0),
        }
        for name, frame in variants.items():
            with self.subTest(name):
                self.assertEqual(len(boxes(frame)), 1, boxes(frame))


class RejectsNonFaces(unittest.TestCase):
    def test_regions_of_the_photo_without_a_face_are_not_faces(self):
        base = load()
        regions = {
            "torso and mission patch": base[260:512, 0:300],
            "flag": base[0:300, 0:100],
            "shuttle model": base[0:300, 340:512],
            "helmet": base[330:512, 270:512],
            "neck and collar": base[190:300, 110:310],
            "hair only": base[10:70, 150:300],
            "suit sleeve": base[300:480, 20:140],
        }
        for name, region in regions.items():
            with self.subTest(name):
                self.assertEqual(boxes(region), [], name)

    def test_skin_coloured_shapes_and_textures_are_not_faces(self):
        rng = np.random.default_rng(7)
        skin = np.zeros((480, 640, 3), np.uint8)
        skin[:] = (110, 150, 200)  # BGR skin-like tone
        cv2.ellipse(skin, (200, 240), (70, 95), 0, 0, 360, (125, 165, 215), -1)   # a face-sized blob with no features
        cv2.ellipse(skin, (450, 250), (40, 110), 20, 0, 360, (100, 140, 190), -1)  # a limb
        cv2.circle(skin, (330, 120), 45, (120, 160, 210), -1)                      # a fist-sized disc
        cases = {
            "skin-coloured shapes": skin,
            "noise": rng.integers(0, 255, (480, 640, 3), dtype=np.uint8),
            "checkerboard": (np.indices((480, 640)).sum(axis=0) // 16 % 2 * 255).astype(np.uint8)[..., None].repeat(3, 2),
            "flat colour": np.full((480, 640, 3), 128, np.uint8),
            "gradient": np.tile(np.linspace(0, 255, 640, dtype=np.uint8), (480, 1))[..., None].repeat(3, 2),
        }
        for name, frame in cases.items():
            with self.subTest(name):
                self.assertEqual(boxes(frame), [], name)


class LandmarkGeometry(unittest.TestCase):
    # right eye, left eye, nose, right mouth corner, left mouth corner - a normal upright face 100x120 at (0,0)
    GOOD = np.array([[30, 40], [70, 40], [50, 62], [34, 88], [66, 88]], float)

    def test_a_normal_layout_passes_in_any_rotation(self):
        self.assertTrue(app._plausible_face(0, 0, 100, 120, self.GOOD))
        angle = np.deg2rad(90)
        rot = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
        turned = (self.GOOD - 50) @ rot.T + 50
        self.assertTrue(app._plausible_face(0, 0, 120, 100, turned))

    def test_impossible_layouts_are_rejected(self):
        bad = {
            "nose above the eyes": np.array([[30, 40], [70, 40], [50, 10], [34, 88], [66, 88]], float),
            "nose below the mouth": np.array([[30, 40], [70, 40], [50, 110], [34, 88], [66, 88]], float),
            "eyes on top of each other": np.array([[50, 40], [50.5, 40], [50, 62], [34, 88], [66, 88]], float),
            "mouth as wide as a torso": np.array([[30, 40], [70, 40], [50, 62], [-90, 88], [190, 88]], float),
            "landmarks far outside the box": np.array([[300, 400], [340, 400], [320, 422], [304, 448], [336, 448]], float),
            "mouth on the eyes": np.array([[30, 40], [70, 40], [50, 41], [34, 41], [66, 41]], float),
        }
        for name, landmarks in bad.items():
            with self.subTest(name):
                self.assertFalse(app._plausible_face(0, 0, 100, 120, landmarks))

    def test_boxes_that_are_too_small_or_the_wrong_shape_are_rejected(self):
        self.assertFalse(app._plausible_face(0, 0, 15, 15, self.GOOD * 0.15))
        self.assertFalse(app._plausible_face(0, 0, 300, 90, self.GOOD))    # a wide band
        self.assertFalse(app._plausible_face(0, 0, 40, 200, self.GOOD))    # a tall strip


class ServiceOutput(unittest.TestCase):
    def test_image_analysis_reports_faces_and_the_detector_in_use(self):
        raw = FIXTURE.read_bytes()
        item = app._analyze_image("astronaut.jpg", raw)
        self.assertEqual(item["face_count"], 1)
        self.assertEqual(item["faces"][0]["face_id"], 1)
        self.assertIn("detection_score", item["faces"][0])
        self.assertTrue(item["annotated_preview"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(item["width"], 512)

    def test_health_names_the_detector_and_still_denies_identity_recognition(self):
        import asyncio

        info = asyncio.run(app.health())
        self.assertEqual(info["face_detection"], "yunet_2023mar")
        self.assertEqual(info["face_detection_error"], "")
        self.assertIs(info["identity_recognition"], False)
        self.assertEqual(app.SERVICE_VERSION, "ct-atlas-visual-intel-v2")


if __name__ == "__main__":
    unittest.main(verbosity=2)
