// Pinch-zoom math for the PDF page stack. Everything is in client (viewport) px.
// During a pinch the whole .page-stack gets one CSS transform (origin 0 0); on release the
// real zoom is rendered and the scroll position puts the same page point back under the fingers.

export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 4
export const clampZoom = (n) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, n))

// Page point under (x, y) as page fractions. In a gap or a side margin it picks the nearest page
// (vertically) and leaves u, v outside 0..1, so a point beside the page stays where it was too.
export function anchorAt(rects, x, y) {
  let best = -1, bestD = Infinity
  rects.forEach((r, i) => {
    const d = Math.max(r.top - y, 0, y - (r.top + r.height))
    if (d < bestD) { best = i; bestD = d }
  })
  if (best < 0) return null
  const r = rects[best]
  return { index: best, u: (x - r.left) / r.width, v: (y - r.top) / r.height }
}

// Translation for `translate(tx, ty) scale(k)` that shows the content which was under the start
// midpoint (s.x0, s.y0) at the current midpoint (x, y). s.left/top: the untransformed stack's client
// position at the start; scrolled: how far the scroller moved since, which shifts the stack's layout box.
export function previewTransform(s, x, y, k, scrolledX = 0, scrolledY = 0) {
  return {
    tx: x - (s.left - scrolledX) - k * (s.x0 - s.left),
    ty: y - (s.top - scrolledY) - k * (s.y0 - s.top),
  }
}

// Scroll delta that brings page point a (fractions) of a page laid out at rect r under (x, y).
export const anchorScroll = (r, a, x, y) => ({ dx: r.left + a.u * r.width - x, dy: r.top + a.v * r.height - y })

// Part of the requested correction the browser could not apply because scroll hit an edge.
export const anchorPan = (delta, before, after) => delta - (after - before)
