"""Process USGS river-depth grids."""

from pathlib import Path
import base64
import datetime as dt
import json
import warnings
import numpy as np
import rasterio

ROOT = Path(__file__).resolve().parent
RAW = ROOT / ".data/depth/raw"
OUT = ROOT.parent / "app/public/data/nj/depth.json"
CHECK = ROOT / ".data/depth-validation.json"
MARKS = ROOT / "data/depth-ida-marks.json"
RIVERS = ROOT.parent / "app/public/data/nj/rivers.json"
# Depth sample locations.
SPOTS = {
    "Ridgewood Public Library lot": (40.98151, -74.112113),
    "Maple Field": (40.98585, -74.10986),
    "Ridgewood High School": (40.97725, -74.10557),
}
BLOCK = 2  # 2 x 2 cells of 3 m
MIN_WET = 2  # wet cells needed in a block
SITES = [
    {
        "lid": "HOHN4",
        "short": "Ho-Ho-Kus Brook",
        "pattern": "hohonj_*",
        "stages": [2.5 + 0.5 * i for i in range(12)],
    },
    {
        "lid": "RWDN4",
        "short": "Saddle River",
        "pattern": "ridnj_*",
        "stages": [5.0 + i for i in range(10)],
    },
]


def grids(pattern):
    found = sorted({p.parent for p in RAW.glob(f"**/{pattern}/hdr.adf")}, key=lambda p: p.name)
    if not found:
        raise SystemExit(f"No {pattern} USGS depth grids found under {RAW}")
    return found


def stack(paths):
    """All levels on one 3 m grid (NaN = dry), with the grid's top-left corner in Web Mercator meters."""
    rs = [rasterio.open(p) for p in paths]
    assert all(abs(r.res[0] - 3) < 1e-6 and abs(r.res[1] - 3) < 1e-6 for r in rs)
    left = min(r.bounds.left for r in rs)
    top = max(r.bounds.top for r in rs)
    right = max(r.bounds.right for r in rs)
    bottom = min(r.bounds.bottom for r in rs)
    W = int(round((right - left) / 3))
    H = int(round((top - bottom) / 3))
    W += -W % BLOCK
    H += -H % BLOCK
    out = np.full((len(rs), H, W), np.nan, np.float32)
    for i, r in enumerate(rs):
        a = r.read(1).astype(np.float32)
        a[(a < -1e30) | (a < 0)] = np.nan
        c = int(round((r.bounds.left - left) / 3))
        w = int(round((top - r.bounds.top) / 3))
        out[i, w : w + r.height, c : c + r.width] = a
        r.close()
    return out, left, top


def consistency(st, stages):
    """For each level: share of its wet cells that are more than 0.5 ft deeper than at the next level up."""
    rows = []
    for i in range(len(stages) - 1):
        a, b = st[i], st[i + 1]
        both = ~np.isnan(a) & ~np.isnan(b)
        rows.append(
            {
                "stage": stages[i],
                "next": stages[i + 1],
                "wetCells": int((~np.isnan(a)).sum()),
                "deeperThanNext": round(float(((a - b) > 0.5)[both].sum() / max(both.sum(), 1)), 4),
                "medianRise": round(float(np.median((b - a)[both])), 3) if both.any() else None,
            }
        )
    return rows


def blocks(st):
    """BLOCK x BLOCK averages per level; a block is wet at a level when at least MIN_WET of its cells are."""
    L, H, W = st.shape
    h, w = H // BLOCK, W // BLOCK
    v = st.reshape(L, h, BLOCK, w, BLOCK)
    wet = (~np.isnan(v)).sum(axis=(2, 4))
    with np.errstate(invalid="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-dry blocks
        mean = np.nanmean(v, axis=(2, 4))
    return np.where(wet >= MIN_WET, mean, np.nan)


def encode(b):
    """Encode wet-cell runs and depths in 0.1 ft units."""
    keep = (~np.isnan(b)).any(0)
    runs = []
    cells = []
    for r in range(keep.shape[0]):
        c = 0
        row = keep[r]
        while c < row.size:
            if not row[c]:
                c += 1
                continue
            s = c
            while c < row.size and row[c]:
                c += 1
            runs.append((r, s, c - s))
            cells.extend((r, k) for k in range(s, c))
    idx = np.array(cells)
    d = b[:, idx[:, 0], idx[:, 1]].T  # cells x levels
    q = np.where(np.isnan(d), 0, np.clip(np.maximum(np.round(d * 10), 1), 1, 255)).astype(np.uint8)
    return np.array(runs, "<u2"), q


def merc(lng, lat):
    R = 20037508.34
    return lng * R / 180, np.log(np.tan((90 + lat) * np.pi / 360)) / (np.pi / 180) * R / 180


def sample(b, left, top, cell, lng, lat):
    """Depth per level (NaN = dry) in the cell holding a point, or None outside the grid."""
    x, y = merc(lng, lat)
    c = int(np.floor((x - left) / cell))
    r = int(np.floor((top - y) / cell))
    return None if not (0 <= r < b.shape[1] and 0 <= c < b.shape[2]) else b[:, r, c]


def bracket(stages, d, level):
    """Bracket depth between mapped river levels."""
    d = np.nan_to_num(np.round(np.asarray(d, float) * 10) / 10)
    exact = [i for i, v in enumerate(stages) if abs(v - level) <= 1e-6]
    if exact:
        return (round(float(d[exact[0]]), 1), round(float(d[exact[0]]), 1))
    if level > stages[-1]:
        return (round(float(d[-1]), 1), None)
    a = max((i for i, v in enumerate(stages) if v < level), default=-1)
    lo = d[a] if a >= 0 else 0.0
    hi = d[a + 1]
    return (round(float(min(lo, hi)), 1), round(float(max(lo, hi)), 1))


NEAR_M = 50


def nearby(k, lng, lat, meters):
    """Find floodable cells within the given distance."""
    x, y = merc(lng, lat)
    cell = 3 * BLOCK
    scale = np.cos(np.radians(lat))
    reach = int(np.ceil(meters / scale / cell)) + 1
    c0 = int(np.floor((x - k["left"]) / cell))
    r0 = int(np.floor((k["top"] - y) / cell))
    out = []
    for r in range(r0 - reach, r0 + reach + 1):
        for c in range(c0 - reach, c0 + reach + 1):
            if not (0 <= r < k["b"].shape[1] and 0 <= c < k["b"].shape[2]):
                continue
            d = k["b"][:, r, c]
            m = np.hypot(k["left"] + (c + 0.5) * cell - x, k["top"] - (r + 0.5) * cell - y) * scale
            if m <= meters and np.isnan(d[0]) and not np.isnan(d).all():
                out.append((float(m), d))
    return sorted(out, key=lambda t: t[0])


def nearest_water(k, near, level):
    """The nearest of those cells that the maps put under water at a level: (meters, depth range), or None."""
    for m, d in near:
        lo, hi = bracket(k["stages"], d, level)
        if lo > 0 or (hi or 0) > 0:
            return round(m), (lo, hi)
    return None


def validate(built):
    """Ida high-water marks and the three test spots, with the app's ~7 m cells and the original 3 m cells."""
    rivers = {s["lid"]: s for s in json.loads(RIVERS.read_text())["sites"]}
    peak = lambda lid, rid: max(v for v in rivers[lid]["replays"][rid]["hourly"] if v is not None)
    marks = json.loads(MARKS.read_text())
    rows = []
    for m in marks["marks"]:
        k = built[m["site"]]
        level = peak(m["site"], marks["storm"])
        app = sample(k["b"], k["left"], k["top"], 3 * BLOCK, m["lng"], m["lat"])
        fine = sample(k["st"], k["left"], k["top"], 3, m["lng"], m["lat"])
        # Measure distance to the modeled water edge.
        x, y = merc(m["lng"], m["lat"])
        up = min(i for i, v in enumerate(k["stages"]) if v > level)
        wet = np.argwhere(~np.isnan(k["st"][up]))
        cx = k["left"] + (wet[:, 1] + 0.5) * 3
        cy = k["top"] - (wet[:, 0] + 0.5) * 3
        edge = float(np.min(np.hypot(cx - x, cy - y))) * np.cos(np.radians(m["lat"]))
        rows.append(
            {
                "mark": m["id"],
                "description": m["description"],
                "site": m["site"],
                "level": level,
                "observedAboveGround": round(m["elevation"] - m["ground"], 2),
                "markQuality": m["quality"],
                "modeled": bracket(k["stages"], app, level) if app is not None else None,
                "modeled3m": bracket(k["stages"], fine, level) if fine is not None else None,
                "metersToModeledWater": round(edge, 1),
            }
        )
    spots = []
    for name, (lat, lng) in SPOTS.items():
        for lid, k in built.items():
            here = sample(k["b"], k["left"], k["top"], 3 * BLOCK, lng, lat)
            near = nearby(k, lng, lat, NEAR_M)
            if (here is None or np.isnan(here).all()) and not near:
                continue
            row = {"spot": name, "site": lid}
            for rid in ("ida", "september-2023"):
                lvl = peak(lid, rid)
                row[rid] = {
                    "level": lvl,
                    "here": None if here is None else bracket(k["stages"], here, lvl),
                    f"nearestFloodWithin{NEAR_M}m": nearest_water(k, near, lvl),
                }
            spots.append(row)
    return rows, spots


def write_unless_same(path, doc, **fmt):
    """Write JSON, keeping the existing file when nothing but its build time would change."""
    if path.exists():
        old = json.loads(path.read_text())
        new = json.loads(json.dumps(doc))
        if {k: v for k, v in old.items() if k != "builtAt"} == {
            k: v for k, v in new.items() if k != "builtAt"
        }:
            print("unchanged", path.name)
            return
    path.write_text(json.dumps(doc, **fmt))
    print("wrote", path.name, path.stat().st_size, "bytes")


def main():
    doc = {
        "v": 1,
        "builtAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "crs": "EPSG:3857",
        "cell": 3 * BLOCK,
        "units": "feet, in tenths (0 = dry)",
        "sites": [],
    }
    built = {}
    for s in SITES:
        paths = grids(s["pattern"])
        assert len(paths) == len(s["stages"]), (s["lid"], len(paths))
        st, left, top = stack(paths)
        stages = list(s["stages"])
        check = consistency(st, stages)
        skipped = []
        # Skip inconsistent depth grids.
        for row in check:
            if row["deeperThanNext"] > 0.5:
                i = stages.index(row["stage"])
                skipped.append(
                    {
                        "stage": row["stage"],
                        "grid": paths[i].name,
                        "why": f"more than 0.5 ft deeper than the {row['next']} ft grid in {row['deeperThanNext']:.1%} of its cells",
                    }
                )
        keepi = [i for i, v in enumerate(stages) if v not in {k["stage"] for k in skipped}]
        b = blocks(st[keepi])
        runs, q = encode(b)
        site = {
            "lid": s["lid"],
            "short": s["short"],
            "stages": [stages[i] for i in keepi],
            "skipped": skipped,
            "x0": round(left, 3),
            "y0": round(top, 3),
            "cols": int(b.shape[2]),
            "rows": int(b.shape[1]),
            "runs": base64.b64encode(runs.tobytes()).decode(),
            "depth": base64.b64encode(q.tobytes()).decode(),
            "cells": int(q.shape[0]),
            "checks": check,
        }
        doc["sites"].append(site)
        built[s["lid"]] = {
            "b": b,
            "st": st[keepi],
            "left": left,
            "top": top,
            "stages": site["stages"],
        }
        print(
            s["lid"],
            "levels",
            site["stages"],
            "skipped",
            skipped,
            "cells",
            site["cells"],
            "runs",
            len(runs),
        )
    rows, spots = validate(built)
    doc["validation"] = {
        "storm": "ida",
        "marks": len(rows),
        "rows": [
            {k: r[k] for k in ("mark", "site", "level", "observedAboveGround", "modeled")}
            for r in rows
        ],
    }
    write_unless_same(
        CHECK,
        {
            "builtAt": doc["builtAt"],
            "marks": rows,
            "spots": spots,
            "grids": {
                x["lid"]: {"skipped": x["skipped"], "checks": x["checks"]} for x in doc["sites"]
            },
        },
        indent=1,
    )
    for r in rows:
        print("mark", r)
    for sp in spots:
        print("spot", sp)
    write_unless_same(OUT, doc, separators=(",", ":"))


if __name__ == "__main__":
    main()
