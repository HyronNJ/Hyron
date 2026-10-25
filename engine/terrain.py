"""Summarize terrain within each map cell."""

from pathlib import Path
import time
import numpy as np
import numba
from pyproj import Transformer
from grid import (
    priority_flood,
    X0,
    Y1,
    RES,
    H,
    W,
    LNG0,
    LAT0,
    DLNG,
    DLAT,
    COLS,
    ROWS,
)

CACHE = Path(__file__).resolve().parent / ".data/statewide"
STREAM_M2 = 1e6  # drainage line threshold for HAND
FLOW_M2 = 1e5  # concentrated flow path
FEATURES = [
    "elev",
    "paved",
    "hand_lt1",
    "hand_lt3",
    "hand_p10",
    "dep_share",
    "dep_mean",
    "flow_share",
    "stream",
    "slope",
    "water",
]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


@numba.njit(cache=True)
def drainage_height(order, parent, filled, stream, count):
    """Elevation of the drainage line each pixel flows to (pixels processed outlet-first)."""
    d = np.empty(filled.size, np.float32)
    for t in range(count):
        i = order[t]
        j = parent[i]
        d[i] = filled[i] if (j < 0 or stream[i]) else d[j]
    return d


@numba.njit(cache=True)
def summarize(rows, cols, z, imp, hand, dep, logup, slope, water, out):
    n, m = z.shape
    flow = np.log1p(FLOW_M2)
    for k in range(rows.size):
        r0 = rows[k]
        c0 = cols[k]
        if r0 < 4 or c0 < 4 or r0 >= n - 4 or c0 >= m - 4:
            out[k, :] = np.nan
            continue
        cnt = 0
        se = 0.0
        sp = 0.0
        h1 = 0
        h3 = 0
        ds = 0
        dm = 0.0
        fs = 0
        st = 0.0
        ss = 0.0
        wa = 0
        hv = np.empty(81, np.float32)
        for dr in range(-4, 5):
            for dc in range(-4, 5):
                r = r0 + dr
                c = c0 + dc
                cnt += 1
                se += z[r, c]
                sp += imp[r, c]
                ss += slope[r, c]
                h = hand[r, c]
                hv[cnt - 1] = h
                if h < 1.0:
                    h1 += 1
                if h < 3.0:
                    h3 += 1
                if dep[r, c] > 0.1:
                    ds += 1
                dm += dep[r, c]
                if logup[r, c] >= flow:
                    fs += 1
                if logup[r, c] > st:
                    st = logup[r, c]
                if water[r, c]:
                    wa += 1
        hv.sort()
        out[k, 0] = se / cnt
        out[k, 1] = sp / cnt
        out[k, 2] = h1 / cnt
        out[k, 3] = h3 / cnt
        out[k, 4] = hv[8]
        out[k, 5] = ds / cnt
        out[k, 6] = dm / cnt
        out[k, 7] = fs / cnt
        out[k, 8] = st
        out[k, 9] = ss / cnt
        out[k, 10] = wa / cnt


def main():
    path = CACHE / "terrain-cells.npz"
    hyd = dict(np.load(CACHE / "hydrology30.npz"))
    z = hyd["elevation"]
    water = hyd["water"]
    hand_path = CACHE / "hand30.npy"
    if hand_path.exists():
        hand = np.load(hand_path)
    else:
        log("Priority-Flood for drainage heights over", z.shape)
        seeds = water.copy()
        seeds[[0, -1], :] = True
        seeds[:, [0, -1]] = True
        filled, parent, order, count = priority_flood(
            z.ravel().astype(np.float64), H, W, seeds.ravel()
        )
        stream = (hyd["log_upstream"].ravel() >= np.log1p(STREAM_M2)) | water.ravel()
        log("Height above nearest drainage")
        dh = drainage_height(order, parent, filled, stream, count)
        hand = np.maximum(0, filled - dh).reshape(z.shape).astype(np.float32)
        del filled, parent, order, dh, stream
        np.save(hand_path, hand)
    log("Summaries per map area")
    to_utm = Transformer.from_crs(4326, 26918, always_xy=True)
    cc, rr = np.meshgrid(np.arange(COLS), np.arange(ROWS))
    lng = LNG0 + DLNG * (cc.ravel() + 0.5)
    lat = LAT0 + DLAT * (rr.ravel() + 0.5)
    x, y = to_utm.transform(lng, lat)
    rows = np.floor((Y1 - np.asarray(y)) / RES).astype(np.int64)
    cols = np.floor((np.asarray(x) - X0) / RES).astype(np.int64)
    out = np.empty((rows.size, len(FEATURES)), np.float32)
    summarize(
        rows,
        cols,
        z,
        hyd["impervious"],
        hand,
        hyd["depression"],
        hyd["log_upstream"],
        hyd["slope"],
        water,
        out,
    )
    np.savez_compressed(path, features=out, names=np.array(FEATURES), cols=COLS, rows=ROWS)
    log("Wrote", path, out.shape)


if __name__ == "__main__":
    main()
