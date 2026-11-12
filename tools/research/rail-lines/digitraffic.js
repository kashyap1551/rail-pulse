const fs = require('fs');
const { tm35finToLonLat, lengthKm, measure } = require('./lib.js');
const S = process.argv[2];

const src = JSON.parse(fs.readFileSync(S + '/radat.json', 'utf8'));
console.log('features', src.features.length, '| crs:', JSON.stringify(src.crs || null).slice(0, 100));
const withGeom = src.features.filter((f) => f.geometry && f.geometry.coordinates);
console.log('with geometry', withGeom.length, '| property keys:', Object.keys(withGeom[0].properties || {}).join(', '));
console.log('sample properties:', JSON.stringify(withGeom[0].properties).slice(0, 260));

// Convert metres -> lon/lat and flatten to a list of lines
const lines = [];
for (const f of withGeom) {
  const parts = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
  for (const part of parts) lines.push(part.map(([E, N]) => tm35finToLonLat(E, N)));
}
const pts = lines.reduce((n, l) => n + l.length, 0);
let minLon = 99, maxLon = 0, minLat = 99, maxLat = 0;
for (const l of lines) for (const [x, y] of l) { minLon = Math.min(minLon, x); maxLon = Math.max(maxLon, x); minLat = Math.min(minLat, y); maxLat = Math.max(maxLat, y); }
console.log(`converted: ${lines.length} lines, ${pts} points, ${lengthKm(lines).toFixed(0)} km of line`);
console.log(`extent lon ${minLon.toFixed(2)}..${maxLon.toFixed(2)}, lat ${minLat.toFixed(2)}..${maxLat.toFixed(2)} (Finland is about lon 20..32, lat 59.7..70.1)`);

for (const tol of [0, 10, 25, 50]) {
  const m = measure(lines, tol);
  console.log(`tolerance ${String(tol).padStart(2)} m: ${m.lines} lines, ${m.points} points, ${m.rawKB} KB raw, ${m.gzipKB} KB gzipped, ${lengthKm(m.out).toFixed(0)} km`);
  if (tol === 25) fs.writeFileSync(S + '/rail/digitraffic-25m.json', m.json);
}
