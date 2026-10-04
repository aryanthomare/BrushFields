# BrushFields

Type a 2D velocity field, drop particles into it, and
[p5.brush](https://github.com/acamposuribe/p5.brush) traces their paths with
natural-media brushes (pencil, charcoal, marker, pastel, spray …).

```
dx/dt = f(x, y, t)
dy/dt = g(x, y, t)
```

## Run it

Open `index.html` in a browser, or serve the repository root:

```bash
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
- **Live brush** (on by default): each particle drags a brush. The stroke it
  is laying is repainted every frame from where it began up to the particle,
  so you watch it being painted in, and it is committed to the painting when
  that load of paint runs out.
- **Hide field** (toolbar) hides the arrows, axes and labels so only the
  painting shows. Particle dots are off by default; turn them on under View.
- **Redraw clean** repaints every stored path from scratch with fresh colour
  variation.
- **Save PNG** names the file after the field, with a millisecond timestamp
  so every save gets its own name:
  `dx=y__dy=a (1-x^2) y-x__a=1__2026-10-04_23-05-12-345.png`.
  Only the parameters the equations use are listed. Names stay plain ASCII
  (`*` becomes a space, `/` becomes ` over `) and are cut to 200 characters,
  so the full equations, parameters, window, style and time are also stored
  in the PNG's Title and Description text fields. Image viewers that show
  metadata display these, or you can run `exiftool file.png`.
- **Paint styles** (Brush → Style):
  - *Gouache* (default): an opaque body with bristles dragged through it.
  - *Oil (bristle brush)*: the stroke is built from 7–12 separate bristles.
    Each one sits at its own offset, wanders slightly, carries a darker,
    plain or lighter load of paint, and runs dry at its own point (the edges
    first), which gives grooves, dark edge ridges and a ragged dry end.
  - *Watercolour*: transparent glazes using p5.brush's watercolour fill,
    with bleed and darker edges. This is by far the slowest style, so use
    fewer particles.
  - *Pencil & ink*: any built-in p5.brush brush (HB, charcoal, marker …).

  Paint is laid in "dips": each stroke covers a set length of path (the
  **Stroke length** slider), starts with a press, thins as the paint runs
  out, and overlaps the end of the previous dip. With many particles painting
  at once, strokes use fewer bristles (down to 7) to keep the frame rate up. **Colour variation** mixes
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
| Layers | Finished strokes are committed once to a p5 framebuffer. Each frame the visible WEBGL canvas shows that framebuffer and then repaints every stroke still in progress. A plain 2D canvas on top shows field arrows, axes and particle dots, and none of that ends up in the painting. |
| Stable wet strokes | A stroke in progress is redrawn every frame, so its texture has to come out identical each time. Every stroke and bristle has fixed seeds, and paths are drawn in fixed 12-point pieces, each seeded separately, because p5.brush sizes its random pool by stroke length. Only the piece at the brush head changes as it grows. |
| Offscreen flush | p5.brush keeps the last operation's paint pending until a different kind of operation follows. After drawing into the framebuffer, two invisible off-canvas marks (a wash, then a line) push it through. |

**Resizing.** p5.brush keeps its internal buffers at the old size after
`resizeCanvas()`. In testing, strokes drawn after a resize came out as stretched vertical smears.
To avoid that, the paper keeps the resolution it started with and CSS scales
it to fit the window. Reload the page to get a sharp canvas at a new window
size.
