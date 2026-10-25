"""Export map tiles, overview data and claim records."""

from pathlib import Path
import datetime as dt
import json
import struct
import numpy as np
import data as D

ROOT = Path(__file__).resolve().parent
APP = ROOT.parent / "app"
OUT = APP / "public/data/nj"
CACHE = ROOT / ".data/statewide"
TILE, BLOCK, REPS = 40, 8, 5
# Storms widely known by name; the rest are shown by date.
NAMES = {
    "2020-07-10": "Tropical Storm Fay",
    "2020-08-04": "Tropical Storm Isaias",
    "2021-08-21": "Tropical Storm Henri",
    "2021-09-01": "Ida",
}


def q(v, scale, lo=0, hi=65535, offset=0.0):
    return int(min(hi, max(lo, round((v + offset) * scale))))


def old_cells():
    """Read cell locations and municipalities from existing tiles."""
    cells = {}
    for p in (OUT / "t").glob("*.bin"):
        b = p.read_bytes()
        magic = b[:4]
        if magic not in (b"HYT1", b"HYT2", b"HYT3"):
            continue
        tx, ty = map(int, p.stem.split("-"))
        n = struct.unpack_from("<H", b, 4)[0]
        at = 6
        for _ in range(n):
            local = struct.unpack_from("<H", b, at)[0]
            if magic == b"HYT1":
                w, m = struct.unpack_from("<BH", b, at + 2)
                at += 21
            else:
                w, m = 0, struct.unpack_from("<H", b, at + 2)[0]
                at += 25 if magic == b"HYT2" else 27
            col = tx * TILE + local % TILE
            row = ty * TILE + local // TILE
            cells[row * D.COLS + col] = (w, m)
    return cells


NO_BG = 65535


def payload(m, f, rec, g):
    """Encode a 25-byte cell record."""
    sfha, x500, h1, h3, p10, dep, flow, stream, paved, slope, elev = f
    hist, claims, homes = rec
    return struct.pack(
        "<HHBBBBBHBBHHHHHH",
        m,
        q(elev, 100, offset=10),
        q(paved, 1, hi=100),
        q(sfha, 16, hi=16),
        q(x500, 16, hi=16),
        q(h1, 255, hi=255),
        q(h3, 255, hi=255),
        q(p10, 100),
        q(dep, 255, hi=255),
        q(flow, 255, hi=255),
        q(stream, 1000),
        q(slope, 100),
        q(hist, 10),
        q(claims, 1),
        q(homes, 1),
        NO_BG if g < 0 else int(g),
    )


def main():
    model = json.loads((APP / "public/data/model-nj-v1.json").read_text())
    meta = D.meta()
    bg = D.cell_block_groups()
    sfha, x500 = D.floodplain()
    terr = np.load(CACHE / "terrain-cells.npz")
    F = terr["features"]
    names = list(terr["names"])
    cells = old_cells()
    if not cells:
        raise RuntimeError("No map tiles found to take the land cells from")
    hu = np.array(meta["hu"], float)
    hist = np.array(meta["hist"]) / np.maximum(hu, 1) * 1000
    allc = np.array(meta["hist"]) + np.array(meta.get("since2016", [0] * len(hu)))
    ground = np.column_stack(
        [sfha, x500]
        + [
            F[:, names.index(k)]
            for k in [
                "hand_lt1",
                "hand_lt3",
                "hand_p10",
                "dep_share",
                "flow_share",
                "stream",
                "paved",
                "slope",
                "elev",
            ]
        ]
    )
    land = np.array(sorted(cells))
    if np.isnan(ground[land]).any():
        bad = land[np.isnan(ground[land]).any(1)]
        ground[bad] = np.nan_to_num(ground[bad])
    g = bg[land]
    rec = np.zeros((land.size, 3))
    has = g >= 0
    rec[has, 0] = hist[g[has]]
    rec[has, 1] = allc[g[has]]
    rec[has, 2] = hu[g[has]]
    recmap = dict(zip(land.tolist(), rec))

    # Rank cells under a fixed reference storm.
    from model import rain_features

    ref = np.zeros(120)
    ref[96:120] = [0, 1, 3, 8, 15, 25, 30, 18, 10, 6, 4, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    rf = rain_features(ref, 108)
    from trees import load_trees, predict

    feats = model["features"]
    X = np.column_stack(
        [np.tile(rf, (land.size, 1)), ground[land]]
        + ([rec[:, 0]] if "claims_before_2016" in feats else [])
    )
    rank = np.full(D.COLS * D.ROWS, -np.inf)
    rank[land] = predict(*load_trees(model["model"]), X)

    OUT.mkdir(parents=True, exist_ok=True)
    for p in (OUT / "t").glob("*.bin"):
        p.unlink()
    cols = land % D.COLS
    rows = land // D.COLS
    tile_id = (cols // TILE) + (rows // TILE) * 1000
    order = np.lexsort((cols, rows, tile_id))
    tiles = []
    for key in np.unique(tile_id):
        members = land[order][tile_id[order] == key]
        tx, ty = int(key % 1000), int(key // 1000)
        buf = bytearray(b"HYT3" + struct.pack("<H", members.size))
        for i in members:
            c, r = int(i % D.COLS), int(i // D.COLS)
            buf += struct.pack("<H", (r - ty * TILE) * TILE + (c - tx * TILE)) + payload(
                cells[i][1], ground[i], recmap[i], bg[i]
            )
        (OUT / "t" / f"{tx}-{ty}.bin").write_bytes(bytes(buf))
        tiles.append(f"{tx}-{ty}")

    block_id = (cols // BLOCK) + (rows // BLOCK) * 1000
    o = np.lexsort((-rank[land], block_id))
    bids, starts = np.unique(block_id[o], return_index=True)
    ends = np.append(starts[1:], o.size)
    blocks = bytearray(b"HYO3" + struct.pack("<I", 0))
    nblocks = 0
    for bid, s0, s1 in zip(bids, starts, ends):
        members = land[o[s0:s1]]
        # Choose five representative cells per block.
        reps = (
            members
            if members.size <= REPS
            else members[
                np.unique(
                    np.round(np.array([0.1, 0.3, 0.5, 0.7, 0.9]) * (members.size - 1)).astype(int)
                )
            ]
        )
        elev = float(np.mean(ground[members, 10]))
        dominant = int(np.bincount([cells[i][1] for i in members]).argmax())
        blocks += struct.pack(
            "<HHHHB", int(bid % 1000), int(bid // 1000), q(elev, 10, offset=10), dominant, reps.size
        )
        for i in reps:
            blocks += struct.pack("<HH", int(i % D.COLS), int(i // D.COLS)) + payload(
                cells[i][1], ground[i], recmap[i], bg[i]
            )
        nblocks += 1
    struct.pack_into("<I", blocks, 4, nblocks)
    (OUT / "overview.bin").write_bytes(bytes(blocks))

    index = json.loads((OUT / "index.json").read_text())
    index.update(
        {
            "version": "nj-3",
            "builtAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "tiles": sorted(tiles),
            "soil": {},
            "counts": {
                "landCells": int(land.size),
                "tiles": len(tiles),
                "blocks": nblocks,
                "municipalities": len(index["municipalities"]),
            },
            "features": [
                "sfha_share",
                "x500_share",
                "hand_lt1_share",
                "hand_lt3_share",
                "hand_p10_m",
                "depression_share",
                "flow_path_share",
                "log1p_max_upstream_m2",
                "impervious_percent",
                "slope_deg",
                "elevation_m",
            ],
            "record": [
                "claims_per_1000_homes_before_2016",
                "nfip_claims_since_1978_non_tidal",
                "housing_units_2020",
                "block_group_index (claims.json)",
            ],
        }
    )
    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    print("tiles", len(tiles), "blocks", nblocks, "cells", land.size)
    claims_file(meta)


def claims_file(meta):
    """Per-storm FEMA claims of every block group that had any (the place panel's flood history)."""
    storms, rows = [], {}
    for k, s in enumerate(meta["storms"]):
        y = np.zeros(len(meta["hu"]))
        for b, a, _, _ in s["rows"]:
            y[b] += a
        storms.append(
            {
                "start": s["d0"],
                "end": s["d1"],
                "name": NAMES.get(s["d0"]),
                "claims": int(round(y.sum())),
            }
        )
        for b in np.flatnonzero(y >= 0.05):
            rows.setdefault(int(b), []).append([k, round(float(y[b]), 1)])
    hist = np.array(meta["hist"])
    doc = {
        "v": 1,
        "storms": storms,
        "claims": {str(b): v for b, v in sorted(rows.items())},
        "before2016": {str(b): int(hist[b]) for b in np.flatnonzero(hist > 0)},
        "source": "FEMA NFIP non-tidal claims",
    }
    (OUT / "claims.json").write_text(json.dumps(doc, separators=(",", ":")))
    print("claims.json", len(rows), "block groups with storm claims")


if __name__ == "__main__":
    main()
