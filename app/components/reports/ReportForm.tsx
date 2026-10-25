import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  ImagePlus,
  LocateFixed,
  LoaderCircle,
  MapPin,
  ShieldCheck,
  Sparkles,
  X,
  Search,
} from "lucide-react";
import Modal from "@/components/Modal";
import { categories } from "@/lib/reports";
import { WATER_LEVELS } from "@/lib/community";
import { loadBoundaries, municipalityAt } from "@/lib/geo";
import { searchPlaces, type SearchResult } from "@/lib/search";
import type { Coord, Report, ReportCategory, WaterLevel } from "@/lib/types";

export default function ReportForm({
  point,
  address,
  onClose,
  onCreated,
}: {
  point: Coord;
  address: string;
  onClose: () => void;
  onCreated: (report: Report) => void;
}) {
  const [, setTownsLoaded] = useState(false);
  useEffect(() => {
    void loadBoundaries()
      .then(() => setTownsLoaded(true))
      .catch(() => {});
  }, []);
  const [location, setLocation] = useState(point),
    [locationLabel, setLocationLabel] = useState(address),
    [category, setCategory] = useState<ReportCategory>("Blocked drain");
  const [note, setNote] = useState(""),
    [safe, setSafe] = useState(false),
    [locationConfirmed, setLocationConfirmed] = useState(false),
    [publicPin, setPublicPin] = useState(false),
    [photo, setPhoto] = useState<File | null>(null),
    [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [analyzing, setAnalyzing] = useState(false),
    [analysisProgress, setAnalysisProgress] = useState(0),
    [suggested, setSuggested] = useState(false),
    [analysisNote, setAnalysisNote] = useState("");
  const [search, setSearch] = useState(""),
    [searching, setSearching] = useState(false),
    [results, setResults] = useState<SearchResult[]>([]);
  const [waterLevel, setWaterLevel] = useState<WaterLevel | null>(null);
  const fileInput = useRef<HTMLInputElement>(null),
    worker = useRef<Worker | null>(null),
    chosenManually = useRef(false),
    photoGeneration = useRef(0);
  useEffect(
    () => () => {
      worker.current?.terminate();
    },
    [],
  );

  async function choosePhoto(file: File) {
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file.");
      return;
    }
    if (file.size > 20_000_000) {
      setError("Choose a photo smaller than 20 MB.");
      return;
    }
    const generation = ++photoGeneration.current;
    worker.current?.terminate();
    setAnalyzing(false);
    setError("");
    setSuggested(false);
    setAnalysisNote("");
    try {
      const image = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Photo could not be prepared");
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      image.close();
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Photo could not be prepared"))),
          "image/jpeg",
          0.85,
        ),
      );
      if (generation !== photoGeneration.current) return;
      const jpg = new File([blob], "hyron-report.jpg", { type: "image/jpeg" });
      setPhoto(jpg);
      setPreview(canvas.toDataURL("image/jpeg", 0.65));
      setAnalyzing(true);
      setAnalysisProgress(0);
      chosenManually.current = false;
      const task = new Worker("/photo-worker.js", { type: "module" });
      worker.current = task;
      task.onmessage = (event) => {
        if (generation !== photoGeneration.current) return;
        if (event.data.type === "progress")
          setAnalysisProgress(Math.round(event.data.progress ?? 0));
        if (event.data.type === "result") {
          setAnalyzing(false);
          setAnalysisNote(
            event.data.category === "Other"
              ? "Choose the issue type that fits what you saw."
              : "Photo suggestion · you can change it",
          );
          if (!chosenManually.current && event.data.category !== "Other") {
            setCategory(event.data.category);
            setSuggested(true);
          }
          task.terminate();
        }
        if (event.data.type === "error") {
          setAnalyzing(false);
          setAnalysisNote("Photo analysis is unavailable. Choose the issue type below.");
          task.terminate();
        }
      };
      task.onerror = () => {
        setAnalyzing(false);
        setAnalysisNote("Choose the issue type below. Your photo is ready to attach.");
        task.terminate();
      };
      task.postMessage({ image: canvas.toDataURL("image/jpeg", 0.65) });
    } catch {
      setAnalyzing(false);
      setError("This image couldn’t be opened. Try a JPEG or PNG photo.");
    }
  }
  function removePhoto() {
    photoGeneration.current++;
    worker.current?.terminate();
    setPhoto(null);
    setPreview(null);
    setAnalyzing(false);
    setSuggested(false);
    setAnalysisNote("");
  }
  async function searchLocation() {
    if (search.trim().length < 3) return;
    setSearching(true);
    setError("");
    try {
      const found = await searchPlaces(
        search.trim(),
        location,
        new AbortController().signal,
        () => {},
      );
      setResults(found);
      if (!found.length)
        setError(
          "No New Jersey address found. Use your location or the point selected on the map.",
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Address search is unavailable.");
    } finally {
      setSearching(false);
    }
  }
  function locate() {
    if (!navigator.geolocation) {
      setError("Location isn’t supported in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const next = { lat: p.coords.latitude, lng: p.coords.longitude };
        const town = municipalityAt(next);
        if (!town) {
          setError(
            "Reporting is available in New Jersey. Select a New Jersey location on the map.",
          );
          return;
        }
        setLocation(next);
        setLocationConfirmed(false);
        setLocationLabel(`Selected location in ${town}`);
      },
      () =>
        setError("Location permission wasn’t available. Use the map location or search instead."),
      { timeout: 10000 },
    );
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set(
        "data",
        JSON.stringify({
          ...location,
          address: locationLabel,
          category,
          description: note,
          publicPin,
          safeLocation: safe,
          locationConfirmed,
          waterLevel: category === "Street flooding" ? waterLevel : null,
        }),
      );
      if (photo) form.set("photo", photo);
      const response = await fetch("/api/reports", { method: "POST", body: form });
      const data = (await response.json()) as { error?: string; report: Report };
      if (!response.ok) throw new Error(data.error);
      onCreated(data.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Your report couldn’t be saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Report a street issue" onClose={onClose} wide>
      <form onSubmit={submit} className="report-form">
        <div className="report-columns">
          <div>
            <input
              className="visually-hidden"
              ref={fileInput}
              type="file"
              accept="image/*"
              aria-label="Choose a report photo"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void choosePhoto(file);
                e.currentTarget.value = "";
              }}
            />
            {preview ? (
              <div className="photo-preview">
                <img src={preview} alt="Your report photo" />
                <button
                  type="button"
                  className="photo-remove"
                  aria-label="Remove photo"
                  onClick={removePhoto}
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="photo-drop"
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files[0];
                  if (file) void choosePhoto(file);
                }}
              >
                <span>
                  <ImagePlus size={28} />
                </span>
                <strong>Add a photo</strong>
                <small>Optional · Choose or drop here</small>
              </button>
            )}
            {analyzing && (
              <div className="photo-analysis">
                <Sparkles size={15} />
                <span>
                  {analysisProgress > 0
                    ? `Preparing photo analysis · ${analysisProgress}%`
                    : "Preparing private photo analysis…"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    worker.current?.terminate();
                    setAnalyzing(false);
                    setAnalysisNote("Photo is ready. Choose the issue type below.");
                  }}
                >
                  Skip
                </button>
              </div>
            )}
            {analysisNote && (
              <p className="analysis-note">
                <Sparkles size={13} />
                {analysisNote}
              </p>
            )}
            <label className="field-label" htmlFor="category">
              What did you notice? {suggested && <span>Suggested from photo</span>}
            </label>
            <select
              id="category"
              value={category}
              onChange={(e) => {
                chosenManually.current = true;
                setCategory(e.target.value as ReportCategory);
                setSuggested(false);
              }}
            >
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            {category === "Street flooding" && (
              <fieldset className="water-level">
                <legend className="field-label">How deep was the water on the road?</legend>
                <div>
                  {WATER_LEVELS.map((l) => (
                    <label key={l.id} className={waterLevel === l.id ? "selected" : ""}>
                      <input
                        type="radio"
                        name="water-level"
                        value={l.id}
                        checked={waterLevel === l.id}
                        onChange={() => setWaterLevel(l.id)}
                      />
                      <span>{l.short}</span>
                    </label>
                  ))}
                </div>
                <small>Never enter water to check.</small>
              </fieldset>
            )}
            <label className="field-label" htmlFor="report-note">
              Details
            </label>
            <textarea
              id="report-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              minLength={5}
              maxLength={1500}
              required
              placeholder="What did you see?"
              rows={4}
            />
          </div>
          <div>
            <div className="field-label">Location</div>
            <div className="location-confirm">
              <MapPin size={19} />
              <div>
                <strong>{locationLabel}</strong>
                <small>
                  {municipalityAt(location) ?? "Choose a New Jersey location"} ·{" "}
                  {location.lat.toFixed(4)}, {location.lng.toFixed(4)}
                </small>
              </div>
              {locationConfirmed && <Check size={16} />}
            </div>
            <label className="checkbox-row location-check">
              <input
                type="checkbox"
                checked={locationConfirmed}
                onChange={(e) => setLocationConfirmed(e.target.checked)}
              />
              <span>This is where I saw the issue.</span>
            </label>
            <div className="search-inline">
              <input
                aria-label="Search report address"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search a different address"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void searchLocation();
                  }
                }}
              />
              <button
                type="button"
                aria-label="Search report location"
                onClick={() => void searchLocation()}
              >
                {searching ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />}
              </button>
            </div>
            {results.length > 0 && (
              <div className="inline-results">
                {results.map((r, i) => (
                  <button
                    type="button"
                    key={i}
                    onClick={() => {
                      if (!municipalityAt(r)) {
                        setError("Choose an address in New Jersey.");
                        return;
                      }
                      setLocation(r);
                      setLocationConfirmed(false);
                      setLocationLabel(r.address || r.label);
                      setResults([]);
                      setSearch("");
                    }}
                  >
                    <MapPin size={14} />
                    <span>
                      {r.label}
                      <small>{r.address}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="text-button locate-report" onClick={locate}>
              <LocateFixed size={15} /> Use my location
            </button>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={publicPin}
                onChange={(e) => setPublicPin(e.target.checked)}
              />
              <span>
                Share an approximate pin
                <small>Your photo and note stay private.</small>
              </span>
            </label>
            <label className="checkbox-row safe-check">
              <input
                type="checkbox"
                required
                checked={safe}
                onChange={(e) => setSafe(e.target.checked)}
              />
              <span>I’m reporting from a safe location.</span>
            </label>
          </div>
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <span>
            <ShieldCheck size={14} /> Photo location data removed
          </span>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || !safe || !locationConfirmed || note.trim().length < 5}
          >
            {busy ? <LoaderCircle size={16} className="spin" /> : <ChevronRight size={16} />}{" "}
            {busy ? "Saving your report…" : "Save & review email"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
