const VIEW_W = 1000, VIEW_H = 200
const STROKE_ROOM = 8
const SCROLL_MS_PER_PX = 12
const SCROLL_MAX_LOOP_MS = 9000
const ZIG_PX = 14
const ZIG_MIN_PX = 5
const ZIGS_PER_TAP = 1.75
const CYCLE_MIN_MS = 2800
const ZIGS_PER_MS = 0.004
const FLAT_EDGE = 0.1
const FLAT_EDGE_PINNED = 0.04
const HEIGHT_EASING = 0.1
const REDUCED_MOTION_MS = 1500

const ease = (p) => (1 - Math.cos(Math.PI * p)) / 2
const round = (n) => Math.round(n * 10) / 10
const clamp = (v, low, high) => Math.min(high, Math.max(low, v))
const loopMs = (steps) => steps.reduce((sum, step) => sum + step[2], 0)

function smoothstep(from, to, v) {
  const t = clamp((v - from) / (to - from), 0, 1)
  return t * t * (3 - 2 * t)
}

function strengthAt(steps, t) {
  const length = loopMs(steps)
  let ms = ((t % length) + length) % length
  for (const [from, to, duration] of steps) {
    if (ms < duration) return from + (to - from) * ease(ms / duration)
    ms -= duration
  }
  return 0
}

export function liveWave(path, reducedMotion) {
  let steps = null
  let target = 0
  let height = 0
  let view = 'scroll'
  let frame = 0

  function draw(now) {
    const t = reducedMotion ? REDUCED_MOTION_MS : now
    height = reducedMotion ? target : height + (target - height) * HEIGHT_EASING
    if (Math.abs(height - target) < 0.002) height = target

    const width = path.ownerSVGElement.clientWidth || VIEW_W
    const loop = steps ? loopMs(steps) : 1
    const whole = view !== 'scroll'
    const speed = view === 'cycle' ? loop / Math.max(loop, CYCLE_MIN_MS) : steps ? Math.max(1, loop / SCROLL_MAX_LOOP_MS) : 1
    const msPerUnit = whole ? loop / VIEW_W : (SCROLL_MS_PER_PX * width) / VIEW_W * speed
    const at = (x) => view === 'pinned' ? x * msPerUnit : t * speed - x * msPerUnit

    const taps = steps ? steps.filter((step) => step[0] || step[1]).map((step) => step[2]) : []
    const tapPx = taps.length ? Math.min(...taps) / msPerUnit * (width / VIEW_W) : Infinity
    const zigPx = clamp(tapPx / ZIGS_PER_TAP, ZIG_MIN_PX, ZIG_PX)
    const zig = (zigPx * VIEW_W) / width
    const strongest = (x) => steps ? Math.max(...[-0.5, 0, 0.5].map((side) => strengthAt(steps, at(x + side * zig)))) : 0

    const edge = view === 'pinned' ? FLAT_EDGE_PINNED : FLAT_EDGE
    const run = t * ZIGS_PER_MS
    const offset = run % 1
    const first = Math.floor(run)
    const middle = VIEW_H / 2
    let d = `M0 ${middle}`
    for (let k = 0; (k + offset) * zig < VIEW_W; k++) {
      const x = (k + offset) * zig
      const u = x / VIEW_W
      const index = k - first
      const taper = smoothstep(edge * 0.3, edge, Math.min(u, 1 - u))
      const vary = 0.8 + 0.2 * Math.abs(Math.sin(index * 2.39))
      const sign = index % 2 ? -1 : 1
      d += ` L${round(x)} ${round(middle - sign * height * taper * vary * strongest(x) * (middle - STROKE_ROOM))}`
    }
    path.setAttribute('d', d + ` L${VIEW_W} ${middle}`)

    const moving = !reducedMotion && !document.hidden && (target > 0 || height > 0)
    frame = moving ? requestAnimationFrame(draw) : 0
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !frame) frame = requestAnimationFrame(draw)
  })

  return function set(newSteps, newTarget, newView = 'scroll') {
    steps = newSteps
    target = newTarget
    view = newView
    if (!frame) frame = requestAnimationFrame(draw)
  }
}
