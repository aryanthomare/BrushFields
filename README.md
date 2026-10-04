# Vector Field Painter

Type a 2D velocity field, drop particles into it, and
[p5.brush](https://github.com/acamposuribe/p5.brush) traces their paths with
natural-media brushes (pencil, charcoal, marker, pastel, spray …).

```
dx/dt = f(x, y, t)
dy/dt = g(x, y, t)
```

## Run it

Open `index.html` in a browser, or serve the folder:

```bash
cd vectorfield
python -m http.server 8000   # then visit http://localhost:8000
```

The libraries load from the jsDelivr content delivery network, so you need
to be online: p5.js 2.2.3, p5.brush 2.2.3 and math.js 15.2.0.

## Using it

- **Equations** accept `x`, `y`, time `t`, parameters `a b c d` (each with a
  slider), constants `pi` and `e`, and the usual functions (`sin`, `cos`,
  `exp`, `log`, `sqrt`, `abs`, `atan2`, …). Powers use `^`. The equations are
  parsed by math.js, not `eval`.
- **Click** the paper to drop one particle, **drag** to drop a stream of them, and
  press **Space** to pause.
- **Redraw clean** repaints every stored path as long strokes. While the
  simulation runs, paths are drawn in short pieces, which can leave faint
  joins; this button removes them.
- **Paint styles** (Brush → Style):
  - *Gouache* (default): an opaque body with a lighter, broken bristle
    texture dragged over it.
  - *Bristle paint*: a flat custom brush tip whose dots leave bristle
    streaks, plus a darker broken pass on top.
  - *Watercolour*: transparent glazes using p5.brush's watercolour fill,
    with bleed and darker edges. This is by far the slowest style, so use
    fewer particles.
  - *Pencil & ink*: any built-in p5.brush brush (HB, charcoal, marker …).

  Paint is laid in "dips": each stroke covers a set length of path (the
  **Stroke length** slider), starts with a press, thins as the paint runs
  out, and overlaps the end of the previous dip. **Colour variation** mixes
  each dip slightly differently in hue, lightness and saturation. Paper
  grain is baked under every painting.
- **Presets**: centre, spiral sink, saddle, Van der Pol, Hopf limit cycle,
  Lotka–Volterra, damped pendulum, cellular flow, double gyre (time-dependent).

## How it works

| Piece | What it does |
|---|---|
| Integrator | Fourth-order Runge–Kutta with a fixed step Δt. A particle stops when it leaves the window (or wraps around), comes to rest at a fixed point, reaches its lifetime, or the field returns a non-finite value. |
| Path recording | Positions are stored in world units, keeping only points at least about 2.5 px apart. |
| Brush strokes | Each path is cut into strokes. Pencil & ink and bristle paint use `brush.spline([[x, y, pressure], …])`. Gouache and watercolour build a ribbon polygon around the path, with a half-width that follows the pressure, and draw it with `brush.wash` or `brush.fill`. Pressure comes from the local speed, so slow stretches draw heavier. |
| Draw queue | Strokes wait in a queue that is drained within a 14 ms budget per frame, so heavy redraws don't freeze the controls. |
| Two layers | The p5 WEBGL canvas is the paper and is never cleared between frames. A plain 2D canvas on top shows field arrows, axes and particle dots, and none of that ends up in the painting. |

**Resizing.** p5.brush keeps its internal buffers at the old size after
`resizeCanvas()`. In testing, strokes drawn after a resize came out as stretched vertical smears.
To avoid that, the paper keeps the resolution it started with and CSS scales
it to fit the window. Reload the page to get a sharp canvas at a new window
size.
