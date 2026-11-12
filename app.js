const API_BASE = 'https://rata.digitraffic.fi/api/v1';
const LOCATIONS_URL = API_BASE + '/train-locations/latest';
const GRAPHQL_URL = 'https://rata.digitraffic.fi/api/v2/graphql/graphql';

// Free CARTO basemaps key (request one at https://carto.com/basemaps/apikey). It is meant to be
// public: it ends up in the page source, so it is committed to the repo on purpose.
const CARTO_KEY = 'cb1_56cb_1_2d69dedfcd17afdbb965d1a8';
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=' + CARTO_KEY;

const REFRESH_MS = 15000;       // trains report about every 15 s
const TIMEOUT_MS = 10000;       // give up on a stuck request so the next refresh can run
const TYPE_RETRY_MS = 30000;    // look up train types at most this often
const STALE_MS = 120000;        // data whose newest train report is older than this counts as old
const INFO_REFRESH_MS = 60000;  // delays change slowly: look up train types and delays about once a minute
const DELAY_STALE_MS = 300000;  // if the delay lookup keeps failing, stop trusting old delays after 5 minutes
const TRAIL_MS = 60000;         // how far back a train's fading tail reaches
const TRAIL_MIN_ZOOM = 7;       // zoomed out further than this a minute of travel is under a pixel: don't draw tails
const SNAP_DISTANCE_M = 100000; // a jump this big is a data glitch: don't animate it
const MIN_HEADING_MOVE_M = 30;  // ignore GPS jitter when working out which way a train faces
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const NARROW_SCREEN = window.matchMedia('(max-width: 640px)');

// Times are shown in Finnish time, whatever the viewer's time zone
const TIME_FMT = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Helsinki' });
const TIME_SEC_FMT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Helsinki'
});

// ---------- Train types ----------
// Digitraffic gives every train a type code (IC, S, HL ...) inside a category (Long-distance,
// Commuter, Cargo ...). We sort them into eight classes, which the card and the route panel name
// exactly ("Pendolino", "Regional" ...), and the classes into five colour groups, which the map and
// the legend use. Only about five colours stay clearly apart on a map (and for colour-blind viewers),
// and green, amber and red are kept for delay, so similar classes share a colour.
const GROUPS = [
  { id: 'intercity', name: 'InterCity & Pendolino', rgb: '34,211,238',  hex: '#22d3ee' }, // cyan
  { id: 'express',   name: 'Express & night',       rgb: '167,139,250', hex: '#a78bfa' }, // violet
  { id: 'local',     name: 'Commuter & regional',   rgb: '241,245,249', hex: '#f1f5f9' }, // white
  { id: 'cargo',     name: 'Cargo',                 rgb: '255,79,216',  hex: '#ff4fd8' }, // magenta
  { id: 'other',     name: 'Service & other',       rgb: '115,123,136', hex: '#737b88' }  // grey (also: type unknown)
];
const GROUP_BY_ID = new Map(GROUPS.map((g) => [g.id, g]));

const CLASSES = [
  { id: 'pendolino', name: 'Pendolino',       group: 'intercity' },
  { id: 'intercity', name: 'InterCity',       group: 'intercity' },
  { id: 'express',   name: 'Express & night', group: 'express' },
  { id: 'regional',  name: 'Regional',        group: 'local' },
  { id: 'commuter',  name: 'Commuter',        group: 'local' },
  { id: 'cargo',     name: 'Cargo',           group: 'cargo' },
  { id: 'other',     name: 'Service & other', group: 'other' },
  { id: 'unknown',   name: 'Type unknown',    group: 'other' }
];
const CLASS_BY_ID = new Map(CLASSES.map((c) => [c.id, c]));

function classify(info) {
  if (!info) return CLASS_BY_ID.get('unknown');
  const { type, category } = info;
  if (type === 'S' || type === 'AE') return CLASS_BY_ID.get('pendolino');
  if (type === 'IC' || type === 'IC2') return CLASS_BY_ID.get('intercity');
  if (type === 'P' || type === 'PYO') return CLASS_BY_ID.get('express');
  if (type === 'H' || type === 'HDM' || type === 'HSM') return CLASS_BY_ID.get('regional');
  if (category === 'Commuter') return CLASS_BY_ID.get('commuter');
  if (category === 'Cargo') return CLASS_BY_ID.get('cargo');
  return CLASS_BY_ID.get('other'); // locomotives, shunting, test drives, track machines, special trains
}

// ---------- Delay bands ----------
// The same three colours and bands are used wherever delay is shown: on time (0 min or early),
// 1-4 min late, 5+ min late. Grey means we have no delay reading for that train.
const DELAY_BANDS = [
  { id: 'ontime',   name: 'On time',          rgb: '93,255,160',  hex: '#5dffa0' },
  { id: 'late',     name: '1–4 min late',     rgb: '255,194,71',  hex: '#ffc247' },
  { id: 'verylate', name: '5+ min late',      rgb: '255,107,129', hex: '#ff6b81' },
  { id: 'nodata',   name: 'No delay data',    rgb: '135,146,161', hex: '#8792a1' }
];
const BAND_BY_ID = new Map(DELAY_BANDS.map((b) => [b.id, b]));

function bandOf(minutes) {
  if (typeof minutes !== 'number') return BAND_BY_ID.get('nodata');
  if (minutes <= 0) return BAND_BY_ID.get('ontime');
  return BAND_BY_ID.get(minutes <= 4 ? 'late' : 'verylate');
}

// Trains are coloured either by their type or by their delay (the switch in the panel)
let colourMode = 'type'; // 'type' or 'delay'

// The colour group of a train's type (the card and route panel always use this, whatever the mode)
function typeColour(state) {
  return GROUP_BY_ID.get(state.cls.group);
}

// What the map colours a train by right now
function displayColour(state) {
  return colourMode === 'delay' ? state.band : typeColour(state);
}

// ---------- Map ----------
const WORLD =L.latLngBounds([[-85, -180], [85, 180]]);
const map = L.map('map', { maxBounds: WORLD, maxBoundsViscosity: 1 }); // can't pan off the world
map.zoomControl.setPosition('topright'); // keeps the zoom buttons clear of the stats panel
const mapEl = map.getContainer();

// You can't zoom out past the point where one world map fills the screen (no repeated worlds)
function limitZoomOut() {
  map.setMinZoom(0);
  map.setMinZoom(map.getBoundsZoom(WORLD, true));
}
limitZoomOut();
map.on('resize', limitZoomOut);

// Zoomed out, a full-size glow smears hundreds of trains into one blob: shrink and dim it in steps
function markZoomLevel() {
  const zoom = map.getZoom();
  mapEl.classList.toggle('zoom-far', zoom < 6);              // the whole country or further out
  mapEl.classList.toggle('zoom-mid', zoom >= 6 && zoom < 8); // regional
}
map.on('zoomend', markZoomLevel);

map.fitBounds([[59.7, 19.5], [70.2, 31.7]]); // all of Finland, on any screen size
markZoomLevel();

L.tileLayer(TILE_URL, {
  subdomains: 'abcd',
  maxZoom: 20,
  noWrap: true, // draw the world once, not side by side
  bounds: WORLD,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> ' +
    '&copy; <a href="https://carto.com/attribution/" target="_blank" rel="noopener">CARTO</a>'
}).addTo(map);

// Digitraffic's terms ask for both links: the source (digitraffic.fi) and the licence (CC BY 4.0)
const DIGITRAFFIC_LINK = '<a href="https://www.digitraffic.fi" target="_blank" rel="noopener">Fintraffic / digitraffic.fi</a>';
const CC_LINK = '<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>';
map.attributionControl.addAttribution(`Trains: ${DIGITRAFFIC_LINK} (${CC_LINK})`);
// The track lines are Digitraffic's too, but we simplify them (tools/build-rail-network.js), and CC BY asks us to say so
map.attributionControl.addAttribution(`Track lines: ${DIGITRAFFIC_LINK} (${CC_LINK}), simplified`);

// The credits can wrap onto two lines on a narrow screen. Publish their height as --credit-h so
// the route panel always sits above them and they are never covered.
const creditEl = map.attributionControl.getContainer();
function syncCreditHeight() {
  document.documentElement.style.setProperty('--credit-h', `${creditEl.offsetHeight}px`);
}
new ResizeObserver(syncCreditHeight).observe(creditEl);
syncCreditHeight();

// ---------- Helpers ----------
async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function formatTime(iso) {
  return iso ? TIME_FMT.format(new Date(iso)) : '–';
}

// Compass direction (0-360, clockwise from north) from point a to point b
function bearing(a, b) {
  const rad = Math.PI / 180;
  const dLng = (b.lng - a.lng) * rad;
  const y = Math.sin(dLng) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
            Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos(dLng);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

// ---------- Train details we look up separately from positions ----------
// The position feed has no train type and no delay, so one GraphQL query fetches both for every
// train that has a position: its type (which never changes) and its delay, taken from the latest
// timetable row that has an actual time (the last station it passed). We ask about once a minute,
// or sooner when new trains appear that we don't know the type of.
const typeInfo = new Map();    // "2026-11-10-27" -> { type, category, line, operator }
const typeMissing = new Set(); // trains Digitraffic gave no type for: don't keep asking
let delayByKey = new Map();    // "2026-11-10-27" -> minutes late (negative = early)
let delaysUpdatedAt = 0;       // when the delays were last fetched successfully
let lastInfoFetch = 0;

const INFO_QUERY = `{ latestTrainLocations { train {
  trainNumber departureDate commuterLineid operator { shortCode }
  trainType { name trainCategory { name } }
  timeTableRows(where: { actualTime: { greaterThan: "2000-01-01T00:00:00Z" } },
                orderBy: { actualTime: DESCENDING }, take: 1) { differenceInMinutes }
} } }`;

async function loadInfo() {
  lastInfoFetch = Date.now();
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: INFO_QUERY }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${GRAPHQL_URL}`);
  const text = await res.text();
  recordInfoSize(new TextEncoder().encode(text).length); // measured for railPulseHealth()
  const json = JSON.parse(text);
  if (json.errors) throw new Error(json.errors[0].message);
  const delays = new Map();
  for (const loc of json.data.latestTrainLocations) {
    const t = loc.train;
    if (!t) continue;
    const key = `${t.departureDate}-${t.trainNumber}`;
    if (t.trainType) {
      typeInfo.set(key, {
        type: t.trainType.name,
        category: t.trainType.trainCategory ? t.trainType.trainCategory.name : '',
        line: t.commuterLineid || '',
        operator: t.operator ? t.operator.shortCode : ''
      });
    }
    // No row with an actual time means the train hasn't left its first station yet: no delay reading
    const row = t.timeTableRows && t.timeTableRows[0];
    if (row && typeof row.differenceInMinutes === 'number') delays.set(key, row.differenceInMinutes);
  }
  delayByKey = delays;
  delaysUpdatedAt = Date.now();
}

function delaysUsable() {
  return Date.now() - delaysUpdatedAt <= DELAY_STALE_MS;
}

// Fill in a train's type, class, delay and delay band from what we have looked up
function syncInfo(state) {
  if (!state.info && typeInfo.has(state.key)) {
    state.info = typeInfo.get(state.key);
    state.cls = classify(state.info);
  }
  const minutes = delaysUsable() ? delayByKey.get(state.key) : undefined;
  state.delay = typeof minutes === 'number' ? minutes : null;
  state.band = bandOf(state.delay);
}

// The one way a train is named everywhere (card, panel, marker tooltip): "S 42", "U-train 8501".
// Only if its type is unknown does it fall back to "Train 42".
function trainName(info, number) {
  if (!info) return `Train ${number}`;
  return info.category === 'Commuter' && info.line
    ? `${info.line}-train ${number}`
    : `${info.type} ${number}`;
}

function trainTitle(state) {
  return trainName(state.info, state.number);
}

function trainSubtitle(state) {
  const parts = [state.cls.name];
  if (state.info && state.info.operator) parts.push(state.info.operator.toUpperCase());
  return parts.join(' · ');
}

// ---------- Train markers ----------
// A glowing orb; once a train has moved it becomes an arrow pointing the way it travels.
const TRAIN_ICON = L.divIcon({
  className: 'train-icon',
  html: '<span class="glow"></span>' +
        '<svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 L20 21 L12 16.5 L4 21 Z"/></svg>',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
  popupAnchor: [0, -10]
});

// One entry per train, kept so a refresh can move existing markers instead of adding new ones.
const trains = new Map();
const hiddenTypes = new Set(); // colour groups switched off in the legend (Type mode)
const hiddenBands = new Set(); // delay bands switched off in the legend (Delay mode)

function isHidden(state) {
  return colourMode === 'delay' ? hiddenBands.has(state.band.id) : hiddenTypes.has(state.cls.group);
}

// Keep only trains with a position, and reshape them into a simple form.
function cleanTrains(raw) {
  return raw
    .filter((t) => t.location && Array.isArray(t.location.coordinates))
    .map((t) => ({
      key: `${t.departureDate}-${t.trainNumber}`, // unique per train per day
      date: t.departureDate,
      number: t.trainNumber,
      speed: Number(t.speed) || 0,
      timestamp: t.timestamp,
      lng: t.location.coordinates[0], // longitude comes first in the API...
      lat: t.location.coordinates[1]  // ...but Leaflet wants [latitude, longitude]
    }));
}

function createTrain(t) {
  const position = L.latLng(t.lat, t.lng);
  const info = typeInfo.get(t.key) || null;
  const state = {
    key: t.key, date: t.date, number: t.number, speed: t.speed, lastReport: t.timestamp,
    info, cls: classify(info),
    delay: null, band: bandOf(null), // minutes late and its band, filled in by syncInfo()
    trail: [],          // recent positions { ll, t } the fading tail is drawn through
    moving: t.speed > 0,
    target: position,   // where the last report says the train is
    heading: null,      // degrees; unknown until we see it move
    rotation: 0,        // the arrow's angle, kept unwrapped so it turns the short way round
    anim: null,
    details: null, detailsError: false, loading: false,
    copiedUntil: 0,     // until when the card's button says "Link copied"
    route: null,        // its route line along the rail network, worked out once (see buildRoute)
    split: null,        // metres along that route where the train is: done behind, ahead in front
    popupEl: makeEl('div')
  };
  state.marker = L.marker(position, { icon: TRAIN_ICON })
    // autoPan is off: keepPopupClear() below moves the map so the card avoids the panel and credits
    .bindPopup(state.popupEl, { minWidth: 270, maxWidth: 300, className: 'train-popup', autoPan: false })
    .addTo(map);
  state.marker.on('popupopen', () => {
    if (routeState) closeRoute(); // one profile at a time: a card replaces the route panel
    renderPopup(state);
    loadDetails(state);
  });
  syncInfo(state);
  applyLook(state);
  return state;
}

function applyLook(state) {
  const el = state.marker.getElement();
  el.style.setProperty('--rgb', displayColour(state).rgb);
  el.title = trainTitle(state); // tooltip on hover
  el.classList.toggle('is-stopped', !state.moving);
  el.classList.toggle('has-heading', state.moving && state.heading !== null);
  el.classList.toggle('is-hidden', isHidden(state));
  el.classList.toggle('is-selected', state === routeState);
  state.marker.setZIndexOffset(state === routeState ? 2000 : state.moving ? 1000 : 0); // moving trains draw on top
  if (state.heading !== null) {
    el.querySelector('.arrow').style.transform = `rotate(${state.rotation}deg)`;
  }
}

function updateTrain(state, t) {
  const next = L.latLng(t.lat, t.lng);
  const moved = state.target.distanceTo(next); // metres since the last report

  if (t.speed > 0 && moved >= MIN_HEADING_MOVE_M) {
    const heading = bearing(state.target, next);
    state.rotation = state.heading === null
      ? heading
      : state.rotation + ((heading - state.rotation + 540) % 360) - 180;
    state.heading = heading;
  }

  if (moved > 0) {
    const here = state.marker.getLatLng();
    if (moved > SNAP_DISTANCE_M) {
      state.anim = null;
      state.trail.length = 0; // a data glitch: don't draw a tail across the country
      state.marker.setLatLng(next);
    } else if (REDUCED_MOTION) {
      state.anim = null;
      if (t.speed > 0) pushTrail(state, here);
      state.marker.setLatLng(next);
    } else {
      // Glide from wherever the marker is right now to the new position
      if (t.speed > 0) pushTrail(state, here);
      state.anim = { from: here, to: next, start: performance.now(), dur: REFRESH_MS };
    }
  }

  state.target = next;
  state.speed = t.speed;
  state.moving = t.speed > 0;
  if (!state.moving) state.trail.length = 0; // a stopped train has no tail
  state.lastReport = t.timestamp;
  syncInfo(state); // its type or delay may have just been looked up
  applyLook(state);
  if (state.marker.isPopupOpen()) renderPopup(state);
}

function updateTrains(list) {
  const seen = new Set();
  for (const t of list) {
    seen.add(t.key);
    const state = trains.get(t.key);
    if (state) updateTrain(state, t);
    else trains.set(t.key, createTrain(t));
  }
  // Remove markers for trains that stopped reporting
  for (const [key, state] of trains) {
    if (!seen.has(key)) {
      if (state === routeState) closeRoute();
      state.marker.remove();
      trains.delete(key);
    }
  }
  startAnimation();
  updateLegendCounts();
  updateNetworkStatus();
  trails.requestDraw();
  if (routeState) { // keep the open route live
    loadDetails(routeState);
    if (routeState.details) drawRoute(routeState); // redraw so the line follows the train
  }
}

// ---------- Fading tails ----------
// A short tail behind each moving train: the positions it has glided through in the last minute,
// fading out towards the back, in the train's current colour. Drawn on one canvas so hundreds of
// tails stay cheap; the tail's front end is the gliding marker itself, so it never detaches.
function pushTrail(state, latlng) {
  const now = performance.now();
  state.trail.push({ ll: latlng, t: now });
  // Keep one point from before the window (the tail starts partway along that segment), drop older ones
  while (state.trail.length >= 2 && state.trail[1].t < now - TRAIL_MS) state.trail.shift();
}

const TrailLayer = L.Layer.extend({
  onAdd(leafletMap) {
    if (!leafletMap.getPane('trails')) {
      const pane = leafletMap.createPane('trails');
      pane.style.zIndex = 450;          // above the route line, below the train markers
      pane.style.pointerEvents = 'none'; // never blocks a click on a train
    }
    this._canvas = L.DomUtil.create('canvas', 'trail-canvas', leafletMap.getPane('trails'));
    this._ctx = this._canvas.getContext('2d');
    this._frame = null;
    this._zooming = false;
    this._resize();
    leafletMap.on('move moveend', this.requestDraw, this);
    leafletMap.on('resize', this._onResize, this);
    leafletMap.on('zoomstart', this._onZoomStart, this);
    leafletMap.on('zoomend', this._onZoomEnd, this);
  },

  onRemove(leafletMap) {
    leafletMap.off('move moveend', this.requestDraw, this);
    leafletMap.off('resize', this._onResize, this);
    leafletMap.off('zoomstart', this._onZoomStart, this);
    leafletMap.off('zoomend', this._onZoomEnd, this);
    L.DomUtil.remove(this._canvas);
  },

  _resize() {
    const size = this._map.getSize();
    this._dpr = Math.min(window.devicePixelRatio || 1, 2); // sharp on phones without a huge canvas
    this._canvas.width = Math.round(size.x * this._dpr);
    this._canvas.height = Math.round(size.y * this._dpr);
    this._canvas.style.width = `${size.x}px`;
    this._canvas.style.height = `${size.y}px`;
  },

  _onResize() {
    this._resize();
    this.requestDraw();
  },

  // While Leaflet animates a zoom the tails would stay at the old scale, so hide them until it ends
  _onZoomStart() {
    this._zooming = true;
    this._canvas.style.visibility = 'hidden';
  },

  _onZoomEnd() {
    this._zooming = false;
    this._canvas.style.visibility = '';
    this.requestDraw();
  },

  // Redraw on the next frame (several requests in one frame only draw once)
  requestDraw() {
    if (this._frame !== null) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      this.draw();
    });
  },

  draw() {
    const ctx = this._ctx;
    const size = this._map.getSize();
    // The map pane moves when you drag the map: keep the canvas pinned over the visible area
    L.DomUtil.setPosition(this._canvas, this._map.containerPointToLayerPoint([0, 0]));
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    if (this._zooming || this._map.getZoom() < TRAIL_MIN_ZOOM) return;

    const now = performance.now();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const state of trains.values()) {
      if (!state.moving || state.trail.length === 0 || isHidden(state)) continue;
      this._drawTail(ctx, state, now, size);
    }
    ctx.globalAlpha = 1;
  },

  _drawTail(ctx, state, now, size) {
    const cutoff = now - TRAIL_MS;
    const head = state.marker.getLatLng();
    const verts = state.trail;

    // The tail's points, oldest first, ending at the marker
    const points = [];
    let i = 0;
    while (i < verts.length && verts[i].t < cutoff) i++;
    if (i > 0) { // start exactly one minute back, partway along the segment that crosses the cutoff
      const a = verts[i - 1];
      const b = i < verts.length ? verts[i] : { ll: head, t: now };
      const f = (cutoff - a.t) / (b.t - a.t);
      points.push([a.ll.lat + (b.ll.lat - a.ll.lat) * f, a.ll.lng + (b.ll.lng - a.ll.lng) * f]);
    }
    for (; i < verts.length; i++) points.push([verts[i].ll.lat, verts[i].ll.lng]);
    points.push([head.lat, head.lng]);

    // Screen positions. Skip tails that are off screen or too short to see.
    const px = points.map((p) => this._map.latLngToContainerPoint(p));
    const tail = px[0];
    const front = px[px.length - 1];
    if (Math.hypot(front.x - tail.x, front.y - tail.y) < 1.5) return;
    let onScreen = false;
    for (const p of px) {
      if (p.x > -40 && p.x < size.x + 40 && p.y > -40 && p.y < size.y + 40) { onScreen = true; break; }
    }
    if (!onScreen) return;

    // One path and one gradient per tail (transparent at the back, bright at the train), which keeps
    // hundreds of tails cheap. Everything except the open route's train fades while a route is open.
    const rgb = displayColour(state).rgb;
    const dim = routeState && routeState !== state ? 0.25 : 1;
    const gradient = ctx.createLinearGradient(tail.x, tail.y, front.x, front.y);
    gradient.addColorStop(0, `rgba(${rgb},0)`);
    gradient.addColorStop(1, `rgba(${rgb},0.9)`);
    ctx.strokeStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(tail.x, tail.y);
    for (let k = 1; k < px.length; k++) ctx.lineTo(px[k].x, px[k].y);
    ctx.globalAlpha = 0.25 * dim; // a wide soft pass for the glow...
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.globalAlpha = dim;        // ...and a thin bright core
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
});

const trails = new TrailLayer().addTo(map);

// ---------- Smooth gliding ----------
// One animation loop moves every gliding marker a little each frame.
let frameId = null;

function tick(now) {
  let active = false;
  for (const state of trains.values()) {
    if (!state.anim) continue;
    const { from, to, start, dur } = state.anim;
    const t = Math.min((now - start) / dur, 1);
    state.marker.setLatLng([from.lat + (to.lat - from.lat) * t, from.lng + (to.lng - from.lng) * t]);
    if (t >= 1) state.anim = null;
    else active = true;
  }
  trails.draw(); // the tails follow the markers frame by frame
  frameId = active ? requestAnimationFrame(tick) : null;
}

function startAnimation() {
  if (frameId === null) frameId = requestAnimationFrame(tick);
}

// ---------- Click details ----------
// Stations (code -> name and position), fetched once the first time a train is clicked.
let stationsPromise = null;
function getStations() {
  if (!stationsPromise) {
    stationsPromise = fetchJson(API_BASE + '/metadata/stations')
      .then((list) => new Map(list.map((s) => [s.stationShortCode, {
        name: s.stationName.replace(/ asema$/, ''),
        lat: typeof s.latitude === 'number' ? s.latitude : null,
        lng: typeof s.longitude === 'number' ? s.longitude : null
      }])))
      .catch((err) => {
        stationsPromise = null; // try again next time
        throw err;
      });
  }
  return stationsPromise;
}

// Boil one train's full timetable down to what the popup and the route panel show.
function summarise(train, stations) {
  if (!train) return null;
  const rows = train.timeTableRows || [];
  const nameOf = (code) => (stations.get(code) ? stations.get(code).name : code);

  // Rows run in route order. The last row with an actual time is where the train has got to.
  let lastDone = -1;
  rows.forEach((r, i) => { if (r.actualTime) lastDone = i; });

  // One entry per station where the train stops (plus the first and last), merging its arrival and departure.
  const stops = [];
  rows.forEach((r, i) => {
    if (!(r.commercialStop || i === 0 || i === rows.length - 1)) return;
    let stop = stops[stops.length - 1];
    if (!stop || stop.code !== r.stationShortCode) {
      const st = stations.get(r.stationShortCode);
      stop = {
        code: r.stationShortCode, name: nameOf(r.stationShortCode), track: '',
        lat: st ? st.lat : null, lng: st ? st.lng : null, arr: null, dep: null
      };
      stops.push(stop);
    }
    const time = {
      scheduled: r.scheduledTime, actual: r.actualTime || null,
      estimate: r.liveEstimateTime || null, diff: r.differenceInMinutes, cancelled: Boolean(r.cancelled)
    };
    if (r.type === 'ARRIVAL') stop.arr = time;
    else stop.dep = time;
    if (r.commercialTrack) stop.track = r.commercialTrack;
  });

  let nextFound = false;
  for (const s of stops) {
    const done = s.dep ? Boolean(s.dep.actual) : Boolean(s.arr && s.arr.actual);
    if (done) s.status = 'passed';
    else if (s.arr && s.arr.actual) s.status = 'at';
    else if (!nextFound) { s.status = 'next'; nextFound = true; }
    else s.status = 'upcoming';
  }
  const next = stops.find((s) => s.status === 'next');
  const passed = stops.filter((s) => s.status === 'passed').length;

  // The line of the route on the map: every timetable point we know the position of
  const points = [];
  let passedCount = 0;
  rows.forEach((r, i) => {
    const st = stations.get(r.stationShortCode);
    if (st && st.lat !== null) {
      const last = points[points.length - 1];
      if (!last || last.lat !== st.lat || last.lng !== st.lng) points.push({ lat: st.lat, lng: st.lng, code: r.stationShortCode });
    }
    if (i <= lastDone) passedCount = points.length;
  });

  return {
    cancelled: Boolean(train.cancelled),
    origin: rows.length ? nameOf(rows[0].stationShortCode) : null,
    destination: rows.length ? nameOf(rows[rows.length - 1].stationShortCode) : null,
    delay: lastDone >= 0 ? rows[lastDone].differenceInMinutes : null,
    stops,
    next: next ? { name: next.name, kind: next.arr ? 'arr' : 'dep', time: nextTime(next) } : null,
    progress: stops.length > 1 ? Math.min(1, passed / (stops.length - 1)) : 0,
    points,
    passedCount
  };
}

function nextTime(stop) {
  const t = stop.arr || stop.dep;
  return t ? t.estimate || t.scheduled : null;
}

async function loadDetails(state) {
  if (state.loading) return;
  state.loading = true;
  state.detailsError = false;
  if (state.marker.isPopupOpen()) renderPopup(state);
  try {
    const [list, stations] = await Promise.all([
      fetchJson(`${API_BASE}/trains/${state.date}/${state.number}`),
      getStations().catch(() => new Map()) // names and positions are a nicety: fall back to codes
    ]);
    state.details = summarise(list[0], stations);
    state.detailsError = !state.details;
  } catch (err) {
    console.error('Could not load train details:', err);
    state.detailsError = true;
  } finally {
    state.loading = false;
    if (state.marker.isPopupOpen()) renderPopup(state);
    if (state === routeState) {
      renderRoute(state);
      drawRoute(state);
      if (routeFitPending && state.details) {
        routeFitPending = false;
        fitRoute(state);
      }
    }
  }
}

// ---------- The popup card ----------
const TRAIN_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M7 2.5h10A3.5 3.5 0 0 1 20.5 6v9.5A3.5 3.5 0 0 1 17 19l1.6 2.5h-2.1L15 19H9l-1.5 2.5H5.4L7 19a3.5 3.5 0 0 1-3.5-3.5V6A3.5 3.5 0 0 1 7 2.5zM6.5 6.5V11h11V6.5h-11zM8 13.7a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm8 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/></svg>';

function makeBadge(colour) {
  const badge = makeEl('div', 'badge');
  badge.style.setProperty('--rgb', colour.rgb);
  badge.innerHTML = TRAIN_SVG; // fixed markup, no data in it
  return badge;
}

// Who the train is: icon, name ("T 3493"), exact type and operator ("Cargo · VR"). The card and the
// route panel both start with this, so they always show the same identity.
function makeHead(state) {
  const head = makeEl('div', 'tp-head');
  const text = makeEl('div', 'head-text');
  text.append(makeEl('div', 'tp-title', trainTitle(state)), makeEl('div', 'tp-sub', trainSubtitle(state)));
  head.append(makeBadge(typeColour(state)), text);
  return head;
}

function delayInfo(d) {
  if (d.cancelled) return { text: 'Cancelled', cls: 'd-bad' };
  if (d.delay === null) return null;
  if (d.delay <= 0) return { text: 'On time', cls: 'd-ok' };
  return { text: `+${d.delay} min`, cls: d.delay >= 5 ? 'd-bad' : 'd-late' };
}

function tile(label, value, extraClass, wide) {
  const el = makeEl('div', 'tile' + (wide ? ' wide' : ''));
  el.append(makeEl('div', 'tile-label', label), makeEl('div', 'tile-value' + (extraClass ? ' ' + extraClass : ''), value));
  return el;
}

function makeTiles(state) {
  const d = state.details;
  const tiles = makeEl('div', 'tiles');
  tiles.append(tile('Speed', `${state.speed} km/h`));
  const delay = d && delayInfo(d);
  tiles.append(tile('Delay', delay ? delay.text : '–', delay ? delay.cls : ''));
  if (d && d.next) tiles.append(tile('Next stop', `${d.next.name} · ${d.next.kind} ${formatTime(d.next.time)}`, '', true));
  return tiles;
}

// "Copy link", on the card and in the route panel
function linkLabel(state) {
  return performance.now() < state.copiedUntil ? 'Link copied' : 'Copy link';
}

function makeLinkButton(state) {
  const button = makeEl('button', 'tp-btn tp-btn-quiet tp-link', linkLabel(state));
  button.type = 'button';
  button.setAttribute('aria-label', 'Copy a link to this train');
  button.addEventListener('click', () => copyTrainLink(state));
  return button;
}

function renderPopup(state) {
  const d = state.details;
  const card = makeEl('div', 'tp-card');
  card.style.setProperty('--rgb', typeColour(state).rgb);
  card.append(makeHead(state));

  if (d && d.origin) {
    const route = makeEl('div', 'tp-route');
    const ends = makeEl('div', 'tp-ends');
    ends.append(makeEl('span', '', d.origin), makeEl('span', '', d.destination));
    const bar = makeEl('div', 'tp-progress');
    const fill = makeEl('i');
    fill.style.width = `${Math.round(d.progress * 100)}%`;
    const dot = makeEl('b');
    dot.style.left = `${Math.round(d.progress * 100)}%`;
    bar.append(fill, dot);
    route.append(ends, bar);
    card.append(route);
  }

  card.append(makeTiles(state));

  const actions = makeEl('div', 'tp-actions');
  const routeButton = makeEl('button', 'tp-btn', d ? 'View full route' : 'Loading route…');
  routeButton.type = 'button';
  routeButton.disabled = !d;
  routeButton.addEventListener('click', () => openRoute(state));
  actions.append(routeButton, makeLinkButton(state));
  card.append(actions);

  const note = state.detailsError && !d
    ? 'More details unavailable right now.'
    : `Last report ${TIME_SEC_FMT.format(new Date(state.lastReport))} · Finnish time`;
  card.append(makeEl('div', 'tp-note', note));

  state.popupEl.replaceChildren(card);
  const popup = state.marker.getPopup();
  popup.update(); // resize the popup to fit the new content
  keepPopupClear(popup);
}

// Slide the map just enough that the open card sits inside the map, clear of the stats panel,
// the zoom buttons and the credits. If it can't fit beside the panel, the panel collapses.
function keepPopupClear(popup, alreadyCollapsed = false) {
  if (!popup.isOpen() || !popup.getElement()) return;
  const MARGIN = 12;
  const wrapper = popup.getElement().querySelector('.leaflet-popup-content-wrapper').getBoundingClientRect();
  const card = { left: wrapper.left, right: wrapper.right, top: wrapper.top, bottom: wrapper.bottom + 22 }; // 22 = the tip pointing at the train
  const view = mapEl.getBoundingClientRect();
  const credit = creditEl.getBoundingClientRect();
  const limits = { left: view.left + MARGIN, right: view.right - MARGIN, top: view.top + MARGIN, bottom: credit.top - MARGIN };
  const blockers = [panel, map.zoomControl.getContainer()].map((el) => el.getBoundingClientRect());

  const moved = (dx, dy) => ({ left: card.left + dx, right: card.right + dx, top: card.top + dy, bottom: card.bottom + dy });
  const inside = (c) => c.left >= limits.left - 0.5 && c.right <= limits.right + 0.5 &&
                        c.top >= limits.top - 0.5 && c.bottom <= limits.bottom + 0.5;
  const overlaps = (c, b) => c.left < b.right + MARGIN && c.right > b.left - MARGIN &&
                             c.top < b.bottom + MARGIN && c.bottom > b.top - MARGIN;
  const clear = (c) => inside(c) && !blockers.some((b) => overlaps(c, b));

  // 1. Smallest slide that keeps the card inside the map
  let dx = 0;
  let dy = 0;
  if (card.top < limits.top) dy = limits.top - card.top;
  else if (card.bottom > limits.bottom) dy = limits.bottom - card.bottom;
  if (card.left < limits.left) dx = limits.left - card.left;
  else if (card.right > limits.right) dx = limits.right - card.right;

  // 2. If it now overlaps the panel or zoom buttons, try sliding it down, up, right or left past them
  if (!clear(moved(dx, dy))) {
    const options = [];
    for (const b of blockers) {
      const c = moved(dx, dy);
      options.push([dx, dy + (b.bottom + MARGIN - c.top)]);    // below it
      options.push([dx, dy + (b.top - MARGIN - c.bottom)]);     // above it
      options.push([dx + (b.right + MARGIN - c.left), dy]);     // to its right
      options.push([dx + (b.left - MARGIN - c.right), dy]);     // to its left
    }
    const fits = options.filter(([x, y]) => clear(moved(x, y)))
      .sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
    if (fits.length) {
      [dx, dy] = fits[0];
    } else if (!alreadyCollapsed && !panel.classList.contains('is-collapsed')) {
      setPanelCollapsed(true); // the panel is the only thing we can shrink; then try again
      keepPopupClear(popup, true);
      return;
    }
  }
  if (dx !== 0 || dy !== 0) map.panBy([-dx, -dy], { duration: 0.25 }); // panning the map moves the card the other way
}

// ---------- The rail network ----------
// data/rail-network.json is made once by tools/build-rail-network.js from Digitraffic's track lines
// (CC BY 4.0), simplified. The page draws it as faint lines under the trains, and finds each train's
// route along it: every pair of neighbouring timetable points is joined by the shortest way along the lines.
const NETWORK_URL = 'data/rail-network.json';
const M_PER_DEG = 111320;      // metres per degree of latitude
const GRID_DEG = 0.01;         // size of the cells in the "which lines are near here" lookup
const STATION_SNAP_M = 1000;   // a timetable point further than this from any line can't be matched
const SNAP_SLACK_M = 15;       // also try lines up to this much further away than the nearest one
const DETOUR_FACTOR = 2.5;     // a way longer than 2.5 times the straight distance (plus 3 km) isn't believed
const SPLIT_MAX_M = 1000;      // a train further than this from its route keeps its last split point
const SPLIT_BACK_M = 300;      // the split never moves back by less than this: a smaller step back is noise (the train
                               // snapping to a neighbouring track, or reversing out of a platform), so the old split stays
const SPUR_MATCH_M = 8;        // the way out to a station and the way back count as the same line within this distance
                               // (they can be on neighbouring tracks, 5 m apart)...
const SPUR_MIN_M = 20;         // ...if the stub is at least this long (shorter is just the station's own spot on the line)...
const SPUR_MAX_M = 1500;       // ...and at most this long: more than that is a real out-and-back, not a stub beside the line

let network = null;           // { edges, adj, grid } once loaded; null if not loaded yet or it failed

map.createPane('network').style.zIndex = 350; // under the route line (400), the tails (450) and the trains (600)
const networkLayer = L.polyline([], {
  renderer: L.canvas({ pane: 'network', padding: 0.2 }), // one canvas for all the lines keeps panning smooth
  color: '#8fd3e6', weight: 1, opacity: 0.3, interactive: false, smoothFactor: 1.2
}).addTo(map);

// Thinner when zoomed out, so the whole country doesn't turn into a grey mesh
function styleNetwork() {
  const zoom = map.getZoom();
  networkLayer.setStyle({ weight: zoom < 7 ? 0.8 : zoom < 10 ? 1.1 : zoom < 13 ? 1.5 : 2 });
}
map.on('zoomend', styleNetwork);
styleNetwork();

// Distances on the ground, in metres, between [lat, lng] points (flat-earth maths: fine over a few km)
function metresBetween(a, b) {
  const dy = (b[0] - a[0]) * M_PER_DEG;
  const dx = (b[1] - a[1]) * M_PER_DEG * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
  return Math.hypot(dx, dy);
}

// How far point p is from the segment a-b, and how far along the segment (0 to 1) the nearest spot is
function distToSegment(p, a, b) {
  const kx = M_PER_DEG * Math.cos(p[0] * Math.PI / 180);
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * M_PER_DEG;
  const bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * M_PER_DEG;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
}

// Read the compact file (see the format in tools/build-rail-network.js) into lines we can search and route along
function decodeNetwork(file) {
  const u = file.unit;
  const nodes = file.nodes;
  const edges = file.edges.map((row) => {
    const [a, b] = row;
    let x = nodes[a * 2];
    let y = nodes[a * 2 + 1];
    const pts = [[y * u, x * u]]; // [lat, lng]
    for (let i = 2; i < row.length; i += 2) {
      x += row[i];
      y += row[i + 1];
      pts.push([y * u, x * u]);
    }
    pts.push([nodes[b * 2 + 1] * u, nodes[b * 2] * u]);
    const cum = [0]; // metres from the start of the line to each point
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metresBetween(pts[i - 1], pts[i]));
    return { a, b, pts, cum, len: cum[cum.length - 1] };
  });
  const adj = Array.from({ length: nodes.length / 2 }, () => []); // node -> the lines that end there
  const grid = new Map();                                          // map cell -> [line, segment] pairs in it
  edges.forEach((e, ei) => {
    adj[e.a].push(ei);
    adj[e.b].push(ei);
    for (let i = 1; i < e.pts.length; i++) {
      const p = e.pts[i - 1];
      const q = e.pts[i];
      for (let cx = Math.floor(Math.min(p[1], q[1]) / GRID_DEG); cx <= Math.floor(Math.max(p[1], q[1]) / GRID_DEG); cx++) {
        for (let cy = Math.floor(Math.min(p[0], q[0]) / GRID_DEG); cy <= Math.floor(Math.max(p[0], q[0]) / GRID_DEG); cy++) {
          const k = cx * 100003 + cy;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push([ei, i - 1]);
        }
      }
    }
  });
  return { edges, adj, grid };
}

async function loadNetwork() {
  try {
    const res = await fetch(NETWORK_URL, { signal: AbortSignal.timeout(TIMEOUT_MS * 3) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    network = decodeNetwork(await res.json());
    networkLayer.setLatLngs(network.edges.map((e) => e.pts));
    if (routeState && routeState.details) drawRoute(routeState); // a route opened before the lines arrived
  } catch (err) {
    // Not fatal: routes are then drawn as dashed straight lines between the stations
    console.warn('Could not load the rail network (opening the page as a plain file blocks this; use a web server).', err);
  }
}

// Every line segment within `radius` metres of a spot: [{ ei (line), si (segment), d (metres), t (0 to 1 along it) }]
function linesNear(lat, lng, radius) {
  const ry = Math.ceil(radius / (M_PER_DEG * GRID_DEG));
  const rx = Math.ceil(radius / (M_PER_DEG * Math.cos(lat * Math.PI / 180) * GRID_DEG));
  const cx = Math.floor(lng / GRID_DEG);
  const cy = Math.floor(lat / GRID_DEG);
  const found = [];
  const seen = new Set();
  for (let i = -rx; i <= rx; i++) {
    for (let j = -ry; j <= ry; j++) {
      for (const [ei, si] of network.grid.get((cx + i) * 100003 + cy + j) || []) {
        const id = ei * 65536 + si;
        if (seen.has(id)) continue;
        seen.add(id);
        const e = network.edges[ei];
        const { d, t } = distToSegment([lat, lng], e.pts[si], e.pts[si + 1]);
        if (d <= radius) found.push({ ei, si, d, t });
      }
    }
  }
  return found;
}

// Where a timetable point sits on the lines. A station is often where several tracks overlap and only some
// lead anywhere, so this gives the nearest line plus every other line within a few metres of it:
// [{ e (line), s (metres from its start), d (metres from the station) }], nearest first.
const snapCache = new Map();
function snapsFor(lat, lng) {
  const key = `${lat},${lng}`;
  if (snapCache.has(key)) return snapCache.get(key);
  let nearest = null;
  for (const radius of [100, 300, STATION_SNAP_M]) {
    const hits = linesNear(lat, lng, radius);
    if (hits.length) { nearest = Math.min(...hits.map((h) => h.d)); break; }
  }
  const result = [];
  if (nearest !== null) {
    const best = new Map(); // line -> its closest segment
    for (const h of linesNear(lat, lng, Math.min(nearest + SNAP_SLACK_M, STATION_SNAP_M))) {
      if (!best.has(h.ei) || h.d < best.get(h.ei).d) best.set(h.ei, h);
    }
    for (const h of [...best.values()].sort((a, b) => a.d - b.d).slice(0, 8)) {
      const e = network.edges[h.ei];
      result.push({ e: h.ei, s: e.cum[h.si] + h.t * (e.cum[h.si + 1] - e.cum[h.si]), d: h.d });
    }
  }
  snapCache.set(key, result);
  return result;
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(key, value) {
    const a = this.a;
    a.push([key, value]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// The shortest way along the lines from any of the start spots `As` to any of the end spots `Bs`
// (each from snapsFor). Returns { length, steps: [{ e, s0, s1 }] } or null. A step runs along line e from
// s0 to s1 metres from its start (s0 > s1 means against its direction). Being away from the line costs
// twice the distance, which only ever decides between routes that are otherwise equal.
function routeAlong(As, Bs) {
  const { edges, adj } = network;
  const dist = new Map();
  const from = new Map();
  const heap = new MinHeap();
  const relax = (n, d, via) => {
    if (d < (dist.has(n) ? dist.get(n) : Infinity)) { dist.set(n, d); from.set(n, via); heap.push(d, n); }
  };
  const targets = new Map(); // node -> end spots reached through it
  const addTarget = (n, j, off, enter) => {
    if (!targets.has(n)) targets.set(n, []);
    targets.get(n).push({ j, off, enter });
  };
  As.forEach((A, i) => {
    const e = edges[A.e];
    relax(e.a, A.s + 2 * A.d, { start: i, side: 'a' });
    relax(e.b, e.len - A.s + 2 * A.d, { start: i, side: 'b' });
  });
  Bs.forEach((B, j) => {
    const e = edges[B.e];
    addTarget(e.a, j, B.s + 2 * B.d, 'a');
    addTarget(e.b, j, e.len - B.s + 2 * B.d, 'b');
  });

  let best = Infinity;
  let end = null;
  As.forEach((A, i) => Bs.forEach((B, j) => { // both spots on the same line: just go along it
    const cost = Math.abs(A.s - B.s) + 2 * A.d + 2 * B.d;
    if (A.e === B.e && cost < best) { best = cost; end = { direct: true, i, j }; }
  }));

  const settled = new Set();
  while (heap.size) {
    const [d, n] = heap.pop();
    if (settled.has(n) || d > dist.get(n)) continue;
    settled.add(n);
    if (d >= best) break;
    for (const t of targets.get(n) || []) {
      if (d + t.off < best) { best = d + t.off; end = { node: n, j: t.j, enter: t.enter }; }
    }
    for (const ei of adj[n]) {
      const e = edges[ei];
      relax(e.a === n ? e.b : e.a, d + e.len, { edge: ei, node: n });
    }
  }
  if (!end) return null;

  if (end.direct) {
    return { length: best, steps: [{ e: As[end.i].e, s0: As[end.i].s, s1: Bs[end.j].s }] };
  }
  const B = Bs[end.j];
  const steps = [{ e: B.e, s0: end.enter === 'a' ? 0 : edges[B.e].len, s1: B.s }];
  let n = end.node;
  for (;;) { // walk back to where it started
    const via = from.get(n);
    if (via.start !== undefined) {
      const A = As[via.start];
      steps.push({ e: A.e, s0: A.s, s1: via.side === 'a' ? 0 : edges[A.e].len });
      break;
    }
    const e = edges[via.edge];
    steps.push({ e: via.edge, s0: via.node === e.a ? 0 : e.len, s1: via.node === e.a ? e.len : 0 });
    n = via.node;
  }
  return { length: best, steps: steps.reverse() };
}

// The point `s` metres along a list of points with running distances `cum`
function pointAlong(pts, cum, s) {
  if (s <= 0) return pts[0];
  if (s >= cum[cum.length - 1]) return pts[pts.length - 1];
  const i = lastIndexAtMost(cum, s);
  const f = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
}

function lastIndexAtMost(cum, s) { // the last i with cum[i] <= s (cum only grows)
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}

// The points of one step of a way, in the direction of travel
function stepPoints(step) {
  const e = network.edges[step.e];
  const lo = Math.min(step.s0, step.s1);
  const hi = Math.max(step.s0, step.s1);
  const out = [pointAlong(e.pts, e.cum, lo)];
  for (let i = 0; i < e.pts.length; i++) if (e.cum[i] > lo && e.cum[i] < hi) out.push(e.pts[i]);
  out.push(pointAlong(e.pts, e.cum, hi));
  return step.s0 <= step.s1 ? out : out.reverse();
}

// The way along the lines between two timetable points as [lat, lng] points, or null if there isn't a believable one
const wayCache = new Map();
function wayBetween(A, B) {
  if (!network) return null;
  const key = `${A.lat},${A.lng}|${B.lat},${B.lng}`;
  if (wayCache.has(key)) return wayCache.get(key);
  let way = null;
  const sa = snapsFor(A.lat, A.lng);
  const sb = snapsFor(B.lat, B.lng);
  if (sa.length && sb.length) {
    const r = routeAlong(sa, sb);
    if (r && r.length <= DETOUR_FACTOR * metresBetween([A.lat, A.lng], [B.lat, B.lng]) + 3000) {
      way = [];
      for (const step of r.steps) {
        for (const p of stepPoints(step)) {
          const last = way[way.length - 1];
          if (!last || last[0] !== p[0] || last[1] !== p[1]) way.push(p);
        }
      }
    }
  }
  wayCache.set(key, way);
  return way;
}

// A train's whole route as one line: every timetable point it passes (not only its stops), each pair joined
// along the lines. A pair that can't be matched becomes a straight stretch, drawn dashed. The shape never
// changes once built; only where the train is on it does (see updateSplit).
function buildRoute(points) {
  const pts = [];  // [lat, lng] along the whole route
  const cum = [];  // metres from the start to each of those points
  const legs = []; // one per pair of neighbouring timetable points: the range of pts it covers, and whether it was matched
  const at = [];   // for every timetable point: the spot on the route line that is its place
  const add = (p) => {
    cum.push(pts.length ? cum[cum.length - 1] + metresBetween(pts[pts.length - 1], p) : 0);
    pts.push(p);
  };
  let spurs = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    let way = wayBetween(points[i], points[i + 1]);
    // A station's spot can be on a short dead-end stub beside the through track. The way in and the way
    // out then run back over each other; cut that out and let the route pass the station on the through line.
    if (way && i > 0 && legs[i - 1].matched) {
      const J = pts.length - 1;
      // Follow the way out of the station while it stays on the way we came in by; `base` is where it leaves it
      let m = -1;
      let base = null;
      while (m + 1 < way.length - 1) {
        let near = null;
        for (let k = J - 1; k >= 0 && cum[J] - cum[k] <= SPUR_MAX_M + 100; k--) {
          const { d, t } = distToSegment(way[m + 1], pts[k], pts[k + 1]);
          if (!near || d < near.d) near = { d, k, t };
        }
        if (!near || near.d > SPUR_MATCH_M || (base && near.k > base.k + 1)) break; // it left the way in, or ran forward again
        base = near;
        m++;
      }
      if (base) {
        const at0 = cum[base.k] + base.t * (cum[base.k + 1] - cum[base.k]); // metres along the route where it leaves
        if (cum[J] - at0 >= SPUR_MIN_M && cum[J] - at0 <= SPUR_MAX_M) {
          const point = pointAlong(pts, cum, at0);
          pts.length = base.k + 1;
          cum.length = base.k + 1;
          add(point);
          const last = pts.length - 1;
          // The stub can reach back over several short legs: they now end at the point where the route leaves the line
          for (let j = i - 1; j >= 0 && legs[j].i1 > last; j--) {
            legs[j].i1 = last;
            legs[j].i0 = Math.min(legs[j].i0, last);
            at[j + 1] = point;
          }
          at[i] = point;
          way = way.slice(m + 1);
          spurs++;
        }
      }
    }
    const i0 = Math.max(0, pts.length - 1);
    if (way) {
      way.forEach(add);
    } else {
      if (!pts.length) add([points[i].lat, points[i].lng]);
      add([points[i + 1].lat, points[i + 1].lng]);
    }
    if (i === 0) at.push(pts[0]);
    at.push(pts[pts.length - 1]);
    legs.push({ i0, i1: pts.length - 1, matched: Boolean(way) });
  }
  const atCode = new Map();
  points.forEach((p, i) => { if (p.code && !atCode.has(p.code)) atCode.set(p.code, at[i]); });
  return { pts, cum, legs, at, atCode, spurs, matchedLegs: legs.filter((l) => l.matched).length };
}

// The train's route, worked out once and kept. It is rebuilt only if its timetable points change or the
// lines have just arrived.
function ensureRoute(state) {
  const d = state.details;
  const key = (network ? 'lines:' : 'no-lines:') + d.points.map((p) => `${p.lat},${p.lng}`).join(';');
  if (!state.route || state.route.key !== key) {
    state.route = buildRoute(d.points);
    state.route.key = key;
    state.split = null; // distances along a rebuilt route are new, so the old split means nothing on it
  }
  return state.route;
}

// Snap the train onto its route line and remember where: that point splits "done" from "ahead".
// Only the legs around the one the timetable says the train is on are searched, so a route that passes the
// same place twice can't pull the train to the wrong visit. A train more than a kilometre from the line
// keeps its last split.
function updateSplit(state) {
  const route = state.route;
  const d = state.details;
  if (!route.legs.length) return;
  const current = Math.max(0, Math.min(route.legs.length - 1, d.passedCount - 1));
  const first = route.legs[Math.max(0, current - 1)].i0;
  const last = route.legs[Math.min(route.legs.length - 1, current + 1)].i1;
  const here = [state.target.lat, state.target.lng];
  let best = null;
  for (let i = first; i < last; i++) {
    const { d: dist, t } = distToSegment(here, route.pts[i], route.pts[i + 1]);
    if (!best || dist < best.d) best = { d: dist, s: route.cum[i] + t * (route.cum[i + 1] - route.cum[i]) };
  }
  const known = state.split !== null && state.split !== undefined;
  if (best && best.d <= SPLIT_MAX_M) {
    const back = known ? state.split - best.s : 0; // metres backwards from where the split already is
    if (back <= 0 || back >= SPLIT_BACK_M) state.split = best.s;
  } else if (!known) {
    state.split = route.cum[route.legs[current].i0];
  }
}

// The route cut at the split into stretches: { from, to (metres along the route), behind, matched }
function routeParts(route, split) {
  const parts = [];
  const push = (from, to, behind, matched) => {
    if (to <= from) return;
    const last = parts[parts.length - 1];
    if (last && last.behind === behind && last.matched === matched) last.to = to;
    else parts.push({ from, to, behind, matched });
  };
  for (const leg of route.legs) {
    const s0 = route.cum[leg.i0];
    const s1 = route.cum[leg.i1];
    if (split >= s1) push(s0, s1, true, leg.matched);
    else if (split <= s0) push(s0, s1, false, leg.matched);
    else { push(s0, split, true, leg.matched); push(split, s1, false, leg.matched); }
  }
  return parts;
}

function sliceRoute(route, from, to) {
  const out = [pointAlong(route.pts, route.cum, from)];
  for (let i = lastIndexAtMost(route.cum, from) + 1; i < route.pts.length && route.cum[i] < to; i++) out.push(route.pts[i]);
  out.push(pointAlong(route.pts, route.cum, to));
  return out;
}

// ---------- The full-route panel ----------
const routeEl = document.getElementById('route');
const routeHead = document.getElementById('route-head');
const routeTiles = document.getElementById('route-tiles');
const routeStops = document.getElementById('route-stops');
const routeLayer = L.layerGroup().addTo(map);
let routeState = null;       // the train whose route is open
let routeFitPending = false; // zoom the map to the route once its data arrives

// "View full route": the card closes and the panel takes its place, so only one profile shows at a time
function openRoute(state) {
  const previous = routeState;
  routeState = state;
  state.marker.closePopup();
  routeEl.hidden = false;
  routeEl.style.setProperty('--rgb', typeColour(state).rgb); // the panel keeps the train's type colour
  mapEl.style.setProperty('--rgb', displayColour(state).rgb); // the line on the map follows the colour mode
  mapEl.classList.add('route-open');
  trails.requestDraw(); // other trains' tails fade back
  routeFitPending = true;
  if (NARROW_SCREEN.matches) setPanelCollapsed(true); // on a phone the route sheet needs the room
  if (previous && previous !== state) applyLook(previous);
  applyLook(state);
  routeStops.scrollTop = 0;
  delete routeStops.dataset.scrolled; // scroll to the next stop again for this train
  renderRoute(state);
  drawRoute(state);
  loadDetails(state); // refresh the delays now
}

function closeRoute() {
  const state = routeState;
  routeState = null;
  routeEl.hidden = true;
  mapEl.classList.remove('route-open');
  routeLayer.clearLayers();
  trails.requestDraw();
  if (state && trains.has(state.key)) applyLook(state);
}

function renderRoute(state) {
  const d = state.details;
  routeHead.style.setProperty('--rgb', typeColour(state).rgb);

  // The same identity as the card (icon, name, type and operator), with where the train goes under it
  const head = makeHead(state);
  head.style.flex = '1';
  head.style.paddingRight = '0';
  if (d && d.origin) head.querySelector('.head-text').append(makeEl('div', 'route-trip', `${d.origin} → ${d.destination}`));
  const close = makeEl('button', '', '×');
  close.id = 'route-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close route');
  close.addEventListener('click', closeRoute);
  routeHead.replaceChildren(head, close);

  const actions = makeEl('div', 'route-actions');
  actions.append(makeLinkButton(state));
  routeTiles.replaceChildren(makeTiles(state), actions);

  const items = [];
  if (d) {
    for (const stop of d.stops) items.push(makeStopItem(stop));
  } else {
    items.push(makeEl('li', 'tp-note', state.detailsError ? 'Route unavailable right now.' : 'Loading route…'));
  }
  routeStops.replaceChildren(...items);
  const nextItem = routeStops.querySelector('.stop.next, .stop.at');
  if (nextItem && !routeStops.dataset.scrolled) {
    routeStops.dataset.scrolled = '1';
    nextItem.scrollIntoView({ block: 'center' });
  }
}

// "19:42" or, when it differs from the timetable, "19:42 → 19:45" with the new time coloured
function timeLine(label, t) {
  const el = makeEl('span');
  if (t.cancelled) {
    el.className = 'cancelled';
    el.textContent = `${label} ${formatTime(t.scheduled)}`;
    return el;
  }
  const real = t.actual || t.estimate;
  el.append(`${label} ${formatTime(t.scheduled)}`);
  if (real && formatTime(real) !== formatTime(t.scheduled)) {
    const delay = makeEl('b', t.diff >= 5 ? 'd-bad' : t.diff > 0 ? 'd-late' : 'd-ok', ` → ${t.actual ? '' : '~'}${formatTime(real)}`);
    el.append(delay);
  }
  return el;
}

function makeStopItem(stop) {
  const li = makeEl('li', `stop ${stop.status}`);
  li.append(makeEl('span', 'dot'), makeEl('div', 'stop-name', stop.name),
    makeEl('div', 'stop-track', stop.track ? `Track ${stop.track}` : ''));
  const times = makeEl('div', 'stop-times');
  if (stop.arr) times.append(timeLine('arr', stop.arr));
  if (stop.dep) times.append(timeLine('dep', stop.dep));
  li.append(times);
  if (stop.status === 'at') li.append(makeEl('div', 'stop-flag', 'In the station now'));
  else if (stop.status === 'next') li.append(makeEl('div', 'stop-flag', 'Next stop'));
  return li;
}

// The route on the map: the part already travelled dim, the part ahead glowing, dashed where the lines
// couldn't be matched. The line itself is fixed; only the split between dim and glowing moves.
function drawRoute(state) {
  routeLayer.clearLayers();
  const d = state.details;
  if (!d || d.points.length < 2) return;
  const route = ensureRoute(state);
  updateSplit(state);
  const colour = displayColour(state);
  const hex = colour.hex;
  mapEl.style.setProperty('--rgb', colour.rgb); // the glow on the line

  for (const part of routeParts(route, state.split)) {
    const dashed = part.matched ? null : '2 9';
    L.polyline(sliceRoute(route, part.from, part.to), part.behind
      ? { color: hex, weight: 3, opacity: 0.4, dashArray: dashed, className: 'route-line', interactive: false }
      : { color: hex, weight: 4, opacity: 0.95, dashArray: dashed, className: 'route-line route-ahead', interactive: false }
    ).addTo(routeLayer);
  }

  for (const stop of d.stops) {
    const onLine = route.atCode.get(stop.code); // draw the stop where the route line passes it
    const place = onLine && (stop.lat === null || metresBetween(onLine, [stop.lat, stop.lng]) < 500)
      ? onLine : (stop.lat === null ? null : [stop.lat, stop.lng]);
    if (!place) continue;
    const done = stop.status === 'passed';
    L.circleMarker(place, {
      radius: 4, weight: 2, color: hex, fillColor: done ? hex : '#08141b', fillOpacity: 1
    }).bindTooltip(stop.name, { direction: 'top' }).addTo(routeLayer);
  }
}

function fitRoute(state) {
  const d = state.details;
  if (!d || d.points.length < 2) return;
  const bounds = L.latLngBounds(ensureRoute(state).pts);
  // Leave room for the panel: on the right on a computer, at the bottom on a phone
  const sheet = NARROW_SCREEN.matches
    ? { paddingTopLeft: [30, 60], paddingBottomRight: [30, routeEl.offsetHeight + creditEl.offsetHeight + 30] }
    : { paddingTopLeft: [280, 40], paddingBottomRight: [380, 60] };
  map.fitBounds(bounds, { ...sheet, maxZoom: 10 });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && routeState) closeRoute();
});

// ---------- Stats panel and legend ----------
const els = {
  total: document.getElementById('stat-total'),
  moving: document.getElementById('stat-moving'),
  fastest: document.getElementById('stat-fastest'),
  updated: document.getElementById('stat-updated'),
  status: document.getElementById('status')
};

const panel = document.getElementById('panel');
const panelToggle = document.getElementById('panel-toggle');
function setPanelCollapsed(collapsed) {
  panel.classList.toggle('is-collapsed', collapsed);
  panelToggle.setAttribute('aria-expanded', String(!collapsed));
}
panelToggle.addEventListener('click', () => setPanelCollapsed(!panel.classList.contains('is-collapsed')));
setPanelCollapsed(window.matchMedia('(max-width: 480px)').matches); // start collapsed on phones

// The legend lists either the five type colour groups or the delay bands, depending on the colour mode.
// Both count every train on the map (the "Right now" line at the top counts passenger trains only, and
// says so). Clicking an entry hides or shows those trains; each mode remembers its own hidden entries.
const legendEl = document.getElementById('legend');
const legendTitleEl = document.getElementById('legend-title');
let legendRows = new Map(); // entry id -> { li, count }

function buildLegend() {
  const delayMode = colourMode === 'delay';
  const items = delayMode ? DELAY_BANDS : GROUPS;
  const hidden = delayMode ? hiddenBands : hiddenTypes;
  legendTitleEl.textContent = delayMode ? 'Delay' : 'Train types';
  legendEl.replaceChildren();
  legendRows = new Map();
  for (const item of items) {
    const li = makeEl('li');
    const button = makeEl('button', 'legend-item' + (hidden.has(item.id) ? ' is-off' : ''));
    button.type = 'button';
    button.style.setProperty('--rgb', item.rgb);
    button.setAttribute('aria-pressed', String(!hidden.has(item.id)));
    const count = makeEl('span', 'legend-count', '0');
    button.append(makeEl('span', 'swatch'), makeEl('span', 'legend-name', item.name), count);
    button.addEventListener('click', () => {
      const off = !hidden.has(item.id);
      if (off) hidden.add(item.id);
      else hidden.delete(item.id);
      button.classList.toggle('is-off', off);
      button.setAttribute('aria-pressed', String(!off));
      for (const state of trains.values()) applyLook(state);
      trails.requestDraw();
    });
    li.append(button);
    legendEl.append(li);
    legendRows.set(item.id, { li, count });
  }
  updateLegendCounts();
}

function updateLegendCounts() {
  const delayMode = colourMode === 'delay';
  const counts = new Map();
  for (const state of trains.values()) {
    const id = delayMode ? state.band.id : state.cls.group;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  for (const [id, row] of legendRows) {
    const n = counts.get(id) || 0;
    row.count.textContent = n;
    row.li.hidden = id === 'nodata' && n === 0; // only mention "No delay data" if there are some
  }
}

// "Colour trains by: Type | Delay"
const modeButtons = { type: document.getElementById('mode-type'), delay: document.getElementById('mode-delay') };

function setColourMode(mode) {
  colourMode = mode;
  for (const [name, button] of Object.entries(modeButtons)) {
    button.setAttribute('aria-pressed', String(name === mode));
    button.classList.toggle('is-on', name === mode);
  }
  buildLegend();
  for (const state of trains.values()) applyLook(state);
  if (routeState && routeState.details) drawRoute(routeState); // the route line follows the mode too
  trails.requestDraw();
}
for (const [mode, button] of Object.entries(modeButtons)) {
  button.addEventListener('click', () => setColourMode(mode));
}
setColourMode('type');

// ---------- "Is it bad right now?" ----------
// Share of passenger trains (long-distance and commuter) that are on time, and that are 5+ minutes
// late, using the delay at each train's last station. Trains that haven't left their first station
// have no delay yet, so they are left out.
const netLineEl = document.getElementById('net-line');
const netNoteEl = document.getElementById('net-note');
const netBarEls = {
  ok: document.querySelector('#net-bar .ok'),
  late: document.querySelector('#net-bar .late'),
  bad: document.querySelector('#net-bar .bad')
};

const FEW_TRAINS = 20; // below this many counted trains the line shows counts, not percentages

// Whole-number percentages that add up to exactly 100 (largest remainders get the spare points)
function percentages(counts, total) {
  const exact = counts.map((c) => (100 * c) / total);
  const whole = exact.map(Math.floor);
  let spare = 100 - whole.reduce((a, b) => a + b, 0);
  exact.map((x, i) => [x - whole[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => {
    if (spare > 0) { whole[i] += 1; spare -= 1; }
  });
  return whole;
}

function updateNetworkStatus() {
  const usable = delaysUsable();
  let onTime = 0;
  let late = 0;
  let veryLate = 0;
  if (usable) {
    for (const state of trains.values()) {
      const category = state.info && state.info.category;
      if (category !== 'Long-distance' && category !== 'Commuter') continue; // passenger trains only
      if (state.delay === null) continue; // not departed yet: no delay reading
      if (state.delay <= 0) onTime += 1;
      else if (state.delay <= 4) late += 1;
      else veryLate += 1;
    }
  }
  const n = onTime + late + veryLate;

  netLineEl.replaceChildren('Right now: ');
  if (!usable) {
    netLineEl.append('delay data unavailable');
    netNoteEl.textContent = "Couldn't read delays just now.";
  } else if (n === 0) {
    netLineEl.append('no delay readings yet');
    netNoteEl.textContent = "Passenger trains that haven't departed yet have no delay and are left out.";
  } else {
    // All three bands are always shown, so the figures add up: to the train count, or to 100%.
    // With few trains a percentage says too much ("1 of 3" is not "33%"), so it shows counts instead.
    const few = n < FEW_TRAINS;
    const counts = [onTime, late, veryLate];
    if (few) {
      // "8 passenger trains: 4 on time · 1 late 1–4 min · 3 late 5+ min": the total once, then the three parts
      netLineEl.replaceChildren(`${n} passenger train${n === 1 ? '' : 's'}: `);
      [['d-ok', 'on time'], ['d-late', 'late 1–4 min'], ['d-bad', 'late 5+ min']].forEach(([cls, label], i) => {
        if (i > 0) netLineEl.append(' · ');
        netLineEl.append(makeEl('b', cls, `${counts[i]} ${label}`));
      });
      netNoteEl.textContent = 'Long-distance and commuter trains; trains not yet departed are left out. ' +
        'Few are running, so these are counts, not percentages.';
    } else {
      const shares = percentages(counts, n);
      [['d-ok', 'on time'], ['d-late', '1–4 min late'], ['d-bad', '5+ min late']].forEach(([cls, label], i) => {
        if (i > 0) netLineEl.append(' · ');
        netLineEl.append(makeEl('b', cls, `${shares[i]}% ${label}`));
      });
      netNoteEl.textContent = `${n} passenger trains counted (long-distance and commuter); trains not yet departed are left out.`;
    }
  }
  netBarEls.ok.style.width = n ? `${(100 * onTime) / n}%` : '0';
  netBarEls.late.style.width = n ? `${(100 * late) / n}%` : '0';
  netBarEls.bad.style.width = n ? `${(100 * veryLate) / n}%` : '0';
}

// ---------- The "i" next to Moving ----------
// A button (not a hover tooltip) so it works with a tap on a phone as well as a click.
const infoButton = document.getElementById('moving-info-btn');
const infoNote = document.getElementById('moving-info');

function setInfoOpen(open) {
  infoNote.hidden = !open;
  infoButton.setAttribute('aria-expanded', String(open));
}
infoButton.addEventListener('click', (e) => {
  e.stopPropagation();
  setInfoOpen(infoNote.hidden);
});
document.addEventListener('click', (e) => { // a tap anywhere else closes it
  if (!infoNote.hidden && !infoNote.contains(e.target)) setInfoOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setInfoOpen(false);
});

// Time (in ms) of the newest train report in the data, or null if there are none
function newestReport(list) {
  let newest = null;
  for (const t of list) {
    const ms = Date.parse(t.timestamp);
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

function showStats(list, newestMs) {
  const moving = list.filter((t) => t.speed > 0).length;
  const fastest = list.reduce((a, b) => (b.speed > a.speed ? b : a), list[0]);

  els.total.textContent = list.length;
  els.moving.textContent = moving;
  els.fastest.textContent = fastest
    ? `${trainName(typeInfo.get(fastest.key) || null, fastest.number)} · ${fastest.speed} km/h`
    : '–';
  // How fresh the data is: the time of the newest train report, not when this page last asked
  els.updated.textContent = newestMs === null ? '–' : TIME_SEC_FMT.format(new Date(newestMs));
}

// The warning line under the panel: shown when a refresh fails, or when the data is too old
function showStatus(text) {
  els.status.textContent = text;
  els.status.hidden = false;
}

function hideStatus() {
  els.status.hidden = true;
}

// ---------- Health check (in memory only: nothing is stored or sent anywhere) ----------
// Counts refreshes, failures and old data, and the longest stretch without fresh data,
// to check the "runs for 24 hours" goal. Type railPulseHealth() in the console to see it.
const health = {
  refreshes: 0,      // every attempt to refresh
  failed: 0,         // attempts that errored
  stale: 0,          // attempts that worked but returned data older than 2 minutes
  longestGapMs: 0,   // longest time between two pieces of fresh data
  lastFreshAt: null, // when we last got fresh data
  trackingSince: Date.now(), // where to measure a gap from until the first fresh data
  activeMs: 0,       // time the tab was visible (hidden tabs don't refresh, so they don't count)
  activeSince: document.hidden ? null : Date.now(),
  infoLookups: 0,    // successful type-and-delay lookups (the GraphQL request)
  infoBytesLatest: null, // size of the latest answer, in bytes of text after the browser unzipped it
  infoBytesLargest: 0    // and the biggest answer so far (it grows with the number of trains on the map)
};

function recordInfoSize(bytes) {
  health.infoLookups += 1;
  health.infoBytesLatest = bytes;
  health.infoBytesLargest = Math.max(health.infoBytesLargest, bytes);
}

function recordRefresh(outcome) { // outcome: 'fresh', 'stale' or 'failed'
  const now = Date.now();
  health.refreshes += 1;
  if (outcome === 'failed') health.failed += 1;
  if (outcome === 'stale') health.stale += 1;
  const since = health.lastFreshAt === null ? health.trackingSince : health.lastFreshAt;
  health.longestGapMs = Math.max(health.longestGapMs, now - since);
  if (outcome === 'fresh') health.lastFreshAt = now;
}

function pauseHealth() { // the tab was hidden: stop the clock
  if (health.activeSince !== null) health.activeMs += Date.now() - health.activeSince;
  health.activeSince = null;
  health.lastFreshAt = null;
}

function resumeHealth() { // the tab is visible again
  health.activeSince = Date.now();
  health.trackingSince = Date.now();
}

function healthSummary() {
  const activeMs = health.activeMs + (health.activeSince === null ? 0 : Date.now() - health.activeSince);
  const minutes = Math.round(activeMs / 60000);
  const gap = Math.round(health.longestGapMs / 1000);
  const kb = (bytes) => (bytes === null ? 'none yet' : `${(bytes / 1024).toFixed(1)} KB`);
  const line = `Rail Pulse health: ${health.refreshes} refreshes in ${minutes} min (${health.failed} failed, ` +
    `${health.stale} with old data), longest gap without fresh data ${gap} s` +
    (health.longestGapMs > STALE_MS ? ' (over the 2-minute limit)' : ' (within the 2-minute limit)') +
    `. Type-and-delay lookup answers (unzipped): latest ${kb(health.infoBytesLatest)}, largest ${kb(health.infoBytesLargest || null)}` +
    ` over ${health.infoLookups} lookups.`;
  return {
    refreshes: health.refreshes, failed: health.failed, staleData: health.stale,
    longestGapSeconds: gap, activeMinutes: minutes,
    graphqlLookups: health.infoLookups,
    graphqlLatestBytes: health.infoBytesLatest, graphqlLargestBytes: health.infoBytesLargest,
    line
  };
}

window.railPulseHealth = function railPulseHealth() {
  const summary = healthSummary();
  console.log(summary.line);
  return summary;
};
setInterval(() => console.log(healthSummary().line), 60 * 60 * 1000); // once an hour

// ---------- Pulse line: trains moving, since you opened the page ----------
// One point per successful refresh, kept in memory only (gone when you close or reload the page).
// The line breaks where there was a long pause (tab hidden, failed refreshes) instead of joining it up.
const pulse = []; // { t, moving }
const PULSE_GAP_MS = REFRESH_MS * 2.5;
const pulseSvg = document.getElementById('pulse-chart');
const pulseNowEl = document.getElementById('pulse-now');
const pulseRangeEl = document.getElementById('pulse-range');
const SVG_NS = 'http://www.w3.org/2000/svg';

function recordPulse(list) {
  pulse.push({ t: Date.now(), moving: list.filter((t) => t.speed > 0).length });
  if (pulse.length > 50000) pulse.shift(); // about 8 days of refreshes: only a safety limit
  drawPulse();
}

function durationText(ms) {
  const minutes = Math.round(ms / 60000);
  if (ms < 60000) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

function drawPulse() {
  const W = 200;
  const H = 44;
  const PAD = 3;
  const n = pulse.length;
  const last = pulse[n - 1];
  pulseNowEl.textContent = last.moving;
  pulseSvg.replaceChildren();
  if (n < 2) {
    pulseRangeEl.textContent = 'collecting…';
    pulseSvg.setAttribute('aria-label', `Trains moving: ${last.moving} now. More points are collected every 15 seconds.`);
    return;
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pulse) {
    lo = Math.min(lo, p.moving);
    hi = Math.max(hi, p.moving);
  }
  const span = Math.max(last.t - pulse[0].t, 1);
  const pad = Math.max(3, (hi - lo) * 0.15); // so a steady number draws as a calm line, not a jagged one
  const yMin = Math.max(0, lo - pad);
  const yMax = hi + pad;
  const x = (p) => PAD + ((p.t - pulse[0].t) / span) * (W - 2 * PAD);
  const y = (p) => H - PAD - ((p.moving - yMin) / (yMax - yMin)) * (H - 2 * PAD);

  // Split into runs at long pauses, thin out long runs so the drawing stays small
  const runs = [[pulse[0]]];
  for (let i = 1; i < n; i++) {
    if (pulse[i].t - pulse[i - 1].t > PULSE_GAP_MS) runs.push([]);
    runs[runs.length - 1].push(pulse[i]);
  }
  const step = Math.max(1, Math.ceil(n / 300));
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('class', 'pulse-line');
  let d = '';
  for (const run of runs) {
    const pts = run.filter((_, i) => i % step === 0 || i === run.length - 1);
    pts.forEach((p, i) => { d += `${i === 0 ? 'M' : 'L'}${x(p).toFixed(1)} ${y(p).toFixed(1)}`; });
    if (pts.length === 1) d += `h0.01`; // a lone point still shows (round cap)
  }
  line.setAttribute('d', d);
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', 'pulse-dot');
  dot.setAttribute('cx', x(last).toFixed(1));
  dot.setAttribute('cy', y(last).toFixed(1));
  dot.setAttribute('r', '2.6');
  pulseSvg.append(line, dot);

  const duration = durationText(span);
  pulseRangeEl.textContent = lo === hi ? String(lo) : `${lo}–${hi}`; // the range, short enough for one line
  pulseRangeEl.title = `Lowest and highest number moving over ${duration}`;
  pulseSvg.setAttribute('aria-label',
    `Trains moving since you opened the page, over ${duration}: ${last.moving} now, between ${lo} and ${hi}.`);
}

// ---------- Share a train ----------
// The card's "Copy link" gives a link ending in ?train=2026-11-11-27. Opening it centres the map on
// that train and opens its card, or says why the train can't be shown.
const noticeEl = document.getElementById('notice');
let noticeTimer = null;

function showNotice(text) {
  const close = makeEl('button', '', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', hideNotice);
  noticeEl.replaceChildren(text, close);
  noticeEl.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(hideNotice, 10000);
}

function hideNotice() {
  noticeEl.hidden = true;
}

function trainLink(state) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('train', state.key);
  return url.toString();
}

async function copyText(text) {
  try {
    // Some browsers never answer when clipboard access isn't allowed, so don't wait forever
    const giveUp = new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timed out')), 1500));
    await Promise.race([navigator.clipboard.writeText(text), giveUp]);
    return true;
  } catch (err) { /* not allowed here: try the older way below */ }
  try {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.append(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    return ok;
  } catch (err) {
    return false;
  }
}

async function copyTrainLink(state) {
  const url = trainLink(state);
  if (!(await copyText(url))) {
    window.prompt('Copy this link:', url); // last resort: let the person copy it by hand
    return;
  }
  state.copiedUntil = performance.now() + 2000; // the button says "Link copied" for 2 seconds
  const relabel = () => { // the card's button and the route panel's button
    const places = state === routeState ? [state.popupEl, routeEl] : [state.popupEl];
    for (const place of places) for (const b of place.querySelectorAll('.tp-link')) b.textContent = linkLabel(state);
  };
  relabel();
  setTimeout(relabel, 2050);
}

// The train key from the address, if the page was opened from a shared link
const linkedKey = new URLSearchParams(location.search).get('train');
let pendingLink = linkedKey && /^\d{4}-\d{2}-\d{2}-\d+$/.test(linkedKey) ? linkedKey : null;

async function openLinkedTrain() {
  const key = pendingLink;
  pendingLink = null;
  const state = trains.get(key);
  if (state) {
    map.setView(state.marker.getLatLng(), Math.max(map.getZoom(), 10), { animate: false });
    state.marker.openPopup();
    return;
  }
  const match = /^(\d{4}-\d{2}-\d{2})-(\d+)$/.exec(key);
  showNotice(await explainMissingTrain(match[1], Number(match[2])));
}

// A train that isn't in the position feed: ask Digitraffic why, so the message can be specific
async function explainMissingTrain(date, number) {
  try {
    const train = (await fetchJson(`${API_BASE}/trains/${date}/${number}`))[0];
    if (!train) return "That train isn't running any more.";
    if (train.cancelled) return 'That train was cancelled.';
    const rows = train.timeTableRows || [];
    if (rows.length && rows[rows.length - 1].actualTime) return "That train isn't running any more: it has finished its journey.";
    if (!rows.some((r) => r.actualTime)) return "That train hasn't started its journey yet.";
    return "That train isn't reporting a position right now.";
  } catch (err) {
    return "That train isn't running any more.";
  }
}

// ---------- Swipe the route sheet down to close it (phones) ----------
// Drag from the handle or the header; the sheet follows the finger and closes if you pull far or fast enough.
let sheetDrag = null;

routeEl.addEventListener('pointerdown', (e) => {
  if (!NARROW_SCREEN.matches || !e.target.closest('#route-head, #route-grab') || e.target.closest('button')) return;
  sheetDrag = { id: e.pointerId, startY: e.clientY, lastY: e.clientY, lastT: performance.now(), speed: 0 };
  routeEl.setPointerCapture(e.pointerId);
  routeEl.style.transition = 'none';
});

routeEl.addEventListener('pointermove', (e) => {
  if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
  const now = performance.now();
  sheetDrag.speed = (e.clientY - sheetDrag.lastY) / Math.max(now - sheetDrag.lastT, 1); // px per ms, down is positive
  sheetDrag.lastY = e.clientY;
  sheetDrag.lastT = now;
  routeEl.style.transform = `translateY(${Math.max(0, e.clientY - sheetDrag.startY)}px)`;
});

function endSheetDrag(e) {
  if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
  const pulled = Math.max(0, e.clientY - sheetDrag.startY);
  const close = pulled > 100 || (sheetDrag.speed > 0.6 && pulled > 20);
  sheetDrag = null;
  const reset = () => { routeEl.style.transition = ''; routeEl.style.transform = ''; };
  if (!close) {
    routeEl.style.transition = REDUCED_MOTION ? 'none' : 'transform 0.2s ease';
    routeEl.style.transform = '';
    return;
  }
  if (REDUCED_MOTION) {
    closeRoute();
    reset();
    return;
  }
  routeEl.style.transition = 'transform 0.2s ease';
  routeEl.style.transform = 'translateY(110%)';
  setTimeout(() => { closeRoute(); reset(); }, 200);
}
routeEl.addEventListener('pointerup', endSheetDrag);
routeEl.addEventListener('pointercancel', endSheetDrag);

// ---------- Refresh loop ----------
let firstLoad = true;
let refreshing = false; // a refresh is in progress
let timerId = null;     // the pending next refresh

// Schedule the next refresh. Not while the tab is hidden: nobody is looking, so don't ask Digitraffic.
function scheduleNext() {
  clearTimeout(timerId);
  timerId = document.hidden ? null : setTimeout(refresh, REFRESH_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(timerId);
    timerId = null;
    pauseHealth();
  } else {
    resumeHealth();
    refresh(); // straight away, so the map isn't showing old positions
  }
});

async function refresh() {
  if (refreshing) return; // never two at once; the one in progress schedules the next
  refreshing = true;
  clearTimeout(timerId);
  timerId = null;
  let outcome = 'failed';
  try {
    const raw = await fetchJson(LOCATIONS_URL);

    if (firstLoad) {
      console.log(`Fetched ${raw.length} trains. Example:`, raw[0]);
      firstLoad = false;
    }

    const list = cleanTrains(raw);

    // Look up train types and delays about once a minute, or sooner (not more than every 30 s)
    // when new trains have appeared that we don't know the type of
    const sinceInfo = Date.now() - lastInfoFetch;
    const newTrains = list.some((t) => !typeInfo.has(t.key) && !typeMissing.has(t.key));
    if (sinceInfo > INFO_REFRESH_MS || (newTrains && sinceInfo > TYPE_RETRY_MS)) {
      try {
        await loadInfo();
        for (const t of list) if (!typeInfo.has(t.key)) typeMissing.add(t.key);
      } catch (err) {
        // The trains still show: in the neutral "unknown" colour, and with the delays we already have
        console.error('Could not load train types and delays:', err);
      }
    }

    updateTrains(list);
    const newest = newestReport(list);
    showStats(list, newest);
    recordPulse(list);
    if (pendingLink) openLinkedTrain(); // the page was opened from a shared train link

    // The request worked, but is the data itself recent? (Uses this device's clock.)
    const ageMs = newest === null ? Infinity : Date.now() - newest;
    if (ageMs > STALE_MS) {
      outcome = 'stale';
      showStatus(newest === null
        ? 'No train reports in the data right now.'
        : `Data may be out of date: the newest train report is ${Math.floor(ageMs / 60000)} min old.`);
    } else {
      outcome = 'fresh';
      hideStatus();
    }
  } catch (err) {
    // Keep the last markers and numbers on screen; just tell the user.
    console.error('Refresh failed:', err);
    showStatus("Couldn't load data, retrying…");
  } finally {
    refreshing = false;
    if (!document.hidden) recordRefresh(outcome);
    // Schedule the next run only after this one ends, so requests never overlap.
    scheduleNext();
  }
}

loadNetwork(); // the rail lines load alongside the first train positions; neither waits for the other
refresh();
