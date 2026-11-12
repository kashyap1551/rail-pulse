# Rail Pulse: PRD

Version 9 · 12 Nov 2026 · Based on my opportunity assessment (docs/opportunity-assessment.md)

## Problem
People who follow Finland's railways can't tell at a glance whether trains across the whole country are running normally right now, especially during storms or strikes. (Hypothesis, not yet confirmed with real users.)

## User
A rail enthusiast following Finland's railways, on a winter evening when the news reports heavy snow or a storm, opening it on their phone to see how much of the network is still moving. Transport journalists are the next segment, not v1.

## Why a plain live map isn't enough
VR's "On track" page, Fintraffic's traffic-situation page and independent sites like Junat Kartalla and junaan.fi already show live trains. My guess (unconfirmed): none of them says whether tonight is worse than a normal evening, or by how much. That comparison is the intended core of the product.

## Scope and direction
- v1 (this build): a live map with a "right now" network status. It is the foundation and my learning path. It says how the network is doing now, but not whether that is worse than a normal evening, so it does not yet answer the core question.
- v2: the "now vs a normal evening" view, built if the smallest test (below) passes.

## Must-haves (v1)
1. Full-screen dark map of Finland, one dot per train reporting a position.
2. Trains are coloured by type, in five colour groups that stay clearly apart on a map: InterCity & Pendolino (cyan), Express & night (violet), Commuter & regional (white), Cargo (magenta), Service & other and type unknown (grey). The card and route panel still name the exact type (e.g. "Pendolino", "Regional"). Type colours never use the delay colours (green, amber, red). Moving trains glow and show an arrow pointing the way they travel; stopped trains are a small hollow square outlined in the train's colour, with no glow.
3. Clicking a train opens a card: type badge, train name and operator, origin to destination with a progress bar, speed, delay, next stop and last report time (Finnish time), plus a "View full route" button. Only one profile shows at a time: "View full route" closes the card and opens the route panel in its place, and clicking any train (including the same one) closes the panel and opens that train's card.
4. Stats panel: trains reporting, trains moving, fastest train and its speed (named the same way as on the card, e.g. "S 42"), and the time of the newest train report in the data (Finnish time).
5. Refresh every 15 seconds; trains glide smoothly to their new position and markers never pile up. Refreshing pauses while the tab is hidden and resumes at once when it is visible again.
6. On a failed refresh, keep the last data and show "Couldn't load data, retrying…". Also show a warning when the newest train report in the data is more than 2 minutes old, even if the refresh itself worked.
7. Credits on the map, fully visible at all times (CARTO's free terms require them): "Trains: Fintraffic / digitraffic.fi (CC BY 4.0)", "Track lines: Fintraffic / digitraffic.fi (CC BY 4.0), simplified" and "© OpenStreetMap contributors © CARTO". In both Digitraffic credits "Fintraffic / digitraffic.fi" links to https://www.digitraffic.fi and "CC BY 4.0" to https://creativecommons.org/licenses/by/4.0/ (Digitraffic's terms ask for both); OpenStreetMap links to its copyright page and CARTO to its attribution page. Nothing (route panel, cards) may cover them.
8. Works on a phone, readable contrast. Zoom buttons don't cover the panel, and a train card always opens clear of the panel and the zoom buttons.
9. Hosted free on GitHub Pages.
10. Dark teal-and-black look: teal-tinted dark map, near-black glass panels, light text. Colour is reserved for train types (neon) and for delay (green on time, amber late, red 5+ minutes late). Type colours are the five groups in item 2 (cyan, violet, white, magenta, grey), none of them green, amber or red.
11. The map shows one world only: no repeated worlds, and zooming out stops there.
12. Legend in the stats panel: the five type colour groups, each shown as a small bar in its colour (never a circle, so a circle only ever means a train marker) with a live count of all trains. Clicking a group hides or shows those trains. The panel can be collapsed (it starts collapsed on phones).
13. Full route panel (side panel on a computer, bottom sheet on a phone): the same identity as the card (icon, train name such as "T 3493", type and operator such as "Cargo · VR", origin → destination), speed and delay, a "Copy link" button, and every stop with track, scheduled and actual or expected times and delay, the next stop highlighted. The route is drawn on the map (travelled part dim, part ahead glowing) and other trains fade back.
14. Network status at the top of the panel, for passenger trains only (long-distance and commuter): "Right now: 81% on time · 12% 1–4 min late · 7% 5+ min late" (example numbers), always with all three bands so they add up (to 100%, or to the train count), plus a thin bar. With fewer than 20 trains counted it shows the total once and counts instead of percentages ("8 passenger trains: 4 on time · 1 late 1–4 min · 3 late 5+ min"), because "1 of 3" is not "33%". Same bands as the delay colours: on time (0 min or early), 1–4 min late, 5+ min late. Trains with no delay yet (not departed) are left out, and a short note says which trains are counted. The legend counts every train on the map and says "all trains". Delays refresh about once a minute. It describes the network right now; it does not compare with a normal evening (v2).
15. A switch in the panel, "Colour trains by: Type | Delay". In Delay mode every train is green, amber or red by its delay (grey if there is no delay data), and the legend switches to the delay bands with live counts. Clicking a band hides or shows those trains, like the type legend.
16. A short fading tail behind each moving train showing about its last minute, in the train's current colour. It stays attached to the gliding marker, disappears when the train stops, follows the legend filters, and fades with the other trains when a route is open. It only shows when zoomed in (about regional level and closer), because a minute of travel is under a pixel at national zoom. The page must stay smooth on a phone.
17. The map explains itself: a one-line key under the legend, "▲ Moving · □ Stopped", drawn with the real arrow and hollow square and valid in both Type and Delay mode, and an "i" button next to Moving that opens, by click or tap, the note "Trains with speed above 0 km/h. Numbers drop sharply at night, when most passenger trains don't run."
18. Zoomed out to all of Finland, the train glows shrink and dim in steps, so crowded areas (the Helsinki commuter trains) stay separate dots instead of merging into one blob.
19. A pulse line in the panel: a small line chart of how many trains are moving, one point per refresh, labelled "since you opened the page". It breaks where the page paused (hidden tab, failed refreshes). Kept in memory only.
20. On a phone, the route sheet can be swiped down to close (from its handle or header), and every tap target is at least 44 px: panel toggle, the "i" button, the Type | Delay switch, legend rows, the card's buttons, close buttons, zoom buttons and the train markers.
21. Share a train: a "Copy link" button on the card and in the route panel. Opening the link (`?train=DATE-NUMBER`) centres the map on that train and opens its card. If the train is not running any more, a message says so (and why when Digitraffic can tell: finished its journey, cancelled, not started yet).
22. The rail network is drawn as faint lines under the trains, from Digitraffic's track data (CC BY 4.0), simplified so lines stay within about 1 m of the source. It contains the lines trains actually run on, freight branches included, and no yard or siding tracks. It is made once by a script in `tools/` into `data/rail-network.json` (188 KB), which the page loads.
23. A train's route follows the track: every timetable point the train passes (not only its stops) is joined to the next along the network, worked out once per train and kept. A stretch that cannot be matched is drawn dashed (so is every stretch if the network file cannot load). The train's position is snapped onto the route line and splits "done" from "ahead" at that point; only the split moves on a refresh, never the line's shape. A train more than 1 km from its route keeps its last split, and the split never moves backwards by less than 300 m (a smaller step back is noise: the train snapping to a neighbouring track).

## Non-goals (v1)
- The "now vs a normal evening" comparison and any history (v2).
- Station timetables, delay history and station pages. (The card and route panel show only the clicked train's own route and current delays.)
- Journalist-specific features.
- Accounts, notifications and alerts.
- Countries other than Finland.
- Languages other than English.
- Visitor tracking, analytics or cookies.
- React, a backend, a database, build tools or npm packages. (The one-off data script in `tools/` uses only Node's built-in modules and is not part of the page.)

## Success metrics (4 weeks)
1. 5 rail enthusiasts interviewed about the last disruption they followed.
2. At least 3 of the 5 describe a real moment when a "tonight vs a normal evening" view would have answered a question they had.
3. The live page runs for 24 hours on GitHub Pages with no blank page, no crash that stops updates, and never more than 2 minutes without fresh data. A failed refresh that recovers is not an error. "Fresh" means the newest train report is no more than 2 minutes old. Measured by in-page counters (refreshes, failures, old data, longest gap): type `railPulseHealth()` in the browser console, or read the one-line summary printed every hour. It also reports the size of the latest and largest type-and-delay answer. Nothing is stored or sent anywhere. Caveat: age is judged by the viewer's device clock.
4. A forum post about it gets at least 10 replies, and at least 3 people agree to a short interview.

## Riskiest assumption
Enthusiasts actually want to know whether tonight is worse than normal. If they only want to see trains, existing maps already serve them and the product has no reason to exist.

Smallest test, run in parallel with the build: one mock-up screenshot labelled as a mock-up (e.g. "Tonight: 23% of trains delayed, vs 8% on a normal Tuesday evening", example numbers), shown to 5 enthusiasts on English-language rail forums. First ask about the last disruption they followed: what they checked and what they couldn't find out. Then show the mock-up. Pass: 3 of 5 describe a real moment it would have helped.

## Assumptions to check
- Digitraffic can supply each day's trains with scheduled and actual times, so a "normal evening" can be defined without storing history myself. Checked 10 Nov 2026: confirmed. The trains-by-departure-date query returns scheduled time, actual time and minutes late for every stop, and history goes back years (details in docs/decisions.md).
- Digitraffic can give every train's latest delay in the same small request that already returns train types. Checked 11 Nov 2026 around 01:00 Finnish time: 40 trains, 10 KB, 0.3–0.4 s. The size at a busy daytime is estimated (about 77 KB for 300 trains), not yet measured: `railPulseHealth()` now reports the latest and largest answer, so check it on a weekday afternoon. (Measured at night on 12 Nov: 42 to 43 trains, about 9 KB.)
- The delay at a train's last station is a good enough stand-in for its delay right now (guess; between stations it can be a little behind).
- Disruptions worth checking happen roughly 10–20 evenings a year, mostly November to March, plus rare strike days (guess).
