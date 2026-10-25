"""Process river flood extents and gauge records."""

from pathlib import Path
import json
import sys
from shapely.geometry import shape, mapping, MultiPolygon, Polygon
from shapely.validation import make_valid

ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent / "app/public/data/nj/rivers.json"


def polygonal(g):
    g = make_valid(g)
    parts = [p for p in getattr(g, "geoms", [g]) if isinstance(p, (Polygon, MultiPolygon))]
    polys = [q for p in parts for q in getattr(p, "geoms", [p])]
    return MultiPolygon(polys) if polys else None


def rounded(geom, digits=5):
    def walk(c):
        return (
            [round(c[0], digits), round(c[1], digits)]
            if isinstance(c[0], (int, float))
            else [walk(x) for x in c]
        )

    m = mapping(geom)
    return {"type": m["type"], "coordinates": walk(m["coordinates"])}


def main(path):
    doc = json.loads(Path(path).read_text())
    for site in doc["sites"]:
        feats = []
        for f in site["flood"]["features"]:
            g = polygonal(shape(f["geometry"]))
            if g is None:
                continue
            g = polygonal(g.simplify(0.00002, preserve_topology=True))
            # Repair rounding artifacts.
            for _ in range(4):
                if g is None:
                    break
                r = rounded(g)
                if shape(r).is_valid:
                    break
                g = polygonal(shape(r))
            if g is None or not shape(r).is_valid:
                raise RuntimeError(f"{site['lid']} {f['properties']['stage']} ft: could not repair")
            feats.append(
                {
                    "type": "Feature",
                    "properties": {"stage": f["properties"]["stage"]},
                    "geometry": r,
                }
            )
        feats.sort(key=lambda f: f["properties"]["stage"])
        site["flood"] = {"type": "FeatureCollection", "features": feats}
        site["stages"] = [f["properties"]["stage"] for f in feats]
        print(site["lid"], len(feats), "stages", site["stages"][0], "-", site["stages"][-1])
    text = json.dumps(doc, separators=(",", ":"), ensure_ascii=False)
    OUT.write_text(text)
    print("wrote", OUT, f"{len(text.encode()) / 1e3:.0f} kB")


if __name__ == "__main__":
    main(sys.argv[1])
