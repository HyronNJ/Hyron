import type { Prefs } from "@/lib/prefs";
import type { Coord } from "@/lib/types";
import PlaceInput from "@/components/routes/RoutePlaceInput";

type Units = "imperial" | "metric";
type Place = Coord & { label: string; address: string };
type Props = {
  units: Units;
  onUnits: (units: Units) => void;
  prefs: Prefs;
  onPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  /** The place the map opens at under "My place", once one is chosen. */
  startPlace: Place | null;
  onStartPlace: (place: Place) => void;
  /** The place selected on the map now, offered as a quick choice. */
  selection: Place;
};

/** A segmented radio group: every option is clickable, and the arrow keys move the choice. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = options.findIndex(([option]) => option === value);
    const next = (index + step + options.length) % options.length;
    onChange(options[next][0]);
    (event.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  }
  return (
    <div
      className="segmented pref-choice"
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          tabIndex={value === option ? 0 : -1}
          className={value === option ? "active" : ""}
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Row({
  title,
  note,
  children,
  more,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
  more?: React.ReactNode;
}) {
  return (
    <div className="pref-row">
      <div className="pref-head">
        <div>
          <h3>{title}</h3>
          <p>{note}</p>
        </div>
        {children}
      </div>
      {more}
    </div>
  );
}

/** The Preferences dialog body. Every choice takes effect and is saved on this device at once. */
export default function Preferences({
  units,
  onUnits,
  prefs,
  onPref,
  startPlace,
  onStartPlace,
  selection,
}: Props) {
  return (
    <div className="prefs">
      <Row title="Appearance" note="Auto follows your device's light or dark setting.">
        <Choice
          label="Appearance"
          value={prefs.theme}
          options={[
            ["system", "Auto"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
          onChange={(theme) => onPref("theme", theme)}
        />
      </Row>
      <Row title="Units" note="Rain and depth in inches, or in millimeters and centimeters.">
        <Choice
          label="Units"
          value={units}
          options={[
            ["imperial", "Imperial"],
            ["metric", "Metric"],
          ]}
          onChange={onUnits}
        />
      </Row>
      <Row
        title="Motion"
        note="Reduce turns off map fly-overs, smooth playback and shimmer. Auto follows your device."
      >
        <Choice
          label="Motion"
          value={prefs.motion}
          options={[
            ["system", "Auto"],
            ["reduce", "Reduce"],
          ]}
          onChange={(motion) => onPref("motion", motion)}
        />
      </Row>
      <Row
        title="Open the map at"
        note="Where the map starts the next time you open Hyron."
        more={
          prefs.start === "place" && (
            <div className="pref-place">
              <PlaceInput
                label="My place"
                value={startPlace}
                keepValue
                onChange={(place) => {
                  if (place) onStartPlace({ ...place, address: place.address ?? "" });
                }}
                near={startPlace ?? selection}
                selection={selection}
                placeholder="Search for a place, like home or school"
              />
            </div>
          )
        }
      >
        <Choice
          label="Open the map at"
          value={prefs.start}
          options={[
            ["place", "My place"],
            ["last", "Last place"],
          ]}
          onChange={(start) => onPref("start", start)}
        />
      </Row>
      <p className="quiet-note">Saved on this device. Official alerts keep their source wording.</p>
    </div>
  );
}
