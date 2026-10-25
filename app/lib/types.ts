import type { FeatureCollection } from "geojson";

export type MapLayer = "outlook" | "ground";
/** A square outline on the map (the selected 280 m area). */
export type Area = { id: string; lng: number; lat: number; dx: number; dy: number };
/** GeoJSON overlays drawn above the flood signal. */
export type WaterOverlay = { lines: FeatureCollection; spots: FeatureCollection };
export type RouteOverlay = { lines: FeatureCollection; flags: FeatureCollection };

export type Coord = { lat: number; lng: number };
/** Block-group claims, flood zones and drainage height. */
export type FloodRecord = {
  floodplain: number;
  floodplain500: number;
  claims: number;
  homes: number;
  lowGround: number;
  blockGroup: number | null;
};
export type Cell = {
  id: string;
  lat: number;
  lng: number;
  elevation: number;
  slope: number;
  lowPoint: number;
  impervious: number;
  municipality: string;
  water: boolean;
  static?: (number | null)[] | null;
  record?: FloodRecord;
  col?: number;
  row?: number;
  w?: number;
  county?: string;
};
/** A 280 m statewide area summary (8 x 8 cells) showing its strongest representative cells. */
export type Block = {
  id: string;
  col: number;
  row: number;
  lat: number;
  lng: number;
  elevation: number;
  municipality: string;
  county: string;
  reps: Cell[];
};
export type WeatherSeries = {
  rain: number[];
  temperature: number[];
  probability: (number | null)[];
};
/** Hourly weather at a statewide grid of points sharing one time axis. */
export type WeatherGrid = {
  points: Coord[];
  times: string[];
  series: WeatherSeries[];
  fetchedAt: string;
  source: string;
  sourceUrl: string;
  stale: boolean;
  mode: "live" | "replay";
  label?: string;
  timelineStart?: string;
};
export type WeatherHour = {
  time: string;
  rain: number;
  temperature: number;
  probability: number | null;
  soilMoisture: number | null;
};
export type WeatherData = {
  hours: WeatherHour[];
  fetchedAt: string;
  source: string;
  sourceUrl: string;
  stale: boolean;
  location: Coord;
  mode: "live" | "replay";
  label?: string;
  timelineStart?: string;
};
export type Place = Coord & { id: string; label: string; address: string };
export type ReportCategory =
  | "Blocked drain"
  | "Street flooding"
  | "Debris or obstruction"
  | "Erosion or road damage"
  | "Other";
export type Report = Coord & {
  id: string;
  category: ReportCategory;
  description: string;
  address: string;
  municipality: string;
  hasPhoto: boolean;
  status: "draft_ready" | "marked_sent" | "resolved";
  publicPin: boolean;
  createdAt: string;
  updatedAt: string;
  recipient: string | null;
  emailSubject: string;
  emailBody: string;
  waterLevel?: WaterLevel | null;
};
/** How deep the reporter saw water on the road (street flooding reports only). */
export type WaterLevel = "puddles" | "over-curb" | "lane-covered" | "impassable";
export type PublicPin = Coord & {
  id: string;
  category: ReportCategory;
  municipality: string;
  createdAt: string;
  waterLevel?: WaterLevel | null;
};
export type Alert = {
  id: string;
  event: string;
  headline: string;
  description: string;
  severity: string;
  expires: string;
  sourceUrl: string;
};
