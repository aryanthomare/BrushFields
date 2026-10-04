// =============================================================================
//  Vector Field Painter
//
//  Type a velocity field  dx/dt = f(x, y, t),  dy/dt = g(x, y, t),
//  drop particles into it, and p5.brush traces where they go.
//
//  Layers (bottom to top):
//    #paper   — p5 WEBGL canvas. p5.brush strokes accumulate here and are
//               never cleared between frames, so it behaves like real paper.
//    #overlay — plain 2D canvas, redrawn every frame: field arrows, axes,
//               particle heads. Kept separate so it never gets baked into
//               the artwork.
//
//  Pipeline per frame:
//    integrate (RK4)  →  record points in world units  →  cut them into
//    chunks  →  queue  →  drain the queue into brush.spline() under a time
//    budget, so a heavy redraw never freezes the UI.
// =============================================================================

/* global p5, brush, math */

const PAPER = "#f3f2ee";
const PALETTE = ["#1b2a4a", "#a23b2a", "#2f6b4f", "#b8862b", "#5b3f7a", "#1f6f8b", "#3a3a3a"];
const BASE_SIZE = 600;          // brush.scaleBrushes(3) looks right at 600 px
const MAX_PARTICLES = 400;
const LIVE_CHUNK = 24;          // points per live brush stroke
const CLEAN_CHUNK = 420;        // points per stroke when redrawing cleanly
const SPEED_CHUNK = 36;         // shorter strokes when colour follows speed
const FRAME_BUDGET_MS = 14;     // time allowed for brush drawing per frame

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
  running: true,
  boundary: "stop",             // "stop" | "wrap"
  showField: true,
  showHeads: true,
  brushName: "HB",
  weight: 1,
  ink: PALETTE[0],
  inkFast: "#a23b2a",
  colorMode: "single",          // "single" | "palette" | "speed"
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
    runs: [[]],         // runs of [x, y, speed] in world units; wrap starts a new run
    sent: 0,            // index in the current run already queued for drawing
  };
  recordPoint(p, true);
  S.particles.push(p);
}

function recordPoint(p, force = false) {
  const run = p.runs[p.runs.length - 1];
  const last = run[run.length - 1];
  if (!force && last) {
    const [ax, ay] = toPx(last[0], last[1]);
    const [bx, by] = toPx(p.x, p.y);
    if (Math.hypot(bx - ax, by - ay) < 2.5 * (W / BASE_SIZE)) return;  // too close to bother
  }
  run.push([p.x, p.y, p.speed]);
}

// Queue the not-yet-drawn tail of the current run in strokes of LIVE_CHUNK
// points. With final = true the leftover short tail is queued as well.
function flushParticle(p, final = false) {
  const run = p.runs[p.runs.length - 1];
  while (run.length - p.sent >= LIVE_CHUNK) {
    const end = p.sent + LIVE_CHUNK;
    // start one point back so consecutive strokes join
    queueStroke(run.slice(Math.max(0, p.sent - 1), end), p.color);
    p.sent = end;
  }
  if (final && run.length > p.sent) {
    queueStroke(run.slice(Math.max(0, p.sent - 1)), p.color);
    p.sent = run.length;
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

function queueStroke(worldPts, color) {
  if (worldPts.length < 2) return;
  let col = color;
  if (S.colorMode === "speed") {
    const mean = worldPts.reduce((s, q) => s + q[2], 0) / worldPts.length;
    col = speedColor(mean);
  }
  const pts = worldPts.map(([x, y, s]) => {
    const [px, py] = toPx(x, y);
    return [px, py, pressureFor(s)];
  });
  drawQueue.push({ pts, col, brushName: S.brushName, weight: S.weight });
}

function drainQueue() {
  const t0 = performance.now();
  while (drawQueue.length && performance.now() - t0 < FRAME_BUDGET_MS) {
    const s = drawQueue.shift();
    // a stroke whose points all coincide makes brush.spline throw; skip it
    const [a, b] = [s.pts[0], s.pts[s.pts.length - 1]];
    if (s.pts.length === 2 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5) continue;
    brush.set(s.brushName, s.col, s.weight);
    try {
      brush.spline(s.pts, S.curvature);
    } catch (err) {
      console.warn("stroke skipped:", err.message);
    }
  }
}

// Re-queue every stored path as long strokes (no seams from live chunking).
function redrawClean() {
  drawQueue = [];
  needClear = true;
  const size = S.colorMode === "speed" ? SPEED_CHUNK : CLEAN_CHUNK;
  for (const p of S.particles) {
    if (S.colorMode === "single") p.color = S.ink;
    for (const run of p.runs) {
      for (let i = 0; i < run.length - 1; i += size) {
        queueStroke(run.slice(Math.max(0, i - 1), i + size + 1), p.color);
      }
    }
    p.sent = p.runs[p.runs.length - 1].length;
  }
}

function clearAll() {
  S.particles = [];
  drawQueue = [];
  needClear = true;
  S.t = 0;
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

  // axes through the origin when it is in view
  const [ox, oy] = toPx(0, 0);
  octx.strokeStyle = "rgba(40, 52, 70, 0.28)";
  octx.lineWidth = 1;
  octx.beginPath();
  if (oy >= 0 && oy <= H) { octx.moveTo(0, oy); octx.lineTo(W, oy); }
  if (ox >= 0 && ox <= W) { octx.moveTo(ox, 0); octx.lineTo(ox, H); }
  octx.stroke();

  if (S.showField) {
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
    applyBrushScale();
    populateBrushes();
    new ResizeObserver(fitToStage).observe(document.getElementById("stage"));
    loadPreset("vanderpol");
    seedGrid(7, 5);
  };

  p.draw = () => {
    p.translate(-p.width / 2, -p.height / 2);   // WEBGL origin is the centre
    if (needClear) { p.background(PAPER); needClear = false; }
    if (!S.fx) return;
    if (!fieldCache) fieldCache = sampleField();   // also sets speedRef
    if (S.running) stepParticles();
    drainQueue();
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
  for (const name of brush.box()) {
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
  $("boundary").addEventListener("change", () => (S.boundary = $("boundary").value));

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
  });
  $("pressure").addEventListener("change", () => (S.pressureFromSpeed = $("pressure").checked));
  $("curv").addEventListener("input", () => {
    S.curvature = +$("curv").value;
    $("curv-out").textContent = S.curvature.toFixed(2);
  });
  $("show-field").addEventListener("change", () => (S.showField = $("show-field").checked));
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
