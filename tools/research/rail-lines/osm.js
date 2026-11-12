const fs = require('fs');
const { lengthKm, measure } = require('./lib.js');
const S = process.argv[2];

const osm = JSON.parse(fs.readFileSync(S + '/rail/osm-main.json', 'utf8'));
const ways = osm.elements.filter((e) => e.type === 'way' && e.geometry);
console.log('OSM snapshot time:', osm.osm3s.timestamp_osm_base, '| ways:', ways.length);
const usage = {};
for (const w of ways) { const u = (w.tags && w.tags.usage) || '(no usage tag)'; usage[u] = (usage[u] || 0) + 1; }
console.log('ways by usage tag:', JSON.stringify(usage));

const toLine = (w) => w.geometry.map((p) => [p.lon, p.lat]);
const all = ways.map(toLine);
const mainOnly = ways.filter((w) => ['main', 'branch'].includes(w.tags && w.tags.usage)).map(toLine);
const kmAll = lengthKm(all), kmMain = lengthKm(mainOnly);
console.log(`all railway=rail without service tag: ${all.length} lines, ${all.reduce((n, l) => n + l.length, 0)} points, ${kmAll.toFixed(0)} km`);
console.log(`usage main+branch only:               ${mainOnly.length} lines, ${kmMain.toFixed(0)} km`);

for (const [label, lines] of [['all', all], ['main+branch', mainOnly]]) {
  for (const tol of [10, 25, 50]) {
    const m = measure(lines, tol);
    console.log(`OSM ${label.padEnd(11)} tolerance ${String(tol).padStart(2)} m: ${m.lines} lines, ${m.points} points, ${m.rawKB} KB raw, ${m.gzipKB} KB gzipped`);
    if (tol === 25) fs.writeFileSync(`${S}/rail/osm-${label === 'all' ? 'all' : 'main'}-25m.json`, m.json);
  }
}

// How well do the two datasets agree? Sample points every ~200 m along one and see whether the other has a line within 150 m.
const dt = JSON.parse(fs.readFileSync(S + '/rail/digitraffic-25m.json', 'utf8'));
const kx = 111320 * Math.cos(63 * Math.PI / 180), ky = 111320;
function densify(lines, stepM) {
  const pts = [];
  for (const l of lines) for (let i = 1; i < l.length; i++) {
    const dx = (l[i][0] - l[i - 1][0]) * kx, dy = (l[i][1] - l[i - 1][1]) * ky, d = Math.hypot(dx, dy);
    const n = Math.max(1, Math.round(d / stepM));
    for (let k = 0; k < n; k++) pts.push([(l[i - 1][0] + (l[i][0] - l[i - 1][0]) * k / n) * kx, (l[i - 1][1] + (l[i][1] - l[i - 1][1]) * k / n) * ky]);
  }
  return pts;
}
function grid(pts, cell) { const g = new Map(); for (const [x, y] of pts) { const k = Math.floor(x / cell) + ',' + Math.floor(y / cell); (g.get(k) || g.set(k, []).get(k)).push([x, y]); } return g; }
function near(g, cell, x, y, r) {
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [px, py] of (g.get((cx + i) + ',' + (cy + j)) || [])) if (Math.hypot(px - x, py - y) <= r) return true;
  return false;
}
const R = 150, CELL = 200;
const dtPts = densify(dt, 50), osmMainPts = densify(mainOnly, 50), osmAllPts = densify(all, 50);
const gDT = grid(dtPts, CELL), gMain = grid(osmMainPts, CELL), gAll = grid(osmAllPts, CELL);
const share = (from, g) => (100 * from.filter(([x, y]) => near(g, CELL, x, y, R)).length / from.length).toFixed(0);
console.log(`\nAgreement within ${R} m:`);
console.log(`  Digitraffic line that has an OSM main/branch line nearby: ${share(dtPts, gMain)}%   (any OSM rail: ${share(dtPts, gAll)}%)`);
console.log(`  OSM main/branch line that has a Digitraffic line nearby:  ${share(osmMainPts, gDT)}%`);
console.log(`  OSM all rail that has a Digitraffic line nearby:          ${share(osmAllPts, gDT)}%`);
