import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Layers, List, Map as MapIcon, Route, X } from "lucide-react";
import { toast } from "sonner";
import FloodMap from "@/components/map/FloodMap";
import RoutePlanner, { type RouteRiver } from "@/components/routes/RoutePlanner";
import DepthSection from "@/components/rivers/DepthSection";
import { useStatewide, type MapView } from "@/hooks/use-statewide";
import { useWaterPaths } from "@/hooks/use-water-paths";
import { useRivers } from "@/hooks/use-rivers";
import { HISTORY_HOURS, MODEL_FOR, REPLAY_STORM } from "@/lib/nj-model";
import { placeWeather, weatherWeights } from "@/lib/statewide";
import { LATTICE } from "@/lib/nj";
import { nearRivers } from "@/lib/rivers";
import { loadTruth, type TruthData } from "@/lib/truth";
import { townInfoAt } from "@/lib/geo";
import type { Coord, PublicPin, MapLayer, RouteOverlay } from "@/lib/types";
import type { WorkspaceController } from "@/hooks/use-workspace";
import { useWeather, type WeatherMode } from "@/hooks/use-weather";
import { usePlayback } from "@/hooks/use-playback";
import { useAlerts } from "@/hooks/use-alerts";
import ForecastTimeline from "@/components/map/ForecastTimeline";
import LocationSummary from "@/components/map/LocationSummary";
import AreaList from "@/components/map/AreaList";

export type SelectedPlace = Coord & { label: string; address: string };
export type MapFocus = Coord & { zoom: number; key: number; flat?: boolean };
const EMPTY_PINS: PublicPin[] = [];
const NO_RIVER: RouteRiver = { flood: [], unknown: [], high: [], sites: [], scenario: false };
const riskRiver = () => NO_RIVER;
const noRain = () => null;
type MapMode = "risk" | WeatherMode;
type Props = {
  hidden: boolean;
  routes: boolean;
  selection: SelectedPlace;
  focus: MapFocus | null;
  onSelect: (place: SelectedPlace, zoom?: number) => void;
  onLocate: () => void;
  onSave: () => void;
  onReport: () => void;
  onCloseRoute: () => void;
  onRoute: () => void;
  workspace: WorkspaceController;
  units: "imperial" | "metric";
  dark: boolean;
};

export default function MapWorkspace(props: Props) {
  const [mode, setMode] = useState<MapMode>("risk");
  const [layer, setLayer] = useState<MapLayer>("outlook");
  useEffect(() => {
    if (props.routes) setLayer("outlook");
  }, [props.routes]);
  const [view, setView] = useState<MapView | null>(null);
  const [list, setList] = useState(false);
  // Show the map when a place is selected.
  const [shownFocus, setShownFocus] = useState(props.focus);
  if (props.focus !== shownFocus) {
    setShownFocus(props.focus);
    setList(false);
  }
  const [layersOpen, setLayersOpen] = useState(false);
  const [showWater, setShowWater] = useState(true);
  const [showReports, setShowReports] = useState(false);
  const [showClaims, setShowClaims] = useState(false);
  const [truth, setTruth] = useState<TruthData | null>(null);
  const [routeOverlay, setRouteOverlay] = useState<RouteOverlay | null>(null);
  const [fit, setFit] = useState<{ bounds: [number, number, number, number]; key: number } | null>(
    null,
  );
  const persistent = mode === "risk";
  const weather = useWeather(persistent ? "live" : mode, !persistent);
  const grid = weather.grid;
  const base = useMemo(() => {
    if (!grid) return 0;
    const start =
      mode === "live"
        ? Math.floor(weather.now / 3_600_000) * 3_600_000
        : Date.parse(grid.timelineStart!);
    return grid.times.findIndex((time) => Date.parse(time) >= start);
  }, [grid, mode, weather.now]);
  const engineCount =
    grid && base >= HISTORY_HOURS
      ? Math.max(0, Math.min(mode === "ida" ? 37 : 25, grid.times.length - base - 6))
      : 0;
  const count = persistent ? 1 : Math.min(engineCount, 25);
  const playback = usePlayback(count);
  const engine = useStatewide(
    grid,
    base,
    persistent ? 1 : engineCount,
    view,
    props.selection,
    persistent ? "risk" : MODEL_FOR[mode],
  );
  const selectedForecast = useMemo(
    () => engine.forecast?.slice(0, count) ?? null,
    [engine.forecast, count],
  );
  const localWeather = useMemo(
    () => (grid ? placeWeather(grid, props.selection) : null),
    [grid, props.selection],
  );
  const hours = useMemo(
    () => localWeather?.hours.slice(base, base + count) ?? [],
    [localWeather, base, count],
  );
  const times = useMemo(() => hours.map((hour) => hour.time), [hours]);
  const forecastError =
    engine.error ||
    (!persistent && !grid ? weather.error : "") ||
    (grid && base < HISTORY_HOURS ? "Weather history is incomplete. Retry or open a replay." : "");
  const alerts = useAlerts(props.selection);
  const rivers = useRivers({
    // Load river conditions for routes and depth.
    wanted: !persistent && (props.routes || nearRivers(props.selection)),
    mode: persistent ? "live" : mode,
    hours,
    now: weather.now,
    selection: props.selection,
    units: props.units,
  });
  const water = useWaterPaths(showWater, view, engine.index?.tiles ?? null);
  const waterOverlay = useMemo(
    () => (showWater && water.active ? { lines: water.lines, spots: water.spots } : null),
    [showWater, water.active, water.lines, water.spots],
  );
  const overview = useMemo(
    () => ({ blocks: engine.blocks, scores: engine.blockScores }),
    [engine.blocks, engine.blockScores],
  );
  const area = useMemo(
    () =>
      engine.cell
        ? {
            id: engine.cell.id,
            lat: engine.cell.lat,
            lng: engine.cell.lng,
            dx: LATTICE.dLng,
            dy: LATTICE.dLat,
          }
        : null,
    [engine.cell],
  );
  const saved = props.workspace.places.some(
    (place) =>
      Math.abs(place.lat - props.selection.lat) < 0.0003 &&
      Math.abs(place.lng - props.selection.lng) < 0.0003,
  );
  const town = townInfoAt(props.selection);
  const townLabel = town ? `${town.name}, ${town.county} County` : "New Jersey";

  useEffect(() => {
    if (!showClaims || truth) return;
    let cancelled = false;
    loadTruth()
      .then((data) => {
        if (!cancelled) setTruth(data);
      })
      .catch(() => toast.error("Historical claims could not load."));
    return () => {
      cancelled = true;
    };
  }, [showClaims, truth]);
  const claims = useMemo(
    () =>
      showClaims && mode !== "live" && truth?.replays[mode]
        ? { dots: truth.replays[mode].dots, storm: mode }
        : null,
    [showClaims, truth, mode],
  );

  function changeMode(next: MapMode) {
    setMode(next);
    setLayer("outlook");
    playback.reset();
  }

  function chooseLayer(next: MapLayer) {
    setLayersOpen(false);
    setLayer(next);
  }

  const rainAt = useCallback(
    ([lng, lat]: [number, number], hour: number) => {
      if (!grid) return null;
      const end = base + hour;
      if (end < 23 || end >= grid.times.length) return null;
      const { index, weight } = weatherWeights(grid.points, { lng, lat });
      let last1 = 0,
        last3 = 0,
        last24 = 0;
      index.forEach((point, part) => {
        const rain = grid.series[point].rain;
        last1 += weight[part] * rain[end];
        for (let time = end - 2; time <= end; time++) last3 += weight[part] * rain[time];
        for (let time = end - 23; time <= end; time++) last24 += weight[part] * rain[time];
      });
      return { last1, last3, last24 };
    },
    [grid, base],
  );

  const displayRoute = useCallback(
    (overlay: RouteOverlay | null, bounds?: [number, number, number, number]) => {
      setRouteOverlay(overlay);
      if (bounds) setFit({ bounds, key: Date.now() });
    },
    [],
  );

  return (
    <section className={`map-workspace ${persistent ? "persistent" : ""}`} hidden={props.hidden}>
      <div className="map-and-timeline">
        <div className="map-stage">
          <div className="map-renderer" hidden={list}>
            <FloodMap
              key={props.dark ? "dark" : "light"}
              focus={props.focus}
              selected={props.selection}
              selectedArea={area}
              onSelect={(point, label) =>
                props.onSelect({
                  ...point,
                  label: label ?? "Selected location",
                  address: "Selected location in New Jersey",
                })
              }
              overview={overview}
              detail={engine.detail ? engine.tiles : null}
              playhead={playback.playhead}
              pins={
                showReports && (persistent || mode === "live")
                  ? props.workspace.community
                  : EMPTY_PINS
              }
              onLocate={props.onLocate}
              layer={layer}
              preparing={engine.scoring}
              dark={props.dark}
              persistent={persistent}
              onView={setView}
              water={waterOverlay}
              truth={claims}
              route={props.routes ? routeOverlay : null}
              fit={fit}
            />
          </div>
          {list && (
            <AreaList
              persistent={persistent}
              tiles={engine.tiles}
              blocks={engine.blocks}
              scores={engine.blockScores}
              hour={playback.hour}
              detail={engine.detail}
              onSelect={(place) => {
                setList(false);
                props.onSelect({ ...place, label: place.label, address: `${place.label}, NJ` }, 14);
              }}
            />
          )}
          <div className="map-toolbar">
            <select
              className="map-view-select"
              aria-label="Map view"
              value={mode}
              onChange={(event) => changeMode(event.target.value as MapMode)}
            >
              <option value="risk">Flood risk</option>
              <option value="live">Rain outlook</option>
              <option value="ida">Ida · 2021</option>
              <option value="september-2023">September 2023</option>
            </select>
            <button
              className="map-tool map-direction"
              aria-pressed={props.routes}
              onClick={props.routes ? props.onCloseRoute : props.onRoute}
            >
              <Route size={15} /> Directions
            </button>
            <button
              className="map-tool"
              aria-pressed={list}
              onClick={() => setList((value) => !value)}
            >
              {list ? <MapIcon size={15} /> : <List size={15} />}
              {list ? "Map" : "Areas"}
            </button>
            <div
              className="layers-control"
              onKeyDown={(event) => {
                if (event.key === "Escape") setLayersOpen(false);
              }}
            >
              <button
                className="map-tool"
                aria-expanded={layersOpen}
                onClick={() => setLayersOpen((value) => !value)}
              >
                <Layers size={15} />
                Layers
                <ChevronDown size={12} />
              </button>
              {layersOpen && (
                <div className="layers-menu">
                  <header>
                    <strong>Map layers</strong>
                    <button
                      className="icon-button"
                      aria-label="Close layers"
                      onClick={() => setLayersOpen(false)}
                    >
                      <X size={14} />
                    </button>
                  </header>
                  {(
                    [
                      ["outlook", persistent ? "Flood risk" : "Flood outlook"],
                      ["ground", "Ground height"],
                    ] as const
                  ).map(([value, label]) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name="layer"
                        checked={layer === value}
                        onChange={() => chooseLayer(value)}
                      />
                      {label}
                    </label>
                  ))}
                  <hr />
                  <label>
                    <input
                      type="checkbox"
                      checked={showWater}
                      onChange={(event) => setShowWater(event.target.checked)}
                    />
                    Water flow paths
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={showReports}
                      onChange={(event) => setShowReports(event.target.checked)}
                    />
                    Neighbor reports
                  </label>
                  {!persistent && mode !== "live" && (
                    <label>
                      <input
                        type="checkbox"
                        checked={showClaims}
                        onChange={(event) => setShowClaims(event.target.checked)}
                      />
                      Historical claims
                    </label>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        {!persistent && (
          <ForecastTimeline
            hideSource
            mode={mode as WeatherMode}
            onMode={changeMode}
            hours={hours}
            hour={playback.hour}
            playhead={playback.playhead}
            onHour={playback.selectHour}
            playing={playback.playing}
            onPlay={playback.toggle}
            error={forecastError}
            loading={weather.loading}
            onRefresh={() => {
              if (engine.error) window.location.reload();
              else weather.refresh();
            }}
            signal={engine.forecast?.map((item) => item.score)}
            stale={grid?.stale}
          />
        )}
      </div>
      <aside
        className="location-pane"
        aria-label={props.routes ? "Directions" : "Location details"}
      >
        {props.routes ? (
          <RoutePlanner
            susceptibility={persistent}
            selection={props.selection}
            units={props.units}
            now={weather.now}
            live={mode === "live"}
            timelineHour={playback.hour}
            times={times}
            pins={
              !persistent && mode === "live"
                ? props.workspace.ready
                  ? props.workspace.community
                  : props.workspace.error
                    ? "failed"
                    : "pending"
                : EMPTY_PINS
            }
            riverFor={persistent ? riskRiver : rivers.forRoute}
            riverLabel={rivers.routeLabel}
            rainAt={persistent ? noRain : rainAt}
            forecast={
              forecastError
                ? "failed"
                : engine.scoring || (!persistent && !grid)
                  ? "loading"
                  : "ready"
            }
            cellsAt={engine.cellsAt}
            scoreCells={engine.scoreCells}
            scores={engine.scores}
            onDisplay={displayRoute}
            onClose={props.onCloseRoute}
            onFocusPoint={(point) =>
              props.onSelect(
                { ...point, label: "Route location", address: "Selected route location" },
                16,
              )
            }
          />
        ) : (
          <LocationSummary
            persistent={persistent}
            susceptibilityScore={engine.riskScore}
            label={props.selection.label}
            town={townLabel}
            cell={engine.cell}
            forecast={selectedForecast}
            hour={playback.hour}
            onHour={playback.selectHour}
            weather={localWeather}
            now={weather.now}
            live={mode === "live"}
            loading={
              (persistent
                ? engine.scoring || engine.cellStatus === "loading"
                : !engine.index ||
                  !grid ||
                  engine.cellStatus === "loading" ||
                  (!!engine.cell?.static && !selectedForecast)) && !forecastError
            }
            error={forecastError}
            units={props.units}
            onSave={props.onSave}
            onReport={props.onReport}
            onRoute={props.onRoute}
            alerts={alerts.alerts}
            alertsLoading={alerts.loading}
            alertsUnavailable={alerts.unavailable}
            saved={saved}
            replayStorm={REPLAY_STORM[mode]}
          >
            {rivers.pointDepth &&
              (rivers.pointDepth.here.length > 0 || rivers.pointDepth.near.length > 0) &&
              !persistent && (
                <details className="summary-details">
                  <summary>
                    River water depth
                    <ChevronDown size={14} />
                  </summary>
                  <DepthSection
                    here={rivers.pointDepth.here}
                    near={rivers.pointDepth.near}
                    hours={rivers.timeline}
                    hour={playback.hour}
                    onHour={playback.selectHour}
                    units={props.units}
                    live={mode === "live"}
                    validation={rivers.depth?.validation}
                  />
                </details>
              )}
            {rivers.error && <p className="inline-error">{rivers.error}</p>}
          </LocationSummary>
        )}
      </aside>
    </section>
  );
}
