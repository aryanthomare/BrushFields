// =============================================================================
//  Vector Field Painter
//
//  Type a velocity field  dx/dt = f(x, y, t),  dy/dt = g(x, y, t),
//  drop particles into it, and p5.brush traces where they go.
//
//  Layers (bottom to top):
//    paperFB  — p5 framebuffer holding the finished ("dry") paint. Strokes
//               are committed here once and never redrawn.
//    #paper   — the visible p5 WEBGL canvas. Every frame it shows paperFB
//               and then paints each particle's stroke in progress ("wet"),
//               from where that stroke began up to the particle, so the
//               brush is seen travelling with the particle.
//    layers   — with a finite lifetime and "fade" on, particles born at about
//               the same time share a framebuffer of their own, white where
//               nothing is painted, multiplied over paperFB. Once all of its
//               particles have died the layer fades to white and is dropped,
//               so the trails vanish with their particles. (p5.brush always
//               paints opaquely and mixes against white where the target is
//               transparent, so a transparent layer per particle won't work.)
//    #overlay — plain 2D canvas: field arrows, axes, particle dots. Kept
//               separate so it never gets baked into the artwork.
//
//  The wet stroke is redrawn from scratch every frame with a fixed random
//  seed and colour, so its texture holds still while it grows, and it looks
//  the same when it is finally committed to paperFB.
//
//  Pipeline per frame:
//    integrate (RK4)  →  record points in world units  →  commit finished
//    strokes to paperFB  →  show paperFB  →  paint the wet strokes on top.
//
//  Paint styles (see drawPaintStroke):
//    dry         — one brush.spline with a built-in pencil / ink brush
//    bristle     — oil-style: a dozen separate bristles, each its own thin
//                  stroke that wanders, runs dry at its own point, and takes
//                  a darker or lighter load of paint; a faint body fills gaps
//    gouache     — an opaque body (brush.wash on a ribbon polygon) with the
//                  same bristles dragged through it for texture
//    watercolour — a ribbon polygon with p5.brush's watercolour fill
//  Paint strokes are "dips": a fixed length of path, tapered at both ends,
//  each with a slightly different mix of the colour.
// =============================================================================

/* global p5, brush, math */

const PAPER = "#f3f2ee";
const PALETTE = ["#1b2a4a", "#a23b2a", "#2f6b4f", "#b8862b", "#5b3f7a", "#1f6f8b", "#3a3a3a"];
const BASE_SIZE = 600;          // brush.scaleBrushes(3) looks right at 600 px
const MAX_PARTICLES = 400;
const LIVE_CHUNK = 24;          // points per pencil stroke when the live brush is off
const CLEAN_CHUNK = 420;        // points per stroke when redrawing cleanly
const SPEED_CHUNK = 36;         // shorter strokes when colour follows speed
const FRAME_BUDGET_MS = 14;     // time allowed for brush drawing per frame
const POINT_GAP = 2.5;          // min px between recorded points (at 600 px)
const MAX_LAYERS = 6;           // fading layers alive at once (each is a full-size framebuffer)
const FADE_FRAMES = 80;         // frames a layer takes to fade out
const STYLES = {
  dry:         { label: "Pencil & ink" },
  bristle:     { label: "Oil (bristle brush)" },
  gouache:     { label: "Gouache" },
  watercolour: { label: "Watercolour" },
};

// ── Presets ───────────────────────────────────────────────────────────────────
// Each preset sets the equations, the window onto the plane, the parameters
// a–d (usable inside the equations) and a sensible time step.
const PRESETS = {
  center: {
    label: "Centre (harmonic oscillator)",
    fx: "y", fy: "-x",
    domain: [-3, 3, -3, 3], params: { a: 1, b: 0, c: 0, d: 0 }, dt: 0.02,
    note: "Closed orbits around a neutral fixed point at the origin.",
  },
  spiral: {
    label: "Spiral sink",
    fx: "a*x - y", fy: "x + a*y",
    domain: [-3, 3, -3, 3], params: { a: -0.15, b: 0, c: 0, d: 0 }, dt: 0.02,
    note: "Set a > 0 to turn the sink into a source.",
  },
  saddle: {
    label: "Saddle point",
    fx: "a*x", fy: "-b*y",
    domain: [-3, 3, -3, 3], params: { a: 1, b: 1, c: 0, d: 0 }, dt: 0.01,
    note: "One stable and one unstable direction through the origin.",
  },
  vanderpol: {
    label: "Van der Pol oscillator",
    fx: "y", fy: "a*(1 - x^2)*y - x",
    domain: [-4, 4, -5, 5], params: { a: 1, b: 0, c: 0, d: 0 }, dt: 0.01,
    note: "Every orbit is pulled onto one limit cycle. a sets the nonlinearity.",
  },
  hopf: {
    label: "Hopf limit cycle",
    fx: "a*x - y - x*(x^2 + y^2)", fy: "x + a*y - y*(x^2 + y^2)",
    domain: [-2, 2, -2, 2], params: { a: 1, b: 0, c: 0, d: 0 }, dt: 0.01,
    note: "Circle of radius √a. For a < 0 the cycle disappears into a sink.",
  },
  lotka: {
    label: "Lotka–Volterra (predator–prey)",
    fx: "a*x - b*x*y", fy: "d*x*y - c*y",
    domain: [0, 6, 0, 5], params: { a: 1, b: 0.6, c: 0.8, d: 0.4 }, dt: 0.01,
    note: "x = prey, y = predators. Orbits circle the coexistence point (c/d, a/b).",
  },
  pendulum: {
    label: "Damped pendulum",
    fx: "y", fy: "-sin(x) - a*y",
    domain: [-7, 7, -4, 4], params: { a: 0.12, b: 0, c: 0, d: 0 }, dt: 0.02,
    note: "x = angle, y = angular velocity. a is friction; set a = 0 for no damping.",
  },
  cells: {
    label: "Cellular flow",
    fx: "sin(x)*cos(y)", fy: "-cos(x)*sin(y)",
    domain: [-6.3, 6.3, -4.2, 4.2], params: { a: 1, b: 0, c: 0, d: 0 }, dt: 0.03,
    note: "Counter-rotating convection cells, divergence-free.",
  },
  gyre: {
    label: "Double gyre (time-dependent)",
    fx: "-pi*a*sin(pi*(b*sin(c*t)*x^2 + (1 - 2*b*sin(c*t))*x))*cos(pi*y)",
    fy: "pi*a*cos(pi*(b*sin(c*t)*x^2 + (1 - 2*b*sin(c*t))*x))*sin(pi*y)*(2*b*sin(c*t)*x + 1 - 2*b*sin(c*t))",
    domain: [0, 2, 0, 1], params: { a: 0.1, b: 0.25, c: 0.628, d: 0 }, dt: 0.05,
    note: "Ocean-mixing benchmark. The dividing line oscillates in time t, so paths become chaotic.",
  },
};

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  fx: null, fy: null,           // compiled math.js expressions
  timeDependent: false,
  scope: { x: 0, y: 0, t: 0, a: 0, b: 0, c: 0, d: 0 },
  domain: { xmin: -3, xmax: 3, ymin: -3, ymax: 3 },
  t: 0,
  dt: 0.02,
  stepsPerFrame: 6,
  lifetime: 4000,               // steps; Infinity when the slider is at max
  fade: true,                   // trails vanish once their particles have died
  running: true,
  boundary: "stop",             // "stop" | "wrap"
  showField: true,
  showHeads: false,
  style: "gouache",
  live: true,                   // paint the stroke in progress every frame
  brushName: "HB",              // built-in brush used by the "dry" style
  dipLength: 170,               // px of path per paint stroke
  jitter: 0.5,                  // 0–1 colour variation between paint strokes
  weight: 1,
  ink: PALETTE[0],
  inkFast: "#a23b2a",
  colorMode: "palette",         // "single" | "palette" | "speed"
  pressureFromSpeed: true,
  curvature: 0.3,
  particles: [],
  nextColor: 0,
  speedRef: 1,                  // typical speed in px per unit time (for pressure / colour)
};

let P;                          // p5 instance
let overlay, octx;              // 2D overlay
let W = BASE_SIZE, H = BASE_SIZE;
let brushScale = 1;             // multiplier already applied via scaleBrushes
let drawQueue = [];             // pending brush strokes
let needClear = true;
let needRedraw = false;
let fieldCache = null;          // quiver samples
let fpsSmooth = 60;
let paperTex = null;            // p5.Graphics with paper grain, drawn on clear
let paperFB = null;             // p5.Framebuffer with the committed paint
let commitNow = [];             // finished live strokes, committed this frame
let layers = [];                // fading layers, oldest first (see layerFor)
let scratchFB = null;           // a layer plus its wet strokes, rebuilt each frame
let stepCount = 0;              // integration steps since the last clear
let nextSeed = 1;               // seeds for brush randomness, one per stroke
let slowTicks = 0;              // status updates in a row with a low frame rate

// ── Coordinate mapping (world ↔ pixels, y up in world) ───────────────────────
const sx = () => W / (S.domain.xmax - S.domain.xmin);
const sy = () => H / (S.domain.ymax - S.domain.ymin);
const toPx = (x, y) => [(x - S.domain.xmin) * sx(), (S.domain.ymax - y) * sy()];
const toWorld = (px, py) => [S.domain.xmin + px / sx(), S.domain.ymax - py / sy()];

// ── Field evaluation ──────────────────────────────────────────────────────────
function velocity(x, y, t, out) {
  const sc = S.scope;
  sc.x = x; sc.y = y; sc.t = t;
  let u = S.fx.evaluate(sc);
  let v = S.fy.evaluate(sc);
  // math.js returns Complex for e.g. sqrt(-1); treat that as "no field here"
  out[0] = typeof u === "number" ? u : NaN;
  out[1] = typeof v === "number" ? v : NaN;
  return out;
}

// Classic fourth-order Runge–Kutta step. Returns false if the field blew up.
const k1 = [0, 0], k2 = [0, 0], k3 = [0, 0], k4 = [0, 0];
function rk4(p, t, h) {
  velocity(p.x, p.y, t, k1);
  velocity(p.x + 0.5 * h * k1[0], p.y + 0.5 * h * k1[1], t + 0.5 * h, k2);
  velocity(p.x + 0.5 * h * k2[0], p.y + 0.5 * h * k2[1], t + 0.5 * h, k3);
  velocity(p.x + h * k3[0], p.y + h * k3[1], t + h, k4);
  const nx = p.x + (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
  const ny = p.y + (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false;
  p.x = nx; p.y = ny;
  // speed in screen pixels per unit time (what the eye sees)
  p.speed = Math.hypot(k1[0] * sx(), k1[1] * sy());
  return true;
}

// ── Equations ─────────────────────────────────────────────────────────────────
function compileEquations(fxStr, fyStr) {
  const usesT = (node) => node.filter((n) => n.isSymbolNode && n.name === "t").length > 0;
  try {
    const nx = math.parse(fxStr), ny = math.parse(fyStr);
    const cx = nx.compile(), cy = ny.compile();
    // probe once so typos like "sin x" or unknown symbols surface now
    const probe = { ...S.scope, x: 0.37, y: -0.21, t: 0 };
    const u = cx.evaluate(probe), v = cy.evaluate(probe);
    for (const [val, name] of [[u, "dx/dt"], [v, "dy/dt"]]) {
      if (typeof val !== "number" && !(val && val.isComplex)) {
        throw new Error(`${name} must produce a single number`);
      }
    }
    S.fx = cx; S.fy = cy;
    S.timeDependent = usesT(nx) || usesT(ny);
    fieldCache = null;
    return null;
  } catch (err) {
    if (/actual: function/.test(err.message)) {
      return "A function needs brackets around its input, for example sin(x) rather than sin x";
    }
    return err.message.replace(/^Undefined symbol (\w+)/,
      "Unknown name \"$1\". Use x, y, t, a, b, c, d, pi, e or a function such as sin()");
  }
}

// ── Particles ─────────────────────────────────────────────────────────────────
function inkFor() {
  if (S.colorMode === "palette") return PALETTE[S.nextColor++ % PALETTE.length];
  return S.ink;
}

function spawn(x, y) {
  if (S.particles.filter((p) => p.alive).length >= MAX_PARTICLES) return;
  const p = {
    x, y, speed: 0, age: 0, stall: 0, alive: true,
    color: inkFor(),
    layer: layerFor(),  // fading layer it paints into, or null for paperFB
    runs: [[]],         // runs of [x, y, speed] in world units; wrap starts a new run
    sent: 0,            // index in the current run already committed
    dipSeed: 0,         // random seed of the stroke in progress
    dipCol: "#000000",  // colour of the stroke in progress
  };
  newDip(p);
  recordPoint(p, true);
  S.particles.push(p);
}

function recordPoint(p, force = false) {
  const run = p.runs[p.runs.length - 1];
  const last = run[run.length - 1];
  if (!force && last) {
    const [ax, ay] = toPx(last[0], last[1]);
    const [bx, by] = toPx(p.x, p.y);
    if (Math.hypot(bx - ax, by - ay) < POINT_GAP * pxScale()) return;  // too close to bother
  }
  run.push([p.x, p.y, p.speed]);
}

// Points per stroke. Each stroke is one "dip" of the brush. Without the live
// brush, pencil strokes stay short so the trace keeps up with the particle.
function strokePoints() {
  if (S.style === "dry" && !S.live) return LIVE_CHUNK;
  return Math.max(8, Math.round(S.dipLength / POINT_GAP));
}

// Start a new stroke for p: a fresh seed for the brush texture and a fresh
// mix of the colour. Both stay fixed while the stroke is painted.
function newDip(p) {
  p.dipSeed = (nextSeed++ * 2654435761) % 4294967296;
  const base = S.colorMode === "speed" ? speedColor(p.speed) : p.color;
  p.dipCol = S.style === "dry" ? base : mixVariation(base);
  p.dipBristles = bristleCount();
}

// The part of p's current run that belongs to the stroke in progress, and the
// length that stroke will have once finished (so its taper is stable).
function wetSpan(p) {
  const run = p.runs[p.runs.length - 1];
  const start = Math.max(0, p.sent - strokeOverlap());
  return { run, start, full: p.sent + strokePoints() - start };
}

// How far a stroke reaches back into the previous one. Paint strokes overlap
// a little, the way a painter restarts slightly behind where paint ran out.
function strokeOverlap() {
  return S.style === "dry" ? 1 : Math.round(strokePoints() * 0.18);
}

// Commit every finished stroke of the current run. With final = true the
// stroke in progress is finished too, tapering to wherever the path ended.
function flushParticle(p, final = false) {
  const n = strokePoints();
  for (;;) {
    const { run, start, full } = wetSpan(p);
    if (run.length - p.sent >= n) {
      commitStroke(makeStroke(run.slice(start, p.sent + n), p.dipCol, p.dipSeed, full, p.dipBristles), p.layer);
      p.sent += n;
      newDip(p);
    } else {
      if (final && run.length > p.sent) {
        commitStroke(makeStroke(run.slice(start), p.dipCol, p.dipSeed, 0, p.dipBristles), p.layer);
        p.sent = run.length;
        newDip(p);
      }
      return;
    }
  }
}

function startNewRun(p) {
  flushParticle(p, true);
  p.runs.push([]);
  p.sent = 0;
  recordPoint(p, true);
}

function stepParticles() {
  const { xmin, xmax, ymin, ymax } = S.domain;
  const mx = 0.02 * (xmax - xmin), my = 0.02 * (ymax - ymin);
  for (let k = 0; k < S.stepsPerFrame; k++) {
    for (const p of S.particles) {
      if (!p.alive) continue;
      const px0 = toPx(p.x, p.y);
      if (!rk4(p, S.t, S.dt)) { kill(p); continue; }
      p.age++;
      // boundaries
      if (p.x < xmin - mx || p.x > xmax + mx || p.y < ymin - my || p.y > ymax + my) {
        if (S.boundary === "wrap") {
          p.x = xmin + ((((p.x - xmin) % (xmax - xmin)) + (xmax - xmin)) % (xmax - xmin));
          p.y = ymin + ((((p.y - ymin) % (ymax - ymin)) + (ymax - ymin)) % (ymax - ymin));
          startNewRun(p);
          continue;
        }
        recordPoint(p, true);
        kill(p);
        continue;
      }
      // fixed points: stop once the particle has effectively come to rest
      const px1 = toPx(p.x, p.y);
      p.stall = Math.hypot(px1[0] - px0[0], px1[1] - px0[1]) < 0.002 ? p.stall + 1 : 0;
      if (p.stall > 300 || p.age >= S.lifetime) { recordPoint(p, true); kill(p); continue; }
      recordPoint(p);
    }
    S.t += S.dt;
    stepCount++;
  }
  for (const p of S.particles) if (p.alive) flushParticle(p);
}

function kill(p) {
  p.alive = false;
  flushParticle(p, true);
}

// ── Brush drawing ─────────────────────────────────────────────────────────────
function pressureFor(speed) {
  if (!S.pressureFromSpeed) return 1;
  // slow → heavier line, fast → lighter, like a pen dragged at different speeds
  return 0.55 + 0.85 / (1 + speed / S.speedRef);
}

function speedColor(speed) {
  const u = Math.min(1, Math.max(0, (speed / (speed + S.speedRef) - 0.2) / 0.6));
  return lerpHex(S.ink, S.inkFast, u);
}

function lerpHex(a, b, u) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const ca = (pa >> shift) & 255, cb = (pb >> shift) & 255;
    out |= Math.round(ca + (cb - ca) * u) << shift;
  }
  return "#" + out.toString(16).padStart(6, "0");
}

// ── Colour helpers (hex ↔ HSL) for per-stroke paint variation ───────────────
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, sat = 0;
  if (max !== min) {
    const d = max - min;
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, sat, l];
}

function hslToHex(h, sat, l) {
  h = ((h % 360) + 360) % 360;
  sat = Math.min(1, Math.max(0, sat));
  l = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return "#" + to(r) + to(g) + to(b);
}

// shift lightness (dl, 0–1 units) and hue (dh, degrees)
function shade(hex, dl, dh = 0, ds = 0) {
  const [h, sat, l] = hexToHsl(hex);
  return hslToHex(h + dh, sat + ds, l + dl);
}

// a slightly different mix of the same paint for each dip
function mixVariation(hex) {
  const j = S.jitter;
  if (!j) return hex;
  const g = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;  // ~[-1, 1], centred
  return shade(hex, 0.07 * j * g(), 9 * j * g(), 0.08 * j * g());
}

// ── Paint brushes ─────────────────────────────────────────────────────────────
// Registered before scaleBrushes() so they scale with the built-ins.
// One bristle is a small soft marker dot stamped along its own path; many
// overlapping bristles make up a stroke (see paintBristles).
const HAIR_WEIGHT = 1.6;        // vf-hair weight before scaling
function addPaintBrushes() {
  brush.add("vf-hair", {
    type: "marker", weight: HAIR_WEIGHT, scatter: 0.04, opacity: 70, spacing: 0.25,
    pressure: [1, 1], noise: 0.4, markerTip: false,
  });
}

// Small seeded generator, so a stroke's bristle layout is identical on every
// frame it is redrawn.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalsOf(pts) {
  const last = pts.length - 1;
  return pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(last, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    return [-dy / len, dx / len];
  });
}

// A brush stroke built from separate bristles. Each bristle:
//   · sits at its own offset across the stroke, scaled by pressure, so the
//     brush splays when pressed and narrows as it lifts;
//   · wanders slightly, so the grooves between bristles come and go;
//   · starts a little late and runs dry at its own point, edges first, which
//     gives the ragged dry-brush end;
//   · carries a darker, plain or lighter load of paint. Outer bristles are
//     dark, like the ridge of paint pushed to the edge of a real stroke.
// Bristles of one shade are drawn back to back so p5.brush blends them in a
// single pass. Each bristle has its own seeds (see seededSpline), so its
// texture never depends on how long it or the other bristles currently are.
function paintBristles(s, halfW, count) {
  const rnd = mulberry32(s.seed);
  const n = normalsOf(s.pts);
  const N = s.pts.length;
  const groups = [[], [], []];
  for (let b = 0; b < count; b++) {
    const across = b / (count - 1) - 0.5;                       // -0.5 … 0.5
    const edge = Math.abs(across) * 2;                          // 0 centre … 1 edge
    const off = across * 2 * halfW * 0.9 + (rnd() - 0.5) * halfW * 0.15;
    const uEnd = 1.02 - edge * 0.25 - rnd() * 0.25;
    const uStart = rnd() * 0.025;
    const amp = halfW * 0.05 * rnd(), freq = 0.05 + rnd() * 0.08, phase = rnd() * 6.283;
    const group = edge > 0.8 ? 0 : rnd() < 0.45 ? 2 : 1;
    const width = ((2 * halfW * 1.7) / count) / (HAIR_WEIGHT * brushScale) *
      (edge > 0.8 ? 1.15 : 1) * (0.75 + rnd() * 0.5);
    const path = [];
    for (let i = 0; i < N; i++) {
      const u = s.us[i];
      if (u < uStart || u > uEnd) continue;
      const dry = Math.min(1, Math.max(0, (u - (uEnd - 0.2)) / 0.2));  // lifting off near its end
      const pr = s.pts[i][2];
      const o = off * pr + amp * Math.sin(phase + i * freq);
      path.push([s.pts[i][0] + n[i][0] * o, s.pts[i][1] + n[i][1] * o, pr * (1 - 0.5 * dry)]);
    }
    if (path.length > 2) groups[group].push({ path, width, seed: s.seed + 101 * (b + 1) });
  }
  const shades = [shade(s.col, -0.08), s.col, shade(s.col, 0.07, 0, -0.05)];
  groups.forEach((g, gi) => {
    for (const h of g) {
      brush.set("vf-hair", shades[gi], h.width);
      seededSpline(h.path, h.seed);
    }
  });
}

// Draw a path as a run of fixed-length pieces, each with its own seed.
// p5.brush sizes a pool of random values by the length of each stroke before
// stamping it, so a growing stroke would get a new texture along its whole
// length every frame. Pieces of fixed length come out identical every time;
// only the piece at the brush head changes as it grows. Pieces of one colour
// share a blend pass, so there are no seams.
const PIECE = 12;               // points per piece (~30 px)
function seededSpline(path, seedBase) {
  for (let j = 0; j < path.length - 1; j += PIECE) {
    const piece = path.slice(j, j + PIECE + 1);
    if (piece.length < 2) break;
    brush.seed(seedBase + 7919 * (j + 1));
    brush.spline(piece, S.curvature);
  }
}

// Fewer bristles when many particles paint at once, to bound the work per
// frame. Fixed for each stroke when it starts, so a stroke never changes.
function bristleCount() {
  const alive = S.particles.reduce((c, p) => c + (p.alive ? 1 : 0), 0);
  return Math.max(7, Math.min(12, Math.round(240 / Math.max(1, alive))));
}

// Paper grain: per-pixel tooth, soft blotches and a few fibres, baked under
// every painting. Drawn with the raw 2D context because tens of thousands of
// p5 shape calls would stall start-up.
function makePaperTexture() {
  const g = P.createGraphics(W, H);
  g.pixelDensity(1);
  const ctx = g.drawingContext;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = Math.random();
    if (r < 0.5) { d[i] = 70; d[i + 1] = 62; d[i + 2] = 48; d[i + 3] = r * 30; }     // dark tooth
    else { d[i] = 255; d[i + 1] = 255; d[i + 2] = 250; d[i + 3] = (r - 0.5) * 36; } // light tooth
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = "rgb(120, 110, 90)";
  for (let i = 0; i < (W * H) / 900; i++) {          // soft blotches
    ctx.globalAlpha = Math.random() * 0.014;
    const r = 10 + Math.random() * 45;
    ctx.beginPath();
    ctx.ellipse(Math.random() * W, Math.random() * H, r, r * (0.6 + Math.random() * 0.8), Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 0.05;                            // a few fibres
  ctx.strokeStyle = "rgb(110, 100, 80)";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let i = 0; i < (W * H) / 4000; i++) {
    const x = Math.random() * W, y = Math.random() * H, a = Math.random() * Math.PI * 2, l = 4 + Math.random() * 10;
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  return g;
}

// Turn a slice of recorded path into a drawable stroke. `full` is the length
// the stroke will have when finished; the pressure envelope is laid out over
// that length so a growing wet stroke keeps the same shape.
function makeStroke(worldPts, col, seed, full = 0, bristles = 10) {
  const n = full || worldPts.length;
  const us = [];
  const pts = worldPts.map(([x, y, s], i) => {
    const [px, py] = toPx(x, y);
    const u = n > 1 ? i / (n - 1) : 0;
    us.push(u);
    const taper = S.style === "dry" ? 1 : dipEnvelope(u, n);
    return [px, py, pressureFor(s) * taper];
  });
  return { pts, us, col, seed, bristles, style: S.style, brushName: S.brushName, weight: S.weight };
}

// Live strokes are committed in the frame they finish, so nothing flickers.
// Watercolour fills are expensive, so they wait in the time-budgeted queue
// and show a quick wet wash until they are painted.
function commitStroke(s, layer) {
  if (s.pts.length < 2) return;
  s.layer = layer;
  if (s.style === "watercolour") drawQueue.push({ ...s, preview: true });
  else commitNow.push(s);
}

// Pressure along one dip: a quick press at the start, full body, then the
// brush lifting and running dry over the last third.
// The next dip starts inside this one's tail (strokeOverlap), so the
// narrowing is mostly painted over and only shows where a path ends.
function dipEnvelope(u, n) {
  const short = n < 12;                                   // tails of a path: no big taper
  const rise = short ? 0 : 0.08, fall = short ? 0.5 : 0.25;
  let e = 1;
  if (u < rise) e = 0.7 + 0.3 * (u / rise);
  if (u > 1 - fall) e = Math.min(e, 1 - 0.45 * Math.pow((u - (1 - fall)) / fall, 1.5));
  return e;
}

// Outline of a stroke as a closed polygon: offset each point along its normal
// by a half-width that follows the pressure. Only every `step`-th point is
// used: p5.brush's watercolour fill subdivides every edge, so fewer vertices
// make it much cheaper. With `us` given, the body starts narrow and thins
// over the last fifth of the stroke, where the brush is running out of paint.
function ribbon(pts, halfWidth, step = 2, us = null) {
  const left = [], right = [];
  const last = pts.length - 1;
  const idx = [];
  for (let i = 0; i < last; i += step) idx.push(i);
  idx.push(last);                                  // always end on the final point
  for (const i of idx) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(last, i + 1)];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    let w = halfWidth * pts[i][2] * (1 + 0.08 * Math.sin(i * 0.7));     // slight wobble at the edge
    if (us) {
      const d = Math.min(1, Math.max(0, (us[i] - 0.8) / 0.2));
      w *= 1 - 0.75 * d * d * (3 - 2 * d);                               // smoothstep down to a dry tail
      const a = Math.min(1, us[i] / 0.06);
      w *= 0.35 + 0.65 * a * a * (3 - 2 * a);                            // rounded start, under the bristles
    }
    left.push([pts[i][0] + nx * w, pts[i][1] + ny * w]);
    right.push([pts[i][0] - nx * w, pts[i][1] - ny * w]);
  }
  return left.concat(right.reverse());
}

function drawStroke(s, wet = false) {
  const k = pxScale();
  brush.seed(s.seed);                 // same texture every time this stroke is drawn
  if (wet && s.style === "watercolour") {
    // still wet: a quick translucent wash; the full watercolour fill comes later
    brush.noStroke();
    brush.wash(s.col, 70);
    brush.polygon(ribbon(s.pts, 6 * k * s.weight, 3));
    brush.noWash();
    return;
  }
  switch (s.style) {
    case "bristle":
      // a thin film of paint between the bristles, then the bristles
      brush.noStroke();
      brush.wash(s.col, 60);
      brush.polygon(ribbon(s.pts, 5.4 * k * s.weight, 2, s.us));
      brush.noWash();
      paintBristles(s, 6 * k * s.weight, s.bristles);
      break;
    case "gouache":
      brush.noStroke();
      brush.wash(s.col, 165);
      brush.polygon(ribbon(s.pts, 5.6 * k * s.weight, 2, s.us));
      brush.noWash();
      paintBristles(s, 6 * k * s.weight, Math.max(6, s.bristles - 2));
      break;
    case "watercolour":
      brush.noStroke();
      brush.fill(s.col, 90);
      brush.fillBleed(0.05);
      brush.fillTexture(0.45, 0.55);
      brush.polygon(ribbon(s.pts, 6 * k * s.weight, 5));
      brush.noFill();
      break;
    default:
      brush.set(s.brushName, s.col, s.weight);
      seededSpline(s.pts, s.seed);
  }
}

function drawSafe(s, wet = false) {
  // a stroke whose points all coincide makes p5.brush throw; skip it
  const [a, b] = [s.pts[0], s.pts[s.pts.length - 1]];
  if (s.pts.length < 2 || (s.pts.length === 2 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5)) return;
  try {
    drawStroke(s, wet);
  } catch (err) {
    console.warn("stroke skipped:", err.message);
  }
}

// p5.brush holds the last operation's paint until the next operation of a
// different kind (or the end of the frame on the main canvas). Before leaving
// an offscreen target, two invisible off-canvas marks of different kinds push
// everything real through.
function flushBrush() {
  brush.noStroke();
  brush.wash("#ffffff", 1);
  brush.polygon([[-60, -60], [-50, -60], [-50, -50]]);
  brush.noWash();
  brush.set("pen", "#ffffff", 0.1);
  brush.line(-60, -40, -50, -40);
}

// Commit this frame's finished strokes, then as much of the backlog
// (redraws, watercolour) as fits in the frame budget.
function paintCommitted() {
  if (!commitNow.length && !drawQueue.length) return;
  const byLayer = new Map();
  for (const s of commitNow) {
    if (!byLayer.has(s.layer)) byLayer.set(s.layer, []);
    byLayer.get(s.layer).push(s);
  }
  commitNow = [];
  for (const [layer, list] of byLayer) paintInto(layer ? layer.fb : paperFB, () => list.forEach((s) => drawSafe(s)));
  // the backlog, a run of strokes with the same target at a time
  const t0 = performance.now();
  const inBudget = () => performance.now() - t0 < FRAME_BUDGET_MS;
  while (drawQueue.length && inBudget()) {
    const layer = drawQueue[0].layer;
    paintInto(layer ? layer.fb : paperFB, () => {
      while (drawQueue.length && drawQueue[0].layer === layer && inBudget()) drawSafe(drawQueue.shift());
    });
  }
}

// Point p5.brush at a framebuffer, draw, and push the paint through.
function paintInto(fb, fn) {
  fb.draw(() => {
    P.translate(-W / 2, -H / 2);
    brush.load(fb);
    fn();
    flushBrush();
  });
  brush.load();
}

// The current stroke of each live particle that paints into `layer`.
function wetStrokes(layer) {
  const out = [];
  if (!S.live) return out;
  for (const p of S.particles) {
    if (!p.alive || p.layer !== layer) continue;
    const { run, start, full } = wetSpan(p);
    if (run.length - start < 2) continue;
    out.push(makeStroke(run.slice(start), p.dipCol, p.dipSeed, full, p.dipBristles));
  }
  return out;
}

// Show paperFB, then multiply each fading layer over it. A layer with
// particles still painting is first copied to scratchFB and their wet strokes
// are painted onto the copy, so they mix with that layer's paint exactly as
// they will once committed.
function showLayers() {
  P.image(paperFB, -W / 2, -H / 2, W, H);
  for (const L of layers) {
    let src = L.fb;
    const wet = wetStrokes(L);
    if (wet.length) {
      scratchFB.draw(() => {
        P.clear();
        P.image(L.fb, -W / 2, -H / 2, W, H);
      });
      paintInto(scratchFB, () => wet.forEach((s) => drawSafe(s, true)));
      src = scratchFB;
    }
    P.blendMode(P.MULTIPLY);
    P.image(src, -W / 2, -H / 2, W, H);
    P.blendMode(P.BLEND);
  }
}

// Strokes still being painted straight onto the canvas: live particles that
// paint into paperFB, and the wet look of watercolour strokes in the queue.
function paintWet() {
  for (const s of wetStrokes(null)) drawSafe(s, true);
  for (const s of drawQueue) if (s.preview) drawSafe(s, true);
}

function clearPaper() {
  paperFB.draw(() => {
    P.background(PAPER);
    if (paperTex) P.image(paperTex, -W / 2, -H / 2, W, H);
  });
  for (const L of layers) L.fresh = true;
}

// ── Fading layers ─────────────────────────────────────────────────────────────
// Particles born within a quarter of a lifetime of each other share a layer,
// so a trail outlasts its particle by at most about that long (less when its
// layer-mates die sooner). With the lifetime at ∞ or fading off, particles
// paint into paperFB and their trails stay.
function layerFor() {
  if (!S.fade || !Number.isFinite(S.lifetime)) return null;
  const open = layers.filter((L) => !L.fading).pop();
  const span = Math.max(60, S.lifetime / 4);
  if (open && (stepCount - open.born < span || layers.length >= MAX_LAYERS)) return open;
  const L = { fb: P.createFramebuffer({ width: W, height: H, depth: false }), born: stepCount, fading: 0, fresh: true };
  layers.push(L);
  return L;
}

// A new or cleared layer is white: nothing painted, so multiplying changes nothing.
function clearFreshLayers() {
  for (const L of layers) {
    if (!L.fresh) continue;
    L.fb.draw(() => P.background(255));
    L.fresh = false;
  }
}

// Start fading a layer once all of its particles have died, and move each
// fading layer a step closer to white: covering it with white at alpha
// 1/(frames left) leaves a straight-line fade. Fading pauses with the
// simulation.
function updateLayers(running) {
  for (const L of layers) {
    if (!L.fading && !S.particles.some((p) => p.layer === L && p.alive)) L.fading = 1;
  }
  if (!running) return;
  for (const L of layers.filter((L) => L.fading)) {
    if (L.fading >= FADE_FRAMES) { dropLayer(L); continue; }
    const a = 255 / (FADE_FRAMES - L.fading + 1);
    L.fb.draw(() => {
      P.noStroke();
      P.fill(255, a);
      P.rect(-W / 2, -H / 2, W, H);
    });
    L.fading++;
  }
}

// Remove a layer along with its particles and any strokes still waiting for it.
function dropLayer(L) {
  layers = layers.filter((x) => x !== L);
  S.particles = S.particles.filter((p) => p.layer !== L);
  drawQueue = drawQueue.filter((s) => s.layer !== L);
  commitNow = commitNow.filter((s) => s.layer !== L);
  L.fb.remove();
}

// Re-queue every stored path. Dry media gets long seamless strokes; paint
// styles are re-laid as dips with fresh colour variation.
function redrawClean() {
  for (const L of layers.filter((L) => L.fading)) dropLayer(L);   // already on their way out
  drawQueue = [];
  needClear = true;
  const size = S.style !== "dry" ? strokePoints()
    : S.colorMode === "speed" ? SPEED_CHUNK : CLEAN_CHUNK;
  const back = strokeOverlap();
  for (const p of S.particles) {
    if (S.colorMode === "single") p.color = S.ink;
    for (const run of p.runs) {
      for (let i = 0; i < run.length - 1; i += size) {
        const slice = run.slice(Math.max(0, i - back), i + size + 1);
        const base = S.colorMode === "speed" ? speedColor(slice[0][2]) : p.color;
        const col = S.style === "dry" ? base : mixVariation(base);
        drawQueue.push({ ...makeStroke(slice, col, (nextSeed++ * 2654435761) % 4294967296, 0, 12), layer: p.layer });
      }
    }
    p.sent = p.runs[p.runs.length - 1].length;
    newDip(p);
  }
}

function clearAll() {
  for (const L of layers) L.fb.remove();
  layers = [];
  S.particles = [];
  drawQueue = [];
  commitNow = [];
  needClear = true;
  S.t = 0;
  stepCount = 0;
}

// ── Overlay: field arrows, axes, particle heads ──────────────────────────────
function sampleField() {
  const cols = Math.max(8, Math.round(W / 34));
  const rows = Math.max(6, Math.round(H / 34));
  const out = [];
  const v = [0, 0];
  const speeds = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const px = (i + 0.5) * (W / cols), py = (j + 0.5) * (H / rows);
      const [x, y] = toWorld(px, py);
      velocity(x, y, S.t, v);
      const vx = v[0] * sx(), vy = -v[1] * sy();           // screen space
      const m = Math.hypot(vx, vy);
      if (Number.isFinite(m)) speeds.push(m);
      out.push({ px, py, vx, vy, m });
    }
  }
  speeds.sort((a, b) => a - b);
  S.speedRef = Math.max(1e-6, speeds[Math.floor(speeds.length / 2)] || 1);
  const maxM = speeds[Math.floor(speeds.length * 0.95)] || 1;
  return { pts: out, cell: Math.min(W / cols, H / rows), maxM };
}

function drawOverlay() {
  const dpr = overlay.width / W;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, W, H);

  if (S.showField) {
    // axes through the origin when it is in view
    const [ox, oy] = toPx(0, 0);
    octx.strokeStyle = "rgba(40, 52, 70, 0.28)";
    octx.lineWidth = 1;
    octx.beginPath();
    if (oy >= 0 && oy <= H) { octx.moveTo(0, oy); octx.lineTo(W, oy); }
    if (ox >= 0 && ox <= W) { octx.moveTo(ox, 0); octx.lineTo(ox, H); }
    octx.stroke();

    if (!fieldCache || S.timeDependent) fieldCache = sampleField();
    const { pts, cell, maxM } = fieldCache;
    for (const a of pts) {
      if (!Number.isFinite(a.m) || a.m === 0) continue;
      const strength = Math.min(1, a.m / maxM);
      const len = cell * (0.25 + 0.4 * Math.sqrt(strength));
      const ux = a.vx / a.m, uy = a.vy / a.m;
      const x0 = a.px - ux * len / 2, y0 = a.py - uy * len / 2;
      const x1 = a.px + ux * len / 2, y1 = a.py + uy * len / 2;
      octx.strokeStyle = `rgba(40, 52, 70, ${0.18 + 0.32 * strength})`;
      octx.lineWidth = 1.1;
      octx.beginPath();
      octx.moveTo(x0, y0); octx.lineTo(x1, y1);
      const h = Math.min(5, len * 0.35);
      octx.moveTo(x1, y1); octx.lineTo(x1 - h * (ux - uy * 0.5), y1 - h * (uy + ux * 0.5));
      octx.moveTo(x1, y1); octx.lineTo(x1 - h * (ux + uy * 0.5), y1 - h * (uy - ux * 0.5));
      octx.stroke();
    }
  }

  if (S.showHeads) {
    for (const p of S.particles) {
      if (!p.alive) continue;
      const [px, py] = toPx(p.x, p.y);
      octx.fillStyle = p.color;
      octx.strokeStyle = PAPER;
      octx.lineWidth = 1.5;
      octx.beginPath();
      octx.arc(px, py, 3.2, 0, Math.PI * 2);
      octx.fill(); octx.stroke();
    }
  }

  if (!S.showField) return;
  // domain labels in the corners
  octx.fillStyle = "rgba(40, 52, 70, 0.6)";
  octx.font = "11px 'JetBrains Mono', ui-monospace, monospace";
  const f = (n) => +n.toFixed(3);
  octx.textBaseline = "bottom";
  octx.fillText(`(${f(S.domain.xmin)}, ${f(S.domain.ymin)})`, 6, H - 5);
  octx.textAlign = "right";
  octx.textBaseline = "top";
  octx.fillText(`(${f(S.domain.xmax)}, ${f(S.domain.ymax)})`, W - 6, 5);
  octx.textAlign = "left";
}

// ── Layout / resize ───────────────────────────────────────────────────────────
// p5.brush does not survive resizeCanvas() cleanly (its internal buffers keep
// the old size), so the paper keeps the resolution it was created with and is
// scaled with CSS to fit the stage. Pointer positions are mapped back through
// that scale.
function stageSize() {
  const r = document.getElementById("stage").getBoundingClientRect();
  return [Math.max(240, Math.floor(r.width)), Math.max(240, Math.floor(r.height))];
}

function sizeOverlay() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  overlay.width = Math.round(W * dpr);
  overlay.height = Math.round(H * dpr);
}

function fitToStage() {
  const [sw, sh] = stageSize();
  const k = Math.min(sw / W, sh / H);
  const w = Math.floor(W * k) + "px", h = Math.floor(H * k) + "px";
  for (const el of [overlay, document.getElementById("paper")]) {
    if (!el) continue;
    el.style.width = w;
    el.style.height = h;
  }
}

// canvas size relative to the 600 px reference
const pxScale = () => Math.min(W, H) / BASE_SIZE;

function applyBrushScale() {
  const target = 3 * (Math.min(W, H) / BASE_SIZE);
  brush.scaleBrushes(target / brushScale);
  brushScale = target;
}

// pointer event → canvas pixel coordinates
function eventToPx(e) {
  const r = overlay.getBoundingClientRect();
  return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)];
}

// ── p5 sketch ─────────────────────────────────────────────────────────────────
const sketch = (p) => {
  brush.instance(p);
  P = p;

  p.setup = () => {
    // W, H were measured before p5 started: p5's temporary default canvas
    // takes up room in the layout while setup() runs.
    p.pixelDensity(Math.min(2, window.devicePixelRatio || 1));
    const c = p.createCanvas(W, H, p.WEBGL);
    c.parent("stage");
    c.id("paper");
    sizeOverlay();
    fitToStage();
    addPaintBrushes();
    applyBrushScale();
    populateBrushes();
    paperTex = makePaperTexture();
    paperFB = p.createFramebuffer({ width: W, height: H });
    scratchFB = p.createFramebuffer({ width: W, height: H, depth: false });
    new ResizeObserver(fitToStage).observe(document.getElementById("stage"));
    loadPreset("vanderpol");
    seedGrid(7, 5);
  };

  p.draw = () => {
    if (needClear) { clearPaper(); needClear = false; }
    clearFreshLayers();
    if (S.fx) {
      if (!fieldCache) fieldCache = sampleField();   // also sets speedRef
      if (S.running) stepParticles();
    }
    paintCommitted();
    updateLayers(S.running);
    showLayers();
    p.translate(-p.width / 2, -p.height / 2);       // WEBGL origin is the centre
    paintWet();
    drawOverlay();
    fpsSmooth = 0.95 * fpsSmooth + 0.05 * p.frameRate();
    if (p.frameCount % 10 === 0) updateStatus();
  };
};

// ── UI wiring ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function populateBrushes() {
  const sel = $("brush");
  sel.innerHTML = "";
  for (const name of brush.box().filter((n) => !n.startsWith("vf-"))) {
    const o = document.createElement("option");
    o.value = o.textContent = name;
    sel.appendChild(o);
  }
  sel.value = S.brushName;
}

function readParams() {
  for (const k of ["a", "b", "c", "d"]) {
    const v = parseFloat($(`p-${k}`).value);
    S.scope[k] = Number.isFinite(v) ? v : 0;
  }
  fieldCache = null;
}

function setParam(k, v) {
  const range = $(`p-${k}`), num = $(`n-${k}`);
  const span = Math.max(2, Math.ceil(Math.abs(v) * 2));
  range.min = -span; range.max = span;
  range.value = v; num.value = v;
}

function applyEquations() {
  readParams();
  const err = compileEquations($("fx").value, $("fy").value);
  $("eq-error").textContent = err || "";
  $("eq-error").hidden = !err;
  $("fx").setAttribute("aria-invalid", err ? "true" : "false");
  $("fy").setAttribute("aria-invalid", err ? "true" : "false");
}

function readDomain() {
  const v = ["xmin", "xmax", "ymin", "ymax"].map((k) => parseFloat($(k).value));
  if (v.some((n) => !Number.isFinite(n)) || v[0] >= v[1] || v[2] >= v[3]) {
    $("domain-error").hidden = false;
    return;
  }
  $("domain-error").hidden = true;
  [S.domain.xmin, S.domain.xmax, S.domain.ymin, S.domain.ymax] = v;
  fieldCache = null;
  clearAll();
}

function loadPreset(key) {
  const pr = PRESETS[key];
  $("preset").value = key;
  $("fx").value = pr.fx;
  $("fy").value = pr.fy;
  $("preset-note").textContent = pr.note;
  for (const k of ["a", "b", "c", "d"]) setParam(k, pr.params[k]);
  ["xmin", "xmax", "ymin", "ymax"].forEach((k, i) => ($(k).value = pr.domain[i]));
  setDt(pr.dt);
  applyEquations();
  readDomain();
}

// dt slider is logarithmic: 0.001 … 0.2
function setDt(dt) {
  S.dt = dt;
  $("dt").value = Math.log10(dt);
  $("dt-out").textContent = dt.toPrecision(2);
}

function seedGrid(nx, ny) {
  const { xmin, xmax, ymin, ymax } = S.domain;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      spawn(xmin + (i + 0.5) * (xmax - xmin) / nx, ymin + (j + 0.5) * (ymax - ymin) / ny);
}

function seedRandom(n) {
  const { xmin, xmax, ymin, ymax } = S.domain;
  for (let i = 0; i < n; i++)
    spawn(xmin + Math.random() * (xmax - xmin), ymin + Math.random() * (ymax - ymin));
}

function updateStatus() {
  const alive = S.particles.filter((p) => p.alive).length;
  $("st-t").textContent = S.t.toFixed(2);
  $("st-alive").textContent = `${alive} / ${S.particles.length}`;
  $("st-queue").textContent = drawQueue.length;
  $("st-fps").textContent = Math.round(fpsSmooth);
  // live painting redraws every stroke in progress each frame; say so when
  // that is what is slowing the page down
  slowTicks = S.live && S.running && alive > 8 && fpsSmooth < 15 ? slowTicks + 1 : 0;
  $("perf-note").hidden = slowTicks < 20;
}

function wireUI() {
  overlay = $("overlay");
  octx = overlay.getContext("2d");
  const presetSel = $("preset");
  for (const [k, v] of Object.entries(PRESETS)) {
    const o = document.createElement("option");
    o.value = k; o.textContent = v.label;
    presetSel.appendChild(o);
  }
  presetSel.addEventListener("change", () => { loadPreset(presetSel.value); seedGrid(7, 5); });

  // equations: recompile as you type (debounced), particles keep moving in the new field
  let eqTimer;
  for (const id of ["fx", "fy"]) {
    $(id).addEventListener("input", () => {
      clearTimeout(eqTimer);
      eqTimer = setTimeout(applyEquations, 250);
    });
  }

  for (const k of ["a", "b", "c", "d"]) {
    $(`p-${k}`).addEventListener("input", () => { $(`n-${k}`).value = $(`p-${k}`).value; readParams(); });
    $(`n-${k}`).addEventListener("change", () => {
      const v = parseFloat($(`n-${k}`).value);
      if (Number.isFinite(v)) setParam(k, v);
      readParams();
    });
  }

  for (const k of ["xmin", "xmax", "ymin", "ymax"]) $(k).addEventListener("change", readDomain);

  $("dt").addEventListener("input", () => setDt(+Math.pow(10, +$("dt").value).toPrecision(2)));
  $("speed").addEventListener("input", () => {
    S.stepsPerFrame = +$("speed").value;
    $("speed-out").textContent = S.stepsPerFrame;
  });
  $("life").addEventListener("input", () => {
    const v = +$("life").value;
    S.lifetime = v >= +$("life").max ? Infinity : v;
    $("life-out").textContent = Number.isFinite(S.lifetime) ? S.lifetime : "∞";
  });
  $("fade").addEventListener("change", () => (S.fade = $("fade").checked));   // applies to new particles
  $("boundary").addEventListener("change", () => (S.boundary = $("boundary").value));

  const styleSel = $("style");
  for (const [k, v] of Object.entries(STYLES)) {
    const o = document.createElement("option");
    o.value = k; o.textContent = v.label;
    styleSel.appendChild(o);
  }
  styleSel.value = S.style;
  const syncStyle = () => {
    S.style = styleSel.value;
    const dry = S.style === "dry";
    $("brush-row").hidden = !dry;
    $("dip-row").hidden = dry && !S.live;
    $("jitter-row").hidden = dry;
    $("water-note").hidden = S.style !== "watercolour";
  };
  styleSel.addEventListener("change", syncStyle);
  syncStyle();
  $("dip").addEventListener("input", () => {
    S.dipLength = +$("dip").value;
    $("dip-out").textContent = S.dipLength;
  });
  $("jitter").addEventListener("input", () => {
    S.jitter = +$("jitter").value;
    $("jitter-out").textContent = S.jitter.toFixed(2);
  });
  $("brush").addEventListener("change", () => (S.brushName = $("brush").value));
  $("weight").addEventListener("input", () => {
    S.weight = +$("weight").value;
    $("weight-out").textContent = S.weight.toFixed(1);
  });
  $("ink").addEventListener("input", () => (S.ink = $("ink").value));
  $("ink-fast").addEventListener("input", () => (S.inkFast = $("ink-fast").value));
  $("colormode").addEventListener("change", () => {
    S.colorMode = $("colormode").value;
    $("ink-fast-row").hidden = S.colorMode !== "speed";
    $("ink-slow-hint").hidden = S.colorMode !== "speed";
    $("ink").closest("label").hidden = S.colorMode === "palette";   // palette inks are fixed
  });
  $("colormode").dispatchEvent(new Event("change"));
  $("pressure").addEventListener("change", () => (S.pressureFromSpeed = $("pressure").checked));
  $("curv").addEventListener("input", () => {
    S.curvature = +$("curv").value;
    $("curv-out").textContent = S.curvature.toFixed(2);
  });
  const syncField = () => {
    $("show-field").checked = S.showField;
    $("toggle-field").textContent = S.showField ? "Hide field" : "Show field";
    $("toggle-field").setAttribute("aria-pressed", String(!S.showField));
  };
  $("show-field").addEventListener("change", () => { S.showField = $("show-field").checked; syncField(); });
  $("toggle-field").addEventListener("click", () => { S.showField = !S.showField; syncField(); });
  syncField();
  $("live").addEventListener("change", () => { S.live = $("live").checked; syncStyle(); });
  $("show-heads").addEventListener("change", () => (S.showHeads = $("show-heads").checked));

  $("play").addEventListener("click", () => {
    S.running = !S.running;
    $("play").textContent = S.running ? "Pause" : "Play";
    $("play").setAttribute("aria-pressed", String(!S.running));
  });
  $("seed-grid").addEventListener("click", () => seedGrid(7, 5));
  $("seed-rand").addEventListener("click", () => seedRandom(30));
  $("clear").addEventListener("click", clearAll);
  $("redraw").addEventListener("click", redrawClean);
  const save = $("save");
  if (save) save.addEventListener("click", () => P.saveCanvas("vector-field", "png"));

  // click to drop one particle, drag to pour a stream of them
  let dragging = false, lastDrop = null;
  const drop = (e) => {
    const [px, py] = eventToPx(e);
    if (lastDrop && Math.hypot(px - lastDrop[0], py - lastDrop[1]) < 14) return;
    lastDrop = [px, py];
    const [x, y] = toWorld(px, py);
    spawn(x, y);
  };
  overlay.addEventListener("pointerdown", (e) => {
    dragging = true; lastDrop = null;
    overlay.setPointerCapture(e.pointerId);
    drop(e);
  });
  overlay.addEventListener("pointermove", (e) => {
    const [x, y] = toWorld(...eventToPx(e));
    $("st-xy").textContent = `${x.toFixed(2)}, ${y.toFixed(2)}`;
    if (dragging) drop(e);
  });
  const end = () => { dragging = false; };
  overlay.addEventListener("pointerup", end);
  overlay.addEventListener("pointercancel", end);

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.code === "Space") { e.preventDefault(); $("play").click(); }
  });
}

// Create the paper only once fonts and layout have settled, so its
// resolution matches the space it is shown in.
window.addEventListener("DOMContentLoaded", () => {
  wireUI();
  const start = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    [W, H] = stageSize();
    new p5(sketch);
  }));
  const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
  Promise.race([fonts, new Promise((r) => setTimeout(r, 1500))]).then(start);
});
