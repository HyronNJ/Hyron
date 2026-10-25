import { useEffect, useState } from "react";
import { LoaderCircle, LocateFixed, MapPin } from "lucide-react";
import { searchPlaces, type SearchResult } from "@/lib/search";
import { inNJ } from "@/lib/nj";
import type { Coord } from "@/lib/types";

type End = Coord & { label: string; address?: string };

export default function RoutePlaceInput({
  label,
  value,
  onChange,
  near,
  selection,
  placeholder,
  keepValue = false,
}: {
  label: string;
  value: End | null;
  onChange: (e: End | null) => void;
  near: Coord;
  selection: End;
  placeholder: string;
  /** Typing doesn't clear the chosen place, and leaving the box without choosing shows it again. */
  keepValue?: boolean;
}) {
  // While typing, the box shows the typed text; otherwise the chosen place's name.
  const [text, setText] = useState(""),
    [editing, setEditing] = useState(false),
    [found, setFound] = useState<{ q: string; results: SearchResult[]; done: boolean }>({
      q: "",
      results: [],
      done: true,
    }),
    [error, setError] = useState("");
  const [locating, setLocating] = useState(false);
  const id = label.replace(/\s+/g, "-");
  const [open, setOpen] = useState(false),
    q = text.trim(),
    searching = editing && open && q.length >= 2;
  useEffect(() => {
    if (!searching) return;
    const c = new AbortController();
    const t = setTimeout(() => {
      void searchPlaces(q, near, c.signal, (r, done) => {
        if (!c.signal.aborted) setFound({ q, results: r.slice(0, 6), done });
      }).catch(() => {
        if (!c.signal.aborted) setFound({ q, results: [], done: true });
      });
    }, 250);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [q, searching]);
  const results = searching && found.q === q ? found.results : [],
    busy = searching && !(found.q === q && found.done);
  const choose = (e: End) => {
    onChange(e);
    setEditing(false);
    setOpen(false);
    setError("");
  };
  function locate() {
    if (!navigator.geolocation) {
      setError("Location isn’t available in this browser.");
      return;
    }
    setLocating(true);
    setError("");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false);
        const here = { lat: p.coords.latitude, lng: p.coords.longitude };
        if (!inNJ(here)) {
          setError("Your location is outside New Jersey.");
          return;
        }
        choose({ ...here, label: "My location" });
      },
      () => {
        setLocating(false);
        setError("Location permission wasn’t available.");
      },
      { timeout: 10000 },
    );
  }
  return (
    <div
      className="route-end"
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setOpen(false);
        if (keepValue) setEditing(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <label className="route-label" htmlFor={`route-${id}`}>
        {label}
      </label>
      <div className="route-input">
        <input
          id={`route-${id}`}
          value={editing ? text : (value?.label ?? "")}
          placeholder={placeholder}
          autoComplete="off"
          aria-expanded={open}
          aria-controls={`route-${id}-options`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // Inside a dialog, the first Escape only closes the suggestions.
              if (keepValue && open) event.preventDefault();
              setEditing(false);
              setOpen(false);
            }
          }}
          onFocus={(event) => {
            setText(value?.label ?? "");
            setEditing(true);
            setOpen(true);
            if (keepValue) event.currentTarget.select();
          }}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            if (value && !keepValue) onChange(null);
          }}
        />
        {busy && <LoaderCircle size={13} className="spin" />}
      </div>
      {open && (
        <div className="route-options" id={`route-${id}-options`}>
          {searching && !busy && results.length === 0 && <p>No places found.</p>}
          {results.map((r) => (
            <button
              key={`${r.lat},${r.lng},${r.label}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose({ lat: r.lat, lng: r.lng, label: r.label, address: r.address })}
            >
              <MapPin size={13} />
              <span>
                <strong>{r.label}</strong>
                <small>{r.address}</small>
              </span>
            </button>
          ))}
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => choose(selection)}>
            <MapPin size={13} />
            <span>
              <strong>Selected place</strong>
              <small>{selection.label}</small>
            </span>
          </button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={locate} disabled={locating}>
            {locating ? <LoaderCircle size={13} className="spin" /> : <LocateFixed size={13} />}
            <span>
              <strong>{locating ? "Locating…" : "My location"}</strong>
            </span>
          </button>
        </div>
      )}
      {error && <p className="route-error">{error}</p>}
    </div>
  );
}
