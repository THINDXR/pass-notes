// Stroke points are stored as [x, y] fractions of the page (0..1) and widths as a fraction
// of page width, so notes line up at any zoom level and on any screen.

// true if (x, y) is within `radius` of any segment of the stroke (all in page fractions)
export function hitsStroke(stroke, x, y, radius) {
  const pts = stroke.points
  const r = radius + stroke.width / 2
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= r
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(x, y, pts[i - 1], pts[i]) <= r) return true
  }
  return false
}

// Recognize a fast Apple Pencil scratch-out only when it is dense and crosses existing ink.
export function scribbleEraseTargets(scribble, strokes, w, h, duration) {
  const p = scribble.points
  if (duration > 1300 || p.length < 6) return []
  let length = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < p.length; i++) {
    const [x, y] = p[i]
    minX = Math.min(minX, x * w); maxX = Math.max(maxX, x * w)
    minY = Math.min(minY, y * h); maxY = Math.max(maxY, y * h)
    if (i === 0) continue
    const dx = (x - p[i - 1][0]) * w, dy = (y - p[i - 1][1]) * h
    length += Math.hypot(dx, dy)
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY)
  const axis = maxX - minX >= maxY - minY ? 0 : 1
  let direction = 0, reverseDistance = 0, reversals = 0
  for (let i = 1; i < p.length; i++) {
    const delta = (p[i][axis] - p[i - 1][axis]) * (axis === 0 ? w : h)
    if (Math.abs(delta) < 1) continue // ignore subpixel jitter and tiny handwriting curves
    const sign = Math.sign(delta)
    if (!direction) direction = sign
    else if (sign === direction) reverseDistance = 0
    else if ((reverseDistance += Math.abs(delta)) >= 12) { reversals++; direction = sign; reverseDistance = 0 }
  }
  if (length < Math.min(w, h) * 0.06 || reversals < 5 || length / Math.max(1, diagonal) < 1.5) return []

  const path = p.map(([x, y]) => [x * w, y * h])
  const pointSegmentDistance = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
  }
  const within = (a, b, c, d, r) => {
    const cross = (p1, p2, p3) => (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p2[1] - p1[1]) * (p3[0] - p1[0])
    const ab1 = cross(a, b, c), ab2 = cross(a, b, d), cd1 = cross(c, d, a), cd2 = cross(c, d, b)
    const on = (p, x, y) => p[0] >= Math.min(x[0], y[0]) - 1e-6 && p[0] <= Math.max(x[0], y[0]) + 1e-6 &&
      p[1] >= Math.min(x[1], y[1]) - 1e-6 && p[1] <= Math.max(x[1], y[1]) + 1e-6
    if ((ab1 * ab2 < 0 && cd1 * cd2 < 0) ||
        (Math.abs(ab1) < 1e-6 && on(c, a, b)) || (Math.abs(ab2) < 1e-6 && on(d, a, b)) ||
        (Math.abs(cd1) < 1e-6 && on(a, c, d)) || (Math.abs(cd2) < 1e-6 && on(b, c, d))) return true
    return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
      pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b)) <= r
  }
  const scratchBox = [minX, minY, maxX, maxY]
  return strokes.filter((stroke) => {
    if (stroke.deleted) return false
    const old = stroke.points.map(([x, y]) => [x * w, y * h])
    if (!old.length) return false
    // Keep the hit radius close to the actual ink width; 1% of a page wrongly erased nearby letters.
    const pad = stroke.width * w / 2 + 2
    const xs = old.map(([x]) => x), ys = old.map(([, y]) => y)
    if (Math.max(...xs) + pad < scratchBox[0] || Math.min(...xs) - pad > scratchBox[2] ||
        Math.max(...ys) + pad < scratchBox[1] || Math.min(...ys) - pad > scratchBox[3]) return false
    for (let i = 0; i < path.length; i++) {
      const a = path[i], b = path[i + 1] ?? a
      for (let j = 0; j < old.length; j++) {
        const c = old[j], d = old[j + 1] ?? c
        if (within(a, b, c, d, pad)) return true
      }
    }
    return false
  }).map((stroke) => stroke.id)
}

function distToSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}

// Smooth path through the recorded points: quadratic curves between midpoints, with each point
// as the control point. Same shape on screen and in exported PDFs. Commands are in page fractions.
export function smoothPath(p) {
  if (p.length < 3) return [['M', ...p[0]], ['L', ...(p[1] ?? p[0])]] // a dot still needs a segment
  const cmds = [['M', ...p[0]]]
  for (let i = 1; i < p.length - 1; i++) {
    cmds.push(['Q', p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2])
  }
  cmds.push(['L', ...p.at(-1)])
  return cmds
}

// Maps on-screen page fractions (u right, v down) to PDF user space (y up), inverting what pdf.js
// does to display a page: the CropBox, rotated clockwise by /Rotate. `displayWidth` is the
// on-screen page width in PDF units, which stroke widths are a fraction of.
export function pdfPageMapper({ x, y, width: W, height: H }, rotation = 0) {
  const r = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360
  const map = {
    0: (u, v) => [x + u * W, y + H - v * H],
    90: (u, v) => [x + v * W, y + u * H],
    180: (u, v) => [x + W - u * W, y + v * H],
    270: (u, v) => [x + W - v * W, y + H - u * H],
  }[r]
  return { map, displayWidth: r % 180 ? H : W }
}

// Path for pdf-lib's drawSvgPath at x 0, y 0 (which flips y, so y is negated here), same shape as
// the canvas. PDF has no quadratic curve, and pdf-lib turns SVG "Q" into a different curve
// (operator "v": first control point = start point), so each Q is written as its exact cubic.
// The map is affine, so mapping control points keeps the curve exact.
export function toPdfPath(points, map) {
  const fmt = ([X, Y]) => `${X.toFixed(3)} ${(-Y).toFixed(3)}`
  const toward = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  let cur
  return smoothPath(points).map(([c, ...v]) => {
    if (c !== 'Q') {
      cur = map(v[0], v[1])
      return c + fmt(cur)
    }
    const q = map(v[0], v[1]), end = map(v[2], v[3])
    const out = `C${fmt(toward(cur, q, 2 / 3))} ${fmt(toward(end, q, 2 / 3))} ${fmt(end)}`
    cur = end
    return out
  }).join(' ')
}

// Skip only subpixel jitter; larger thresholds make thin pencil strokes look angular or sparse.
export const farEnough = (a, b, w, h, minPx = 0.5) => Math.hypot((a[0] - b[0]) * w, (a[1] - b[1]) * h) >= minPx

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export function drawStroke(ctx, stroke, w, h) {
  const p = stroke.points
  if (!p.length) return
  ctx.save()
  ctx.lineCap = ctx.lineJoin = 'round'
  ctx.strokeStyle = stroke.color
  ctx.lineWidth = stroke.width * w
  if (stroke.tool === 'highlighter') {
    ctx.globalAlpha = 0.35
    ctx.globalCompositeOperation = 'multiply'
  }
  ctx.beginPath()
  for (const [c, ...v] of smoothPath(p)) {
    if (c === 'M') ctx.moveTo(v[0] * w, v[1] * h)
    else if (c === 'Q') ctx.quadraticCurveTo(v[0] * w, v[1] * h, v[2] * w, v[3] * h)
    else ctx.lineTo(v[0] * w, v[1] * h)
  }
  ctx.stroke()
  ctx.restore()
}

// Per-canvas pixel budget. Safari refuses canvases over ~16.7M px, and a tablet holds a pdf and an
// ink canvas for each nearby page, so very high zoom renders slightly below screen resolution.
export const MAX_CANVAS_PIXELS = 16_000_000

// Whole-pixel canvas size for a page shown at cssW×cssH, with `ratio` screen pixels per CSS pixel
// (devicePixelRatio × pinch zoom). Only scaled down when it would exceed the budget.
export function canvasSize(cssW, cssH, ratio, max = MAX_CANVAS_PIXELS) {
  const r = Math.min(ratio, Math.sqrt(max / (cssW * cssH)))
  return { width: Math.round(cssW * r), height: Math.round(cssH * r) }
}

// Line widths: a stroke stores `width` as a fraction of the page width as displayed (that is how
// both the canvas and exportPdf scale it), so in the exported PDF its width is
// width × (page width in points, rotation applied) — pdf.js' scale-1 viewport width.
// The tool panel works in points, converted with the width of the page being drawn on.
export const MAX_STROKE_WIDTH = 0.19 // the database requires width < 0.2
export const ptToWidth = (pt, pageWidthPt) => Math.min(MAX_STROKE_WIDTH, Math.max(0.0001, pt / pageWidthPt))
export const widthToPt = (width, pageWidthPt) => width * pageWidthPt

// '#RRGGBB' in the lowercase form the colour input produces; null for anything the database would refuse
export const normalizeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c ?? '') ? c.toLowerCase() : null)
