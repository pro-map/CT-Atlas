"""Regression tests for the Facial Intelligence face detector (visual-intel-service/app.py).

Why: the Haar cascades used before reported body parts and textures as faces. The detector is now YuNet with a
landmark-geometry check. The fixture is the NASA portrait of astronaut Eileen Collins (public domain), also
shipped with scikit-image; the negatives are regions of that same photo that contain no face, plus synthetic
skin-coloured shapes and textures.

Run:  python3 tests/visual_intel_detector_test.py
(also run inside the built container by .github/workflows/deploy-visual-intel.yml)
"""
import asyncio
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
            # It has no confidence to report and must not invent one; the result says which detector ran.
            self.assertTrue(all(face["detection_score"] is None for face in app._detect_faces(load())))
            item = app._analyze_image("astronaut.jpg", FIXTURE.read_bytes())
            self.assertEqual(item["face_detector"], "opencv_haar_fallback")
            self.assertEqual(asyncio.run(app.health())["face_detection"], "opencv_haar_fallback")
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


class AnyFaceSize(unittest.TestCase):
    """YuNet alone misses faces above ~550 px (score falls to ~0.6) and scores big look-alikes (the round mission
    patch on the suit) above the threshold when the photo is 1500-2000 px. The pyramid must fix both."""

    def test_big_faces_are_found_once(self):
        base = load()
        tight = base[19:219, 123:323]
        cases = {f"tight face crop {size}px": cv2.resize(tight, (size, size)) for size in (600, 800, 1000, 1400, 1800, 2200)}
        cases["wide crop, 1800 px wide"] = cv2.resize(base[0:300, 50:400], (1800, int(1800 * 300 / 350)))
        cases["wide crop, 2200 px wide"] = cv2.resize(base[0:300, 50:400], (2200, int(2200 * 300 / 350)))
        for width in (500, 700, 900):   # a phone selfie: 1650x2200 frame, face 500-900 px wide
            canvas = np.full((2200, 1650, 3), 128, np.uint8)
            face = cv2.resize(base[40:230, 120:330], (width, int(width * 190 / 210)))
            canvas[600:600 + face.shape[0], (1650 - width) // 2:(1650 - width) // 2 + width] = face
            cases[f"selfie, face {width}px wide"] = canvas
        for name, frame in cases.items():
            with self.subTest(name):
                self.assertEqual(len(boxes(frame)), 1, boxes(frame))

    def test_a_round_emblem_is_never_a_face_at_any_analysis_size(self):
        base = load()
        for interpolation in (cv2.INTER_LINEAR, cv2.INTER_CUBIC):
            for size in range(1200, 2201, 50):
                with self.subTest(size=size, interpolation=interpolation):
                    found = boxes(cv2.resize(base, (size, size), interpolation=interpolation))
                    self.assertEqual(len(found), 1, f"only the real face at {size}px, got {found}")

    def test_the_committed_1600_px_regression_photo_has_one_face(self):
        frame = cv2.imread(str(HERE / "fixtures" / "astronaut_1600.jpg"))
        self.assertEqual(frame.shape[:2], (1600, 1600))
        self.assertEqual(len(boxes(frame)), 1, boxes(frame))

    def test_every_face_of_a_group_is_kept_at_any_resolution(self):
        base = load()
        tile = np.vstack([np.hstack([base, base]), np.hstack([base, cv2.flip(base, 1)])])
        for size in (1024, 1600, 2200):
            with self.subTest(size=size):
                self.assertEqual(len(boxes(cv2.resize(tile, (size, size)))), 4)

    def test_a_face_is_reported_once_even_though_several_pyramid_levels_see_it(self):
        found = app._detect_faces(load())
        self.assertEqual(len(found), 1)

    def test_a_squeezed_face_is_kept(self):
        base = load()
        for factor in (0.6, 0.5):
            with self.subTest(factor):
                self.assertEqual(len(boxes(cv2.resize(base, None, fx=factor, fy=1.0))), 1)


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

    def test_a_turned_head_with_eyes_close_together_is_still_a_face(self):
        # 3/4 view: the inter-eye distance shrinks, so the eyes-to-mouth / eye-distance ratio grows (about 5 here).
        turned = np.array([[44, 40], [62, 40], [58, 62], [42, 88], [62, 88]], float)
        self.assertTrue(app._plausible_face(0, 0, 100, 120, turned))

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
