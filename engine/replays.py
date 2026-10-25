"""Build historical rainfall replays."""

from pathlib import Path
import datetime as dt
import json
import numpy as np
import data as D

ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent / "app/public/data/nj/replays.json"
WINDOWS = {
    "ida": ("2021-08-28T00:00:00+00:00", 192),
    "september-2023": ("2023-09-24T00:00:00+00:00", 192),
}


def main():
    old = {r["id"]: r for r in json.loads(OUT.read_text())}
    mm, times, meta = D.rain()
    tindex = {t: i for i, t in enumerate(times)}
    seg_of = np.concatenate([np.full(n, k) for k, (_, n) in enumerate(meta["segments"])])
    tempC = (np.array(meta["segMinF"], float) - 32) * 5 / 9
    out = []
    for rid, (start, n) in WINDOWS.items():
        t0 = dt.datetime.fromisoformat(start)
        hours = [t0 + dt.timedelta(hours=k) for k in range(n)]
        cols = [tindex[h] for h in hours]
        if np.isnan(mm[:, cols]).any():
            raise RuntimeError(f"Radar rain has gaps for {rid}")
        temp = tempC[seg_of[cols[len(cols) // 2]]]
        series = [
            {
                "rain": [round(float(v), 2) for v in mm[k, cols]],
                "temperature": [round(float(temp[k]), 1)] * n,
                "probability": [None] * n,
            }
            for k in range(81)
        ]
        r = old[rid]
        out.append(
            {
                **r,
                "times": [h.strftime("%Y-%m-%dT%H:%M:%SZ") for h in hours],
                "series": series,
                "source": "IEM Reanalysis hourly precipitation (NCEP Stage IV radar, gauge-corrected), 81 New Jersey points",
                "sourceUrl": "https://mesonet.agron.iastate.edu/iemre/",
                "fetchedAt": "2026-10-13T03:20:00Z",
            }
        )
        print(rid, "max point total", round(float(mm[:, cols].sum(1).max() / 25.4), 2), "in")
    OUT.write_text(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main()
