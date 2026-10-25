export default function AboutPage() {
  return (
    <article className="content-page about-page">
      <header className="page-heading">
        <h1>About Hyron</h1>
      </header>
      <section>
        <h2>Flood risk</h2>
        <dl className="about-facts">
          <div>
            <dt>Model</dt>
            <dd>Gradient-boosted trees</dd>
          </div>
          <div>
            <dt>Inputs</dt>
            <dd>Rainfall, terrain, paving, flow paths, flood zones</dd>
          </div>
          <div>
            <dt>Training</dt>
            <dd>9,643 non-tidal FEMA claims · 19 storms · 2017–2025</dd>
          </div>
          <div>
            <dt>Scale</dt>
            <dd>Relative susceptibility, not current flooding</dd>
          </div>
        </dl>
      </section>
      <section>
        <h2>The lasting map</h2>
        <ul className="about-notes">
          <li>19 historical storm profiles, applied equally to each area.</li>
          <li>Prepared once from the trained model; independent of today’s rain.</li>
          <li>Higher colors mean greater relative susceptibility across New Jersey.</li>
          <li>Directions compare distance through Moderate and High areas.</li>
          <li>Rain outlook and storm replays retain hourly conditions.</li>
        </ul>
      </section>
      <section>
        <h2>Replays and water maps</h2>
        <ul className="about-notes">
          <li>Ida and September 2023: reconstructed radar rain.</li>
          <li>Replay models exclude that storm; colors are tuned across all storms.</li>
          <li>Ridgewood: USGS river depths for two mapped reaches.</li>
          <li>Unknown future river levels remain unknown.</li>
        </ul>
      </section>
      <section>
        <h2>Limits</h2>
        <ul className="about-notes">
          <li>No blocked-drain, sewer, snowmelt, or coastal-surge model.</li>
          <li>Claims miss uninsured flooding; forecast rain can change.</li>
          <li>Follow official guidance. Never enter floodwater.</li>
        </ul>
      </section>
      <section>
        <h2>Your data</h2>
        <ul className="about-notes">
          <li>Reports and saved places are private to this browser.</li>
          <li>Keep this browser’s cookie to retain access.</li>
          <li>Shared pins omit photos and notes; they do not train the model.</li>
          <li>Photo location data is removed; category suggestions run on your device.</li>
          <li>You review and send municipal email drafts.</li>
          <li>Search and routing use public location providers.</li>
        </ul>
      </section>
      <section>
        <h2>Public data</h2>
        <div className="source-links">
          <a
            href="https://www.fema.gov/openfema-data-page/fima-nfip-redacted-claims-v2"
            target="_blank"
            rel="noreferrer"
          >
            FEMA · flood claims and flood zones
          </a>
          <a href="https://www.usgs.gov/3d-elevation-program" target="_blank" rel="noreferrer">
            USGS · elevation, river maps, and gauges
          </a>
          <a href="https://mesonet.agron.iastate.edu/iemre/" target="_blank" rel="noreferrer">
            NCEP Stage IV / Iowa Environmental Mesonet · past rain
          </a>
          <a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">
            Open-Meteo · live weather
          </a>
          <a href="https://www.weather.gov/" target="_blank" rel="noreferrer">
            National Weather Service · official alerts
          </a>
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap · places and routes
          </a>
        </div>
        <p className="quiet-note">Independent project · No FEMA, USGS, or NOAA endorsement.</p>
      </section>
    </article>
  );
}
