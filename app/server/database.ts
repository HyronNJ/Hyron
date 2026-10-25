import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import type { Place, PublicPin, Report } from "@/lib/types";

export const dataDirectory = resolve(process.env.HYRON_DATA_DIR ?? ".local");
mkdirSync(dataDirectory, { recursive: true });
const photos = resolve(dataDirectory, "photos");
mkdirSync(photos, { recursive: true });

export async function readPhoto(id: string) {
  return readFile(resolve(photos, `${id}.jpg`)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}
export const writePhoto = (id: string, photo: Uint8Array) =>
  writeFile(resolve(photos, `${id}.jpg`), photo);
export const deletePhoto = (id: string) => rm(resolve(photos, `${id}.jpg`), { force: true });

const database = new DatabaseSync(resolve(dataDirectory, "hyron.sqlite"));
database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reports_owner ON reports(owner);
  CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS places_owner ON places(owner);
`);

type StoredRow = { data: string };

export function listReports(owner: string): Report[] {
  const rows = database
    .prepare("SELECT data FROM reports WHERE owner = ? ORDER BY rowid DESC LIMIT 100")
    .all(owner);
  return rows.map((row) => JSON.parse((row as StoredRow).data) as Report);
}

export function findReport(owner: string, id: string): Report | null {
  const row = database
    .prepare("SELECT data FROM reports WHERE owner = ? AND id = ?")
    .get(owner, id) as StoredRow | undefined;
  return row ? (JSON.parse(row.data) as Report) : null;
}

export function saveReport(owner: string, report: Report) {
  database
    .prepare(
      "INSERT INTO reports (id, owner, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE reports.owner = excluded.owner",
    )
    .run(report.id, owner, JSON.stringify(report));
}

export function deleteReport(owner: string, id: string) {
  database.prepare("DELETE FROM reports WHERE owner = ? AND id = ?").run(owner, id);
}

export function listPlaces(owner: string): Place[] {
  const rows = database
    .prepare("SELECT data FROM places WHERE owner = ? ORDER BY rowid DESC")
    .all(owner);
  return rows.map((row) => JSON.parse((row as StoredRow).data) as Place);
}

export function savePlace(owner: string, place: Place) {
  database
    .prepare(
      "INSERT INTO places (id, owner, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE places.owner = excluded.owner",
    )
    .run(place.id, owner, JSON.stringify(place));
}

export function deletePlace(owner: string, id: string) {
  database.prepare("DELETE FROM places WHERE owner = ? AND id = ?").run(owner, id);
}

export function communityPins(): PublicPin[] {
  const cutoff = Date.now() - 72 * 60 * 60 * 1000;
  const rows = database
    .prepare(
      "SELECT data FROM reports WHERE json_extract(data, '$.publicPin') = 1 ORDER BY rowid DESC LIMIT 200",
    )
    .all();
  return rows
    .map((row) => JSON.parse((row as StoredRow).data) as Report)
    .filter((report) => Date.parse(report.createdAt) >= cutoff)
    .map((report) => ({
      id: report.id,
      category: report.category,
      municipality: report.municipality,
      lat: Math.round(report.lat * 1000) / 1000,
      lng: Math.round(report.lng * 1000) / 1000,
      createdAt: report.createdAt,
      waterLevel: report.waterLevel ?? null,
    }));
}
