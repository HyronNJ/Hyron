"""Build flow paths and low-spot map tiles."""

from pathlib import Path
import json
import time
import numpy as np
import numba
from pyproj import Transformer
from rasterio import features as rfeatures
from affine import Affine
from shapely.geometry import LineString, shape
from scipy.ndimage import label
from grid import priority_flood, X0, Y1, RES, H, W, LNG0, LAT0, DLNG, DLAT, TILE

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".data/statewide"
APP = ROOT.parent / "app"
OUT = APP / "public/data/nj/w"
CLASSES = [3e4, 2.5e5, 1e6]  # m2 of upstream area for path classes 1, 2, 3
BASIN_DEPTH, BASIN_PIXELS, LOW_HAND = 0.3, 2, 1.0
SCALE = 4e4  # stored coordinates: 1/40,000 degree steps (about 2.5 m) from the tile corner
DR = np.array([-1, 1, 0, 0, -1, -1, 1, 1])
DC = np.array([0, 0, -1, 1, -1, 1, -1, 1])


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def routing(z, water):
    """D8 receiver code (0-7, -1 at outlets) for every pixel, cached."""
    path = CACHE / "flow30.npz"
    if path.exists():
        return np.load(path)["code"]
    log("Priority-Flood routing over", z.shape)
    seeds = water.copy()
    seeds[[0, -1], :] = True
    seeds[:, [0, -1]] = True
    zz = z.copy()
    zz[zz < -100] = 0
    filled, parent, order, count = priority_flood(zz.ravel(), H, W, seeds.ravel())
    del filled, order
    code = codes(parent)
    np.savez_compressed(path, code=code)
    return code


@numba.njit(cache=True)
def codes(parent):
    out = np.full(parent.size, -1, np.int8)
    for i in range(parent.size):
        j = parent[i]
        if j < 0:
            continue
        dr = j // W - i // W
        dc = j % W - i % W
        for k in range(8):
            if DR[k] == dr and DC[k] == dc:
                out[i] = k
                break
    return out


@numba.njit(cache=True)
def trace(code, cls, stop):
    """Trace flow paths, splitting at junctions and class changes."""
    n = code.size
    indeg = np.zeros(n, np.int8)
    for i in range(n):
        if cls[i] > 0 and code[i] >= 0:
            j = i + DR[code[i]] * W + DC[code[i]]
            if cls[j] > 0 and indeg[j] < 100:
                indeg[j] += 1
    queued = np.zeros(n, np.bool_)
    stack = np.empty(n // 8 + 1024, np.int64)
    top = 0
    for i in range(n):
        if cls[i] > 0 and indeg[i] == 0:
            stack[top] = i
            top += 1
            queued[i] = True
    pix = np.empty(n // 2 + 1024, np.int64)
    starts = np.empty(n // 8 + 1024, np.int64)
    npix = 0
    nlines = 0
    while top > 0:
        top -= 1
        cur = stack[top]
        starts[nlines] = npix
        nlines += 1
        pix[npix] = cur
        npix += 1
        c0 = cls[cur]
        while True:
            if code[cur] < 0:
                break
            nxt = cur + DR[code[cur]] * W + DC[code[cur]]
            if stop[nxt]:
                pix[npix] = nxt
                npix += 1
                break  # reaches open water: end at its edge
            if cls[nxt] == 0:
                break
            pix[npix] = nxt
            npix += 1
            if queued[nxt]:
                break  # joins a path already drawn
            if indeg[nxt] > 1 or cls[nxt] != c0:  # junction or bigger class: new line from here
                queued[nxt] = True
                stack[top] = nxt
                top += 1
                break
            queued[nxt] = True
            cur = nxt
    return starts[:nlines], pix[:npix]


def chaikin(xs, ys):
    """One round of corner cutting so 30 m grid steps read as curves; the ends stay put."""
    if xs.size < 3:
        return xs, ys
    qx = 0.75 * xs[:-1] + 0.25 * xs[1:]
    rx = 0.25 * xs[:-1] + 0.75 * xs[1:]
    qy = 0.75 * ys[:-1] + 0.25 * ys[1:]
    ry = 0.25 * ys[:-1] + 0.75 * ys[1:]
    ox = np.empty(2 * qx.size)
    oy = np.empty(2 * qy.size)
    ox[0::2] = qx
    ox[1::2] = rx
    oy[0::2] = qy
    oy[1::2] = ry
    return np.concatenate([[xs[0]], ox[1:-1], [xs[-1]]]), np.concatenate(
        [[ys[0]], oy[1:-1], [ys[-1]]]
    )


def tile_of(lng, lat):
    c = np.floor((lng - LNG0) / DLNG).astype(int)
    r = np.floor((lat - LAT0) / DLAT).astype(int)
    return (c // TILE) * 1000 + (r // TILE), c, r


def main():
    hyd = np.load(CACHE / "hydrology30.npz")
    z = hyd["elevation"]
    water = hyd["water"]
    code = routing(z, water)
    area = np.expm1(hyd["log_upstream"].astype(np.float64)).ravel()
    dep = hyd["depression"]
    hand = np.load(CACHE / "hand30.npy")
    to_ll = Transformer.from_crs(26918, 4326, always_xy=True)
    to_utm = Transformer.from_crs(4326, 26918, always_xy=True)

    # Land areas on the map (from the shipped tiles' index) decide which pixels count as New Jersey.
    index = json.loads((APP / "public/data/nj/index.json").read_text())
    tiles = set(index["tiles"])
    cc, rr = np.meshgrid(np.arange(W), np.arange(H))
    x = X0 + (cc + 0.5) * RES
    y = Y1 - (rr + 0.5) * RES
    del cc, rr
    lng, lat = to_ll.transform(x.ravel(), y.ravel())
    del x, y
    key, _, _ = tile_of(np.asarray(lng), np.asarray(lat))
    keys = {f"{k // 1000}-{k % 1000}": k for k in np.unique(key)}
    inside = np.isin(key, [keys[t] for t in tiles if t in keys])
    del lng, lat
    log("pixels in mapped tiles", int(inside.sum()))

    cls = np.zeros(area.size, np.int8)
    for k, t in enumerate(CLASSES):
        cls[(area >= t)] = k + 1
    wr = water.ravel()
    cls[wr | ~inside] = 0
    starts, pix = trace(code, cls, wr)
    log("flow lines", starts.size, "pixels", pix.size)

    out = {}

    def put(tkey, kind, item):
        out.setdefault(tkey, {"l": [], "p": []})[kind].append(item)

    ends = np.append(starts[1:], pix.size)
    pc = pix % W
    pr = pix // W
    px = X0 + (pc + 0.5) * RES
    py = Y1 - (pr + 0.5) * RES
    for s0, s1 in zip(starts, ends):
        if s1 - s0 < 2:
            continue
        line = LineString(np.column_stack([px[s0:s1], py[s0:s1]])).simplify(RES * 0.6)
        xs, ys = chaikin(*np.asarray(line.xy))
        lo, la = to_ll.transform(xs, ys)
        lo = np.asarray(lo)
        la = np.asarray(la)
        c = int(cls[pix[s0]])
        tk, _, _ = tile_of(lo, la)
        # Split where a line crosses into another tile, repeating the crossing point in both.
        cut = [0] + [i for i in range(1, tk.size) if tk[i] != tk[i - 1]] + [tk.size]
        for a, b in zip(cut[:-1], cut[1:]):
            seg = slice(a, min(b + 1, tk.size))
            if seg.stop - seg.start >= 2:
                put(int(tk[a]), "l", (c, lo[seg], la[seg]))
    log("lines placed in", len(out), "tiles")

    # Low spots, tile by tile on the 30 m grid.
    stream = area.reshape(H, W) >= CLASSES[1]
    for t in sorted(tiles):
        tx, ty = map(int, t.split("-"))
        w_, s_ = LNG0 + tx * TILE * DLNG, LAT0 + ty * TILE * DLAT
        e_, n_ = w_ + TILE * DLNG, s_ + TILE * DLAT
        xs, ys = to_utm.transform([w_, e_, w_, e_], [s_, s_, n_, n_])
        c0 = max(0, int((min(xs) - X0) / RES) - 2)
        c1 = min(W, int((max(xs) - X0) / RES) + 3)
        r0 = max(0, int((Y1 - max(ys)) / RES) - 2)
        r1 = min(H, int((Y1 - min(ys)) / RES) + 3)
        if c1 <= c0 or r1 <= r0:
            continue
        win = (slice(r0, r1), slice(c0, c1))
        d = dep[win]
        hd = hand[win]
        wt = water[win]
        st = stream[win]
        basin = (d >= BASIN_DEPTH) & ~wt
        # Drop basins a stream runs through (usually a road embankment over a culvert).
        lab, nlab = label(basin, structure=np.ones((3, 3)))
        if nlab:
            sizes = np.bincount(lab.ravel())
            through = np.bincount(lab.ravel(), weights=st.ravel().astype(float))
            ok = (sizes >= BASIN_PIXELS) & (through == 0)
            ok[0] = False
            basin = ok[lab]
        kind = np.zeros(d.shape, np.uint8)
        kind[(hd < LOW_HAND) & ~wt] = 2
        kind[basin] = 1
        tr = Affine(RES, 0, X0 + c0 * RES, 0, -RES, Y1 - r0 * RES)
        tk = int(tx * 1000 + ty)
        for geom, v in rfeatures.shapes(kind, mask=kind > 0, transform=tr, connectivity=8):
            g = shape(geom)
            if g.area < BASIN_PIXELS * RES * RES * 0.99:
                continue
            g = (
                g.buffer(RES * 0.8, join_style="round")
                .buffer(-RES * 0.8, join_style="round")
                .simplify(RES * 0.4)
            )
            if g.geom_type == "MultiPolygon":
                g = max(g.geoms, key=lambda q: q.area)
            if g.is_empty or g.area < RES * RES:
                continue
            rings = []
            for ring in [g.exterior] + list(g.interiors):
                lo, la = to_ll.transform(*np.asarray(ring.xy))
                rings.append((np.asarray(lo), np.asarray(la)))
            # Keep the polygon in the tile its center falls in.
            cx, cy = to_ll.transform(g.centroid.x, g.centroid.y)
            ck, _, _ = tile_of(np.array([cx]), np.array([cy]))
            if int(ck[0]) == tk:
                put(tk, "p", (int(v), rings))
    log("low spots done")

    OUT.mkdir(parents=True, exist_ok=True)
    for p in OUT.glob("*.json"):
        p.unlink()
    total = 0
    nfile = 0
    stats = {"lines": [0, 0, 0], "polys": [0, 0]}
    for tk, data in sorted(out.items()):
        tx, ty = tk // 1000, tk % 1000
        if f"{tx}-{ty}" not in tiles:
            continue
        ox, oy = LNG0 + tx * TILE * DLNG, LAT0 + ty * TILE * DLAT

        def enc(lo, la):
            qx = np.round((lo - ox) * SCALE).astype(int)
            qy = np.round((la - oy) * SCALE).astype(int)
            flat = np.empty(qx.size * 2, int)
            flat[0::2] = np.diff(qx, prepend=0)
            flat[1::2] = np.diff(qy, prepend=0)
            return flat.tolist()

        doc = {
            "v": 1,
            "o": [round(ox, 6), round(oy, 6)],
            "s": SCALE,
            "l": [[c] + enc(lo, la) for c, lo, la in data["l"]],
            "p": [[k] + [enc(lo, la) for lo, la in rings] for k, rings in data["p"]],
        }
        for c, _, _ in data["l"]:
            stats["lines"][c - 1] += 1
        for k, _ in data["p"]:
            stats["polys"][k - 1] += 1
        text = json.dumps(doc, separators=(",", ":"))
        (OUT / f"{tx}-{ty}.json").write_text(text)
        total += len(text)
        nfile += 1
    log("wrote", nfile, "tiles", f"{total / 1e6:.1f} MB", stats)


if __name__ == "__main__":
    main()
