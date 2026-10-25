import { ArrowUpRight, Bookmark, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Place } from "@/lib/types";
import type { WorkspaceController } from "@/hooks/use-workspace";

export default function PlacesPage({
  workspace,
  onSelect,
}: {
  workspace: WorkspaceController;
  onSelect: (place: Place) => void;
}) {
  async function remove(id: string) {
    try {
      await workspace.deletePlace(id);
    } catch {
      toast.error("Place could not be removed.");
    }
  }
  return (
    <section className="content-page">
      <header className="page-heading">
        <div>
          <h1>Saved places</h1>
        </div>
      </header>
      {!workspace.places.length && (
        <div className="empty-state">
          <Bookmark size={25} />
          <h2>No saved places</h2>
          <p>Bookmark a place on the map.</p>
        </div>
      )}
      <div className="workspace-list">
        {workspace.places.map((place) => (
          <div className="place-row" key={place.id}>
            <button onClick={() => onSelect(place)}>
              <Bookmark size={18} />
              <span>
                <strong>{place.label}</strong>
                <small>{place.address}</small>
              </span>
              <ArrowUpRight size={15} />
            </button>
            <button
              className="icon-button"
              aria-label={`Remove ${place.label}`}
              onClick={() => void remove(place.id)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
