// Helpers shared by the rail-line comparison: projection, simplification, size and length measurements.
const zlib = require('zlib');

// ETRS-TM35FIN (EPSG:3067, metres) -> longitude/latitude (GRS80 ellipsoid, same as WGS84 to well under a metre)
function tm35finToLonLat(E, N) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, lon0 = 27 * Math.PI / 180, E0 = 500000;
  const e2 = f * (2 - f), n = f / (2 - f);
  const A = (a / (1 + n)) * (1 + n * n / 4 + n ** 4 / 64);
  const xi = N / (k0 * A), eta = (E - E0) / (k0 * A);
  const b1 = n / 2 - 2 * n ** 2 / 3 + 37 * n ** 3 / 96, b2 = n ** 2 / 48 + n ** 3 / 15, b3 = 17 * n ** 3 / 480;
  let xiP = xi, etaP = eta;
  [[1, b1], [2, b2], [3, b3]].forEach(([j, b]) => {
    xiP -= b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  });
  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  const d1 = 2 * n - 2 * n ** 2 / 3 - 2 * n ** 3, d2 = 7 * n ** 2 / 3 - 8 * n ** 3 / 5, d3 = 56 * n ** 3 / 15;
  const lat = chi + d1 * Math.sin(2 * chi) + d2 * Math.sin(4 * chi) + d3 * Math.sin(6 * chi);
  const lon = lon0 + Math.atan(Math.sinh(etaP) / Math.cos(xiP));
  void e2;
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}

// Metres per degree at a given latitude (good enough for simplification tolerances)
const M_LAT = 111320;
const mLon = (lat) => 111320 * Math.cos(lat * Math.PI / 180);

// Douglas-Peucker simplification with a tolerance in metres; points are [lon, lat]
function simplify(points, tolM) {
  if (points.length <= 2) return points;
  const lat0 = points[0][1], kx = mLon(lat0), ky = M_LAT;
  const xs = points.map((p) => p[0] * kx), ys = points.map((p) => p[1] * ky);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const dx = xs[e] - xs[s], dy = ys[e] - ys[s], len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      let d;
      if (len2 === 0) d = Math.hypot(xs[i] - xs[s], ys[i] - ys[s]);
      else {
        const t = Math.max(0, Math.min(1, ((xs[i] - xs[s]) * dx + (ys[i] - ys[s]) * dy) / len2));
        d = Math.hypot(xs[i] - (xs[s] + t * dx), ys[i] - (ys[s] + t * dy));
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolM) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}

const round5 = (v) => Math.round(v * 1e5) / 1e5;

function lengthKm(lines) {
  let m = 0;
  for (const l of lines) for (let i = 1; i < l.length; i++) {
    m += Math.hypot((l[i][0] - l[i - 1][0]) * mLon(l[i][1]), (l[i][1] - l[i - 1][1]) * M_LAT);
  }
  return m / 1000;
}

// lines: array of arrays of [lon, lat]. Returns sizes of a compact JSON file at a given tolerance.
function measure(lines, tolM) {
  const out = lines.map((l) => simplify(l, tolM).map(([x, y]) => [round5(x), round5(y)])).filter((l) => l.length > 1);
  const json = JSON.stringify(out);
  return {
    tolM, lines: out.length, points: out.reduce((n, l) => n + l.length, 0),
    rawKB: +(Buffer.byteLength(json) / 1024).toFixed(0), gzipKB: +(zlib.gzipSync(json).length / 1024).toFixed(0), json, out
  };
}

module.exports = { tm35finToLonLat, simplify, round5, lengthKm, measure };
