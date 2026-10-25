import { addMapLayers, MAP_THEME, OVERLAY_LAYERS, INTERACTIVE, popupFor } from "./map-layers";
import { useEffect, useRef, useState } from "react";
import type {
  Map as MapLibreMap,
  Marker as MapLibreMarker,
  Popup as MapLibrePopup,
  GeoJSONSource,
  CanvasSource,
  LngLatBoundsLike,
} from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { Plus, Minus, LocateFixed, Expand, LoaderCircle } from "lucide-react";
import type {
  Block,
  Coord,
  PublicPin,
  Area,
  MapLayer,
  WaterOverlay,
  RouteOverlay,
} from "@/lib/types";
import { MAP_LIMITS, NJ_BOUNDS, cellCenter, latticeIndex, njOutline } from "@/lib/nj";
import { detailRaster, overviewRaster, paint, type Raster } from "@/lib/raster";
import { reducedMotion } from "@/lib/prefs";
import { levelRank, pinFade, PIN_HOURS } from "@/lib/community";
import type { TruthDot } from "@/lib/truth";
import type { Playhead } from "@/lib/playhead";
import type { MapView, TileScores } from "@/hooks/use-statewide";
type Props = {
  focus: (Coord & { zoom: number; key: number; offset?: [number, number]; flat?: boolean }) | null;
  selected: Coord;
  selectedArea: Area | null;
  onSelect: (point: Coord, label?: string) => void;
  overview: { blocks: Block[] | null; scores: Float32Array | null };
  detail: TileScores[] | null;
  playhead: Playhead;
  pins: PublicPin[];
  onLocate: () => void;
  layer: MapLayer;
  preparing: boolean;
  dark: boolean;
  onView: (view: MapView) => void;
  water?: WaterOverlay | null;
  truth?: { dots: TruthDot[]; storm: string } | null;
  route?: RouteOverlay | null;
  fit?: { bounds: [number, number, number, number]; key: number } | null;
  persistent?: boolean;
};
const NJ_FIT: LngLatBoundsLike = [
  [NJ_BOUNDS[0], NJ_BOUNDS[1]],
  [NJ_BOUNDS[2], NJ_BOUNDS[3]],
];
// Preserve the view across theme changes.
let keptView: { center: [number, number]; zoom: number; bearing: number; pitch: number } | null =
  null;
let flownFocus: number | null = null;
const square = (a: Area) => [
  [
    [a.lng - a.dx / 2, a.lat - a.dy / 2],
    [a.lng + a.dx / 2, a.lat - a.dy / 2],
    [a.lng + a.dx / 2, a.lat + a.dy / 2],
    [a.lng - a.dx / 2, a.lat + a.dy / 2],
    [a.lng - a.dx / 2, a.lat - a.dy / 2],
  ],
];
const reduced = reducedMotion;
const PLACEHOLDER: Raster["coordinates"] = [
  [NJ_BOUNDS[0], NJ_BOUNDS[3]],
  [NJ_BOUNDS[2], NJ_BOUNDS[3]],
  [NJ_BOUNDS[2], NJ_BOUNDS[1]],
  [NJ_BOUNDS[0], NJ_BOUNDS[1]],
];
/** Canvas state for one map raster. */
type Surface = {
  id: string;
  canvas: HTMLCanvasElement;
  small: HTMLCanvasElement;
  raster: Raster | null;
  image: ImageData | null;
  scale: number;
  shown: boolean;
  pause: ReturnType<typeof setTimeout> | null;
};
function surface(id: string): Surface {
  const canvas = document.createElement("canvas"),
    small = document.createElement("canvas");
  canvas.width = canvas.height = small.width = small.height = 1;
  return { id, canvas, small, raster: null, image: null, scale: 1, shown: true, pause: null };
}
// Keep raster canvases near 640 px.
const scaleFor = (r: Raster) =>
  Math.max(2, Math.min(4, Math.floor(640 / Math.max(r.width, r.height))));
let filterSupport: boolean | null = null;
const canFilter = (ctx: CanvasRenderingContext2D) => {
  if (filterSupport === null) {
    ctx.filter = "blur(1px)";
    filterSupport = ctx.filter === "blur(1px)";
    ctx.filter = "none";
  }
  return filterSupport;
};
export default function FloodMap({
  focus,
  selected,
  selectedArea,
  onSelect,
  overview,
  detail,
  playhead,
  pins,
  onLocate,
  layer,
  preparing,
  dark,
  onView,
  water,
  truth,
  route,
  fit,
  persistent = false,
}: Props) {
  const colors = MAP_THEME[dark ? "dark" : "light"];
  const host = useRef<HTMLDivElement>(null),
    map = useRef<MapLibreMap | null>(null),
    marker = useRef<MapLibreMarker | null>(null),
    popup = useRef<MapLibrePopup | null>(null);
  const selection = useRef(onSelect);
  selection.current = onSelect;
  const viewChange = useRef(onView);
  viewChange.current = onView;
  const layerRef = useRef(layer);
  layerRef.current = layer;
  const surfaces = useRef<{ overview: Surface; detail: Surface } | null>(null);
  const [ready, setReady] = useState(false),
    [failed, setFailed] = useState(false),
    [now, setNow] = useState(() => Date.now()),
    [tilted3D, setTilted3D] = useState(false);

  // Draw one surface at the current playhead and hand the pixels to the map.
  function draw(s: Surface) {
    const m = map.current,
      src = m?.getSource(s.id) as CanvasSource | undefined;
    if (!m || !src || !s.raster) return;
    const small = s.small.getContext("2d"),
      ctx = s.canvas.getContext("2d");
    if (!small || !ctx) return;
    if (!s.image || s.image.width !== s.raster.width || s.image.height !== s.raster.height) {
      s.small.width = s.raster.width;
      s.small.height = s.raster.height;
      s.image = small.createImageData(s.raster.width, s.raster.height);
      s.scale = scaleFor(s.raster);
      s.canvas.width = s.raster.width * s.scale;
      s.canvas.height = s.raster.height * s.scale;
    }
    paint(s.raster, s.image, playhead.get(), layerRef.current === "ground", dark);
    small.putImageData(s.image, 0, 0);
    ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (canFilter(ctx)) ctx.filter = `blur(${(s.scale * 0.55).toFixed(2)}px)`;
    ctx.drawImage(s.small, 0, 0, s.canvas.width, s.canvas.height);
    ctx.filter = "none";
    // Upload only while pixels change; pause shortly after the last frame.
    src.play();
    if (s.pause) clearTimeout(s.pause);
    s.pause = setTimeout(() => {
      src.pause();
      s.pause = null;
    }, 150);
  }
  // Hidden surfaces are skipped during playback and repainted when they are shown again.
  function drawAll(force = false) {
    const s = surfaces.current;
    if (s) for (const g of [s.overview, s.detail]) if (force || g.shown) draw(g);
  }

  useEffect(() => {
    let cancelled = false,
      loaded = false,
      restored: typeof keptView = null;
    let observer: ResizeObserver | null = null;
    void import("maplibre-gl")
      .then((lib) => {
        if (!host.current || cancelled) return;
        lib.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
        restored = keptView;
        keptView = null;
        const instance = new lib.Map({
          container: host.current,
          ...(restored ?? { center: [selected.lng, selected.lat], zoom: 12 }),
          minZoom: 6,
          maxZoom: 17,
          maxBounds: [
            [MAP_LIMITS[0], MAP_LIMITS[1]],
            [MAP_LIMITS[2], MAP_LIMITS[3]],
          ],
          attributionControl: { compact: true },
          style: `https://tiles.openfreemap.org/styles/${colors.style}`,
        });
        map.current = instance;
        popup.current = new lib.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 12,
          maxWidth: "260px",
          className: "hyron-popup",
        });
        // The farthest zoom-out always shows all of New Jersey for this screen size.
        const fitState = () => {
          const camera = instance.cameraForBounds(NJ_FIT, { padding: 16 });
          if (camera?.zoom !== undefined)
            instance.setMinZoom(Math.max(5, Math.min(11, camera.zoom - 0.2)));
        };
        const report = () => {
          const b = instance.getBounds();
          viewChange.current({
            bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
            zoom: instance.getZoom(),
          });
        };
        instance.on("load", () => {
          if (cancelled) return;
          loaded = true;
          fitState();
          if (!restored) instance.fitBounds(NJ_FIT, { padding: 30, duration: 0 });
          // Soften everything outside New Jersey and outline the state.
          instance.addSource("nj-mask", {
            type: "geojson",
            data: {
              type: "Feature",
              properties: {},
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [-180, -85],
                    [180, -85],
                    [180, 85],
                    [-180, 85],
                    [-180, -85],
                  ],
                  njOutline,
                ],
              },
            },
          });
          instance.addLayer({
            id: "nj-mask-fill",
            type: "fill",
            source: "nj-mask",
            paint: { "fill-color": colors.mask, "fill-opacity": colors.maskOpacity },
          });
          const s = { overview: surface("grid-overview"), detail: surface("grid-detail") };
          surfaces.current = s;
          for (const g of [s.overview, s.detail]) {
            instance.addSource(g.id, {
              type: "canvas",
              canvas: g.canvas,
              coordinates: PLACEHOLDER,
              animate: false,
            });
            instance.addLayer({
              id: `${g.id}-fill`,
              type: "raster",
              source: g.id,
              paint: {
                "raster-resampling": "linear",
                "raster-fade-duration": 0,
                "raster-opacity": 0,
                "raster-opacity-transition": { duration: 280, delay: 0 },
              },
            });
          }
          addMapLayers(instance, colors);
          let tilted = false;
          const apply3D = () => {
            // A little hysteresis so the switch does not flicker around the threshold.
            const next = tilted ? instance.getPitch() > 4 : instance.getPitch() > 10;
            if (next === tilted) return;
            tilted = next;
            setTilted3D(next);
            instance.setTerrain(next ? { source: "terrain-dem", exaggeration: 1.6 } : null);
            for (const id of ["terrain-shade", "buildings-3d"])
              if (instance.getLayer(id))
                instance.setLayoutProperty(id, "visibility", next ? "visible" : "none");
          };
          instance.on("pitch", apply3D);
          instance.on("pitchend", apply3D);
          // A map rebuilt for a theme switch can open already tilted.
          apply3D();
          const markerEl = document.createElement("div");
          markerEl.className = "selected-marker";
          marker.current = new lib.Marker({ element: markerEl })
            .setLngLat([selected.lng, selected.lat])
            .addTo(instance);
          setReady(true);
          report();
        });
        instance.on("moveend", report);
        instance.on("click", (e) => {
          const layers = INTERACTIVE.filter(
            (id) =>
              instance.getLayer(id) && instance.getLayoutProperty(id, "visibility") !== "none",
          );
          const hit = layers.length ? instance.queryRenderedFeatures(e.point, { layers }) : [];
          if (hit.length)
            popup.current
              ?.setLngLat(e.lngLat)
              .setDOMContent(popupFor(hit[0], Date.now()))
              .addTo(instance);
          else popup.current?.remove();
          selection.current({ lat: e.lngLat.lat, lng: e.lngLat.lng });
        });
        instance.on("error", (e) => {
          if (!instance.loaded() && /WebGL|initialize/i.test(e.error.message)) setFailed(true);
        });
        instance
          .getCanvas()
          .setAttribute(
            "aria-label",
            "Flood risk map of New Jersey. Use the area list for keyboard selection.",
          );
        observer = new ResizeObserver(() => {
          instance.resize();
          if (instance.loaded()) fitState();
        });
        observer.observe(host.current);
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      observer?.disconnect();
      const m = map.current;
      if (m && loaded) {
        const { lng, lat } = m.getCenter();
        keptView = {
          center: [lng, lat],
          zoom: m.getZoom(),
          bearing: m.getBearing(),
          pitch: m.getPitch(),
        };
      }
      popup.current?.remove();
      marker.current?.remove();
      map.current?.remove();
      map.current = null;
      surfaces.current = null;
    };
  }, []);

  // Rebuild the statewide summary image when its data changes.
  useEffect(() => {
    const s = surfaces.current,
      m = map.current;
    if (!ready || !s || !m || !overview.blocks?.length) return;
    s.overview.raster = overviewRaster(overview.blocks, overview.scores);
    (m.getSource(s.overview.id) as CanvasSource).setCoordinates(s.overview.raster.coordinates);
    draw(s.overview);
  }, [ready, overview.blocks, overview.scores]);
  // Rebuild the 280 m image for the tiles in view.
  useEffect(() => {
    const s = surfaces.current,
      m = map.current;
    if (!ready || !s || !m) return;
    s.detail.raster = detail ? detailRaster(detail) : null;
    if (s.detail.raster) {
      (m.getSource(s.detail.id) as CanvasSource).setCoordinates(s.detail.raster.coordinates);
      draw(s.detail);
    }
  }, [ready, detail]);

  const busy = !!(water || route);
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const showDetail = !!detail?.some((t) => t.scores) || (layer === "ground" && !!detail?.length);
    const s = surfaces.current;
    if (!s) return;
    s.overview.shown = !showDetail;
    s.detail.shown = showDetail;
    const shown = busy ? 0.62 : 1;
    m.setPaintProperty("grid-overview-fill", "raster-opacity", s.overview.shown ? shown : 0);
    m.setPaintProperty("grid-detail-fill", "raster-opacity", s.detail.shown ? shown : 0);
    drawAll(true);
  }, [ready, detail, layer, busy]);
  // Every playhead move repaints at most once per display frame.
  useEffect(() => {
    let frame = 0;
    const unsubscribe = playhead.subscribe(() => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          drawAll();
        });
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [playhead]);

  useEffect(() => {
    if (!ready || !map.current) return;
    marker.current?.setLngLat([selected.lng, selected.lat]);
    if (marker.current) marker.current.getElement().hidden = !!route;
    const a = selectedArea;
    (map.current.getSource("selected-area") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features:
        a && !route
          ? [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "Polygon", coordinates: square(a) },
              },
            ]
          : [],
    });
    // Bring an off-screen selection into view, unless a fly to it is already under way.
    if (
      !route &&
      !map.current.isMoving() &&
      !map.current.getBounds().contains([selected.lng, selected.lat])
    )
      map.current.easeTo({
        center: a ? [a.lng, a.lat] : [selected.lng, selected.lat],
        zoom: Math.max(13, map.current.getZoom()),
        duration: reduced() ? 0 : 250,
      });
  }, [ready, selected, selectedArea, layer, route]);
  // Center the selected map cell.
  useEffect(() => {
    if (!ready || !map.current || !focus || focus.key === flownFocus) return;
    flownFocus = focus.key;

    if (host.current?.clientWidth) map.current.resize();
    const cell = latticeIndex(focus);
    const center = cell ? cellCenter(cell.col, cell.row) : focus;
    map.current.flyTo({
      center: [center.lng, center.lat],
      zoom: focus.zoom,
      offset: focus.offset ?? [0, 0],
      ...(focus.flat ? { pitch: 0, bearing: 0 } : {}),
      duration: reduced() ? 0 : 1200,
      essential: true,
    });
  }, [ready, focus]);
  useEffect(() => {
    if (!ready || !map.current || !fit) return;

    const wide = (host.current?.clientWidth ?? 0) > 760;
    map.current.fitBounds(
      [
        [fit.bounds[0], fit.bounds[1]],
        [fit.bounds[2], fit.bounds[3]],
      ],
      {
        padding: { top: 70, bottom: 40, left: wide ? 370 : 40, right: wide ? 70 : 40 },
        maxZoom: 15.5,
        duration: reduced() ? 0 : 700,
      },
    );
  }, [ready, fit]);
  // Neighbor reports fade as they age; recheck their age every minute.
  useEffect(() => {
    if (!pins.length) return;
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, [pins.length]);
  useEffect(() => {
    if (!ready || !map.current) return;
    const features = pins
      .map((p) => ({ p, fade: pinFade(p.createdAt, now) }))
      .filter((x) => x.fade > 0 && (now - Date.parse(x.p.createdAt)) / 3.6e6 < PIN_HOURS)
      .map(({ p, fade }) => ({
        type: "Feature" as const,
        properties: {
          category: p.category,
          municipality: p.municipality,
          createdAt: p.createdAt,
          waterLevel: p.waterLevel ?? "",
          rank: levelRank(p.waterLevel),
          fade: Math.round(fade * 100) / 100,
        },
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      }));
    (map.current.getSource("community") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features,
    });
  }, [ready, pins, now]);
  // Overlays: set their data and show or hide their layers.
  function overlay(kind: keyof typeof OVERLAY_LAYERS, data: [string, FeatureCollection][] | null) {
    const m = map.current;
    if (!m) return;
    for (const [source, fc] of data ?? [])
      (m.getSource(source) as GeoJSONSource | undefined)?.setData(fc);
    for (const id of OVERLAY_LAYERS[kind])
      if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", data ? "visible" : "none");
  }
  useEffect(() => {
    if (ready)
      overlay(
        "water",
        water
          ? [
              ["water-lines", water.lines],
              ["water-spots", water.spots],
            ]
          : null,
      );
  }, [ready, water]);
  useEffect(() => {
    if (ready)
      overlay(
        "route",
        route
          ? [
              ["route", route.lines],
              ["route-flags", route.flags],
            ]
          : null,
      );
  }, [ready, route]);

  useEffect(() => {
    if (!ready) return;
    overlay(
      "truth",
      truth
        ? [
            [
              "truth",
              {
                type: "FeatureCollection",
                features: truth.dots.map(([lng, lat, claims, homes]) => ({
                  type: "Feature",
                  properties: { claims, homes },
                  geometry: { type: "Point", coordinates: [lng, lat] },
                })),
              },
            ],
          ]
        : null,
    );
  }, [ready, truth]);

  const label = layer === "ground" ? "Ground height" : "Flood risk";
  return (
    <div className={`flood-map ${layer}`}>
      <div className="map-host" ref={host} />
      {/* Covers the blank map until MapLibre's first full render, then fades out. */}
      {!failed && (
        <div className={`map-loading ${ready ? "done" : ""}`} role="status" aria-hidden={ready}>
          <span>Loading the map of New Jersey…</span>
        </div>
      )}
      {failed && (
        <div className="map-error">
          <strong>The map could not load.</strong>
          <span>Use the area list to explore the outlook.</span>
        </div>
      )}
      <div className="map-controls">
        <button aria-label="Zoom in" onClick={() => map.current?.zoomIn()}>
          <Plus size={17} />
        </button>
        <button aria-label="Zoom out" onClick={() => map.current?.zoomOut()}>
          <Minus size={17} />
        </button>
        <button
          aria-label="Show all of New Jersey"
          title="Show all of New Jersey"
          onClick={() =>
            map.current?.fitBounds(NJ_FIT, { padding: 16, duration: reduced() ? 0 : 500 })
          }
        >
          <Expand size={16} />
        </button>
        <button
          className="map-3d"
          aria-label="3D view"
          aria-pressed={tilted3D}
          title={tilted3D ? "Back to the flat map" : "Tilt into 3D terrain and buildings"}
          onClick={() => {
            const m = map.current;
            if (!m) return;
            const duration = reduced() ? 0 : 900;
            if (tilted3D) m.easeTo({ pitch: 0, bearing: 0, duration });
            // Buildings appear from street level, so a far-out view moves in to the selected place.
            else
              m.easeTo({
                pitch: 60,
                bearing: -20,
                duration,
                ...(m.getZoom() < 12 ? { center: [selected.lng, selected.lat], zoom: 14.5 } : {}),
              });
          }}
        >
          3D
        </button>
        <button
          aria-label="Use my location"
          onClick={() => {
            // Recentering returns to the flat, north-up map right away, before the position arrives.
            map.current?.easeTo({ pitch: 0, bearing: 0, duration: reduced() ? 0 : 400 });
            onLocate();
          }}
        >
          <LocateFixed size={17} />
        </button>
      </div>
      <div className="map-legend">
        <div className="legend-title">
          <strong>{label}</strong>
          {preparing && <LoaderCircle size={13} className="spin" aria-label="Preparing map" />}
        </div>
        <div className={`legend-gradient ${layer}`} />
        <div className="legend-labels">
          <span>{layer === "ground" || persistent ? "Lower" : "Very low"}</span>
          <span>{layer === "ground" ? "Higher" : "High"}</span>
        </div>
      </div>
    </div>
  );
}
