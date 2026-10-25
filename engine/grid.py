"""Build the statewide terrain grid and drainage routing."""

from pathlib import Path
import time
import numpy as np
import numba
import rasterio
from rasterio.merge import merge
from rasterio.warp import reproject, Resampling
from rasterio.transform import from_origin
from scipy.ndimage import uniform_filter, distance_transform_edt

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".data/statewide"
RAW = CACHE / "raw"
RES = 30.0
X0, Y1, W, H = 441900.0, 4588500.0, 5370, 9657
TRANSFORM = from_origin(X0, Y1, RES, RES)
LNG0, LAT0, DLNG, DLAT, COLS, ROWS, TILE, BLOCK = -75.6021, 38.9, 0.0033, 0.0025, 522, 988, 40, 8


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def analysis_rasters():
    path = CACHE / "grid30.npz"
    if path.exists():
        with np.load(path) as d:
            return {k: d[k] for k in d.files}
    log("Mosaicking 3DEP elevation tiles")
    sources = [rasterio.open(p) for p in sorted(RAW.glob("dem_*.tif"))]
    mosaic, mosaic_tr = merge(sources)
    crs = sources[0].crs
    for s in sources:
        s.close()
    z = np.full((H, W), -9999, np.float32)
    reproject(
        mosaic[0],
        z,
        src_transform=mosaic_tr,
        src_crs=crs,
        dst_transform=TRANSFORM,
        dst_crs="EPSG:26918",
        resampling=Resampling.average,
        dst_nodata=-9999,
    )
    del mosaic
    out = {"z": z}
    for name, method in [("impervious", Resampling.average), ("landcover", Resampling.nearest)]:
        log("Mosaicking NLCD", name)
        sources = [rasterio.open(p) for p in sorted(RAW.glob(name + "_*.tif"))]
        nodata = sources[0].nodata
        arr, tr = merge(sources, method="first")
        crs = sources[0].crs
        for s in sources:
            s.close()
        a = np.zeros((H, W), np.float32)
        # As in terrain.py: the source's declared nodata (0) is excluded from averaging.
        reproject(
            arr[0],
            a,
            src_transform=tr,
            src_crs=crs,
            src_nodata=nodata,
            dst_transform=TRANSFORM,
            dst_crs="EPSG:26918",
            resampling=method,
        )
        out[name] = a
        del arr
    np.savez(path, **out)
    return out


@numba.njit(cache=True)
def _less(ka, ia, kb, ib):
    return ka < kb or (ka == kb and ia < ib)


@numba.njit(cache=True)
def priority_flood(flat, n, m, seeds):
    """Same algorithm and tie-breaking as terrain.priority_flood (heap of (elevation, index))."""
    N = n * m
    filled = flat.copy()
    seen = np.zeros(N, np.bool_)
    parent = np.full(N, -1, np.int32)
    order = np.empty(N, np.int32)
    cap = 1 << 20
    hk = np.empty(cap, np.float64)
    hi = np.empty(cap, np.int64)
    size = 0
    for i in range(N):
        if seeds[i]:
            seen[i] = True
            if size == cap:
                cap *= 2
                hk2 = np.empty(cap, np.float64)
                hi2 = np.empty(cap, np.int64)
                hk2[:size] = hk[:size]
                hi2[:size] = hi[:size]
                hk = hk2
                hi = hi2
            # push
            k = size
            size += 1
            hk[k] = flat[i]
            hi[k] = i
            while k > 0:
                p = (k - 1) >> 1
                if _less(hk[k], hi[k], hk[p], hi[p]):
                    hk[k], hk[p] = hk[p], hk[k]
                    hi[k], hi[p] = hi[p], hi[k]
                    k = p
                else:
                    break
    dr = np.array([-1, 1, 0, 0, -1, -1, 1, 1])
    dc = np.array([0, 0, -1, 1, -1, 1, -1, 1])
    count = 0
    while size > 0:
        elev = hk[0]
        i = hi[0]
        size -= 1
        if size > 0:
            hk[0] = hk[size]
            hi[0] = hi[size]
            k = 0
            while True:
                l = 2 * k + 1
                if l >= size:
                    break
                c = l
                if l + 1 < size and _less(hk[l + 1], hi[l + 1], hk[l], hi[l]):
                    c = l + 1
                if _less(hk[c], hi[c], hk[k], hi[k]):
                    hk[k], hk[c] = hk[c], hk[k]
                    hi[k], hi[c] = hi[c], hi[k]
                    k = c
                else:
                    break
        order[count] = i
        count += 1
        r = i // m
        c0 = i - r * m
        for d in range(8):
            rr = r + dr[d]
            cc = c0 + dc[d]
            if 0 <= rr < n and 0 <= cc < m:
                j = rr * m + cc
                if not seen[j]:
                    seen[j] = True
                    parent[j] = i
                    v = flat[j]
                    filled[j] = v if v > elev else elev
                    if size == cap:
                        cap *= 2
                        hk2 = np.empty(cap, np.float64)
                        hi2 = np.empty(cap, np.int64)
                        hk2[:size] = hk[:size]
                        hi2[:size] = hi[:size]
                        hk = hk2
                        hi = hi2
                    k = size
                    size += 1
                    hk[k] = filled[j]
                    hi[k] = j
                    while k > 0:
                        p = (k - 1) >> 1
                        if _less(hk[k], hi[k], hk[p], hi[p]):
                            hk[k], hk[p] = hk[p], hk[k]
                            hi[k], hi[p] = hi[p], hi[k]
                            k = p
                        else:
                            break
    return filled, parent, order, count


@numba.njit(cache=True)
def accumulate(order, parent, area, paved):
    for t in range(order.size - 1, -1, -1):
        i = order[t]
        j = parent[i]
        if j >= 0:
            area[j] += area[i]
            paved[j] += paved[i]


def hydrology():
    path = CACHE / "hydrology30.npz"
    if path.exists():
        with np.load(path) as d:
            return {k: d[k] for k in d.files}
    r = analysis_rasters()
    z = r["z"]
    if np.any(z < -100):
        z[z < -100] = 0
    imp = np.clip(r["impervious"], 0, 100)
    lc = r["landcover"]
    # Seed drainage outlets from water and the grid edge.
    water = (lc == 11) | ((lc == 0) & (z <= 1))
    seeds = water.copy()
    seeds[[0, -1], :] = True
    seeds[:, [0, -1]] = True
    log("Priority-Flood over", z.shape, f"{z.size / 1e6:.1f}M cells")
    filled, parent, order, count = priority_flood(z.ravel(), H, W, seeds.ravel())
    if count != z.size:
        raise RuntimeError("Routing graph failed to cover grid")
    log("Upstream accumulation")
    area = np.full(z.size, RES * RES, np.float64)
    paved = area * (imp.ravel() / 100)
    accumulate(order, parent, area, paved)
    del order, parent
    log("Slope, low position, water distance")
    gy, gx = np.gradient(z, RES)
    out = {
        "elevation": z,
        "slope": np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32),
        "depression": np.maximum(0, filled.reshape(z.shape) - z).astype(np.float32),
        "log_upstream": np.log1p(area).reshape(z.shape).astype(np.float32),
        "upstream_impervious": (np.divide(paved, area) * 100).reshape(z.shape).astype(np.float32),
        "low_position": np.maximum(0, uniform_filter(z, size=max(3, int(210 / RES))) - z).astype(
            np.float32
        ),
        "water_distance": (distance_transform_edt(~water) * RES).astype(np.float32),
        "impervious": imp.astype(np.float32),
        "water": water,
    }
    del gx, gy, area, paved, filled
    np.savez(path, **out)
    return out
