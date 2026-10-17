// A burn-up chart in braille: usage over the window, the even-pace diagonal, and where the current
// slope lands by the reset. Pure; x is the fraction of the window elapsed, y the fraction used, both 0–1.

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

  const dashed = (i: number) => i % 3 !== 2
  if (trajectory?.projection) line(trajectory.projection.from, trajectory.projection.to, 'projection', dashed)
  else if (!trajectory && now.elapsed > 0.001 && now.used > 0) {
    const slope = now.used / now.elapsed
    const to = now.used + slope * (1 - now.elapsed) <= 1
      ? { elapsed: 1, used: now.used + slope * (1 - now.elapsed) }
      : { elapsed: now.elapsed + (1 - now.used) / slope, used: 1 }
    line(now, to, 'projection', dashed)
  }

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
