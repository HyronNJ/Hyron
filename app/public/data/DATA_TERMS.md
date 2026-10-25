# Data attribution

Statewide map (`app/public/data/nj/`): USGS 3DEP elevation (public domain), NLCD 2021 impervious surface and land cover (MRLC, public domain), and NJ OGIS municipal boundaries, retrieved 2026-10-12. Live weather: Open-Meteo forecast API (CC BY 4.0). Address and place search: Photon by komoot, using OpenStreetMap data © OpenStreetMap contributors (ODbL).

## New Jersey model

The app's flood signal is trained on public New Jersey data only:

- Flood insurance claims: FEMA OpenFEMA, *FIMA NFIP Redacted Claims* (v2), retrieved 2026-10-13. Public domain. This product uses the FEMA OpenFEMA API, but is not endorsed by FEMA. Claims are allocated to 2020 Census block groups; tidal-overflow claims are excluded.
- Flood zones: FEMA National Flood Hazard Layer (map service, retrieved 2026-10-13), public domain.
- Block groups and housing units: U.S. Census Bureau TIGERweb (2010 and 2020 block groups, 2020 counts), public domain.
- Past-storm rain: Iowa Environmental Mesonet reanalysis (IEMRE) of NCEP Stage IV radar/gauge precipitation, hourly, sampled at the 81 Hyron weather points. Also used for the Ida and September 2023 replays.
- Terrain: the same USGS 3DEP and NLCD 2021 grids as the statewide map, summarized over each whole ~280 m area.

## Map layers and routes

- Where water goes (`nj/w/`): derived from the same USGS 3DEP elevation (public domain).
- Brook and river flood maps (`nj/rivers.json`): USGS Flood Inundation Mapper flood extents for the Hohokus Brook (USGS Scientific Investigations Report 2015-5064) and the Saddle River (Scientific Investigations Map 3299), USGS continuous gauge heights (USGS Water Data APIs) and NOAA National Water Prediction Service flood categories and impact statements, retrieved 2026-10-18. Public domain. Live levels come from the National Water Prediction Service at run time.
- Modeled water depth (`nj/depth.json`, Ridgewood pilot): USGS depth grids for the Hohokus Brook (SIR 2015-5064) and the Saddle River (SIM 3299), downloaded from the reports' pages on 2026-10-18; checked against USGS Short-Term Network high-water marks from Ida with ground elevations from the USGS 3DEP Elevation Point Query Service. Public domain.
- Replay comparison (`nj/truth.json`) and per-storm claims (`nj/claims.json`): FEMA OpenFEMA NFIP claims as above.
- Routes: Valhalla routing on the FOSSGIS servers, using OpenStreetMap data © OpenStreetMap contributors (ODbL), requested from the viewer's browser under the FOSSGIS usage terms (at most one request per second, attribution shown).
