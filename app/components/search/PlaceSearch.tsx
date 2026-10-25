import { useEffect, useRef, useState } from "react";
import { LocateFixed, Search, X } from "lucide-react";
import { searchPlaces, townMatches, type SearchResult } from "@/lib/search";
import type { Coord } from "@/lib/types";

type Props = { near: Coord; onSelect: (place: SearchResult) => void; onLocate: () => void };

export default function PlaceSearch({ near, onSelect, onLocate }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const nearRef = useRef(near);
  nearRef.current = near;

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setActive(0);
    setError("");
    if (query.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setResults(townMatches(query));
    setLoading(true);
    const timer = setTimeout(() => {
      searchPlaces(query, nearRef.current, controller.signal, (places, done) => {
        if (controller.signal.aborted) return;
        setResults(places);
        setLoading(!done);
      }).catch(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setError("Search unavailable. Select the map instead.");
        }
      });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  function choose(place: SearchResult) {
    onSelect(place);
    setQuery("");
    setOpen(false);
  }

  return (
    <div
      className="place-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <Search size={17} />
      <input
        ref={input}
        placeholder="Find a place"
        value={query}
        aria-label="Search places"
        role="combobox"
        aria-expanded={open}
        aria-controls="place-results"
        aria-autocomplete="list"
        aria-activedescendant={results[active] ? `search-${active}` : undefined}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => Math.min(results.length - 1, index + 1));
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(0, index - 1));
          }
          if (event.key === "Enter" && results[active]) choose(results[active]);
        }}
      />
      {query ? (
        <button className="icon-button" aria-label="Clear search" onClick={() => setQuery("")}>
          <X size={14} />
        </button>
      ) : (
        <kbd>⌘ K</kbd>
      )}
      {open && (
        <div className="search-results">
          <button
            className="search-locate"
            onClick={() => {
              onLocate();
              setOpen(false);
            }}
          >
            <LocateFixed size={15} />
            Use my location
          </button>
          <div id="place-results" role="listbox" aria-label="Places">
            {results.map((place, index) => (
              <button
                id={`search-${index}`}
                key={`${place.lat},${place.lng}-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(place)}
              >
                <strong>{place.label}</strong>
                <small>{place.address}</small>
              </button>
            ))}
          </div>
          {loading && <p role="status">Searching…</p>}
          {error && <p role="alert">{error}</p>}
          {!loading && !error && query.length >= 2 && !results.length && (
            <p>No matches. Try adding a town.</p>
          )}
        </div>
      )}
    </div>
  );
}
