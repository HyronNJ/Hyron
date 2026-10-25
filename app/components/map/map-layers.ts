import type { Map as MapLibreMap, MapGeoJSONFeature } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { ago, levelInfo } from "@/lib/community";

// Map colors per theme. Dark mode uses OpenFreeMap's dark basemap and lighter overlay colors.
export const MAP_THEME = {
  light: {
    style: "positron",
    mask: "#e9eef5",
    maskOpacity: 0.6,
    outline: "#6f7f99",
    selected: "#1f47c2",
    halo: "#ffffff",
    waterLines: ["#4a90d0", "#2463b8", "#163f8c"],
    lowspotEdge: "#0b7b77",
    routeFocus: "#1f47c2",
    routeGap: "#5b6472",
    building: "#dfe4ec",
    sky: "#d6e4f5",
    horizon: "#f3f6fb",
  },
  dark: {
    style: "dark",
    mask: "#05080f",
    maskOpacity: 0.55,
    outline: "#8a9ab8",
    selected: "#8fb0ff",
    halo: "#0d131d",
    waterLines: ["#5aa6e6", "#6f9cf5", "#9db8ff"],
    lowspotEdge: "#2fc4bd",
    routeFocus: "#7ea2ff",
    routeGap: "#8a93a3",
    building: "#2a3446",
    sky: "#0b1220",
    horizon: "#141b27",
  },
};
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
export const OVERLAY_LAYERS = {
  water: [
    "water-lowground",
    "water-lowspot",
    "water-lowspot-edge",
    "water-casing",
    "water-lines-1",
    "water-lines-2",
    "water-lines-3",
    "water-arrows",
  ],
  truth: ["truth-dots"],
  route: ["route-casing", "route-lines", "route-gaps", "route-flags"],
} as const;
// Popups open for these layers (the map click still selects the place).
export const INTERACTIVE = ["community-pins", "truth-dots", "route-flags"];

/** A small chevron drawn along flow paths to show which way water runs (white halo, navy stroke). */
function arrowImage(): ImageData | null {
  const c = document.createElement("canvas");
  c.width = c.height = 28;
  const x = c.getContext("2d");
  if (!x) return null;
  const path = () => {
    x.beginPath();
    x.moveTo(10, 7);
    x.lineTo(19, 14);
    x.lineTo(10, 21);
  };
  x.lineCap = "round";
  x.lineJoin = "round";
  x.strokeStyle = "#ffffff";
  x.lineWidth = 7;
  path();
  x.stroke();
  x.strokeStyle = "#123c86";
  x.lineWidth = 3.2;
  path();
  x.stroke();
  return x.getImageData(0, 0, 28, 28);
}
function el(tag: string, cls: string, text?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
/** Popup content, built from DOM nodes so report text can never inject markup. */
export function popupFor(f: MapGeoJSONFeature, now: number): HTMLElement {
  const box = el("div", "map-popup"),
    p = f.properties ?? {};
  if (f.layer.id === "community-pins") {
    const level = levelInfo(p.waterLevel);
    box.appendChild(el("strong", "", String(p.category ?? "Report")));
    if (level) box.appendChild(el("span", "popup-level", level.label));
    box.appendChild(
      el(
        "small",
        "",
        `${String(p.municipality ?? "").replace(/, .*$/, "")} · reported ${ago(String(p.createdAt), now)}`,
      ),
    );
    box.appendChild(
      el("em", "", "Neighbor report, not verified. Location rounded to about 100 m."),
    );
  } else if (f.layer.id === "truth-dots") {
    const n = Math.max(1, Math.round(Number(p.claims)));
    box.appendChild(el("strong", "", `${n} flood insurance ${n === 1 ? "claim" : "claims"}`));
    box.appendChild(
      el(
        "small",
        "",
        `${Number(p.homes).toLocaleString("en-US")} homes in this neighborhood · FEMA records for this storm`,
      ),
    );
  } else if (f.layer.id === "route-flags") {
    box.appendChild(el("strong", "", String(p.title ?? "Flagged stretch")));
    if (p.detail) box.appendChild(el("small", "", String(p.detail)));
  }
  return box;
}

export function addMapLayers(instance: MapLibreMap, colors: (typeof MAP_THEME)["light" | "dark"]) {
  for (const id of [
    "water-spots",
    "water-lines",
    "route",
    "route-flags",
    "truth",
    "community",
    "selected-area",
  ])
    instance.addSource(id, { type: "geojson", data: EMPTY });
  // Where water goes: low ground by streams, closed low spots, then flow paths with arrows.
  instance.addLayer({
    id: "water-lowground",
    type: "fill",
    source: "water-spots",
    filter: ["==", ["get", "k"], 2],
    layout: { visibility: "none" },
    paint: {
      "fill-color": "#5fb4e5",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0.16, 16, 0.26],
    },
  });
  instance.addLayer({
    id: "water-lowspot",
    type: "fill",
    source: "water-spots",
    filter: ["==", ["get", "k"], 1],
    layout: { visibility: "none" },
    paint: { "fill-color": "#0f9f9a", "fill-opacity": 0.32 },
  });
  instance.addLayer({
    id: "water-lowspot-edge",
    type: "line",
    source: "water-spots",
    filter: ["==", ["get", "k"], 1],
    layout: { visibility: "none" },
    paint: {
      "line-color": colors.lowspotEdge,
      "line-width": 1.2,
      "line-dasharray": [2, 1.5],
    },
  });
  instance.addLayer({
    id: "water-casing",
    type: "line",
    source: "water-lines",
    filter: [">=", ["get", "c"], 2],
    layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": colors.halo,
      "line-opacity": 0.85,
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        12,
        ["match", ["get", "c"], 3, 3, 2],
        16,
        ["match", ["get", "c"], 3, 6.5, 4.5],
      ],
    },
  });
  const widths: Record<number, [number, number, number, number]> = {
    1: [13.5, 0.7, 16, 1.6],
    2: [12, 0.9, 16, 2.4],
    3: [11, 1.4, 16, 3.6],
  };
  for (const c of [1, 2, 3] as const) {
    const [z0, w0, z1, w1] = widths[c];
    instance.addLayer({
      id: `water-lines-${c}`,
      type: "line",
      source: "water-lines",
      minzoom: z0,
      filter: ["==", ["get", "c"], c],
      layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": colors.waterLines[c - 1],
        "line-opacity": c === 1 ? 0.75 : 0.9,
        "line-width": ["interpolate", ["linear"], ["zoom"], z0, w0, z1, w1],
      },
    });
  }
  const arrow = arrowImage();
  if (arrow) instance.addImage("water-arrow", arrow, { pixelRatio: 2 });
  instance.addLayer({
    id: "water-arrows",
    type: "symbol",
    source: "water-lines",
    minzoom: 13,
    filter: [">=", ["get", "c"], 2],
    layout: {
      visibility: "none",
      "symbol-placement": "line",
      "symbol-spacing": ["interpolate", ["linear"], ["zoom"], 13, 90, 16, 140],
      "icon-image": "water-arrow",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.75, 16, 1.05],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
  instance.addLayer({
    id: "nj-outline",
    type: "line",
    source: "nj-mask",
    paint: {
      "line-color": colors.outline,
      "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.2, 12, 0.7],
      "line-opacity": 0.65,
    },
  });
  instance.addLayer({
    id: "selected-outline",
    type: "line",
    source: "selected-area",
    paint: { "line-color": colors.selected, "line-width": 1.5, "line-opacity": 0.8 },
  });
  // Route checker: every option drawn, the one in focus on top and darker.
  instance.addLayer({
    id: "route-casing",
    type: "line",
    source: "route",
    filter: ["!=", ["get", "gap"], true],
    layout: {
      visibility: "none",
      "line-cap": "round",
      "line-join": "round",
      "line-sort-key": ["get", "order"],
    },
    paint: { "line-color": colors.halo, "line-width": ["case", ["get", "focus"], 9, 7] },
  });
  instance.addLayer({
    id: "route-lines",
    type: "line",
    source: "route",
    filter: ["!=", ["get", "gap"], true],
    layout: {
      visibility: "none",
      "line-cap": "round",
      "line-join": "round",
      "line-sort-key": ["get", "order"],
    },
    paint: {
      "line-color": [
        "case",
        ["get", "flagged"],
        ["case", ["get", "focus"], "#c2410c", "#f0a46b"],
        ["case", ["get", "focus"], colors.routeFocus, "#9fb3e6"],
      ],
      "line-width": ["case", ["get", "focus"], 5.5, 4],
    },
  });
  // Stretches of the focused route Hyron couldn't check: a dashed grey line over the route.
  instance.addLayer({
    id: "route-gaps",
    type: "line",
    source: "route",
    filter: ["==", ["get", "gap"], true],
    layout: { visibility: "none", "line-cap": "butt", "line-join": "round" },
    paint: { "line-color": colors.routeGap, "line-width": 5.5, "line-dasharray": [1.2, 1] },
  });
  instance.addLayer({
    id: "route-flags",
    type: "circle",
    source: "route-flags",
    layout: { visibility: "none" },
    paint: {
      "circle-color": [
        "case",
        ["==", ["get", "quiet"], true],
        "#9aa3b2",
        ["match", ["get", "kind"], "report", "#c4862b", "river", "#1565c0", "#c2410c"],
      ],
      "circle-radius": ["case", ["==", ["get", "quiet"], true], 5, 7],
      "circle-stroke-color": colors.halo,
      "circle-stroke-width": 2.5,
    },
  });
  // What really happened (replays): FEMA claims, sized by count.
  instance.addLayer({
    id: "truth-dots",
    type: "circle",
    source: "truth",
    layout: { visibility: "none", "circle-sort-key": ["get", "claims"] },
    paint: {
      "circle-color": "#d6336c",
      "circle-opacity": 0.82,
      "circle-stroke-color": colors.halo,
      "circle-stroke-width": 1.2,
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        7,
        ["interpolate", ["linear"], ["sqrt", ["get", "claims"]], 1, 2, 10, 6],
        13,
        ["interpolate", ["linear"], ["sqrt", ["get", "claims"]], 1, 5, 10, 16],
      ],
    },
  });
  // Neighbor reports: amber, darker and larger for deeper water, fading with age.
  instance.addLayer({
    id: "community-halo",
    type: "circle",
    source: "community",
    filter: [">=", ["get", "fade"], 0.99],
    paint: {
      "circle-color": "#c4862b",
      "circle-opacity": 0.18,
      "circle-radius": ["+", 12, ["*", 2, ["get", "rank"]]],
    },
  });
  instance.addLayer({
    id: "community-pins",
    type: "circle",
    source: "community",
    layout: { "circle-sort-key": ["get", "rank"] },
    paint: {
      "circle-color": [
        "match",
        ["get", "rank"],
        4,
        "#8a3b12",
        3,
        "#b5651d",
        2,
        "#d08a1e",
        1,
        "#e0a84a",
        "#c4862b",
      ],
      "circle-radius": ["+", 5, ["get", "rank"]],
      "circle-opacity": ["get", "fade"],
      "circle-stroke-color": colors.halo,
      "circle-stroke-width": 2,
      "circle-stroke-opacity": ["get", "fade"],
    },
  });

  for (const id of INTERACTIVE) {
    instance.on("mouseenter", id, () => {
      instance.getCanvas().style.cursor = "pointer";
    });
    instance.on("mouseleave", id, () => {
      instance.getCanvas().style.cursor = "";
    });
  }
  // Add terrain and buildings for the tilted view.
  const demTiles = ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"];
  const demCredit =
    '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noreferrer">Terrain: Mapzen tiles on AWS, USGS 3DEP</a>';
  // Separate sources for the surface and the shading, as MapLibre recommends.
  instance.addSource("terrain-dem", {
    type: "raster-dem",
    tiles: demTiles,
    encoding: "terrarium",
    tileSize: 256,
    maxzoom: 14,
    attribution: demCredit,
  });
  instance.addSource("terrain-shade-dem", {
    type: "raster-dem",
    tiles: demTiles,
    encoding: "terrarium",
    tileSize: 256,
    maxzoom: 14,
  });
  instance.addLayer(
    {
      id: "terrain-shade",
      type: "hillshade",
      source: "terrain-shade-dem",
      layout: { visibility: "none" },
      paint: {
        "hillshade-exaggeration": 0.35,
        "hillshade-shadow-color": "rgba(35, 48, 72, 0.55)",
        "hillshade-highlight-color": "rgba(255, 255, 255, 0.35)",
        "hillshade-accent-color": "rgba(35, 48, 72, 0.25)",
      },
    },
    "nj-mask-fill",
  );
  // OpenFreeMap's vector tiles carry building heights (OpenMapTiles schema).
  const basemap = Object.entries(instance.getStyle().sources ?? {}).find(
    ([, source]) => source.type === "vector",
  )?.[0];
  if (basemap)
    instance.addLayer(
      {
        id: "buildings-3d",
        type: "fill-extrusion",
        source: basemap,
        "source-layer": "building",
        minzoom: 14,
        layout: { visibility: "none" },
        paint: {
          "fill-extrusion-color": colors.building,
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": 0.8,
        },
      },
      "selected-outline",
    );
  instance.setSky({
    "sky-color": colors.sky,
    "horizon-color": colors.horizon,
    "fog-color": colors.horizon,
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.6,
    "fog-ground-blend": 0.85,
    "atmosphere-blend": 0,
  });
}
