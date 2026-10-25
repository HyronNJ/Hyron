"""Evaluate held-out storm models and calibration."""

from pathlib import Path
import datetime as dt
import json
import math
import struct
import numpy as np
from threadpoolctl import threadpool_limits
import data as D
import model as M
from trees import tree_export
from trees import load_trees, predict

ROOT = Path(__file__).resolve().parent
APP = ROOT.parent / "app"
NJ = APP / "public/data/nj"
REPLAYS = {"ida": "2021-09-01", "september-2023": "2023-09-29"}
COUNTS = {"ida": 37, "september-2023": 25}  # timeline hours the app shows (components/Hyron.tsx)
HISTORY = 95
GROUND = [
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
FADE = {"street": [3, 9], "river": [12, 24]}


def log(*a):
    M.log(*a)


# The app's map data
def tiles():
    """Every land area as the app decodes it from the HYT3 tiles (lib/statewide.ts)."""
    out = []
    for p in sorted((NJ / "t").glob("*.bin")):
        b = p.read_bytes()
        if b[:4] != b"HYT3":
            raise RuntimeError("Run tiles.py first (HYT3 tiles)")
        tx, ty = map(int, p.stem.split("-"))
        n = struct.unpack_from("<H", b, 4)[0]
        at = 6
        for _ in range(n):
            local = struct.unpack_from("<H", b, at)[0]
            a = at + 2
            u8 = lambda o: b[a + o]
            u16 = lambda o: struct.unpack_from("<H", b, a + o)[0]
            col = tx * 40 + local % 40
            row = ty * 40 + local // 40
            paved = u8(4)
            slope = u16(15) / 100
            elev = u16(2) / 100 - 10
            g = [
                u8(5) / 16,
                u8(6) / 16,
                u8(7) / 255,
                u8(8) / 255,
                u16(9) / 100,
                u8(11) / 255,
                u8(12) / 255,
                u16(13) / 1000,
                paved,
                slope,
                elev,
                u16(17) / 10,
            ]
            out.append((col, row, g, u16(23)))
            at += 27
    return out


# App logic, mirrored
def rain_features(h, t):
    lo = max(0, t - 23)
    w = h[lo : t + 1]
    peak3 = max((h[i] + h[i - 1] + h[i - 2] for i in range(lo + 2, t + 1)), default=0.0)
    if t - lo < 2:
        peak3 = float(w.max())
    before = float(h[max(0, t - 95) : max(0, t - 23)].sum())
    return [
        math.log1p(float(w.sum())),
        math.log1p(float(w.max())),
        math.log1p(peak3),
        math.log1p(before),
    ]


def hours_since_rain(h, t):
    i = min(t + 1, h.size - 1)
    k = t + 1 - i
    while i >= 0 and k <= 48:
        if h[i] >= 0.5:
            return max(0, t - i)
        i -= 1
        k += 1
    return math.inf


def gate(h, temp, t):
    if temp[t] < 4:
        return True
    return float(h[max(0, t - 23) : min(t + 1, h.size - 1) + 1].sum()) < 0.25


def fade(since, river):
    k = min(1, max(0, river))
    s0, s1 = FADE["street"]
    r0, r1 = FADE["river"]
    a = s0 + (r0 - s0) * k
    b = s1 + (r1 - s1) * k
    return 1.0 if since <= a else 0.0 if since >= b else 1 - (since - a) / (b - a)


def per1000(raw, cal):
    v = math.log10(max(1e-6, 1000 * math.exp(raw)))
    k, o = cal["log10Predicted"], cal["observedPer1000"]
    if v <= k[0]:
        return o[0]
    if v >= k[-1]:
        return o[-1]
    return float(np.interp(v, k, o))


def score(p, cuts):
    f, m, s = cuts
    if not p > f / 4:
        return 0.0
    seg = lambda v, a, b, lo, hi: lo + (hi - lo) * math.log(v / a) / math.log(b / a)
    if p < f:
        return seg(p, f / 4, f, 0, 15)
    if p < m:
        return seg(p, f, m, 15, 38)
    if p < s:
        return seg(p, m, s, 38, 65)
    return min(100.0, seg(p, s, s * 4, 65, 100))


# Held-out models
def loso(data):
    """Fit and score each storm using the other storms."""
    cols = M.RAIN + M.TERRAIN
    out = {}
    with threadpool_limits(limits=2):
        for s in data["storms"]:
            m = M.fit(data, [x for x in data["storms"] if x["id"] != s["id"]], cols)
            out[s["id"]] = (m, m.predict(M.matrix(data, s, cols)))
    return out


def curve_without(data, held, sid):
    """Build a calibration curve excluding one storm."""
    return M.calibration(dict(data, storms=[s for s in data["storms"] if s["id"] != sid]), held)[0]


def calibrate(P, curve):
    """Apply the claims-per-1,000 calibration curve."""
    return np.interp(np.log10(np.maximum(P, 1e-4)), [k for k, _ in curve], [v for _, v in curve])


def level_table(data, held, curve_for):
    """Pooled over storms: claims at each level when storm `sid` is calibrated with `curve_for(sid)`."""
    keep = data["keep"]
    hu = data["hu"][keep]
    Y, H, C = [], [], []
    for s in data["storms"]:
        Y.append(s["y"][keep])
        H.append(hu)
        C.append(calibrate(held[s["id"]][1] * 1000, curve_for(s["id"])))
    Y, H, C = np.concatenate(Y), np.concatenate(H), np.concatenate(C)
    out = []
    for name, lo, hi in [
        ("Quiet", 0, M.CUTS[0]),
        ("Faint", M.CUTS[0], M.CUTS[1]),
        ("Moderate", M.CUTS[1], M.CUTS[2]),
        ("Strong", M.CUTS[2], np.inf),
    ]:
        s = (C >= lo) & (C < hi)
        out.append(
            {
                "level": name,
                "blockGroupStorms": int(s.sum()),
                "observedPer1000": round(float(Y[s].sum() / max(H[s].sum(), 1) * 1000), 3),
                "shareWithClaims": round(float(np.mean(Y[s] >= 0.5)) if s.any() else 0, 3),
                "shareOfAllClaims": round(float(Y[s].sum() / Y.sum()), 3),
            }
        )
    return out


def held_out_model(data, sid, fitted):
    cols = M.RAIN + M.TERRAIN
    others = [s for s in data["storms"] if s["id"] != sid]
    main = json.loads((APP / "public/data/model-nj-v1.json").read_text())
    head = tree_export(fitted)
    X = np.vstack([M.matrix(data, s, cols) for s in others])
    return {
        "version": f"nj-1-without-{sid}",
        "builtAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "features": cols,
        "link": "exp",
        "model": head,
        "calibration": main["calibration"],
        "cuts": main["cuts"],
        "afterRain": main["afterRain"],
        "ranges": [
            [float(np.nanmin(X[:, i])), float(np.nanmax(X[:, i]))] for i in range(X.shape[1])
        ],
        "heldOut": sid,
        "evaluation": {"storms": len(others)},
    }


def write_model(path, model):
    """Write a held-out model, keeping the existing file when nothing but its build time would change."""
    if path.exists():
        old = json.loads(path.read_text())
        if {k: v for k, v in old.items() if k != "builtAt"} == {
            k: v for k, v in json.loads(json.dumps(model)).items() if k != "builtAt"
        }:
            return False
    path.write_text(json.dumps(model, separators=(",", ":")))
    return True


def run_replay(model, rid, cells):
    """Scores for every area and timeline hour, vectorized but step for step the worker's logic."""
    rep = next(r for r in json.loads((NJ / "replays.json").read_text()) if r["id"] == rid)
    times = rep["times"]
    base = next(i for i, t in enumerate(times) if t >= rep["timelineStart"])
    count = COUNTS[rid]
    assert base >= HISTORY and base + count + 1 < len(times)
    rain = np.array([s["rain"] for s in rep["series"]], float)
    temp = np.array([s["temperature"] for s in rep["series"]], float)
    pts = D.weather_points()
    lat0, lng0 = D.cell_centers()
    idx = np.array([row * D.COLS + col for col, row, _, _ in cells])
    Wt = np.zeros((idx.size, len(pts)))
    for c, i in enumerate(idx):
        ii, ww = D.weather_weights(pts, lat0[i], lng0[i])
        Wt[c, ii] = ww
    h = Wt @ rain
    tc = Wt @ temp
    T = h.shape[1]
    G = np.array([g for _, _, g, _ in cells], float)
    ini, nodes, offs = load_trees(model["model"])
    pick = [GROUND.index(f) for f in model["features"][4:]]
    ground = G[:, pick]
    river = np.maximum(G[:, 0], G[:, 2])
    cs = np.concatenate([np.zeros((h.shape[0], 1)), np.cumsum(h, 1)], 1)
    win = lambda a, b: cs[:, b + 1] - cs[:, a]  # sum of hours a..b inclusive
    # Rain features at every hour j >= 95 (all windows complete there), as in rainFeatures().
    feats = {}

    def features(j):
        if j not in feats:
            w = h[:, j - 23 : j + 1]
            r3 = w[:, 2:] + w[:, 1:-1] + w[:, :-2]
            feats[j] = np.column_stack(
                [
                    np.log1p(w.sum(1)),
                    np.log1p(w.max(1)),
                    np.log1p(r3.max(1)),
                    np.log1p(win(j - 95, j - 24)),
                ]
            )
        return feats[j]

    wet = h >= 0.5
    U = np.zeros((idx.size, count))
    Fk = np.zeros((idx.size, count))
    for k in range(count):
        t = base + k
        gated = (tc[:, t] < 4) | (win(t - 23, min(t + 1, T - 1)) < 0.25)
        # Hours since the last hour with >= 0.5 mm, looking back from t + 1 over 48 hours.
        since = np.full(idx.size, np.inf)
        for i in range(min(t + 1, T - 1), max(-1, t + 1 - 49), -1):
            hit = np.isinf(since) & wet[:, i]
            since[hit] = max(0, t - i)
        a = FADE["street"][0] + (FADE["river"][0] - FADE["street"][0]) * np.clip(river, 0, 1)
        b = FADE["street"][1] + (FADE["river"][1] - FADE["street"][1]) * np.clip(river, 0, 1)
        f = np.where(since <= a, 1.0, np.where(since >= b, 0.0, 1 - (since - a) / (b - a)))
        live = ~gated & (f > 0)
        src = np.where(
            (since > 0) & np.isfinite(since), t - np.where(np.isfinite(since), since, 0), t
        ).astype(int)
        R = np.empty((idx.size, 4))
        for j in np.unique(src[live]):
            m = live & (src == j)
            R[m] = features(int(j))[m]
        rows = np.flatnonzero(live)
        if not rows.size:
            continue
        raw = predict(ini, nodes, offs, np.column_stack([R[rows], ground[rows]]))
        U[rows, k] = 1000 * np.exp(raw)
        Fk[rows, k] = f[rows]
    return U, Fk, [times[base + k] for k in range(count)]


def scores_for(U, F, curve, cuts):
    """Apply calibration, fading and display scaling."""
    p = np.interp(np.log10(np.maximum(1e-6, U)), [a for a, _ in curve], [b for _, b in curve]) * F
    f, m, s = cuts
    out = np.zeros_like(p)
    seg = lambda v, a, b, lo, hi: lo + (hi - lo) * np.log(v / a) / np.log(b / a)
    for sel, a, b, lo, hi in [
        ((p > f / 4) & (p < f), f / 4, f, 0, 15),
        ((p >= f) & (p < m), f, m, 15, 38),
        ((p >= m) & (p < s), m, s, 38, 65),
        (p >= s, s, s * 4, 65, 100),
    ]:
        out[sel] = np.minimum(100, seg(p[sel], a, b, lo, hi))
    out[F <= 0] = 0
    return out


def neighborhoods(values, bgs, valid, nb):
    """Per neighborhood (block group) and hour: the average over its map areas."""
    n = np.bincount(bgs[valid], minlength=nb).astype(float)
    return np.stack(
        [
            np.bincount(bgs[valid], weights=values[valid, k], minlength=nb)
            for k in range(values.shape[1])
        ],
        1,
    ) / np.maximum(n, 1)[:, None], n


def flagged(peak_bg, use, filed, y, hu):
    """Neighborhoods shown as Moderate (or Strong) at any hour, and the claims and homes in them."""
    out = {}
    for name, cut in [("moderate", 38), ("strong", 65)]:
        flag = use & (peak_bg >= cut)
        rest = use & ~flag
        out[name] = {
            "neighborhoodsWithClaimsFlagged": round(
                float(flag[filed].sum() / max(filed.sum(), 1)), 3
            ),
            "claimsInFlagged": round(float(y[flag].sum() / max(y[use].sum(), 1e-9)), 3),
            "homesFlagged": round(float(hu[flag].sum() / hu[use].sum()), 3),
            "per1000Flagged": round(float(y[flag].sum() / max(hu[flag].sum(), 1) * 1000), 2),
            "per1000Rest": round(float(y[rest].sum() / max(hu[rest].sum(), 1) * 1000), 3),
        }
    return out


def ranking(stat, use, filed, y, hu):
    """Compute AUC and claim capture at fixed home shares."""
    from sklearn.metrics import roc_auc_score

    idx = np.flatnonzero(use)
    order = idx[np.argsort(-stat[idx], kind="stable")]
    cum = np.cumsum(hu[order]) / hu[order].sum()
    total = y[order].sum()
    top = []
    for share in (0.01, 0.05, 0.10):
        sel = order[cum <= share]
        rest = np.setdiff1d(idx, sel)
        top.append(
            {
                "homes": share,
                "claims": round(float(y[sel].sum() / max(total, 1e-9)), 3),
                "per1000Top": round(float(y[sel].sum() / max(hu[sel].sum(), 1) * 1000), 2),
                "per1000Rest": round(float(y[rest].sum() / max(hu[rest].sum(), 1) * 1000), 3),
            }
        )
    return {"auc": round(float(roc_auc_score(filed[use], stat[use])), 3), "top": top}


def main():
    data = M.build()
    keep = data["keep"]
    hu = data["hu"]
    cells = tiles()
    log("areas", len(cells))
    bgs = np.array([b for *_, b in cells])
    valid = bgs != 65535
    nb = len(hu)
    held = loso(data)
    main_model = json.loads((APP / "public/data/model-nj-v1.json").read_text())
    live_curve = list(
        zip(
            main_model["calibration"]["log10Predicted"],
            main_model["calibration"]["observedPer1000"],
        )
    )
    # Verify the pooled calibration curve.
    pooled = M.calibration(data, held)[0]
    assert len(pooled) == len(live_curve) and np.allclose(
        np.array(pooled), np.array(live_curve), atol=2e-3
    ), (pooled, live_curve)
    without = {s["id"]: curve_without(data, held, s["id"]) for s in data["storms"]}
    check = {
        "inSample": level_table(data, held, lambda sid: live_curve),
        "crossFitted": level_table(data, held, lambda sid: without[sid]),
    }
    log("calibration check", json.dumps(check))
    truth = {}
    for rid, sid in REPLAYS.items():
        model = held_out_model(data, sid, held[sid][0])
        changed = write_model(APP / f"public/data/model-nj-v1-without-{sid}.json", model)
        log("held-out model", "written" if changed else "unchanged", "for", sid)
        U, F, times = run_replay(model, rid, cells)
        storm = next(s for s in data["storms"] if s["id"] == sid)
        y = storm["y"]
        live = scores_for(U, F, live_curve, model["cuts"])
        # Verify vectorized display scaling.
        rng = np.random.default_rng(1)
        r = rng.integers(0, U.shape[0], 3000)
        c = rng.integers(0, U.shape[1], 3000)
        cal = {
            "log10Predicted": [k for k, _ in live_curve],
            "observedPer1000": [v for _, v in live_curve],
        }
        mirror = np.array(
            [
                score(per1000(math.log(u / 1000), cal) * f, model["cuts"]) if f > 0 and u > 0 else 0
                for u, f in zip(U[r, c], F[r, c])
            ]
        )
        assert np.abs(mirror - live[r, c]).max() < 1e-6
        live_bg, n = neighborhoods(live, bgs, valid, nb)
        raw_bg, _ = neighborhoods(U * F, bgs, valid, nb)
        nested_bg, _ = neighborhoods(scores_for(U, F, without[sid], model["cuts"]), bgs, valid, nb)
        use = keep & (n > 0)
        filed = use & (y >= 0.5)
        # Storm totals from the held-out prediction (whole-storm rain): raw, and with each calibration.
        P = held[sid][1] * 1000
        k = keep
        expected = {
            "actual": int(round(y[use].sum())),
            "model": int(round(float((P * hu[k]).sum() / 1000))),
            "liveCalibration": int(round(float((calibrate(P, live_curve) * hu[k]).sum() / 1000))),
            "calibrationWithoutStorm": int(
                round(float((calibrate(P, without[sid]) * hu[k]).sum() / 1000))
            ),
        }
        stats = {
            "independent": ranking(raw_bg.max(1), use, filed, y, hu),
            "liveScale": flagged(live_bg.max(1), use, filed, y, hu),
            "calibrationWithoutStorm": {
                **flagged(nested_bg.max(1), use, filed, y, hu),
                "topPer1000": round(float(max(v for _, v in without[sid])), 2),
            },
            "expectedClaims": expected,
        }
        dots = []
        for b in np.flatnonzero(use & (y >= 0.5)):
            dots.append(
                [
                    round(float(data["clng"][b]), 5),
                    round(float(data["clat"][b]), 5),
                    round(float(y[b]), 1),
                    int(hu[b]),
                    int(b),
                ]
            )
        truth[rid] = {
            "storm": sid,
            "end": storm["d1"],
            "claims": int(round(y[use].sum())),
            "neighborhoodsWithClaims": int(filed.sum()),
            "neighborhoods": int(use.sum()),
            "model": f"model-nj-v1-without-{sid}.json",
            "stats": stats,
            "dots": dots,
            "times": [times[0], times[-1]],
        }
        log(rid, json.dumps({k: v for k, v in truth[rid].items() if k != "dots"}))
    doc = {
        "v": 2,
        "replays": truth,
        "calibrationCheck": check,
    }
    (NJ / "truth.json").write_text(json.dumps(doc, separators=(",", ":")))
    log("wrote truth.json")


if __name__ == "__main__":
    main()
