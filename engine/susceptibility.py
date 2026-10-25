"""Build the persistent susceptibility map."""

from pathlib import Path
import datetime as dt
import json
import struct

import numpy as np

ROOT = Path(__file__).resolve().parent
APP = ROOT.parent / "app"
import data
from model import rain_features

OUTPUT = APP / "public/data/nj/risk"
GROUND_KEYS = [
    "sfha",
    "x500",
    "hand_lt1",
    "hand_lt3",
    "hand_p10",
    "dep_share",
    "flow_share",
    "stream",
    "paved",
    "slope",
    "elev",
    "claims_before_2016",
]
PERCENTILES = np.array([0, 50, 80, 95, 100], dtype=float)
DISPLAY_SCORES = np.array([0, 15, 38, 65, 100], dtype=float)


def storm_profiles():
    """One statewide-median rain vector per historical storm, each weighted equally."""
    rain, times, _ = data.rain()
    time_index = {time: index for index, time in enumerate(times)}
    profiles = []
    for storm in data.meta()["storms"]:
        start = dt.datetime.fromisoformat(storm["d0"] + "T04:00:00+00:00")
        end = dt.datetime.fromisoformat(storm["d1"] + "T04:00:00+00:00") + dt.timedelta(days=1)
        history_start = start - dt.timedelta(hours=95)
        count = int((end - history_start).total_seconds() // 3600)
        columns = [time_index.get(history_start + dt.timedelta(hours=i), -1) for i in range(count)]
        missing = [i for i, column in enumerate(columns) if column < 0]
        # Match the training reader: at most two absent early antecedent hours are dry.
        if len(missing) > 2 or any(i >= 24 for i in missing):
            raise ValueError(f"Rain history is incomplete for {storm['d0']}")
        segment = np.where(np.array(columns) >= 0, rain[:, np.maximum(columns, 0)], 0)
        if not np.isfinite(segment).all():
            raise ValueError(f"Rain measurements are missing for {storm['d0']}")
        vectors = []
        for series in segment:
            rolling = np.convolve(series, np.ones(24), "full")[: series.size]
            peak = 95 + int(np.argmax(rolling[95:]))
            vectors.append(rain_features(series, peak))
        median = np.median(vectors, axis=0)
        profiles.append(
            {
                "storm": storm["d0"],
                "end": storm["d1"],
                "features": median.tolist(),
                "millimeters": dict(
                    zip(["rain24h", "peak1h", "peak3h", "antecedent72h"], np.expm1(median).tolist())
                ),
                "points": len(vectors),
            }
        )
    if len(profiles) != 19:
        raise ValueError("Expected the 19 historical NJ storm profiles")
    return profiles


def land_cells():
    """Decode the exact quantized terrain inputs shipped to the browser (HYT3)."""
    cells = []
    index = json.loads((APP / "public/data/nj/index.json").read_text())
    for key in sorted(index["tiles"]):
        content = (APP / "public/data/nj/t" / f"{key}.bin").read_bytes()
        if content[:4] != b"HYT3":
            raise ValueError(f"Invalid terrain tile {key}")
        count = struct.unpack_from("<H", content, 4)[0]
        if len(content) != 6 + count * 27:
            raise ValueError(f"Incomplete terrain tile {key}")
        tile_col, tile_row = map(int, key.split("-"))
        for i in range(count):
            offset = 6 + i * 27
            position = struct.unpack_from("<H", content, offset)[0]
            col = tile_col * 40 + position % 40
            row = tile_row * 40 + position // 40
            at = offset + 2
            u8 = lambda j: content[at + j]
            u16 = lambda j: struct.unpack_from("<H", content, at + j)[0]
            ground = [
                u8(5) / 16,
                u8(6) / 16,
                u8(7) / 255,
                u8(8) / 255,
                u16(9) / 100,
                u8(11) / 255,
                u8(12) / 255,
                u16(13) / 1000,
                u8(4),
                u16(15) / 100,
                u16(2) / 100 - 10,
                u16(17) / 10,
            ]
            cells.append((col, row, ground))
    cells.sort(key=lambda cell: (cell[1], cell[0]))
    return cells


def tree_values(nodes, inputs):
    """Evaluate one exported tree over all cells, preserving missing-value branches."""
    result = np.empty(inputs.shape[0], dtype=float)

    def visit(node_index, positions):
        if not positions.size:
            return
        node = nodes[node_index]
        if node[5]:
            result[positions] = float(node[0])
            return
        values = inputs[positions, int(node[1])]
        left = np.where(np.isfinite(values), values <= float(node[2]), bool(node[6]))
        visit(int(node[3]), positions[left])
        visit(int(node[4]), positions[~left])

    visit(0, np.arange(inputs.shape[0]))
    return result


def build():
    model_path = APP / "public/data/model-nj-v1.json"
    model = json.loads(model_path.read_text())
    profiles = storm_profiles()
    cells = land_cells()
    ground = np.array([cell[2] for cell in cells], dtype=float)
    selected = [GROUND_KEYS.index(name) for name in model["features"][4:]]
    inputs = np.zeros((len(cells), len(model["features"])), dtype=float)
    inputs[:, 4:] = ground[:, selected]
    mean_rate = np.zeros(len(cells), dtype=float)
    for profile in profiles:
        inputs[:, :4] = profile["features"]
        prediction = np.full(len(cells), float(model["model"]["initial"]))
        for tree in model["model"]["trees"]:
            prediction += tree_values(tree, inputs)
        mean_rate += np.exp(prediction) / len(profiles)
        print(f"Scored {profile['storm']} across {len(cells):,} cells", flush=True)
    if not np.isfinite(mean_rate).all():
        raise ValueError("Non-finite susceptibility result")

    # Equal rates receive equal midranks. No ID/order-based tie-breaking.
    _, inverse, counts = np.unique(mean_rate, return_inverse=True, return_counts=True)
    starts = np.cumsum(counts) - counts
    percentiles = 100 * (starts + (counts - 1) / 2) / (len(cells) - 1)
    scores = np.interp(percentiles[inverse], PERCENTILES, DISPLAY_SCORES)
    content = bytearray(b"HYR1" + struct.pack("<I", len(cells)))
    for (col, row, _), score in zip(cells, scores):
        content.extend(struct.pack("<HHf", col, row, float(score)))

    metadata = {
        "version": "hyron-susceptibility-v1",
        "builtAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "cells": len(cells),
        "profileCount": len(profiles),
        "profileFeatures": model["features"][:4],
        "profiles": profiles,
        "percentileAnchors": PERCENTILES.tolist(),
        "scoreAnchors": DISPLAY_SCORES.tolist(),
        "referenceRateQuantiles": np.quantile(mean_rate, PERCENTILES / 100).tolist(),
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "scores.bin").write_bytes(content)
    (OUTPUT / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Wrote {len(content):,} bytes and metadata to {OUTPUT}", flush=True)


if __name__ == "__main__":
    build()
