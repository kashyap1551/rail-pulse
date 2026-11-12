# Rail Pulse

A one-page live map of every train in Finland that reports its position, refreshed every 15 seconds from Fintraffic's free open data. Portfolio project.

## Product
- Direction: v1 is a live map (foundation). The product's intended core, built in v2 if the mock-up test passes, is "now vs a normal evening". See docs/PRD.md.
- Data: `GET https://rata.digitraffic.fi/api/v1/train-locations/latest` (no key). Each train has `trainNumber`, `departureDate`, `timestamp`, `speed` (km/h), `location.coordinates` as **[longitude, latitude]** (longitude first).
- Refresh every 15 s (far under the 60 requests/min limit). Refreshing pauses while the tab is hidden. Do not add custom request headers to the REST calls. The one exception is the GraphQL type lookup, a POST that needs `Content-Type: application/json` (see docs/decisions.md).
- Credits on the map: "Trains: Fintraffic / digitraffic.fi (CC BY 4.0)", "Track lines: Fintraffic / digitraffic.fi (CC BY 4.0), simplified" (in both, "Fintraffic / digitraffic.fi" links to https://www.digitraffic.fi and "CC BY 4.0" to the licence) and "© OpenStreetMap contributors © CARTO". They must always be fully visible (CARTO's free terms); OpenStreetMap links to https://www.openstreetmap.org/copyright and CARTO to https://carto.com/attribution/.
- Screen: full-screen dark map (one world only, no repeat) opening on Finland. One marker per train, coloured by type in five groups (InterCity & Pendolino cyan, Express & night violet, Commuter & regional white, Cargo magenta, Service & other grey): moving = glowing orb/arrow showing heading, stopped = small hollow square in the train's colour, no glow. The card and route panel still name the exact type. Trains glide between updates. Click a train: card with type badge, route progress, speed, delay, next stop; "View full route" closes the card and opens a stop-by-stop panel in its place (one profile at a time) and draws the route on the map along the rail network, dashed where it cannot be matched. Small panel: trains reporting, trains moving, fastest train and its speed, last-updated time, plus a legend with counts (click to hide/show). At the top of the panel: "Right now: X% on time · Y% 1–4 min · Z% 5+ min late" for passenger trains (long-distance and commuter; trains with no delay yet are left out); under 20 trains it shows the total once and counts ("8 passenger trains: 4 on time · 1 late 1–4 min · 3 late 5+ min"). A switch colours trains by Type or Delay (the legend follows). Moving trains have a fading one-minute tail, visible when zoomed in. A key line and an "i" button next to Moving explain the markers and what "Moving" means. A pulse line chart shows trains moving since the page opened. The card's Copy link gives `?train=DATE-NUMBER`; opening it centres the map on that train and opens its card. On phones, swipe the route sheet down to close it; tap targets are at least 44 px.
- If a refresh fails: keep the last data on screen and show "Couldn't load data, retrying…".
- Look: dark teal-and-black. CARTO dark tiles tinted with a CSS filter, near-black glass panels, light text. Colour is reserved for train types (neon) and delay (green/amber/red). Type colours are the five groups above and must not be green or amber/red; the magenta for cargo is the one deliberate exception to "no pink" and is close to the delay red, which only shows on the map in Delay mode. Legend swatches are bars, never circles.
- Data: positions from the REST feed; train types and delays from one GraphQL request (POST, about once a minute; see docs/decisions.md); per-train route from /trains/{date}/{number}.
- Rail network: `data/rail-network.json` (188 KB), made by `node tools/build-rail-network.js` from Digitraffic's track lines and 8 days of timetables (only lines trains use; no yards). The page draws it faint under the trains and routes each train along it (shortest way between neighbouring timetable points, once per train); the done/ahead split snaps the train onto the line. If the file cannot load (page opened as a plain file) routes are dashed straight lines: use Live Server or `python3 -m http.server`.
- "Updated" in the panel is the newest train report time; a warning shows if it is over 2 minutes old. Health counters are in memory only: `railPulseHealth()` in the console.
- Link preview: Open Graph and Twitter tags in `index.html` with `preview.jpg` (1200 × 630), on the live URL https://kashyap1551.github.io/rail-pulse/.
- CARTO key: `CARTO_KEY_LIVE` is to be restricted to kashyap1551.github.io in CARTO's dashboard; `CARTO_KEY_LOCAL` (empty until the user makes a second key) is used on localhost/127.0.0.1. Tiles send `referrerPolicy: "strict-origin-when-cross-origin"`.
- Open decisions: terrain map source (see docs/decisions.md findings). Rail lines are decided: Digitraffic.

## Stack (v1)
Plain HTML, CSS, JS in three files: `index.html`, `style.css`, `app.js`, plus the data file `data/rail-network.json`. Leaflet 1.9.4 from unpkg. Dark map tiles (see decisions.md for the current tile source). No frameworks, no build tools, no npm packages for the page. `tools/` holds a one-off Node script (built-in modules only) that the page never loads. Hosted on GitHub Pages.

## Plan
Part 1 (done): opportunity assessment, PRD.
Part 2:
1. index.html skeleton + style.css (done)
2. Full-screen Leaflet map of Finland, dark tiles, both credits
3. Fetch once, log train count + one example train
4. One dot per train, popup with number and speed
5. Stats panel
6. 15-second refresh without piling up dots, plus error message
7. Polish: phone, contrast, zoom buttons don't cover panel
8. Git: init, .gitignore, commits, repo `rail-pulse`, push, GitHub Pages, check live link, then add Open Graph link-preview tags (they need the live URL)
9. README.md as a short product case study (problem, user, key decisions, what I'd do next)

## How we work
- Claude makes all the edits. No exercises, quizzes or "make this change yourself" tasks.
- Explain each step in 2–3 lines: what was built and why, so the user can talk about it in an interview.
- Steps 2–7 are built in one go, then stop and tell the user exactly what to check in the browser. Stop again before anything that needs the user's GitHub login.
- Keep docs/decisions.md and docs/PRD.md up to date. Add a decision row whenever we choose between options. No learning log.
- From Step 8 on, commit after each step with a short, clear message.
- Never run `git push` or anything needing GitHub login: give the exact command; the user runs it in the VS Code terminal.
- Ask before installing anything.
- Anything beyond v1 goes in the Later list below, not into the build.

## Where we left off (12 Nov 2026)
- Built, tested in headless Chrome and documented: everything in the Product section above. Latest batch (12 Nov): one profile at a time, five type colours, hollow-square stopped trains and bar legend swatches, status line with counts and three bands, GraphQL size in `railPulseHealth()`, and the accurate route lines (rail network, per-train routing, split). PRD is version 9; docs/decisions.md has a row for every choice and a findings entry with the route-accuracy numbers.
- Still open: terrain map source (never chosen); testing on a real phone and Safari; a daytime check of the GraphQL answer size (`railPulseHealth()`); re-run `node tools/build-rail-network.js` now and then (new freight branches).
- Git: pushed and live at https://kashyap1551.github.io/rail-pulse/ (12 Nov). Later commits (link preview, CARTO key split, docs) are local until the user pushes; Claude never pushes. Commit identity is set for this repo only (not `--global`): check with `git config --local user.name` and `user.email`. If the email is empty, ask for it; never use the user's real email or guess one. Commits end with the Claude co-author line (the user chose to keep it). Files were checked for personal details before publishing; keep them out of anything committed. `tools/.cache/` is git-ignored.
- Then: the user pushes the latest commits, makes the second CARTO key and restricts the live one (then Claude checks with curl: tiles 200 with the live site as referrer, refused without it), tests on a phone, re-scrapes the link preview; Step 9 (README.md case study).
- `app.js` contains the user's public CARTO key on the `CARTO_KEY` line. Never print or replace it.

## Later
- v2: "now vs a normal evening" comparison (share of trains delayed tonight vs a typical evening). History source is confirmed (see docs/decisions.md). Build only if the mock-up test passes.
- Transport-journalist segment.
