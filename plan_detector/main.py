"""
plan_detector — service FastAPI de détection de murs sur plan image.

v4 ajoute la prise en charge de plans hétérogènes :
  - murs noirs/pleins,
  - murs gris Revit/CAD,
  - murs extérieurs orangés ou hachurés,
  - plans annotés avec portes/fenêtres colorées, grilles et mobilier pâle.

Le pipeline évite de partir directement sur Hough :
  1. segmentation couleur HSV des pixels structurels probables,
  2. suppression des petites annotations/composants fins,
  3. extraction de bandes orthogonales horizontales/verticales,
  4. fusion/snap des segments colinéaires,
  5. fallback Hough uniquement si la vectorisation par bandes ne trouve presque rien.

Sortie compatible avec la v1 :
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
from dataclasses import dataclass
from typing import List, Tuple

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="glb2ifc plan-detector", version="0.4.0")

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


@dataclass
class SegmentPx:
    x1: float
    y1: float
    x2: float
    y2: float
    thickness: float
    confidence: float = 1.0
    source: str = ""

    @property
    def is_horizontal(self) -> bool:
        return abs(self.x2 - self.x1) >= abs(self.y2 - self.y1)

    @property
    def length(self) -> float:
        return math.hypot(self.x2 - self.x1, self.y2 - self.y1)


# ---------- Masque murs ----------

def _extract_dark_wall_mask(
    img_bgr: np.ndarray,
    dark_value_threshold: int = 110,
    dark_max_channel_threshold: int = 130,
    component_keep_ratio: float = 0.0,
) -> np.ndarray:
    """
    Extrait un masque de pixels structurels probables.

    La v2 ne gardait quasiment que le noir. C'est trop restrictif pour les plans
    Revit/CAD où les murs sont gris moyen, et pour certains plans commerciaux où
    les murs extérieurs sont remplis en orange. Cette version combine plusieurs
    signaux HSV :
      - noir / gris sombre,
      - gris neutre moyen,
      - orange/ocre de remplissage de murs,
    tout en rejetant les annotations très saturées rouge/cyan/magenta/vert.

    Le masque reste volontairement large ; les faux positifs fins (grilles,
    textes, mobilier pâle) sont filtrés ensuite par aire, épaisseur et extraction
    de bandes H/V.
    """
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    hue, sat, value = cv2.split(hsv)
    b, g, r = cv2.split(img_bgr)
    max_channel = np.maximum(np.maximum(b, g), r)

    # 1) Traits/masses noirs ou très sombres : anciens plans noir/blanc,
    # textes et contours. Les textes seront retirés par CC/épaisseur.
    dark_ink = (value <= dark_value_threshold) & (max_channel <= max(120, dark_max_channel_threshold))

    # 2) Murs gris typiques des exports CAD/Revit. On prend des gris peu
    # saturés jusqu'à ~210 pour capter les murs gris clairs, mais pas les
    # fonds blancs ni la plupart des meubles très pâles.
    neutral_gray_wall = (sat <= 55) & (value >= 35) & (value <= 190)

    # 3) Gris un peu colorés à cause de l'antialiasing JPEG autour des murs.
    neutral_dark_wall = (sat <= 85) & (value <= 170)

    # 4) Certains plans utilisent un remplissage orange/ocre pour les murs
    # extérieurs. On limite la teinte pour ne pas inclure les annotations rouges,
    # magenta, cyan, vertes.
    orange_wall_fill = (hue >= 5) & (hue <= 36) & (sat >= 35) & (value >= 80) & (value <= 255)

    mask = (dark_ink | neutral_gray_wall | neutral_dark_wall | orange_wall_fill).astype(np.uint8) * 255

    # Nettoyage anti-bruit léger. Ne pas ouvrir trop fort ici, car les cloisons
    # minces et murs hachurés disparaîtraient avant vectorisation.
    k2 = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k3, iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k2, iterations=1)

    # Filtre composants : supprime lettres, poignées/annotations colorées
    # résiduelles et petits symboles. Les murs gris/oranges sont souvent dans de
    # gros composants ; les grilles sont longues mais très fines.
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    cleaned = np.zeros_like(mask)
    if n <= 1:
        return cleaned

    h_img, w_img = mask.shape
    img_area = h_img * w_img
    min_area = max(24, int(img_area * 0.000015))
    large_component_area = max(6000, int(img_area * 0.004))

    for i in range(1, n):
        x, y, cw, ch, area = stats[i]
        if area < min_area:
            continue

        fill = area / max(1, cw * ch)
        min_dim = min(cw, ch)
        max_dim = max(cw, ch)

        # Traits fins isolés : grilles, cotes, axes, lignes de mobilier.
        if min_dim <= 2 and area < img_area * 0.01:
            continue

        # Composants extrêmement vides et pas massifs : souvent grilles/axes.
        if fill < 0.015 and area < img_area * 0.02:
            continue

        # Labels/cotes/titres isolés : compacts, souvent très noirs et avec une
        # faible hauteur (texte horizontal) ou faible largeur (texte vertical).
        # On ne l'applique pas aux très gros composants, car les murs, meubles et
        # textes peuvent être connectés dans un même composant principal.
        label_like = (
            area < large_component_area
            and fill > 0.18
            and ((ch <= 42 and cw <= 900) or (cw <= 42 and ch <= 900))
        )
        if label_like:
            continue

        # Petits symboles compacts ou textes : pas assez longs pour être des murs.
        if max_dim < 18 and area < img_area * 0.001:
            continue

        cleaned[labels == i] = 255

    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, k3, iterations=1)
    return cleaned

def _binarize_otsu_fallback(img_gray: np.ndarray) -> np.ndarray:
    """Fallback noir/blanc historique quand la segmentation couleur échoue."""
    _, bw = cv2.threshold(
        img_gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, kernel, iterations=1)
    bw = cv2.morphologyEx(bw, cv2.MORPH_OPEN, kernel, iterations=1)
    return bw


def _estimate_dominant_thickness_px(mask: np.ndarray) -> float:
    """
    Estime une épaisseur de trait/mur en pixels à partir de la distance transform.

    On utilise un percentile haut mais pas extrême : les textes et traits fins
    pèsent peu, les murs épais dominent.
    """
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 3)
    values = dist[dist > 2.0] * 2.0
    if values.size < 10:
        return 10.0
    return float(np.percentile(values, 70))


# ---------- Extraction de bandes orthogonales ----------

def _runs_1d(row: np.ndarray) -> List[Tuple[int, int]]:
    idx = np.flatnonzero(row)
    if idx.size == 0:
        return []
    breaks = np.where(np.diff(idx) > 1)[0]
    starts = np.r_[0, breaks + 1]
    ends = np.r_[breaks, idx.size - 1]
    return [(int(idx[s]), int(idx[e])) for s, e in zip(starts, ends)]


class _RunGroup:
    def __init__(self, y: int, x1: int, x2: int):
        self.rows = [y]
        self.intervals = [(x1, x2)]
        self.last_y = y

    def add(self, y: int, x1: int, x2: int) -> None:
        self.rows.append(y)
        self.intervals.append((x1, x2))
        self.last_y = y

    def active(self, y: int, gap: int) -> bool:
        return self.last_y >= y - gap

    def bbox(self) -> Tuple[int, int, int, int]:
        xs1 = [a for a, _ in self.intervals]
        xs2 = [b for _, b in self.intervals]
        return min(xs1), min(self.rows), max(xs2), max(self.rows)

    def overlap_score(self, x1: int, x2: int) -> int:
        gx1, _, gx2, _ = self.bbox()
        return max(0, min(x2, gx2) - max(x1, gx1) + 1)

    def core_bbox(self, core_ratio: float = 0.55) -> Tuple[int, int, int, int]:
        """
        BBox robuste : ne garde que les rangées dont la longueur approche la
        longueur max du groupe. Cela évite qu'un mur vertical attaché à un mur
        horizontal fasse exploser l'épaisseur apparente d'une bande.
        """
        lengths = [b - a + 1 for a, b in self.intervals]
        if not lengths:
            return self.bbox()
        max_len = max(lengths)
        ids = [i for i, length in enumerate(lengths) if length >= max(1.0, core_ratio * max_len)]
        if not ids:
            ids = list(range(len(lengths)))

        ys = [self.rows[i] for i in ids]
        xs1 = [self.intervals[i][0] for i in ids]
        xs2 = [self.intervals[i][1] for i in ids]
        return min(xs1), min(ys), max(xs2), max(ys)


def _group_row_intervals(mask: np.ndarray, min_run_px: int, row_gap: int = 2) -> List[_RunGroup]:
    groups: List[_RunGroup] = []
    active: List[_RunGroup] = []

    for y in range(mask.shape[0]):
        intervals = [
            (x1, x2)
            for x1, x2 in _runs_1d(mask[y] > 0)
            if x2 - x1 + 1 >= min_run_px
        ]

        active = [group for group in active if group.active(y, row_gap)]
        used = [False] * len(active)

        for x1, x2 in intervals:
            best_group = None
            best_score = 0
            best_index = -1

            for i, group in enumerate(active):
                if used[i]:
                    continue
                score = group.overlap_score(x1, x2)
                gx1, _, gx2, _ = group.bbox()
                group_width = gx2 - gx1 + 1
                min_width = min(x2 - x1 + 1, group_width)
                if score >= max(6, int(0.15 * min_width)) and score > best_score:
                    best_group = group
                    best_score = score
                    best_index = i

            if best_group is None:
                group = _RunGroup(y, x1, x2)
                groups.append(group)
                active.append(group)
                used.append(False)
            else:
                best_group.add(y, x1, x2)
                used[best_index] = True

    return groups


def _detect_orthogonal_bands(
    wall_mask: np.ndarray,
    scale_mm_per_px: float,
    min_wall_length_mm: float,
    min_wall_thickness_mm: float,
    max_wall_thickness_mm: float,
) -> List[SegmentPx]:
    """Détecte les murs comme bandes H/V épaisses dans le masque noir."""
    dominant_thickness_px = _estimate_dominant_thickness_px(wall_mask)

    min_run_px = max(
        30,
        int(min_wall_length_mm / scale_mm_per_px),
        int(dominant_thickness_px * 2.2),
    )
    min_thickness_px = max(3, int(min_wall_thickness_mm / scale_mm_per_px))
    max_thickness_px = max(min_thickness_px + 1, int(max_wall_thickness_mm / scale_mm_per_px))

    # Ferme les petits blancs de fenêtres/portes dans le sens de la bande, sans
    # gonfler les murs dans l'autre sens.
    bridge_px = max(5, min(80, int(450.0 / scale_mm_per_px)))
    horizontal_mask = cv2.morphologyEx(
        wall_mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (bridge_px, 3)),
        iterations=1,
    )
    vertical_mask = cv2.morphologyEx(
        wall_mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (3, bridge_px)),
        iterations=1,
    ).T

    candidates: List[SegmentPx] = []

    for orientation, mask in (("h", horizontal_mask), ("v", vertical_mask)):
        for group in _group_row_intervals(mask, min_run_px=min_run_px, row_gap=2):
            x1, y1, x2, y2 = group.core_bbox()
            length_px = x2 - x1 + 1
            thickness_px = y2 - y1 + 1

            if length_px < min_run_px:
                continue
            if thickness_px < min_thickness_px or thickness_px > max_thickness_px:
                continue
            if length_px / max(1, thickness_px) < 2.0:
                continue

            roi = mask[y1:y2 + 1, x1:x2 + 1]
            fill = cv2.countNonZero(roi) / max(1, length_px * thickness_px)
            if fill < 0.25:
                continue

            confidence = min(1.0, fill) * min(1.0, length_px / max(1, min_run_px * 2))

            if orientation == "h":
                y = (y1 + y2) / 2.0
                candidates.append(SegmentPx(float(x1), y, float(x2), y, float(thickness_px), confidence, "mask_bands"))
            else:
                # Coordonnées inversées car vertical_mask = mask.T.
                x = (y1 + y2) / 2.0
                candidates.append(SegmentPx(x, float(x1), x, float(x2), float(thickness_px), confidence, "mask_bands"))

    return candidates


# ---------- Fallback Hough sur masque déjà nettoyé ----------

def _skeletonize(bw: np.ndarray) -> np.ndarray:
    """Squelette via thinning de Zhang-Suen (ximgproc), avec fallback maison."""
    try:
        return cv2.ximgproc.thinning(bw, thinningType=cv2.ximgproc.THINNING_ZHANGSUEN)
    except (AttributeError, cv2.error):
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


def _estimate_thickness_on_segment(mask: np.ndarray, seg: SegmentPx, default_px: float) -> float:
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 3)
    n = max(10, int(seg.length // 5))
    samples = []
    for k in range(1, n):
        t = k / n
        x = int(round(seg.x1 + (seg.x2 - seg.x1) * t))
        y = int(round(seg.y1 + (seg.y2 - seg.y1) * t))
        if 0 <= x < dist.shape[1] and 0 <= y < dist.shape[0]:
            samples.append(dist[y, x])
    if not samples:
        return default_px
    return float(2.0 * np.median(samples))


def _detect_hough_fallback(
    wall_mask: np.ndarray,
    scale_mm_per_px: float,
    min_wall_length_mm: float,
    min_wall_thickness_mm: float,
) -> List[SegmentPx]:
    """Fallback conservateur : Hough sur le masque noir, puis filtre par épaisseur."""
    min_len_px = max(20, int(min_wall_length_mm / scale_mm_per_px))
    min_thickness_px = max(3, int(min_wall_thickness_mm / scale_mm_per_px))
    skel = _skeletonize(wall_mask)
    lines = cv2.HoughLinesP(
        skel,
        rho=1,
        theta=np.pi / 180,
        threshold=30,
        minLineLength=min_len_px,
        maxLineGap=max(10, int(250.0 / scale_mm_per_px)),
    )
    if lines is None:
        return []

    out: List[SegmentPx] = []
    default_thick_px = max(4.0, 120.0 / scale_mm_per_px)
    for line in lines:
        x1, y1, x2, y2 = (int(v) for v in line[0])
        # Orthogonalise : les plans fournis sont majoritairement 0/90°.
        if abs(x2 - x1) >= abs(y2 - y1):
            y = round((y1 + y2) / 2.0)
            seg = SegmentPx(float(min(x1, x2)), float(y), float(max(x1, x2)), float(y), default_thick_px, 0.5, "hough")
        else:
            x = round((x1 + x2) / 2.0)
            seg = SegmentPx(float(x), float(min(y1, y2)), float(x), float(max(y1, y2)), default_thick_px, 0.5, "hough")

        if seg.length < min_len_px:
            continue
        seg.thickness = _estimate_thickness_on_segment(wall_mask, seg, default_thick_px)
        if seg.thickness < min_thickness_px:
            continue
        out.append(seg)

    return out


# ---------- Fusion / filtrage ----------

def _merge_axis_aligned_segments(
    candidates: List[SegmentPx],
    scale_mm_per_px: float,
) -> List[SegmentPx]:
    if not candidates:
        return []

    merged: List[SegmentPx] = []
    for orientation in ("h", "v"):
        arr = [s for s in candidates if s.is_horizontal == (orientation == "h")]
        arr.sort(key=lambda s: (s.y1 if orientation == "h" else s.x1, s.x1 if orientation == "h" else s.y1))
        used = [False] * len(arr)

        for i, segment in enumerate(arr):
            if used[i]:
                continue

            group = [segment]
            used[i] = True
            changed = True

            while changed:
                changed = False
                line = float(np.median([s.y1 if orientation == "h" else s.x1 for s in group]))
                start = min(s.x1 if orientation == "h" else s.y1 for s in group)
                end = max(s.x2 if orientation == "h" else s.y2 for s in group)
                thickness = float(np.median([s.thickness for s in group]))
                line_tol = max(5.0, thickness * 0.35)
                gap_tol = max(10.0, min(80.0, 300.0 / scale_mm_per_px), thickness * 1.10)

                for j, other in enumerate(arr):
                    if used[j]:
                        continue
                    other_line = other.y1 if orientation == "h" else other.x1
                    if abs(other_line - line) > line_tol:
                        continue

                    other_start = other.x1 if orientation == "h" else other.y1
                    other_end = other.x2 if orientation == "h" else other.y2
                    if other_end < start - gap_tol or other_start > end + gap_tol:
                        continue

                    group.append(other)
                    used[j] = True
                    changed = True

            line = float(np.median([s.y1 if orientation == "h" else s.x1 for s in group]))
            start = float(min(s.x1 if orientation == "h" else s.y1 for s in group))
            end = float(max(s.x2 if orientation == "h" else s.y2 for s in group))
            thickness = float(np.median([s.thickness for s in group]))
            confidence = float(max(s.confidence for s in group))

            if orientation == "h":
                merged.append(SegmentPx(start, line, end, line, thickness, confidence, "merged"))
            else:
                merged.append(SegmentPx(line, start, line, end, thickness, confidence, "merged"))

    return _remove_contained_duplicates(merged)


def _remove_contained_duplicates(segments: List[SegmentPx]) -> List[SegmentPx]:
    keep: List[SegmentPx] = []

    for i, seg in enumerate(segments):
        orientation = "h" if seg.is_horizontal else "v"
        line = seg.y1 if orientation == "h" else seg.x1
        start = seg.x1 if orientation == "h" else seg.y1
        end = seg.x2 if orientation == "h" else seg.y2
        redundant = False

        for j, other in enumerate(segments):
            if i == j or other.is_horizontal != seg.is_horizontal:
                continue
            other_line = other.y1 if orientation == "h" else other.x1
            other_start = other.x1 if orientation == "h" else other.y1
            other_end = other.x2 if orientation == "h" else other.y2
            line_tol = max(5.0, seg.thickness * 0.25)

            if (
                abs(line - other_line) <= line_tol
                and other_start <= start + 5
                and other_end >= end - 5
                and (other_end - other_start) > (end - start) + 10
            ):
                redundant = True
                break

        if not redundant:
            keep.append(seg)

    return keep


def _segments_to_walls(
    segments: List[SegmentPx],
    image_height_px: int,
    scale_mm_per_px: float,
    min_wall_length_mm: float,
) -> List[Wall]:
    walls: List[Wall] = []
    for seg in segments:
        if seg.length * scale_mm_per_px < min_wall_length_mm:
            continue
        x1, y1, x2, y2 = seg.x1, seg.y1, seg.x2, seg.y2

        walls.append(Wall(
            x1_mm=x1 * scale_mm_per_px,
            y1_mm=(image_height_px - y1) * scale_mm_per_px,
            x2_mm=x2 * scale_mm_per_px,
            y2_mm=(image_height_px - y2) * scale_mm_per_px,
            thickness_mm=max(1.0, seg.thickness * scale_mm_per_px),
        ))

    return walls


# ---------- API détection ----------

def detect_walls(
    img_bgr: np.ndarray,
    scale_mm_per_px: float,
    min_wall_length_mm: float = 400.0,
    min_wall_thickness_mm: float = 80.0,
    max_wall_thickness_mm: float = 900.0,
) -> DetectResponse:
    h, w = img_bgr.shape[:2]

    wall_mask = _extract_dark_wall_mask(img_bgr)
    if cv2.countNonZero(wall_mask) < 50:
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        wall_mask = _binarize_otsu_fallback(gray)

    candidates = _detect_orthogonal_bands(
        wall_mask,
        scale_mm_per_px=scale_mm_per_px,
        min_wall_length_mm=min_wall_length_mm,
        min_wall_thickness_mm=min_wall_thickness_mm,
        max_wall_thickness_mm=max_wall_thickness_mm,
    )

    # Fallback uniquement si le détecteur par bandes n'a quasiment rien trouvé.
    # Cela évite de réintroduire le bruit des cotes/textes sur les plans annotés.
    if len(candidates) < 3:
        candidates.extend(_detect_hough_fallback(
            wall_mask,
            scale_mm_per_px=scale_mm_per_px,
            min_wall_length_mm=min_wall_length_mm,
            min_wall_thickness_mm=min_wall_thickness_mm,
        ))

    merged = _merge_axis_aligned_segments(candidates, scale_mm_per_px=scale_mm_per_px)
    walls = _segments_to_walls(merged, h, scale_mm_per_px, min_wall_length_mm)

    return DetectResponse(
        image_size_px={"w": w, "h": h},
        scale_mm_per_px=scale_mm_per_px,
        walls=walls,
    )


# ---------- Endpoints ----------

@app.get("/health")
def health():
    return {"ok": True, "service": "plan_detector", "version": "0.4.0"}


@app.post("/detect", response_model=DetectResponse)
async def detect(
    image: UploadFile = File(..., description="Plan image (PNG/JPG)"),
    scale_mm_per_px: float = Form(..., gt=0, description="Échelle en mm/pixel"),
    min_wall_length_mm: float = Form(400.0, gt=0),
    min_wall_thickness_mm: float = Form(80.0, gt=0),
    max_wall_thickness_mm: float = Form(900.0, gt=0),
):
    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty image")
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="cannot decode image")
    if max_wall_thickness_mm <= min_wall_thickness_mm:
        raise HTTPException(status_code=400, detail="max_wall_thickness_mm must be > min_wall_thickness_mm")

    return detect_walls(
        img,
        scale_mm_per_px=scale_mm_per_px,
        min_wall_length_mm=min_wall_length_mm,
        min_wall_thickness_mm=min_wall_thickness_mm,
        max_wall_thickness_mm=max_wall_thickness_mm,
    )
