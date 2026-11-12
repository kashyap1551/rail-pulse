#!/usr/bin/env node
// Builds data/rail-network.json: the rail network the page draws under the trains and routes along.
//
// Run it by hand when the track data should be refreshed (the page itself never loads this file):
//   node tools/build-rail-network.js
// Options:  --days=8  --tolerance=1  --snap=12  --station-snap=1000  --out=data/rail-network.json
//
// Uses only Node's built-in modules (no packages). Downloads are kept in tools/.cache so a second run
// is instant; delete that folder to download again.
//
// What it does:
//  1. Downloads Digitraffic's track lines (infra-api radat.geojson, CC BY 4.0) and the station list.
//  2. Joins the line pieces into one network (pieces that end on, or next to, another piece are connected).
//  3. Downloads the timetables of the last few days (passenger, cargo and light-engine trains; not
//     shunting) and finds the shortest way along the network between every pair of timetable points
//     the trains go through. Only the stretches that real trains use are kept, which is what drops
//     yard tracks, sidings and unused parallel tracks while keeping every line and freight branch
//     that trains run on.
//  4. Simplifies the kept lines and writes them in a compact form (see the format at the bottom).
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(__dirname, '.cache');
const BASE = 'https://rata.digitraffic.fi';
const HEADERS = { 'Digitraffic-User': 'rail-pulse-build-script' }; // Digitraffic asks clients to say who they are

const opt = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.slice(2).split('=');
  return [k, v === undefined ? true : v];
}));
const DAYS = Number(opt.days || 8);                 // how many past days of timetables to route
const TOLERANCE_M = Number(opt.tolerance || 1);     // simplification: lines stay within this many metres of the original
const SNAP_M = Number(opt.snap || 12);              // line pieces closer than this at their ends are joined
const STATION_SNAP_M = Number(opt['station-snap'] || 1000); // a station further than this from any line is left unmatched
const OUT = path.join(ROOT, opt.out || 'data/rail-network.json');
const ROUTED_CATEGORIES = new Set(['Long-distance', 'Commuter', 'Cargo', 'Locomotive', 'Test drive']);

// ---------- Coordinates: ETRS-TM35FIN (EPSG:3067, metres) <-> longitude/latitude ----------
// Digitraffic's track lines are in metres. Standard Krüger series for a transverse Mercator on GRS80.
const GRS80_A = 6378137;
const GRS80_F = 1 / 298.257222101;
const K0 = 0.9996;
const LON0 = (27 * Math.PI) / 180;
const FALSE_EASTING = 500000;
const N3 = GRS80_F / (2 - GRS80_F);
const AXIS = (GRS80_A / (1 + N3)) * (1 + (N3 * N3) / 4 + N3 ** 4 / 64);
const ALPHA = [N3 / 2 - (2 * N3 ** 2) / 3 + (5 * N3 ** 3) / 16, (13 * N3 ** 2) / 48 - (3 * N3 ** 3) / 5, (61 * N3 ** 3) / 240];
const BETA = [N3 / 2 - (2 * N3 ** 2) / 3 + (37 * N3 ** 3) / 96, N3 ** 2 / 48 + N3 ** 3 / 15, (17 * N3 ** 3) / 480];
const DELTA = [2 * N3 - (2 * N3 ** 2) / 3 - 2 * N3 ** 3, (7 * N3 ** 2) / 3 - (8 * N3 ** 3) / 5, (56 * N3 ** 3) / 15];

function toLonLat(E, N) {
  const xi = N / (K0 * AXIS);
  const eta = (E - FALSE_EASTING) / (K0 * AXIS);
  let xiP = xi;
  let etaP = eta;
  BETA.forEach((b, i) => {
    const j = 2 * (i + 1);
    xiP -= b * Math.sin(j * xi) * Math.cosh(j * eta);
    etaP -= b * Math.cos(j * xi) * Math.sinh(j * eta);
  });
  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  let lat = chi;
  DELTA.forEach((d, i) => { lat += d * Math.sin(2 * (i + 1) * chi); });
  const lon = LON0 + Math.atan(Math.sinh(etaP) / Math.cos(xiP));
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

function toMetres(lon, lat) {
  const phi = (lat * Math.PI) / 180;
  const lam = (lon * Math.PI) / 180 - LON0;
  const c = (2 * Math.sqrt(N3)) / (1 + N3);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - c * Math.atanh(c * Math.sin(phi)));
  const xi1 = Math.atan2(t, Math.cos(lam));
  const eta1 = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let xi = xi1;
  let eta = eta1;
  ALPHA.forEach((a, i) => {
    const j = 2 * (i + 1);
    xi += a * Math.sin(j * xi1) * Math.cosh(j * eta1);
    eta += a * Math.cos(j * xi1) * Math.sinh(j * eta1);
  });
  return [FALSE_EASTING + K0 * AXIS * eta, K0 * AXIS * xi];
}

// ---------- Downloads (cached) ----------
async function getJson(url, cacheName) {
  const file = path.join(CACHE, cacheName);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`  downloading ${url}`);
  const res = await fetch(url, { headers: HEADERS }); // Node's fetch follows redirects and asks for gzip, which Digitraffic requires
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  return JSON.parse(text);
}

function pastDates(count) { // yesterday and the days before it, as Finnish calendar dates
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' });
  const out = [];
  for (let i = 1; i <= count; i++) out.push(fmt.format(new Date(Date.now() - i * 86400000)));
  return out;
}

// ---------- Geometry helpers (planar, metres) ----------
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

function simplifyLine(points, tol) { // Douglas-Peucker; keeps the first and last point
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const { d } = distToSegment(points[i][0], points[i][1], points[s][0], points[s][1], points[e][0], points[e][1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}

function lineLength(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return m;
}

class UnionFind {
  constructor(n) { this.p = new Int32Array(n).map((_, i) => i); }
  find(a) { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[a] = b; }
}

// A spatial index over line segments, for "nearest line to this point"
class SegmentIndex {
  constructor(lines, cell) {
    this.lines = lines;
    this.cell = cell;
    this.grid = new Map();
    lines.forEach((l, li) => {
      for (let i = 1; i < l.length; i++) {
        const [x1, y1] = l[i - 1];
        const [x2, y2] = l[i];
        for (let cx = Math.floor(Math.min(x1, x2) / cell); cx <= Math.floor(Math.max(x1, x2) / cell); cx++) {
          for (let cy = Math.floor(Math.min(y1, y2) / cell); cy <= Math.floor(Math.max(y1, y2) / cell); cy++) {
            const k = cx * 1000003 + cy;
            if (!this.grid.has(k)) this.grid.set(k, []);
            this.grid.get(k).push([li, i - 1]);
          }
        }
      }
    });
  }

  // every segment within r metres of (x, y): [{ li, si, d, t }]
  within(x, y, r) {
    const out = [];
    const seen = new Set();
    const c = this.cell;
    const rr = Math.ceil(r / c);
    const cx = Math.floor(x / c);
    const cy = Math.floor(y / c);
    for (let i = -rr; i <= rr; i++) {
      for (let j = -rr; j <= rr; j++) {
        for (const [li, si] of this.grid.get((cx + i) * 1000003 + (cy + j)) || []) {
          const id = li * 4194304 + si;
          if (seen.has(id)) continue;
          seen.add(id);
          const a = this.lines[li][si];
          const b = this.lines[li][si + 1];
          const { d, t } = distToSegment(x, y, a[0], a[1], b[0], b[1]);
          if (d <= r) out.push({ li, si, d, t });
        }
      }
    }
    return out;
  }

  nearest(x, y, maxR) {
    let best = null;
    for (let r = 50; r <= maxR * 2; r *= 2) {
      const hits = this.within(x, y, Math.min(r, maxR));
      for (const h of hits) if (!best || h.d < best.d) best = h;
      if (best || r >= maxR) break;
    }
    return best;
  }
}

// ---------- Step 2: join the line pieces into one network ----------
// Two pieces are joined where they meet:
//  - the end of a piece lies within `snap` metres of a point (end to end) or of the middle of a segment
//    (a branch leaving the side of a line, which we split there) of another piece or of the same piece;
//  - any point of a piece lies within OVERLAP_M of another piece: the two run on top of each other (the
//    data draws some stretches twice, for two line numbers), so they are the same track.
// Pieces that merely cross or run side by side (tracks are 3.5 m or more apart) stay separate.
const OVERLAP_M = 1.5;

function nodePieces(pieces, snap) {
  const index = new SegmentIndex(pieces, 30);
  const inserts = pieces.map(() => []);   // per piece: points added inside a segment
  const joins = [];                        // pairs of references to join: { p, v } an original vertex, or { ins } an insert
  let insertCount = 0;

  pieces.forEach((pts, pi) => {
    for (let vi = 0; vi < pts.length; vi++) {
      const isEnd = vi === 0 || vi === pts.length - 1;
      const reach = isEnd ? snap : OVERLAP_M;
      const [x, y] = pts[vi];
      // Other pieces count, and so do far-away parts of the same piece (a line that ends on itself, like a loop)
      const hits = index.within(x, y, reach).filter((h) =>
        h.li !== pi || (isEnd && Math.min(Math.abs(h.si - vi), Math.abs(h.si + 1 - vi)) >= 3));
      if (!hits.length) continue;
      // the points (not segment middles) of other pieces within reach
      const vertexHits = [];
      for (const h of hits) {
        const l = pieces[h.li];
        for (const v of [h.si, h.si + 1]) {
          const d = Math.hypot(l[v][0] - x, l[v][1] - y);
          if (d <= reach) vertexHits.push({ p: h.li, v, d, end: v === 0 || v === l.length - 1 });
        }
      }
      if (vertexHits.length) {
        vertexHits.sort((a, b) => a.d - b.d);
        joins.push([{ p: pi, v: vi }, { p: vertexHits[0].p, v: vertexHits[0].v }]);
        if (isEnd) for (const v of vertexHits.slice(1)) if (v.end) joins.push([{ p: pi, v: vi }, { p: v.p, v: v.v }]);
        continue;
      }
      const best = hits.reduce((a, b) => (b.d < a.d ? b : a));
      const l = pieces[best.li];
      const a = l[best.si];
      const b = l[best.si + 1];
      const px = a[0] + best.t * (b[0] - a[0]);
      const py = a[1] + best.t * (b[1] - a[1]);
      // reuse an insert that is already there (three lines meeting at one point)
      let ins = inserts[best.li].find((n) => n.si === best.si && Math.hypot(n.x - px, n.y - py) <= reach);
      if (!ins) {
        ins = { id: insertCount++, si: best.si, t: best.t, x: px, y: py };
        inserts[best.li].push(ins);
      }
      joins.push([{ p: pi, v: vi }, { ins: ins.id }]);
    }
  });

  // Rebuild every piece with its inserted points, and give every point a global number
  const rebuilt = [];
  const origIndex = [];          // piece -> original vertex -> new vertex number
  const insertNumber = new Map(); // insert id -> new vertex number
  const base = [];
  let total = 0;
  pieces.forEach((pts, pi) => {
    base.push(total);
    const ins = inserts[pi].slice().sort((a, b) => a.si - b.si || a.t - b.t);
    const out = [];
    const map = [];
    let k = 0;
    for (let i = 0; i < pts.length; i++) {
      map.push(total + out.length);
      out.push(pts[i]);
      while (k < ins.length && ins[k].si === i) {
        insertNumber.set(ins[k].id, total + out.length);
        out.push([ins[k].x, ins[k].y]);
        k++;
      }
    }
    rebuilt.push(out);
    origIndex.push(map);
    total += out.length;
  });

  const uf = new UnionFind(total);
  const ref = (r) => (r.ins !== undefined ? insertNumber.get(r.ins) : origIndex[r.p][r.v]);
  for (const [a, b] of joins) uf.union(ref(a), ref(b));

  // Merged points sit at the average of their members
  const sum = new Map();
  const flat = rebuilt.flat();
  flat.forEach(([x, y], g) => {
    const r = uf.find(g);
    const s = sum.get(r) || { x: 0, y: 0, n: 0 };
    s.x += x; s.y += y; s.n += 1;
    sum.set(r, s);
  });
  const nodeOf = (g) => uf.find(g);
  const position = (r) => { const s = sum.get(r); return [s.x / s.n, s.y / s.n]; };

  // One small piece of line (an "atom") for every step between two neighbouring points
  const atoms = [];
  const seenAtoms = new Set(); // a stretch drawn twice (on top of itself) is kept once
  const posCache = new Map();
  const at = (r) => { if (!posCache.has(r)) posCache.set(r, position(r)); return posCache.get(r); };
  rebuilt.forEach((pts, pi) => {
    for (let i = 1; i < pts.length; i++) {
      const a = nodeOf(base[pi] + i - 1);
      const b = nodeOf(base[pi] + i);
      if (a === b) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seenAtoms.has(key)) continue;
      seenAtoms.add(key);
      atoms.push({ a, b, pts: [at(a), at(b)] });
    }
  });
  return atoms;
}

// Merge chains of atoms that meet in twos into single lines between junctions and line ends
function compress(atoms) {
  const adj = new Map();
  const push = (n, i) => { if (!adj.has(n)) adj.set(n, []); adj.get(n).push(i); };
  atoms.forEach((e, i) => { push(e.a, i); push(e.b, i); });
  const through = (n) => { const l = adj.get(n); return l.length === 2 && l[0] !== l[1]; };
  const visited = new Uint8Array(atoms.length);
  const out = [];
  for (let i = 0; i < atoms.length; i++) {
    if (visited[i]) continue;
    visited[i] = 1;
    const forward = atoms[i].pts.slice();
    let cur = i;
    let node = atoms[i].b;
    while (through(node)) { // walk on from the b end
      const [e1, e2] = adj.get(node);
      const next = e1 === cur ? e2 : e1;
      if (visited[next]) break;
      visited[next] = 1;
      const n = atoms[next];
      const seg = n.a === node ? n.pts : n.pts.slice().reverse();
      for (let k = 1; k < seg.length; k++) forward.push(seg[k]);
      node = n.a === node ? n.b : n.a;
      cur = next;
    }
    const b = node;
    const backward = []; // points before the start, collected nearest-first
    cur = i;
    node = atoms[i].a;
    while (through(node)) { // and from the a end
      const [e1, e2] = adj.get(node);
      const prev = e1 === cur ? e2 : e1;
      if (visited[prev]) break;
      visited[prev] = 1;
      const n = atoms[prev];
      const seg = n.b === node ? n.pts : n.pts.slice().reverse(); // oriented to end at `node`
      for (let k = seg.length - 2; k >= 0; k--) backward.push(seg[k]);
      node = n.b === node ? n.a : n.b;
      cur = prev;
    }
    out.push({ a: node, b, pts: backward.reverse().concat(forward) });
  }
  return out;
}

// ---------- The routing graph over the compressed network ----------
class Network {
  constructor(edges) {
    this.edges = edges.map((e) => {
      const cum = [0];
      for (let i = 1; i < e.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]));
      return { a: e.a, b: e.b, pts: e.pts, cum, len: cum[cum.length - 1] };
    });
    this.adj = new Map();
    this.edges.forEach((e, i) => {
      for (const n of [e.a, e.b]) { if (!this.adj.has(n)) this.adj.set(n, []); this.adj.get(n).push(i); }
    });
    this.index = new SegmentIndex(this.edges.map((e) => e.pts), 100);
  }

  // The points on the network close to (x, y): the nearest line, plus every other line within `slack`
  // metres of it (a station often sits where several tracks overlap, and only some of them lead anywhere).
  // Each is { e, s (metres along edge e), d (metres away) }, nearest first.
  snapAll(x, y, maxR, slack = 15, limit = 8) {
    const first = this.index.nearest(x, y, maxR);
    if (!first) return [];
    const best = new Map(); // edge -> its nearest segment
    for (const h of this.index.within(x, y, first.d + slack)) {
      if (!best.has(h.li) || h.d < best.get(h.li).d) best.set(h.li, h);
    }
    return [...best.values()].sort((a, b) => a.d - b.d).slice(0, limit).map((h) => {
      const e = this.edges[h.li];
      return { e: h.li, s: e.cum[h.si] + h.t * (e.cum[h.si + 1] - e.cum[h.si]), d: h.d };
    });
  }

  // Shortest way from any of the starting points `As` to any of the end points `Bs` (each from snapAll).
  // Returns { length, steps: [{ e, s0, s1 }], a, b } or null. A step runs along edge e from s0 to s1 metres
  // from its start (s0 > s1 means against its direction). `a` and `b` say which candidates were used.
  // Being far from the line costs a little (twice the distance), which only decides between equal routes.
  route(As, Bs) {
    const dist = new Map();
    const from = new Map(); // node -> how it was reached
    const heap = new MinHeap();
    const relax = (n, d, via) => { if (d < (dist.has(n) ? dist.get(n) : Infinity)) { dist.set(n, d); from.set(n, via); heap.push(d, n); } };
    const targets = new Map(); // node -> [{ j, off, enter }]
    const addTarget = (n, j, off, enter) => { if (!targets.has(n)) targets.set(n, []); targets.get(n).push({ j, off, enter }); };
    As.forEach((A, i) => {
      const e = this.edges[A.e];
      relax(e.a, A.s + 2 * A.d, { start: i, side: 'a' });
      relax(e.b, e.len - A.s + 2 * A.d, { start: i, side: 'b' });
    });
    Bs.forEach((B, j) => {
      const e = this.edges[B.e];
      addTarget(e.a, j, B.s + 2 * B.d, 'a');
      addTarget(e.b, j, e.len - B.s + 2 * B.d, 'b');
    });
    let best = Infinity;
    let end = null;
    As.forEach((A, i) => Bs.forEach((B, j) => { // both on the same line: just go along it
      if (A.e === B.e && Math.abs(A.s - B.s) + 2 * A.d + 2 * B.d < best) { best = Math.abs(A.s - B.s) + 2 * A.d + 2 * B.d; end = { direct: true, i, j }; }
    }));
    const settled = new Set();
    while (heap.size) {
      const [d, n] = heap.pop();
      if (d > (dist.get(n) ?? Infinity) || settled.has(n)) continue;
      settled.add(n);
      if (d >= best) break;
      for (const t of targets.get(n) || []) if (d + t.off < best) { best = d + t.off; end = { node: n, j: t.j, enter: t.enter }; }
      for (const ei of this.adj.get(n) || []) {
        const e = this.edges[ei];
        relax(e.a === n ? e.b : e.a, d + e.len, { edge: ei, node: n });
      }
    }
    if (!end) return null;
    const pickSteps = (i, j, first, mid, last) => ({ steps: [...first, ...mid, ...last], a: As[i], b: Bs[j] });
    if (end.direct) {
      const r = pickSteps(end.i, end.j, [], [{ e: As[end.i].e, s0: As[end.i].s, s1: Bs[end.j].s }], []);
      return { length: Math.abs(As[end.i].s - Bs[end.j].s), ...r };
    }
    const B = Bs[end.j];
    const eb = this.edges[B.e];
    const lastStep = { e: B.e, s0: end.enter === 'a' ? 0 : eb.len, s1: B.s };
    const middle = [];
    let n = end.node;
    let startStep;
    let startIndex;
    for (;;) {
      const via = from.get(n);
      if (via.start !== undefined) {
        const A = As[via.start];
        startStep = { e: A.e, s0: A.s, s1: via.side === 'a' ? 0 : this.edges[A.e].len };
        startIndex = via.start;
        break;
      }
      const e = this.edges[via.edge];
      middle.push({ e: via.edge, s0: via.node === e.a ? 0 : e.len, s1: via.node === e.a ? e.len : 0 });
      n = via.node;
    }
    const r = pickSteps(startIndex, end.j, [startStep], middle.reverse(), [lastStep]);
    return { length: best, ...r };
  }
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a;
    a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
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

// ---------- Output format ----------
// { "v": 1, "unit": 1e-5, "nodes": [x0, y0, x1, y1, ...], "edges": [[a, b, dx1, dy1, dx2, dy2, ...], ...] }
// Coordinates are whole numbers of 1e-5 degrees (about 1 m): x is longitude, y is latitude. A node is an
// absolute position. An edge is the line between nodes a and b: the numbers after b are the steps (from the
// previous point, starting at node a) to each point in between; the line ends at node b.
const UNIT = 1e5;

function encode(edges) {
  const nodeId = new Map();
  const nodes = [];
  const nodeOf = (n, pt) => {
    if (!nodeId.has(n)) {
      const [lon, lat] = toLonLat(pt[0], pt[1]);
      nodeId.set(n, nodes.length / 2);
      nodes.push(Math.round(lon * UNIT), Math.round(lat * UNIT));
    }
    return nodeId.get(n);
  };
  const out = edges.map((e) => {
    const a = nodeOf(e.a, e.pts[0]);
    const b = nodeOf(e.b, e.pts[e.pts.length - 1]);
    let px = nodes[a * 2];
    let py = nodes[a * 2 + 1];
    const row = [a, b];
    for (let i = 1; i < e.pts.length - 1; i++) {
      const [lon, lat] = toLonLat(e.pts[i][0], e.pts[i][1]);
      const x = Math.round(lon * UNIT);
      const y = Math.round(lat * UNIT);
      row.push(x - px, y - py);
      px = x; py = y;
    }
    return row;
  });
  return { v: 1, unit: 1 / UNIT, nodes, edges: out };
}

// ---------- Main ----------
function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return `median ${q(0.5).toFixed(0)} m, 90th ${q(0.9).toFixed(0)} m, 99th ${q(0.99).toFixed(0)} m, max ${s[s.length - 1].toFixed(0)} m`;
}

async function main() {
  // Self-check of the coordinate conversion (there and back again must agree to a millimetre)
  const probe = toMetres(24.94, 60.17);
  const back = toLonLat(probe[0], probe[1]);
  if (Math.abs(back[0] - 24.94) > 1e-8 || Math.abs(back[1] - 60.17) > 1e-8) throw new Error('coordinate conversion check failed');

  console.log('1. Downloading track lines and stations');
  const radat = await getJson(`${BASE}/infra-api/0.7/radat.geojson`, 'radat.json');
  const stationList = await getJson(`${BASE}/api/v1/metadata/stations`, 'stations.json');
  const stations = new Map();
  for (const s of stationList) {
    if (typeof s.latitude === 'number' && typeof s.longitude === 'number') {
      const [x, y] = toMetres(s.longitude, s.latitude);
      stations.set(s.stationShortCode, { name: s.stationName, x, y });
    }
  }

  const pieces = [];
  for (const f of radat.features) {
    if (!f.geometry || f.geometry.type !== 'MultiLineString') continue;
    for (const line of f.geometry.coordinates) {
      const pts = line.filter((p, i) => i === 0 || p[0] !== line[i - 1][0] || p[1] !== line[i - 1][1]);
      if (pts.length > 1) pieces.push(pts);
    }
  }
  const fullKm = pieces.reduce((n, p) => n + lineLength(p), 0) / 1000;
  console.log(`   ${pieces.length} line pieces, ${fullKm.toFixed(0)} km (every track, yards and parallel tracks included)`);

  console.log('2. Joining the pieces into one network');
  const atoms = nodePieces(pieces, SNAP_M);
  const full = new Network(compress(atoms));
  console.log(`   ${full.edges.length} lines between ${full.adj.size} junctions and line ends`);

  console.log(`3. Routing the timetables of the last ${DAYS} days`);
  const pairs = new Map(); // "A-B" (alphabetical) -> { from, to, trains }
  let trainCount = 0;
  for (const date of pastDates(DAYS)) {
    const trains = await getJson(`${BASE}/api/v1/trains/${date}`, `trains-${date}.json`);
    for (const t of trains) {
      if (!ROUTED_CATEGORIES.has(t.trainCategory) || t.cancelled) continue;
      trainCount++;
      let prev = null;
      for (const r of t.timeTableRows || []) {
        if (r.stationShortCode === prev) continue; // arrival and departure at the same place
        if (prev !== null) {
          const key = prev < r.stationShortCode ? `${prev}-${r.stationShortCode}` : `${r.stationShortCode}-${prev}`;
          const p = pairs.get(key) || { from: prev, to: r.stationShortCode, trains: 0 };
          p.trains += 1;
          pairs.set(key, p);
        }
        prev = r.stationShortCode;
      }
    }
  }
  console.log(`   ${trainCount} trains give ${pairs.size} different pairs of neighbouring timetable points`);

  const snaps = new Map();
  const snapOf = (code) => {
    if (!snaps.has(code)) {
      const st = stations.get(code);
      snaps.set(code, st ? full.snapAll(st.x, st.y, STATION_SNAP_M) : []);
    }
    return snaps.get(code);
  };
  const used = new Set();
  const failures = { noPosition: [], tooFarFromLine: [], noPath: [], detour: [] };
  let routed = 0;
  const snapDistances = [];
  for (const p of pairs.values()) {
    const A = stations.get(p.from);
    const B = stations.get(p.to);
    if (!A || !B) { failures.noPosition.push(`${p.from}-${p.to}`); continue; }
    const sa = snapOf(p.from);
    const sb = snapOf(p.to);
    if (!sa.length || !sb.length) { failures.tooFarFromLine.push(`${!sa.length ? p.from : p.to}`); continue; }
    const r = full.route(sa, sb);
    if (!r) { failures.noPath.push(`${p.from}-${p.to}`); continue; }
    const straight = Math.hypot(A.x - B.x, A.y - B.y);
    if (r.length > 2.5 * straight + 3000) { failures.detour.push(`${p.from}-${p.to} (${(r.length / 1000).toFixed(1)} km for ${(straight / 1000).toFixed(1)} km straight)`); continue; }
    routed++;
    snapDistances.push(r.a.d, r.b.d);
    for (const s of r.steps) used.add(s.e);
  }
  console.log(`   routed ${routed} of ${pairs.size} pairs; station-to-line distance: ${stats(snapDistances)}`);
  for (const [name, list] of Object.entries(failures)) {
    if (list.length) console.log(`   not routed (${name}): ${list.length}${list.length <= 12 ? ' ' + [...new Set(list)].join(', ') : ' e.g. ' + [...new Set(list)].slice(0, 12).join(', ')}`);
  }

  console.log('4. Keeping only the lines trains use, simplifying, writing');
  const keptAtoms = [...used].map((i) => ({ a: full.edges[i].a, b: full.edges[i].b, pts: full.edges[i].pts }));
  const kept = compress(keptAtoms).map((e) => ({ a: e.a, b: e.b, pts: simplifyLine(e.pts, TOLERANCE_M) }));
  const keptKm = kept.reduce((n, e) => n + lineLength(e.pts), 0) / 1000;
  const points = kept.reduce((n, e) => n + e.pts.length, 0);
  const file = encode(kept);
  const json = JSON.stringify(file);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log(`   kept ${kept.length} lines, ${points} points, ${keptKm.toFixed(0)} km (from ${fullKm.toFixed(0)} km), simplified to within ${TOLERANCE_M} m`);
  console.log(`   wrote ${path.relative(ROOT, OUT)}: ${(Buffer.byteLength(json) / 1024).toFixed(0)} KB (${file.nodes.length / 2} junctions and ends)`);
  const zlib = require('zlib');
  console.log(`   (about ${(zlib.gzipSync(json).length / 1024).toFixed(0)} KB when the web server compresses it)`);

  // Check the written file: route the same pairs on what the page will actually load
  const check = new Network(decode(file));
  let ok = 0;
  const lost = [];
  for (const p of pairs.values()) {
    const A = stations.get(p.from);
    const B = stations.get(p.to);
    if (!A || !B) continue;
    const sa = check.snapAll(A.x, A.y, STATION_SNAP_M);
    const sb = check.snapAll(B.x, B.y, STATION_SNAP_M);
    const r = sa.length && sb.length ? check.route(sa, sb) : null;
    if (r && r.length <= 2.5 * Math.hypot(A.x - B.x, A.y - B.y) + 3000) ok++;
    else lost.push(`${p.from}-${p.to}`);
  }
  console.log(`5. Check on the written file: ${ok} of ${pairs.size} pairs can still be routed${lost.length ? '; not: ' + lost.slice(0, 15).join(', ') + (lost.length > 15 ? ' …' : '') : ''}`);
}

// Read the compact format back into edges in metres (used for the check above)
function decode(file) {
  const nodeAt = (i) => [file.nodes[i * 2], file.nodes[i * 2 + 1]];
  return file.edges.map((row) => {
    const [a, b] = row;
    let [x, y] = nodeAt(a);
    const ll = [[x, y]];
    for (let i = 2; i < row.length; i += 2) { x += row[i]; y += row[i + 1]; ll.push([x, y]); }
    ll.push(nodeAt(b));
    return { a, b, pts: ll.map(([px, py]) => toMetres(px / UNIT, py / UNIT)) };
  });
}

if (require.main === module) {
  main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
}

module.exports = { toLonLat, toMetres, nodePieces, compress, Network, SegmentIndex, simplifyLine, decode, encode, lineLength };
