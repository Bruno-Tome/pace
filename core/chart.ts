// A burn-up chart, in braille for a terminal or as an SVG for a surface that draws one: usage over the window, the
// even-pace diagonal, and where the current slope lands by the reset. Pure; x is the fraction of the window elapsed,
// y the fraction used, both 0–1.

export type Layer = 'actual' | 'projection' | 'ideal' | 'empty'
export type Run = { t: string; layer: Layer }

type At = { elapsed: number; used: number }
export type Trajectory = { segments: readonly (readonly At[])[]; projection: { from: At; to: At } | null }

/** Higher wins a cell two layers share */
const RANK: Record<Layer, number> = { empty: 0, ideal: 1, projection: 2, actual: 3 }

/** Braille dot bits by [x within the cell][y within the cell] */
const DOT = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

/**
 * `width` × `height` cells, each row as runs of one layer. `trajectory` is the window's readings (null with fewer
 * than two); `now` is the latest reading, drawn whatever the trajectory, and the origin of a projection when there
 * is no trajectory to take a slope from.
 */
export function chart(trajectory: Trajectory | null, now: At, width: number, height: number): Run[][] {
  const PW = width * 2
  const PH = height * 4
  const bits = Array.from({ length: height }, () => new Array<number>(width).fill(0))
  const layer = Array.from({ length: height }, () => new Array<Layer>(width).fill('empty'))

  const plot = (x: number, y: number, l: Layer) => {
    if (x < 0 || x >= PW || y < 0 || y >= PH) return
    const cx = x >> 1
    const cy = y >> 2
    const row = bits[cy]!
    const lrow = layer[cy]!
    row[cx] = (row[cx] ?? 0) | DOT[x & 1]![y & 3]!
    if (RANK[l] > RANK[lrow[cx]!]) lrow[cx] = l
  }
  const px = (p: At) => Math.round(clamp01(p.elapsed) * (PW - 1))
  const py = (p: At) => Math.round((1 - clamp01(p.used)) * (PH - 1))
  /** A line between two readings; `keep` thins it to a dotted or dashed look by step index, its ends always drawn */
  const line = (a: At, b: At, l: Layer, keep: (i: number) => boolean = () => true) => {
    let x0 = px(a), y0 = py(a)
    const x1 = px(b), y1 = py(b)
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (let i = 0; ; i++) {
      const end = x0 === x1 && y0 === y1
      if (i === 0 || end || keep(i)) plot(x0, y0, l)
      if (end) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }

  line({ elapsed: 0, used: 0 }, { elapsed: 1, used: 1 }, 'ideal', i => i % 2 === 0)

  // Usage as a filled area: every window starts at 0%, then the readings in order, then the latest
  const path: At[] = [{ elapsed: 0, used: 0 }, ...(trajectory?.segments.flat() ?? []), now]
    .filter(p => p.elapsed <= now.elapsed)
    .sort((p, q) => p.elapsed - q.elapsed)
  for (let x = 0; x <= px(now); x++) {
    const u = usedAt(path, x / (PW - 1))
    if (u <= 0) continue
    for (let y = py({ elapsed: 0, used: u }); y < PH; y++) plot(x, y, 'actual')
  }

  const projection = projectionOf(trajectory, now)
  if (projection) line(projection.from, projection.to, 'projection', i => i % 3 !== 2)

  return bits.map((row, cy) => {
    const runs: Run[] = []
    row.forEach((b, cx) => {
      const ch = String.fromCharCode(0x2800 + b)
      const l = b ? layer[cy]![cx]! : 'empty'
      const last = runs[runs.length - 1]
      if (last?.layer === l) last.t += ch
      else runs.push({ t: ch, layer: l })
    })
    return runs
  })
}

/**
 * Where the current slope lands by the reset: the trajectory's own projection, or without a trajectory the line from
 * the window's start through `now`, cut where it reaches 100%; null with nothing to take a slope from
 */
function projectionOf(trajectory: Trajectory | null, now: At): { from: At; to: At } | null {
  if (trajectory) return trajectory.projection
  if (now.elapsed <= 0.001 || now.used <= 0) return null
  const slope = now.used / now.elapsed
  const to = now.used + slope * (1 - now.elapsed) <= 1
    ? { elapsed: 1, used: now.used + slope * (1 - now.elapsed) }
    : { elapsed: now.elapsed + (1 - now.used) / slope, used: 1 }
  return { from: now, to }
}

/** The colours an SVG chart is drawn in, as CSS colours: usage, projection, even pace, and the axes and labels */
export type SvgColors = { actual: string; projection: string; ideal: string; axis: string }

/** Pixels on the left of an SVG chart for its percent labels */
const SVG_GUTTER = 34
/** Readings closer than this many pixels across draw one point */
const POINT_GAP = 3

/**
 * The chart as an SVG `width` × `height` pixels: usage as a filled area with a point at each reading, even pace and
 * the projection dashed, a mark where now is, and 100%, 50% and 0% on the left
 */
export function chartSvg(trajectory: Trajectory | null, now: At, o: { width: number; height: number; colors: SvgColors }): string {
  const { width: W, height: H, colors: c } = o
  const top = 6
  const bottom = H - 2
  const x = (p: At) => (SVG_GUTTER + clamp01(p.elapsed) * (W - SVG_GUTTER - 4)).toFixed(1)
  const y = (p: At) => (bottom - clamp01(p.used) * (bottom - top)).toFixed(1)
  const xy = (p: At) => `${x(p)},${y(p)}`
  const readings = (trajectory?.segments.flat() ?? []).filter(p => p.elapsed <= now.elapsed).sort((p, q) => p.elapsed - q.elapsed)
  const path: At[] = [{ elapsed: 0, used: 0 }, ...readings, now]
  const base = (e: number) => xy({ elapsed: e, used: 0 })
  const points: At[] = []
  for (const p of readings) {
    const last = points[points.length - 1]
    if (!last || Number(x(p)) - Number(x(last)) >= POINT_GAP) points.push(p)
  }
  const projection = projectionOf(trajectory, now)
  const label = (used: number, t: string) =>
    `<text x="${SVG_GUTTER - 6}" y="${(Number(y({ elapsed: 0, used })) + 3).toFixed(1)}" text-anchor="end" font-family="ui-monospace, monospace" font-size="10" fill="${c.axis}">${t}</text>`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    label(1, '100%'), label(0.5, '50%'), label(0, '0%'),
    `<line x1="${SVG_GUTTER}" y1="${top}" x2="${SVG_GUTTER}" y2="${bottom}" stroke="${c.axis}" stroke-width="1" opacity="0.5"/>`,
    `<line x1="${SVG_GUTTER}" y1="${bottom}" x2="${W - 4}" y2="${bottom}" stroke="${c.axis}" stroke-width="1" opacity="0.5"/>`,
    `<line x1="${x({ elapsed: 0, used: 0 })}" y1="${y({ elapsed: 0, used: 0 })}" x2="${x({ elapsed: 1, used: 1 })}" y2="${y({ elapsed: 1, used: 1 })}" stroke="${c.ideal}" stroke-width="1" stroke-dasharray="2 3"/>`,
    `<polygon points="${[...path.map(xy), base(now.elapsed), base(0)].join(' ')}" fill="${c.actual}" fill-opacity="0.35" stroke="none"/>`,
    `<polyline points="${path.map(xy).join(' ')}" fill="none" stroke="${c.actual}" stroke-width="1.5"/>`,
    ...(projection ? [`<line x1="${x(projection.from)}" y1="${y(projection.from)}" x2="${x(projection.to)}" y2="${y(projection.to)}" stroke="${c.projection}" stroke-width="1.5" stroke-dasharray="5 3"/>`] : []),
    ...points.map(p => `<circle cx="${x(p)}" cy="${y(p)}" r="2" fill="${c.actual}"/>`),
    `<line x1="${x(now)}" y1="${top}" x2="${x(now)}" y2="${bottom}" stroke="${c.axis}" stroke-width="1" opacity="0.6"/>`,
    `<circle cx="${x(now)}" cy="${y(now)}" r="3.5" fill="${c.actual}" stroke="${c.axis}" stroke-width="1"/>`,
    '</svg>',
  ].join('')
}

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1)

/** Usage at `elapsed` along `path` (sorted by elapsed), straight between readings */
function usedAt(path: readonly At[], elapsed: number): number {
  let prev = path[0]!
  for (const p of path) {
    if (p.elapsed >= elapsed) {
      const span = p.elapsed - prev.elapsed
      return span <= 0 ? p.used : prev.used + ((p.used - prev.used) * (elapsed - prev.elapsed)) / span
    }
    prev = p
  }
  return prev.used
}
