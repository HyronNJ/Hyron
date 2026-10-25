import { useCallback, useEffect, useState } from "react";
import { request } from "@/lib/api";
import type { Place, PublicPin, Report } from "@/lib/types";

type Workspace = { places: Place[]; reports: Report[]; community: PublicPin[] };
const empty: Workspace = { places: [], reports: [], community: [] };

export function useWorkspace() {
  const [data, setData] = useState<Workspace>(empty);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    try {
      setData(await request<Workspace>("/api/workspace"));
      setReady(true);
      setError("");
    } catch {
      setError("Saved places and reports could not load.");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void request<{ community: PublicPin[] }>("/api/community")
        .then((result) => setData((current) => ({ ...current, community: result.community })))
        .catch(() => setError("Neighbor reports could not refresh."));
    }, 120_000);
    return () => clearInterval(timer);
  }, []);

  async function savePlace(place: Omit<Place, "id">) {
    await request("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(place),
    });
    await reload();
  }

  async function deletePlace(id: string) {
    await request(`/api/places?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await reload();
  }

  async function updateReport(id: string, changes: Partial<Report>) {
    const result = await request<{ report: Report }>(`/api/reports/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
    await reload();
    return result.report;
  }

  async function deleteReport(id: string) {
    await request(`/api/reports/${id}`, { method: "DELETE" });
    await reload();
  }

  return { ...data, ready, error, reload, savePlace, deletePlace, updateReport, deleteReport };
}

export type WorkspaceController = ReturnType<typeof useWorkspace>;
