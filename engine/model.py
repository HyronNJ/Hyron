"""Train and export the NJ flood-claim model."""

from pathlib import Path
import datetime as dt
import json
import time
import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import roc_auc_score
from threadpoolctl import threadpool_limits
import data as D
from trees import tree_export

ROOT = Path(__file__).resolve().parent
APP = ROOT.parent / "app"
CACHE = ROOT / ".data/statewide"
MIN_HOMES = 10

TERRAIN = [
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
]
RAIN = ["rain_24h", "peak_1h", "peak_3h", "rain_before"]
HISTORY = ["claims_before_2016"]
MONO = {
    "rain_24h": 1,
    "peak_1h": 1,
    "peak_3h": 1,
    "rain_before": 1,
    "sfha": 1,
    "x500": 1,
    "hand_lt1": 1,
    "hand_lt3": 1,
    "hand_p10": -1,
    "dep_share": 1,
    "flow_share": 1,
    "stream": 1,
    "paved": 0,
    "slope": 0,
    "elev": 0,
    "claims_before_2016": 1,
}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def rain_features(series: np.ndarray, t: int):
    """Storm rain features at hour t from an hourly series in mm (shared with app/lib/nj-model.ts)."""
    w = series[max(0, t - 23) : t + 1]
    r3 = np.convolve(w, np.ones(3), "valid") if w.size >= 3 else w
    before = series[max(0, t - 95) : max(0, t - 23)]
    return [
        np.log1p(w.sum()),
        np.log1p(w.max()),
        np.log1p(r3.max() if r3.size else 0),
        np.log1p(before.sum()),
    ]


def build():
    meta = D.meta()
    bg = D.cell_block_groups()
    sfha, x500 = D.floodplain()
    terr = np.load(CACHE / "terrain-cells.npz")
    F = terr["features"]
    names = list(terr["names"])
    lat, lng = D.cell_centers()
    nb = len(meta["geoids"])
    cellX = np.column_stack([sfha, x500] + [F[:, names.index(k)] for k in TERRAIN[2:]])
    land = ~np.isnan(F[:, 0]) & (F[:, names.index("water")] < 0.5)
    # Block group means over its land cells; tiny block groups use the cell they sit in.
    X = np.full((nb, len(TERRAIN)), np.nan)
    clat = np.full(nb, np.nan)
    clng = np.full(nb, np.nan)
    ncell = np.zeros(nb, int)
    ok = land & (bg >= 0)
    order = np.argsort(bg[ok])
    idx = np.flatnonzero(ok)[order]
    groups = bg[idx]
    starts = np.flatnonzero(np.r_[True, groups[1:] != groups[:-1]])
    ends = np.r_[starts[1:], groups.size]
    for s0, s1 in zip(starts, ends):
        g = groups[s0]
        m = idx[s0:s1]
        X[g] = np.nanmean(cellX[m], 0)
        clat[g] = lat[m].mean()
        clng[g] = lng[m].mean()
        ncell[g] = m.size
    for g, home in meta["missingHome"].items():
        g = int(g)
        if np.isnan(clat[g]):
            X[g] = cellX[home]
            clat[g] = lat[home]
            clng[g] = lng[home]
            ncell[g] = 1
    hu = np.array(meta["hu"], float)
    hist = np.array(meta["hist"]) / np.maximum(hu, 1) * 1000
    # Storm rain per block group.
    mm, times, rmeta = D.rain()
    tindex = {t: i for i, t in enumerate(times)}
    pts = D.weather_points()
    W = [
        D.weather_weights(pts, a, b) if not np.isnan(a) else ([0], [1.0])
        for a, b in zip(clat, clng)
    ]
    storms = []
    for s in meta["storms"]:
        d0 = dt.datetime.fromisoformat(s["d0"] + "T04:00:00+00:00")
        d1 = dt.datetime.fromisoformat(s["d1"] + "T04:00:00+00:00") + dt.timedelta(days=1)
        lo = d0 - dt.timedelta(hours=95)
        n = int((d1 - lo).total_seconds() // 3600)
        cols = [tindex.get(lo + dt.timedelta(hours=k), -1) for k in range(n)]
        # Allow up to two missing antecedent hours.
        miss = [k for k, c in enumerate(cols) if c < 0]
        if len(miss) > 2 or any(k >= 24 for k in miss):
            raise RuntimeError(f"Rain missing for storm {s['d0']}")
        seg = np.where(np.array(cols) >= 0, mm[:, np.maximum(cols, 0)], 0.0)
        if np.isnan(seg).any():
            raise RuntimeError(f"Rain gaps for storm {s['d0']}")
        R = np.zeros((nb, 4))
        peak_t = np.zeros(nb, int)
        for g in range(nb):
            ii, ww = W[g]
            series = (seg[ii] * np.array(ww)[:, None]).sum(0)
            c24 = np.convolve(series, np.ones(24), "full")[: series.size]
            t = 95 + int(np.argmax(c24[95:]))
            peak_t[g] = t
            R[g] = rain_features(series, t)
        y = np.zeros(nb)
        y4 = np.zeros(nb)
        y2 = np.zeros(nb)
        for b, a, c4, c2 in s["rows"]:
            y[b] += a
            y4[b] += c4
            y2[b] += c2
        storms.append(
            {
                "id": s["d0"],
                "d1": s["d1"],
                "R": R,
                "y": y,
                "y4": y4,
                "y2": y2,
                "claims": float(y.sum()),
            }
        )
        log(
            "storm",
            s["d0"],
            f"{y.sum():.0f} claims, max 24 h rain {np.expm1(R[:, 0]).max():.0f} mm, max hour {np.expm1(R[:, 1]).max():.0f} mm",
        )
    keep = (hu >= MIN_HOMES) & ~np.isnan(X).any(1)
    log(
        "block groups kept",
        int(keep.sum()),
        "of",
        nb,
        f"({hu[keep].sum() / hu.sum() * 100:.1f}% of homes)",
    )
    return dict(
        meta=meta,
        X=X,
        hu=hu,
        hist=hist,
        keep=keep,
        storms=storms,
        clat=clat,
        clng=clng,
        ncell=ncell,
    )


def matrix(data, s, cols):
    parts = []
    for c in cols:
        if c in RAIN:
            parts.append(s["R"][:, RAIN.index(c)])
        elif c in TERRAIN:
            parts.append(data["X"][:, TERRAIN.index(c)])
        else:
            parts.append(data["hist"])
    return np.column_stack(parts)[data["keep"]]


PARAMS = dict(
    loss="poisson",
    max_iter=250,
    learning_rate=0.05,
    max_leaf_nodes=15,
    min_samples_leaf=300,
    l2_regularization=1.0,
    early_stopping=False,
    random_state=7,
)
BALANCE = 0.5  # storm weight ~ claims^-0.5, so Ida (73% of all claims) doesn't decide every split


def fit(data, storms, cols, balance=BALANCE):
    keep = data["keep"]
    Xs = np.vstack([matrix(data, s, cols) for s in storms])
    hu = np.concatenate([data["hu"][keep] for _ in storms])
    w = np.concatenate([data["hu"][keep] * (1 / max(s["claims"], 1)) ** balance for s in storms])
    y = np.concatenate([s["y"][keep] for s in storms])
    return HistGradientBoostingRegressor(monotonic_cst=[MONO[c] for c in cols], **PARAMS).fit(
        Xs, y / hu, sample_weight=w
    )


def scores(pred, y, hu):
    """Compute claim-ranking and calibration metrics."""
    any_claim = y >= 0.5
    out = {"claims": float(y.sum()), "blockGroupsWithClaims": int(any_claim.sum())}
    if 0 < any_claim.sum() < y.size:
        out["auc"] = float(roc_auc_score(any_claim, pred))
    order = np.argsort(-pred)
    cum = np.cumsum(hu[order]) / hu.sum()
    top = order[cum <= 0.10]
    out["capture10"] = float(y[top].sum() / max(y.sum(), 1e-9))
    out["predictedClaims"] = float((pred * hu).sum())
    return out


def evaluate(data, variants, nyc=None):
    keep = data["keep"]
    hu = data["hu"][keep]
    res = {}
    held = {}
    with threadpool_limits(limits=2):
        for name, cols in variants.items():
            per = {}
            for k, s in enumerate(data["storms"]):
                train = [x for j, x in enumerate(data["storms"]) if j != k]
                m = fit(data, train, cols)
                pred = m.predict(matrix(data, s, cols))
                per[s["id"]] = scores(pred, s["y"][keep], hu)
                if name == CHOSEN:
                    held[s["id"]] = (m, pred)
            res[name] = per
            log(name, summary(per))
    if nyc is not None:
        per = {s["id"]: scores(nyc[s["id"]][keep], s["y"][keep], hu) for s in data["storms"]}
        res["nyc_model"] = per
        log("nyc_model", summary(per))
    return res, held


def summary(per):
    a = [v["auc"] for v in per.values() if "auc" in v]
    c = [v["capture10"] for v in per.values()]
    return {
        "meanAUC": round(float(np.mean(a)), 3),
        "medianAUC": round(float(np.median(a)), 3),
        "meanCapture10": round(float(np.mean(c)), 3),
        "storms": len(per),
    }


CHOSEN = "rain_terrain"
CUTS = (0.5, 2.0, 8.0)  # claims per 1,000 homes: Faint, Moderate, Strong


def cell_check(data, held):
    """Apply each held-out model to every ~280 m area and average back to block groups."""
    from scipy import sparse

    meta = data["meta"]
    bg = D.cell_block_groups()
    sfha, x500 = D.floodplain()
    keep = data["keep"]
    terr = np.load(CACHE / "terrain-cells.npz")
    F = terr["features"]
    names = list(terr["names"])
    cellX = np.column_stack([sfha, x500] + [F[:, names.index(k)] for k in TERRAIN[2:]])
    lat, lng = D.cell_centers()
    ok = (
        (bg >= 0)
        & keep[np.maximum(bg, 0)]
        & ~np.isnan(F[:, 0])
        & (F[:, names.index("water")] < 0.5)
    )
    cells = np.flatnonzero(ok)
    cbg = bg[cells]
    pts = D.weather_points()
    r, c, v = [], [], []
    for k, i in enumerate(cells):
        ii, ww = D.weather_weights(pts, lat[i], lng[i])
        r += [k] * len(ii)
        c += ii
        v += ww
    Wm = sparse.csr_matrix((v, (r, c)), shape=(cells.size, 81))
    mm, times, _ = D.rain()
    tindex = {t: i for i, t in enumerate(times)}
    out = {}
    for s in meta["storms"]:
        d0 = dt.datetime.fromisoformat(s["d0"] + "T04:00:00+00:00")
        d1 = dt.datetime.fromisoformat(s["d1"] + "T04:00:00+00:00") + dt.timedelta(days=1)
        lo = d0 - dt.timedelta(hours=95)
        n = int((d1 - lo).total_seconds() // 3600)
        cc = [tindex.get(lo + dt.timedelta(hours=k), -1) for k in range(n)]
        S = np.asarray(
            Wm @ np.where(np.array(cc) >= 0, mm[:, np.maximum(cc, 0)], 0.0), dtype=np.float32
        )
        cs = np.cumsum(np.pad(S, ((0, 0), (1, 0))), 1)
        r24 = cs[:, 24:] - cs[:, :-24]
        t = 95 + np.argmax(r24[:, 95 - 23 :], 1)
        idx = np.arange(cells.size)
        win = np.stack([S[idx, t - k] for k in range(24)], 1)
        r3 = win[:, :-2] + win[:, 1:-1] + win[:, 2:]
        R = np.column_stack(
            [
                np.log1p(win.sum(1)),
                np.log1p(win.max(1)),
                np.log1p(r3.max(1)),
                np.log1p(cs[idx, t - 22] - cs[idx, t - 95]),
            ]
        )
        m = held[s["d0"]][0]
        pc = m.predict(np.column_stack([R, cellX[cells]]))
        agg = np.bincount(cbg, weights=pc, minlength=keep.size) / np.maximum(
            np.bincount(cbg, minlength=keep.size), 1
        )
        y = next(x for x in data["storms"] if x["id"] == s["d0"])["y"]
        out[s["d0"]] = scores(agg[keep], y[keep], data["hu"][keep])
    return out


def calibration(data, held):
    """Held-out predicted vs observed claims per 1,000 homes; monotone curve used by the app."""
    keep = data["keep"]
    hu = data["hu"][keep]
    P = np.concatenate([held[s["id"]][1] for s in data["storms"]]) * 1000
    Y = np.concatenate([s["y"][keep] for s in data["storms"]])
    H = np.concatenate([hu for _ in data["storms"]])
    O = Y / H * 1000
    # Calibration knots: homes-weighted mean prediction vs observed rate in bins of held-out predictions.
    edges = [0, 0.03, 0.1, 0.3, 1, 3, 10, 30, np.inf]
    curve = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        s = (P >= lo) & (P < hi)
        if s.sum() >= 15:
            curve.append(
                [
                    round(float(np.log10(max((P[s] * H[s]).sum() / H[s].sum(), 1e-4))), 4),
                    round(float(Y[s].sum() / H[s].sum() * 1000), 4),
                ]
            )
    for i in range(1, len(curve)):
        curve[i][1] = max(curve[i][1], curve[i - 1][1])
    table = []
    for lo, hi in [(0, 0.1), (0.1, 0.3), (0.3, 1), (1, 3), (3, 10), (10, 30), (30, np.inf)]:
        s = (P >= lo) & (P < hi)
        if s.any():
            table.append(
                {
                    "predicted": [lo, None if hi == np.inf else hi],
                    "blockGroupStorms": int(s.sum()),
                    "observedPer1000": round(float(Y[s].sum() / H[s].sum() * 1000), 3),
                    "shareWithClaims": round(float(np.mean(Y[s] >= 0.5)), 3),
                }
            )
    cal = np.interp(np.log10(np.maximum(P, 1e-4)), [k for k, _ in curve], [v for _, v in curve])
    levels = []
    for name, lo, hi in [
        ("Quiet", 0, CUTS[0]),
        ("Faint", CUTS[0], CUTS[1]),
        ("Moderate", CUTS[1], CUTS[2]),
        ("Strong", CUTS[2], np.inf),
    ]:
        s = (cal >= lo) & (cal < hi)
        levels.append(
            {
                "level": name,
                "blockGroupStorms": int(s.sum()),
                "observedPer1000": round(float(Y[s].sum() / max(H[s].sum(), 1) * 1000), 3),
                "shareWithClaims": round(float(np.mean(Y[s] >= 0.5)) if s.any() else 0, 3),
                "shareOfAllClaims": round(float(Y[s].sum() / Y.sum()), 3),
            }
        )
    return curve, table, levels


def export(data, curve, summ, cellsumm, levels):
    cols = RAIN + TERRAIN
    with threadpool_limits(limits=2):
        m = fit(data, data["storms"], cols)
    head = tree_export(m)
    X = np.vstack([matrix(data, s, cols) for s in data["storms"]])
    ranges = [[float(np.nanmin(X[:, i])), float(np.nanmax(X[:, i]))] for i in range(X.shape[1])]
    years = sorted({s["id"][:4] for s in data["storms"]})
    out = {
        "version": "nj-1",
        "builtAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "features": cols,
        "link": "exp",
        "model": head,
        "calibration": {
            "log10Predicted": [k for k, _ in curve],
            "observedPer1000": [v for _, v in curve],
        },
        "cuts": list(CUTS),
        "afterRain": {"street": [3, 9], "river": [12, 24]},
        "ranges": ranges,
        "evaluation": {
            "storms": len(data["storms"]),
            "period": f"{years[0]}–{years[-1]}",
            "meanAUC": summ[CHOSEN]["meanAUC"],
            "meanCapture10": summ[CHOSEN]["meanCapture10"],
            "areaMeanAUC": cellsumm["meanAUC"],
            "areaMeanCapture10": cellsumm["meanCapture10"],
            "nycMeanAUC": summ.get("nyc_model", {}).get("meanAUC"),
            "nycMeanCapture10": summ.get("nyc_model", {}).get("meanCapture10"),
            "claims": int(round(sum(s["claims"] for s in data["storms"]))),
            "levels": levels,
        },
    }
    (APP / "public/data/model-nj-v1.json").write_text(json.dumps(out, separators=(",", ":")))
    log("exported model with", len(head["trees"]), "trees")


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    data = build()
    variants = {
        "rain_only": RAIN,
        "floodplain_only": ["sfha", "x500"],
        "terrain_only": TERRAIN,
        "rain_terrain": RAIN + TERRAIN,
        "history_only": HISTORY,
        "rain_terrain_history": RAIN + TERRAIN + HISTORY,
    }
    nyc = None
    p = CACHE / "nyc-baseline.npz"
    if p.exists():
        z = np.load(p)
        nyc = {k: z[k] for k in z.files}
    res, held = evaluate(data, variants, nyc)
    summ = {k: summary(v) for k, v in res.items()}
    cells = cell_check(data, held)
    log("area level", summary(cells))
    curve, table, levels = calibration(data, held)
    out = {
        "builtAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "unit": "block group x storm (2020 Census block groups with 10+ homes)",
        "chosen": CHOSEN,
        "minHomes": MIN_HOMES,
        "storms": [
            {"start": s["id"], "end": s["d1"], "claims": round(s["claims"])} for s in data["storms"]
        ],
        "summary": summ,
        "areaLevel": {"summary": summary(cells), "perStorm": cells},
        "calibrationTable": table,
        "levels": levels,
        "perStorm": res,
    }
    (CACHE / "evaluation.json").write_text(json.dumps(out, indent=1))
    np.savez_compressed(
        CACHE / "nj-design.npz",
        X=data["X"],
        hu=data["hu"],
        hist=data["hist"],
        keep=data["keep"],
        clat=data["clat"],
        clng=data["clng"],
        **{f"R_{s['id']}": s["R"] for s in data["storms"]},
        **{f"y_{s['id']}": s["y"] for s in data["storms"]},
    )
    export(data, curve, summ, summary(cells), levels)
    log("wrote evaluation.json")


if __name__ == "__main__":
    main()
