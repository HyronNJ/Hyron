import type { Place, Report } from "@/lib/types";
import type { WorkspaceStore } from "@/server/workspace";

export function cloudflareStore(env: Env): WorkspaceStore {
  const list = async <T>(sql: string, ...values: string[]) => {
    const { results } = await env.DB.prepare(sql)
      .bind(...values)
      .all<{ data: string }>();
    return results.map((row) => JSON.parse(row.data) as T);
  };
  const save = (table: "reports" | "places", owner: string, record: Report | Place) =>
    env.DB.prepare(
      `INSERT INTO ${table} (id, owner, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE ${table}.owner = excluded.owner`,
    )
      .bind(record.id, owner, JSON.stringify(record))
      .run();
  const remove = (table: "reports" | "places", owner: string, id: string) =>
    env.DB.prepare(`DELETE FROM ${table} WHERE owner = ? AND id = ?`).bind(owner, id).run();
  return {
    listReports: (owner) =>
      list<Report>("SELECT data FROM reports WHERE owner = ? ORDER BY rowid DESC LIMIT 100", owner),
    findReport: async (owner, id) =>
      (await list<Report>("SELECT data FROM reports WHERE owner = ? AND id = ?", owner, id))[0] ??
      null,
    saveReport: (owner, report) => save("reports", owner, report),
    deleteReport: (owner, id) => remove("reports", owner, id),
    listPlaces: (owner) =>
      list<Place>("SELECT data FROM places WHERE owner = ? ORDER BY rowid DESC", owner),
    savePlace: (owner, place) => save("places", owner, place),
    deletePlace: (owner, id) => remove("places", owner, id),
    communityPins: async () => {
      const reports = await list<Report>(
        "SELECT data FROM reports WHERE json_extract(data, '$.publicPin') = 1 ORDER BY rowid DESC LIMIT 200",
      );
      return reports
        .filter((report) => Date.parse(report.createdAt) >= Date.now() - 72 * 60 * 60 * 1000)
        .map((report) => ({
          id: report.id,
          category: report.category,
          municipality: report.municipality,
          lat: Math.round(report.lat * 1000) / 1000,
          lng: Math.round(report.lng * 1000) / 1000,
          createdAt: report.createdAt,
          waterLevel: report.waterLevel ?? null,
        }));
    },
    readPhoto: (id) => env.PHOTOS.get(id, "arrayBuffer"),
    writePhoto: (id, photo) => env.PHOTOS.put(id, photo),
    deletePhoto: (id) => env.PHOTOS.delete(id),
  };
}
