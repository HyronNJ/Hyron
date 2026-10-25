import { useEffect, useState, useSyncExternalStore } from "react";
import { Bookmark, CircleHelp, FileText, Map, SlidersHorizontal } from "lucide-react";
import { Toaster, toast } from "sonner";
import Modal from "@/components/Modal";
import ReportForm from "@/components/reports/ReportForm";
import { inNJ } from "@/lib/nj";
import { loadBoundaries, townInfoAt } from "@/lib/geo";
import {
  applyPrefs,
  isDark,
  loadLastPlace,
  loadPrefs,
  loadStartPlace,
  saveLastPlace,
  saveStartPlace,
  savePrefs,
  subscribeDeviceTheme,
  type Prefs,
} from "@/lib/prefs";
import type { Coord, Report } from "@/lib/types";
import Preferences from "@/components/Preferences";
import PlaceSearch from "@/components/search/PlaceSearch";
import MapWorkspace, { type MapFocus, type SelectedPlace } from "@/components/map/MapWorkspace";
import { useWorkspace } from "@/hooks/use-workspace";
import ReportsPage, { ReportEditor } from "@/components/reports/ReportsPage";
import PlacesPage from "@/components/places/PlacesPage";
import AboutPage from "@/components/AboutPage";

type Page = "map" | "places" | "reports" | "about";
const initial: SelectedPlace = {
  lat: 40.8867,
  lng: -74.0442,
  label: "Downtown Hackensack",
  address: "Hackensack, New Jersey",
};
const navigation = [
  { id: "map", label: "Map", icon: Map },
  { id: "places", label: "Places", icon: Bookmark },
  { id: "reports", label: "Reports", icon: FileText },
] as const;

export default function App() {
  const [page, setPage] = useState<Page>("map");
  const [directions, setDirections] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  // "Open the map at" reopens zoomed in on the chosen place or the last place picked, if it is
  // in New Jersey; with no place chosen yet the map opens as usual.
  const [startPlace, setStartPlace] = useState(loadStartPlace);
  const [start] = useState(() => {
    const place = prefs.start === "last" ? loadLastPlace() : startPlace;
    return place && inNJ(place) ? place : null;
  });
  const [selection, setSelection] = useState<SelectedPlace>(start ?? initial);
  const [focus, setFocus] = useState<MapFocus | null>(start && { ...start, zoom: 15, key: 0 });
  const [modal, setModal] = useState<"save" | "report" | "prefs" | null>(null);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [newReport, setNewReport] = useState<Report | null>(null);
  const [units, setUnits] = useState<"imperial" | "metric">(() => {
    try {
      return localStorage.getItem("hyron-units") === "metric" ? "metric" : "imperial";
    } catch {
      return "imperial";
    }
  });
  const workspace = useWorkspace();
  // Auto follows the device, so a change there re-renders and re-applies the theme.
  const dark = useSyncExternalStore(
    subscribeDeviceTheme,
    () => isDark(prefs.theme),
    () => false,
  );

  useEffect(() => {
    void loadBoundaries().catch(() => toast.error("Town boundaries could not load."));
  }, []);
  useEffect(() => {
    applyPrefs(prefs);
    savePrefs(prefs);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? "#0d131d" : "#f7f8fa");
  }, [prefs, dark]);
  useEffect(() => {
    if (prefs.start === "last") saveLastPlace(selection);
  }, [prefs.start, selection]);

  function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
    setPrefs((current) => ({ ...current, [key]: value }));
  }

  function changeUnits(next: "imperial" | "metric") {
    setUnits(next);
    try {
      localStorage.setItem("hyron-units", next);
    } catch {
      /* Preferences can be unavailable in private browsing. */
    }
  }

  function choosePlace(place: SelectedPlace, zoom?: number, flat = false) {
    if (!inNJ(place)) {
      toast("Choose a place in New Jersey.");
      return;
    }
    setSelection(place);
    if (zoom) setFocus({ ...place, zoom, key: Date.now(), flat });
  }

  function locate() {
    if (!navigator.geolocation) {
      toast.error("Location is unavailable. Search for a place instead.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point: Coord = { lat: position.coords.latitude, lng: position.coords.longitude };
        if (!inNJ(point)) {
          toast("Your location is outside New Jersey. Choose a place on the map.");
          return;
        }
        const town = townInfoAt(point)?.name ?? "New Jersey";
        // Recentering on the user always returns to the flat, north-up map.
        choosePlace({ ...point, label: "My location", address: town }, 15, true);
        setPage("map");
      },
      () => toast("Location unavailable. Search or choose a place on the map."),
      { timeout: 10_000, maximumAge: 60_000 },
    );
  }

  async function savePlace(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await workspace.savePlace({ ...selection, label: label.trim() });
      setModal(null);
      toast.success("Place saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Place could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="hyron-app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main navigation">
        <button className="brand" aria-label="Hyron outlook" onClick={() => setPage("map")}>
          <img
            className="brand-wordmark"
            src={dark ? "/brand/hyron-wordmark-light.png" : "/brand/hyron-wordmark.svg"}
            alt=""
          />
          <img className="brand-mark" src="/brand/icon-64.png" alt="" />
        </button>
        <div className="nav-items">
          {navigation.map((item) => (
            <button
              key={item.id}
              aria-label={item.label}
              className={page === item.id ? "active" : ""}
              onClick={() => setPage(item.id)}
              aria-current={page === item.id ? "page" : undefined}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button
            aria-label="About"
            className={page === "about" ? "active" : ""}
            onClick={() => setPage("about")}
          >
            <CircleHelp size={18} />
            <span>About</span>
          </button>
          <button
            className="prefs-button"
            aria-label="Preferences"
            aria-haspopup="dialog"
            onClick={() => setModal("prefs")}
          >
            <SlidersHorizontal size={15} />
            <span>Preferences</span>
          </button>
        </div>
      </nav>
      <div className="app-body">
        <header className="app-header">
          <PlaceSearch
            near={selection}
            onSelect={(place) => {
              setDirections(false);
              choosePlace(place, place.kind === "place" ? 13 : 16);
              setPage("map");
            }}
            onLocate={locate}
          />
          <button
            className="icon-button header-prefs"
            aria-label="Preferences"
            aria-haspopup="dialog"
            onClick={() => setModal("prefs")}
          >
            <SlidersHorizontal size={18} />
          </button>
        </header>
        {workspace.error && (
          <div className="workspace-error" role="alert">
            <span>{workspace.error}</span>
            <button onClick={() => void workspace.reload()}>Retry</button>
          </div>
        )}
        <main id="main" className="main-content">
          <MapWorkspace
            hidden={page !== "map"}
            routes={directions}
            selection={selection}
            focus={focus}
            onSelect={choosePlace}
            onLocate={locate}
            onCloseRoute={() => setDirections(false)}
            onRoute={() => setDirections(true)}
            workspace={workspace}
            units={units}
            dark={dark}
            onSave={() => {
              setLabel(selection.label);
              setModal("save");
            }}
            onReport={() => setModal("report")}
          />
          {page === "places" && (
            <PlacesPage
              workspace={workspace}
              onSelect={(place) => {
                setDirections(false);
                choosePlace(place, 15);
                setPage("map");
              }}
            />
          )}
          {page === "reports" && (
            <ReportsPage workspace={workspace} onCreate={() => setModal("report")} />
          )}
          {page === "about" && <AboutPage />}
        </main>
      </div>
      {modal === "save" && (
        <Modal title="Save place" onClose={() => setModal(null)}>
          <form className="simple-form" onSubmit={(event) => void savePlace(event)}>
            <p>{selection.address}</p>
            <label>
              Name
              <input
                autoFocus
                required
                maxLength={80}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <div className="button-row">
              {["Home", "School", "Work"].map((preset) => (
                <button
                  className="secondary-button"
                  type="button"
                  key={preset}
                  onClick={() => setLabel(preset)}
                >
                  {preset}
                </button>
              ))}
            </div>
            <footer className="button-row">
              <button type="button" className="secondary-button" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button className="primary-button" disabled={saving || !workspace.ready}>
                {saving ? "Saving…" : "Save place"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {modal === "report" && (
        <ReportForm
          point={selection}
          address={selection.address}
          onClose={() => setModal(null)}
          onCreated={(report) => {
            void workspace.reload();
            setModal(null);
            setPage("reports");
            setNewReport(report);
            toast.success("Report saved. Review your email draft.");
          }}
        />
      )}
      {modal === "prefs" && (
        <Modal title="Preferences" onClose={() => setModal(null)}>
          <Preferences
            units={units}
            onUnits={changeUnits}
            prefs={prefs}
            onPref={setPref}
            startPlace={startPlace}
            onStartPlace={(place) => {
              if (!inNJ(place)) {
                toast("Choose a place in New Jersey.");
                return;
              }
              setStartPlace(place);
              saveStartPlace(place);
            }}
            selection={selection}
          />
        </Modal>
      )}
      {newReport && (
        <ReportEditor report={newReport} workspace={workspace} onClose={() => setNewReport(null)} />
      )}
      <Toaster position="bottom-center" closeButton theme={dark ? "dark" : "light"} />
    </div>
  );
}
