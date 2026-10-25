"""Read compact NJ training inputs."""

from pathlib import Path
import base64
import datetime as dt
import gzip
import json
import numpy as np

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
COLS, ROWS = 522, 988
LNG0, LAT0, DLNG, DLAT = -75.6021, 38.9, 0.0033, 0.0025
WGRID = dict(lat0=38.9, lng0=-75.6, step=0.2)


def varints(buf: bytes) -> np.ndarray:
    out = []
    n = 0
    shift = 0
    for b in buf:
        n |= (b & 127) << shift
        if b & 128:
            shift += 7
        else:
            out.append(n)
            n = 0
            shift = 0
    return np.array(out, np.int64)


def meta():
    return json.loads(gzip.decompress((DATA / "hyron-nj-meta.json.gz").read_bytes()))


def cell_block_groups() -> np.ndarray:
    """Index into meta()['geoids'] for every lattice cell (row-major from the south), -1 if none."""
    v = varints(gzip.decompress((DATA / "hyron-nj-cells.bin.gz").read_bytes()))
    out = np.empty(COLS * ROWS, np.int32)
    prev = 0
    at = 0
    for z, run in zip(v[0::2], v[1::2]):
        d = (z >> 1) if (z & 1) == 0 else -((z + 1) >> 1)
        prev += d
        out[at : at + run] = prev - 1
        at += run
    if at != out.size:
        raise RuntimeError("Block group raster is damaged")
    return out


def floodplain():
    a = (
        np.frombuffer(
            gzip.decompress((DATA / "hyron-nj-floodplain.bin.gz").read_bytes()), np.uint8
        ).astype(np.float32)
        / 16
    )
    n = COLS * ROWS
    if a.size != 2 * n:
        raise RuntimeError("Floodplain raster is damaged")
    return a[:n], a[n:]


def rain():
    """Hourly rain in mm, shape (81, T), and the UTC hour of every column."""
    o = json.loads((DATA / "hyron-nj-rain.json").read_text())
    v = varints(gzip.decompress(base64.b64decode(o["p"])))
    T = o["times"]
    if v.size != 81 * T:
        raise RuntimeError("Rain file is damaged")
    p = v.reshape(81, T).astype(np.float64)
    mm = np.where(p > 0, (p - 1) * 0.254, np.nan)
    times = []
    for start, n in o["segments"]:
        t0 = dt.datetime.fromisoformat(start.replace("Z", "+00:00"))
        times += [t0 + dt.timedelta(hours=k) for k in range(n)]
    return mm, times, o


def weather_points():
    return json.loads((ROOT.parent / "app/data/weather-points.json").read_text())


def weather_weights(points, lat, lng):
    """Same bilinear weights as app/lib/statewide.ts weatherWeights."""
    keys = {
        (
            round((p[0] - WGRID["lat0"]) / WGRID["step"]),
            round((p[1] - WGRID["lng0"]) / WGRID["step"]),
        ): i
        for i, p in enumerate(points)
    }
    fi = (lat - WGRID["lat0"]) / WGRID["step"]
    fj = (lng - WGRID["lng0"]) / WGRID["step"]
    i0, j0 = int(np.floor(fi)), int(np.floor(fj))
    ti, tj = fi - i0, fj - j0
    idx, w = [], []
    for di, dj, ww in (
        (0, 0, (1 - ti) * (1 - tj)),
        (1, 0, ti * (1 - tj)),
        (0, 1, (1 - ti) * tj),
        (1, 1, ti * tj),
    ):
        k = keys.get((i0 + di, j0 + dj))
        if k is not None and ww > 1e-9:
            idx.append(k)
            w.append(ww)
    if not w:
        d = [((p[0] - lat) ** 2 + ((p[1] - lng) * 0.76) ** 2) for p in points]
        return [int(np.argmin(d))], [1.0]
    s = sum(w)
    return idx, [x / s for x in w]


def cell_centers():
    cc, rr = np.meshgrid(np.arange(COLS), np.arange(ROWS))
    return LAT0 + DLAT * (rr.ravel() + 0.5), LNG0 + DLNG * (cc.ravel() + 0.5)
