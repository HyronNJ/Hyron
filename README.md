# Hyron

A New Jersey flood-risk map with directions, saved places and maintenance reports. The default map shows relative susceptibility; hourly rain outlooks and historical storm replays are also available.

[Open Hyron](https://hyron.us)

## Run

Requires Node.js 22.13 or newer.

```sh
cd app
npm ci
npm run dev
```

Open http://127.0.0.1:5175. For production, run `npm run build` followed by `npm start` and open http://127.0.0.1:3001.

Cloudflare Pages builds `app/` with `npm run build` and serves `dist/`. Pushes to `main` deploy automatically. Pages Functions use D1 for records and Workers KV for photos; bindings are in `app/wrangler.jsonc`. Initialize the database with `npx wrangler d1 execute hyron --remote --file schema.sql` from `app/`.

The app includes its prepared models and map data. Local records and photos are stored in ignored `app/.local/`. Each browser has its own workspace; clearing its cookie loses access to those records. Reports prepare an email draft for the resident to send.

## Code

Everything needed to run Hyron is in `app/`:

- `components/`: interface grouped by feature.
- `hooks/` and `lib/`: browser state, model inference and geographic calculations.
- `server/`: API, provider requests and SQLite storage.
- `functions/`: Cloudflare Pages API entry point.
- `workers/`: forecast scoring and on-device photo suggestions.
- `styles/`, `data/` and `public/`: appearance and prepared assets.

`npm run check` checks types. `npm run format` formats source code. Optional server settings are `HOST`, `PORT` and `HYRON_DATA_DIR`.

`engine/` contains the Python source behind the maps: [model training](engine/model.py), [terrain features](engine/terrain.py), [map tiles](engine/tiles.py), [persistent susceptibility](engine/susceptibility.py), [replay evaluation](engine/evaluate.py), and river/depth processing. Browser inference is in [app/lib/nj-model.ts](app/lib/nj-model.ts).

Compact source data is included in `engine/data/`. Python dependencies are listed in `engine/requirements.txt`; large terrain rasters and intermediate caches are not bundled. The app runs from its prepared assets without running the engine.

## License

Original code is licensed under [Apache 2.0](LICENSE). Data, models, fonts and bundled libraries retain their own terms; see [data attribution](app/public/data/DATA_TERMS.md) and the licenses alongside bundled assets.
