# Rail-line source comparison (research, 11 Nov 2026)

These scripts produced the Digitraffic vs OpenStreetMap numbers in `docs/decisions.md` (Findings section). They are research, not part of the app: nothing in `index.html`, `app.js` or `style.css` uses them.

- `lib.js`: converts ETRS-TM35FIN metres to longitude/latitude, simplifies lines (Douglas-Peucker, tolerance in metres), rounds to 5 decimals, measures size and length. This is the part a future converter would reuse.
- `digitraffic.js`: reads the Digitraffic download, converts it, reports sizes at 0/10/25/50 m tolerance. Run as `node digitraffic.js <work-folder>`.
- `osm.js`: reads the OpenStreetMap download, reports sizes, and checks how well the two sources agree within 150 m.
- `osm-query.txt`: the Overpass query used (`railway=rail` without a `service` tag, Finland).

The scripts expect their work folder to hold the raw downloads (about 12 MB and 11 MB), which are not kept here:

- Digitraffic: `https://rata.digitraffic.fi/infra-api/0.7/radat.geojson` saved as `<work-folder>/radat.json`. (Asking the API for latitude/longitude directly with `srsName=crs:84` returned a 503, so the conversion is done by `lib.js`.)
- OpenStreetMap: send `osm-query.txt` to the Overpass API and save the result as `<work-folder>/rail/osm-main.json`. Overpass asked for a descriptive User-Agent.

Status: decided on 12 Nov 2026. Digitraffic was used; the real converter is `tools/build-rail-network.js` (it has its own coordinate conversion and simplification, so these scripts are no longer needed by it). These are kept only as the record of the 11 Nov comparison in docs/decisions.md.
