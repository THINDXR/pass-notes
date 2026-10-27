import test from 'node:test'
import assert from 'node:assert/strict'
import { anchorAt, anchorPan, anchorScroll, clampZoom, previewTransform } from './zoom.js'

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`)
// two 400×566 pages, 16px gap, stack at client (16, 60); same layout scaled by k
const layout = (k, left = 16, top = 60) => [0, 1].map((i) => ({ left: left + 0, top: top + i * (566 + 16) * k, width: 400 * k, height: 566 * k }))

test('anchorAt: inside a page, in the left margin, in the gap between pages', () => {
  const rects = layout(1)
  assert.deepEqual(anchorAt(rects, 216, 343), { index: 0, u: 0.5, v: 0.5 })
  const margin = anchorAt(rects, 6, 100) // left of page 1: not clamped to its edge, not page 1 by accident
  assert.equal(margin.index, 0); near(margin.u, -10 / 400)
  const lowerLeft = anchorAt(rects, 20, 60 + 582 + 500) // near the bottom-left corner of page 2
  assert.equal(lowerLeft.index, 1); near(lowerLeft.u, 4 / 400)
  assert.equal(anchorAt(rects, 100, 60 + 566 + 4).index, 0) // in the gap, nearer page 1
  assert.equal(anchorAt([], 0, 0), null)
})

test('previewTransform keeps the start point under the moving midpoint, even if the scroller moved', () => {
  const s = { left: 16, top: 60, x0: 30, y0: 90 } // pinch starts near the top-left corner
  for (const [x, y, k, sx, sy] of [[30, 90, 2.5, 0, 0], [80, 40, 0.6, 0, 0], [120, 300, 3, 25, -40]]) {
    const { tx, ty } = previewTransform(s, x, y, k, sx, sy)
    near(s.left - sx + tx + k * (s.x0 - s.left), x)
    near(s.top - sy + ty + k * (s.y0 - s.top), y)
  }
})

test('gesture end: what the preview showed under the fingers is what the real zoom anchors there', () => {
  for (const [x0, y0] of [[20, 70], [20, 600], [216, 343], [6, 100]]) { // top-left, bottom-left, centre, left margin
    const start = layout(1), s = { left: 16, top: 60, x0, y0 }
    const a = anchorAt(start, x0, y0)
    const k = 2.4, x = x0 + 35, y = y0 - 20 // zoom and drift during the pinch
    const { tx, ty } = previewTransform(s, x, y, k)
    // the anchor page as the preview draws it
    const r = start[a.index]
    const shown = { left: s.left + tx + k * (r.left - s.left), top: s.top + ty + k * (r.top - s.top), width: k * r.width, height: k * r.height }
    near((x - shown.left) / shown.width, a.u)
    near((y - shown.top) / shown.height, a.v)
    // after the real render (any position), scrolling by anchorScroll puts that page point under (x, y)
    const real = layout(k, 16, 60)[a.index]
    const { dx, dy } = anchorScroll(real, a, x, y)
    near(real.left - dx + a.u * real.width, x)
    near(real.top - dy + a.v * real.height, y)
    near(real.left - dx, shown.left) // same on-screen page position: no jump on release
  }
})

test('clampZoom keeps the existing limits', () => {
  assert.equal(clampZoom(0.1), 0.5)
  assert.equal(clampZoom(9), 4)
  assert.equal(clampZoom(1.7), 1.7)
})

test('anchor correction preserves the focal point when the browser clamps scroll at an edge', () => {
  near(anchorPan(-170, 0, 0), -170) // zooming out needs a negative scroll; shift the stack right instead
  near(anchorPan(220, 40, 180), 80) // at the far edge, apply the unapplied remainder to the stack
  near(anchorPan(60, 40, 100), 0) // normal scrolling applied the full correction
})
