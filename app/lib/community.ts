import type { Coord, WaterLevel } from "@/lib/types";

/** What a neighbor saw on the road, worst last. Only for street flooding reports. */
export const WATER_LEVELS: { id: WaterLevel; label: string; short: string }[] = [
  { id: "puddles", label: "Puddles, the road is passable", short: "Puddles" },
  { id: "over-curb", label: "Water over the curb", short: "Over the curb" },
  { id: "lane-covered", label: "Water covering a lane", short: "Lane covered" },
  { id: "impassable", label: "Road under water, impassable", short: "Road impassable" },
];
export const levelInfo = (id?: WaterLevel | null) => WATER_LEVELS.find((l) => l.id === id) ?? null;
export const levelRank = (id?: WaterLevel | null) =>
  id ? WATER_LEVELS.findIndex((l) => l.id === id) + 1 : 0;

/** Pins stay on the map for a day: full strength for 3 hours, then fading as the report ages. */
export const PIN_HOURS = 24;
export function pinFade(createdAt: string, now: number): number {
  const h = (now - Date.parse(createdAt)) / 3.6e6;
  if (!Number.isFinite(h)) return 0;
  if (h <= 3) return 1;
  if (h >= PIN_HOURS) return 0;
  return 1 - ((h - 3) / (PIN_HOURS - 3)) * 0.75;
}
export function ago(createdAt: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(createdAt)) / 60000));
  if (m < 2) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : h < 48 ? "yesterday" : `${Math.round(h / 24)} days ago`;
}
/** Ground distance in meters (accurate to well under 1% across New Jersey). */
export function distance(a: Coord, b: Coord): number {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lng - b.lng) * k, a.lat - b.lat) * 111_320;
}
