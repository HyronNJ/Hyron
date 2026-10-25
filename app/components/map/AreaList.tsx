import { ArrowUpRight } from "lucide-react";
import type { Block } from "@/lib/types";
import type { TileScores } from "@/hooks/use-statewide";
import { riskLevel } from "@/lib/format";

type Area = { id: string; label: string; county: string; lat: number; lng: number; score: number };
type Props = {
  tiles: TileScores[];
  blocks: Block[] | null;
  scores: Float32Array | null;
  hour: number;
  detail: boolean;
  persistent?: boolean;
  onSelect: (area: Area) => void;
};

export default function AreaList(props: Props) {
  const candidates: Area[] = props.detail
    ? props.tiles.flatMap((tile) =>
        tile.cells.map((cell, index) => ({
          id: cell.id,
          label: cell.municipality,
          county: cell.county ?? "",
          lat: cell.lat,
          lng: cell.lng,
          score:
            tile.scores?.[(props.persistent ? 0 : props.hour * tile.cells.length) + index] ?? -1,
        })),
      )
    : (props.blocks ?? []).map((block, index, blocks) => ({
        id: block.id,
        label: block.municipality,
        county: block.county,
        lat: block.lat,
        lng: block.lng,
        score: props.scores?.[(props.persistent ? 0 : props.hour * blocks.length) + index] ?? -1,
      }));

  // Show one area per town, so the list isn't filled with near-identical entries.
  const towns = new Set<string>();
  const areas = candidates
    .filter((area) => area.score >= 0)
    .sort((a, b) => b.score - a.score)
    .filter((area) => {
      const key = `${area.label},${area.county}`;
      if (towns.has(key)) return false;
      towns.add(key);
      return true;
    })
    .slice(0, 30);

  return (
    <section className="area-list">
      <header>
        <h2>{props.persistent ? "Relative flood risk" : "Explore areas"}</h2>
        {!props.persistent && (
          <p>
            {props.detail
              ? "Highest signal by town in this view."
              : "Highest signal by town across New Jersey."}
          </p>
        )}
      </header>
      {!areas.length && <p role="status">Waiting for map data.</p>}
      {areas.map((area) => {
        const level = props.persistent
          ? area.score >= 65
            ? { band: "high", label: "High" }
            : area.score >= 38
              ? { band: "moderate", label: "Moderate" }
              : { band: "low", label: "Lower" }
          : riskLevel(area.score);
        return (
          <button key={area.id} onClick={() => props.onSelect(area)}>
            <span>
              <strong>{area.label.replace(/, .*$/, "")}</strong>
              <small>{area.county} County</small>
            </span>
            <span className={`risk-pill ${level.band}`}>{level.label}</span>
            <ArrowUpRight size={15} />
          </button>
        );
      })}
    </section>
  );
}
