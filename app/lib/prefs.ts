import type { Coord } from "@/lib/types";

/** Preferences saved on this device (units keep their own older "hyron-units" key). */
export type Theme = "system" | "light" | "dark";
export type Motion = "system" | "reduce";
/** "place": the place chosen in Preferences (the app's usual start until one is chosen). */
export type Start = "place" | "last";
export type Prefs = { theme: Theme; motion: Motion; start: Start; idaInvite: boolean };
export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  motion: "system",
  start: "place",
  idaInvite: true,
};

const KEY = "hyron-prefs",
  LAST_PLACE = "hyron-last-place",
  START_PLACE = "hyron-start-place";
const DARK_QUERY = "(prefers-color-scheme: dark)",
  MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function loadPrefs(): Prefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      theme: p.theme === "light" || p.theme === "dark" ? p.theme : "system",
      motion: p.motion === "reduce" ? "reduce" : "system",
      start: p.start === "last" ? "last" : "place",
      idaInvite: p.idaInvite !== false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}
export function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {}
}

/** Whether a theme setting means dark right now ("system" follows the device). */
export const isDark = (theme: Theme) =>
  theme === "dark" ||
  (theme === "system" && typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches);
export function subscribeDeviceTheme(onChange: () => void) {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Sets data-theme and data-motion on <html>, which the stylesheet keys on. */
export function applyPrefs(prefs: Prefs) {
  const root = document.documentElement;
  root.dataset.theme = isDark(prefs.theme) ? "dark" : "light";
  if (prefs.motion === "reduce") root.dataset.motion = "reduce";
  else delete root.dataset.motion;
}
/** The same as applyPrefs, inlined in <head> so a saved dark theme never flashes light on load. */
export const PREFS_SCRIPT = `try{var d=document.documentElement,p=JSON.parse(localStorage.getItem('${KEY}')||'{}');d.dataset.theme=p.theme==='dark'||(p.theme!=='light'&&matchMedia('${DARK_QUERY}').matches)?'dark':'light';if(p.motion==='reduce')d.dataset.motion='reduce'}catch(e){}`;

/** Reduce motion when the setting or the device asks for it. */
export const reducedMotion = () =>
  typeof window !== "undefined" &&
  (document.documentElement.dataset.motion === "reduce" || window.matchMedia(MOTION_QUERY).matches);

type Place = Coord & { label: string; address: string };
function savePlace(key: string, place: Place) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        lat: place.lat,
        lng: place.lng,
        label: place.label,
        address: place.address,
      }),
    );
  } catch {}
}
function loadPlace(key: string): Place | null {
  try {
    const p = JSON.parse(localStorage.getItem(key) ?? "null");
    return p &&
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lng) &&
      typeof p.label === "string" &&
      typeof p.address === "string"
      ? p
      : null;
  } catch {
    return null;
  }
}
export const saveLastPlace = (place: Place) => savePlace(LAST_PLACE, place);
export const loadLastPlace = () => loadPlace(LAST_PLACE);
/** The place chosen under Preferences → Open the map at → My place. */
export const saveStartPlace = (place: Place) => savePlace(START_PLACE, place);
export const loadStartPlace = () => loadPlace(START_PLACE);
