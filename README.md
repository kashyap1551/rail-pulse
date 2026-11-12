# Rail Pulse

**Live: https://kashyap1551.github.io/rail-pulse/**

A live map of every train in Finland that reports its position, refreshed every 15 seconds from Fintraffic's open data, with a one-line answer to "how is the network doing right now?".

![Rail Pulse: live trains on a dark map of Finland, next to the status panel](docs/screenshot.png)

## Problem

People who follow Finland's railways can't tell at a glance whether trains across the whole country are running normally right now, especially during storms or strikes. *(A hypothesis, not yet confirmed with users.)*

Live train maps already exist: VR's own map and independent sites show where every train is. What none of them says is whether tonight is worse than a normal evening, or by how much. A plain live map would only duplicate them, so this project treats the map as the foundation and that comparison as the product's real goal.

## User

A rail enthusiast on a winter evening when the news reports heavy snow, opening the page on their phone to see how much of the network is still moving. Transport journalists are the next segment, not this version.

## Key decisions

Every choice, with the alternatives and the reasons, is in [docs/decisions.md](docs/decisions.md). The requirements are in [docs/PRD.md](docs/PRD.md). The main ones:

- **Narrow, don't duplicate.** Version 1 is the live map plus a "right now" status line; the "tonight vs a normal evening" comparison is version 2, built only if a small user test passes.
- **No backend, no cost.** The page calls Digitraffic's open data straight from the browser and is hosted free on GitHub Pages. No accounts, cookies or analytics.
- **One small request for train types and delays.** A single GraphQL query (about 10 to 20 KB) instead of the full live-train feed (about 8.5 MB), asked about once a minute.
- **An honest status line.** It counts passenger trains only, always shows all three delay bands so they add up (on time, 1–4 min late, 5+ min late), and shows counts instead of percentages when fewer than 20 trains are running ("1 of 3" is not "33%").
- **Colour that reads at a glance.** Five type colours, because only about five stay clearly apart on a map and for colour-blind viewers; green, amber and red are kept for delay only. Moving trains are arrows, stopped trains hollow squares.
- **Routes that follow the real track.** A one-off script turned Digitraffic's 8,840 km of track data, yards and sidings included, into the 5,312 km of line that a week of real timetables actually uses (a 188 KB file). Each train's route is joined station by station along it.
- **Fail visibly, never blank.** If a refresh fails the last data stays on screen with a "retrying" note, and a warning appears if the data itself is more than two minutes old.

## What I tested

- **Route accuracy against real journeys.** The routes of 18 trains from 11 Nov 2026 were rebuilt and compared with every position those trains reported: all 323 station-to-station legs matched the track. For a commuter, an InterCity and a cargo train, the route line ran a median 5.0, 0.4 and 4.0 m from the reported positions, and each route was within 1% of the distance the train actually travelled.
- **Coverage of the network.** Of the positions reported by 52 moving trains, 99% of long-distance, 98% of cargo and 96% of commuter positions lie within 30 m of the drawn lines. What is left is inside station yards, which are left out on purpose.
- **Behaviour in a browser** (Chrome, desktop and phone size with touch): one train profile at a time, colour and legend filters, the status line with 1, 8, 19, 20 and 23 trains, every tap target at least 44 px, swipe-to-close on the route sheet, share links (running, finished and made-up trains), and routes falling back to dashed lines if the track file can't load.
- **Not yet tested:** a real phone, and Safari.

## What I'd do next

Build the core question: **is the network worse than a normal evening right now, and by how much?** For example: "Tonight 23% of trains are delayed, vs 8% on a normal Tuesday evening" (example numbers). Digitraffic already publishes each day's trains with scheduled and actual times going back years, so a "normal evening" can be worked out without storing any history.

Before building it, run the smallest test of the riskiest assumption (that enthusiasts want this at all): show a mock-up to 5 rail enthusiasts on English-language rail forums, after asking about the last disruption they followed. It passes if 3 of the 5 describe a real moment it would have helped.

## How it's built

Plain HTML, CSS and JavaScript in three files (`index.html`, `style.css`, `app.js`) with [Leaflet](https://leafletjs.com) for the map, plus the track file `data/rail-network.json`. No frameworks or build step. To run it locally, serve the folder with any local web server (for example VS Code's Live Server); opening `index.html` as a plain file blocks the track file. To rebuild the track file: `node tools/build-rail-network.js` (Node's built-in modules only).

Built with Claude Code. My role was the product decisions, scope and testing.

## Data and licences

- **Trains** (positions, timetables, types, delays) and **track lines**: Fintraffic / [digitraffic.fi](https://www.digitraffic.fi), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The track lines are simplified from the original.
- **Map tiles:** © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (map data under the ODbL) © [CARTO](https://carto.com/attribution/).
- **Map library:** [Leaflet](https://leafletjs.com) 1.9.4 (BSD 2-Clause licence).
