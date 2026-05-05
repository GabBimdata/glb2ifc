"""
plan_detector — service FastAPI de détection de murs sur plan image (CV classique).

Pipeline:
  1. Lecture image
  2. Niveaux de gris + binarisation (Otsu inversé : murs en blanc)
  3. Nettoyage morphologique (suppression bruit, fermeture petits trous)
  4. Squelette → centerlines des murs
  5. Hough probabiliste pour extraire les segments
  6. Fusion des segments colinéaires proches
  7. Estimation de l'épaisseur locale via distance transform
  8. Retour JSON avec coordonnées en mm (selon scale_mm_per_px fourni)

Hypothèses :
  - Plan "propre" type CAD exporté en image (PNG/JPG noir & blanc).
  - Murs = traits sombres sur fond clair.
  - Pas de mobilier ni hachures lourdes (v1).

Sortie:
  {
    "image_size_px": {"w": ..., "h": ...},
    "scale_mm_per_px": ...,
    "walls": [
      {
        "x1_mm": ..., "y1_mm": ...,
        "x2_mm": ..., "y2_mm": ...,
        "thickness_mm": ...
      }, ...
    ]
  }

Convention axes : origine en bas-gauche de l'image (Y inversé pour matcher l'usage CAO).
"""

from __future__ import annotations

import io
import math
from typing import List, Tuple

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="glb2ifc plan-detector", version="0.1.0")

# CORS large : on tourne en localhost, le serveur Node appelle ce service.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Modèles ----------

class Wall(BaseModel):
    x1_mm: float
    y1_mm: float
    x2_mm: float
    y2_mm: float
    thickness_mm: float


class DetectResponse(BaseModel):
    image_size_px: dict
    scale_mm_per_px: float
    walls: List[Wall]


# ---------- Détection ----------

def _binarize(img_gray: np.ndarray) -> np.ndarray:
    """Otsu inversé : murs (sombres) → 255, fond → 0."""
    _, bw = cv2.threshold(
        img_gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
    )
    return bw


def _clean(bw: np.ndarray) -> np.ndarray:
    """Nettoyage morpho : ferme petits trous, retire bruit isolé."""
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, kernel, iterations=1)
    opened = cv2.morphologyEx(closed, cv2.MORPH_OPEN, kernel, iterations=1)
    return opened


def _skeletonize(bw: np.ndarray) -> np.ndarray:
    """Squelette via thinning de Zhang-Suen (ximgproc), avec fallback maison."""
    try:
        # Disponible si opencv-contrib-python est installé.
        return cv2.ximgproc.thinning(bw, thinningType=cv2.ximgproc.THINNING_ZHANGSUEN)
    except (AttributeError, cv2.error):
        # Fallback : thinning itératif basique.
        skel = np.zeros(bw.shape, np.uint8)
        img = bw.copy()
        kernel = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
        while True:
            eroded = cv2.erode(img, kernel)
            opened = cv2.dilate(eroded, kernel)
            subset = cv2.subtract(img, opened)
            skel = cv2.bitwise_or(skel, subset)
            img = eroded.copy()
            if cv2.countNonZero(img) == 0:
                break
        return skel


def _hough_segments(skel: np.ndarray, min_len_px: int) -> List[Tuple[int, int, int, int]]:
    """Hough probabiliste sur squelette → liste (x1,y1,x2,y2)."""
    lines = cv2.HoughLinesP(
        skel,
        rho=1,
        theta=np.pi / 180,
        threshold=40,
        minLineLength=min_len_px,
        maxLineGap=10,
    )
    if lines is None:
        return []
    return [tuple(int(v) for v in l[0]) for l in lines]


def _segment_angle(seg) -> float:
    x1, y1, x2, y2 = seg
    return math.atan2(y2 - y1, x2 - x1)


def _segment_len(seg) -> float:
    x1, y1, x2, y2 = seg
    return math.hypot(x2 - x1, y2 - y1)


def _point_line_dist(px, py, seg) -> float:
    """Distance d'un point à la droite portant le segment."""
    x1, y1, x2, y2 = seg
    dx, dy = x2 - x1, y2 - y1
    L = math.hypot(dx, dy)
    if L < 1e-6:
        return math.hypot(px - x1, py - y1)
    return abs(dy * px - dx * py + x2 * y1 - y2 * x1) / L


def _merge_collinear(
    segments: List[Tuple[int, int, int, int]],
    angle_tol_deg: float = 3.0,
    dist_tol_px: float = 6.0,
    gap_tol_px: float = 15.0,
) -> List[Tuple[int, int, int, int]]:
    """Fusionne les segments quasi-colinéaires et proches, en gardant les extrêmes."""
    if not segments:
        return []

    angle_tol = math.radians(angle_tol_deg)
    used = [False] * len(segments)
    merged = []

    for i, seg_i in enumerate(segments):
        if used[i]:
            continue
        cluster = [seg_i]
        used[i] = True
        ang_i = _segment_angle(seg_i)

        changed = True
        while changed:
            changed = False
            for j, seg_j in enumerate(segments):
                if used[j]:
                    continue
                ang_j = _segment_angle(seg_j)
                # Différence d'angle modulo pi (segments non orientés)
                diff = abs(((ang_i - ang_j) + math.pi / 2) % math.pi - math.pi / 2)
                if diff > angle_tol:
                    continue
                # Distance perpendiculaire (utilise un seg du cluster comme référence)
                ref = cluster[0]
                d1 = _point_line_dist(seg_j[0], seg_j[1], ref)
                d2 = _point_line_dist(seg_j[2], seg_j[3], ref)
                if max(d1, d2) > dist_tol_px:
                    continue
                # Distance le long de la ligne (gap entre extrémités)
                if _min_endpoint_gap(cluster, seg_j) > gap_tol_px:
                    continue
                cluster.append(seg_j)
                used[j] = True
                changed = True

        merged.append(_collapse_cluster(cluster))

    return merged


def _min_endpoint_gap(cluster, seg) -> float:
    """Plus petite distance entre une extrémité du cluster et une extrémité de seg."""
    pts_cluster = []
    for s in cluster:
        pts_cluster.extend([(s[0], s[1]), (s[2], s[3])])
    pts_seg = [(seg[0], seg[1]), (seg[2], seg[3])]
    best = float("inf")
    for a in pts_cluster:
        for b in pts_seg:
            d = math.hypot(a[0] - b[0], a[1] - b[1])
            if d < best:
                best = d
    return best


def _collapse_cluster(cluster) -> Tuple[int, int, int, int]:
    """Remplace un cluster de segments par les 2 points extrêmes projetés sur l'axe principal."""
    pts = []
    for s in cluster:
        pts.append((s[0], s[1]))
        pts.append((s[2], s[3]))
    pts = np.array(pts, dtype=np.float32)
    # Axe principal via PCA simple
    mean = pts.mean(axis=0)
    centered = pts - mean
    cov = np.cov(centered, rowvar=False)
    eigvals, eigvecs = np.linalg.eigh(cov)
    axis = eigvecs[:, np.argmax(eigvals)]
    proj = centered @ axis
    p_min = mean + proj.min() * axis
    p_max = mean + proj.max() * axis
    return (int(p_min[0]), int(p_min[1]), int(p_max[0]), int(p_max[1]))


def _estimate_thickness(bw: np.ndarray, seg, default_px: float) -> float:
    """Épaisseur du mur via distance transform échantillonnée le long du segment."""
    dist = cv2.distanceTransform(bw, cv2.DIST_L2, 3)
    x1, y1, x2, y2 = seg
    n = max(10, int(_segment_len(seg) // 5))
    samples = []
    for k in range(1, n):
        t = k / n
        x = int(round(x1 + (x2 - x1) * t))
        y = int(round(y1 + (y2 - y1) * t))
        if 0 <= x < dist.shape[1] and 0 <= y < dist.shape[0]:
            samples.append(dist[y, x])
    if not samples:
        return default_px
    # distance transform = rayon → épaisseur ≈ 2 × médiane
    return float(2.0 * np.median(samples))


def detect_walls(
    img_bgr: np.ndarray,
    scale_mm_per_px: float,
    min_wall_length_mm: float = 200.0,
) -> DetectResponse:
    h, w = img_bgr.shape[:2]
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    bw = _binarize(gray)
    bw = _clean(bw)
    skel = _skeletonize(bw)

    min_len_px = max(10, int(min_wall_length_mm / scale_mm_per_px))
    raw = _hough_segments(skel, min_len_px=min_len_px)
    merged = _merge_collinear(raw)

    walls: List[Wall] = []
    for seg in merged:
        if _segment_len(seg) < min_len_px:
            continue
        thick_px = _estimate_thickness(bw, seg, default_px=max(3.0, 100.0 / scale_mm_per_px))
        x1, y1, x2, y2 = seg
        # Inversion Y pour passer en repère bas-gauche (CAO standard)
        walls.append(Wall(
            x1_mm=x1 * scale_mm_per_px,
            y1_mm=(h - y1) * scale_mm_per_px,
            x2_mm=x2 * scale_mm_per_px,
            y2_mm=(h - y2) * scale_mm_per_px,
            thickness_mm=thick_px * scale_mm_per_px,
        ))

    return DetectResponse(
        image_size_px={"w": w, "h": h},
        scale_mm_per_px=scale_mm_per_px,
        walls=walls,
    )


# ---------- Endpoints ----------

@app.get("/health")
def health():
    return {"ok": True, "service": "plan_detector"}


@app.post("/detect", response_model=DetectResponse)
async def detect(
    image: UploadFile = File(..., description="Plan image (PNG/JPG)"),
    scale_mm_per_px: float = Form(..., gt=0, description="Échelle en mm/pixel"),
    min_wall_length_mm: float = Form(200.0, gt=0),
):
    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty image")
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="cannot decode image")
    return detect_walls(img, scale_mm_per_px, min_wall_length_mm)
