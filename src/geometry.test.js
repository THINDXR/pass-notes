import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_CANVAS_PIXELS, MAX_STROKE_WIDTH, canvasSize, farEnough, hitsStroke, hexToRgb, normalizeColor, ptToWidth, scribbleEraseTargets, smoothPath, widthToPt } from './geometry.js'

const line = { points: [[0.1, 0.5], [0.9, 0.5]], width: 0.01 }

test('hitsStroke', () => {
  assert.ok(hitsStroke(line, 0.5, 0.5, 0.01))
  assert.ok(hitsStroke(line, 0.5, 0.514, 0.01)) // radius + half width
  assert.ok(!hitsStroke(line, 0.5, 0.53, 0.01))
  assert.ok(!hitsStroke(line, 0.95, 0.5, 0.01)) // past the end
  assert.ok(hitsStroke({ points: [[0.2, 0.2]], width: 0.01 }, 0.205, 0.2, 0.001))
})

test('scribble erase only returns existing strokes crossed by a fast zigzag scratch-out', () => {
  const old = { id: 'old', points: [[0.2, 0.5], [0.8, 0.5]], width: 0.01 }
  const nearby = { id: 'nearby', points: [[0.2, 0.558], [0.8, 0.558]], width: 0.01 }
  const far = { id: 'far', points: [[0.2, 0.8], [0.8, 0.8]], width: 0.01 }
  const scribble = { points: [[0.2, 0.45], [0.8, 0.55], [0.2, 0.45], [0.8, 0.55], [0.2, 0.45], [0.8, 0.55], [0.2, 0.45], [0.8, 0.55]] }
  assert.deepEqual(scribbleEraseTargets(scribble, [old, nearby, far], 1000, 1400, 500), ['old'])
  assert.deepEqual(scribbleEraseTargets(scribble, [{ ...old, deleted: true }], 1000, 1400, 500), [])
  assert.deepEqual(scribbleEraseTargets(scribble, [old], 1000, 1400, 1500), []) // slow writing stays ink
  assert.deepEqual(scribbleEraseTargets({ points: [[0.2, 0.5], [0.8, 0.5]] }, [old], 1000, 1400, 300), []) // straight stroke stays ink
  const quickWriting = { points: [[0.2, 0.5], [0.3, 0.42], [0.4, 0.56], [0.5, 0.43], [0.6, 0.55], [0.7, 0.46], [0.8, 0.52]] }
  assert.deepEqual(scribbleEraseTargets(quickWriting, [old], 1000, 1400, 400), []) // fast cursive motion still flows in one direction
  const shortScratch = { points: [[0.2, 0.45], [0.8, 0.55], [0.2, 0.45], [0.8, 0.55], [0.2, 0.45], [0.8, 0.55]] }
  assert.deepEqual(scribbleEraseTargets(shortScratch, [old], 1000, 1400, 400), []) // fewer reversals are treated as writing
  assert.deepEqual(scribbleEraseTargets(scribble, [], 1000, 1400, 500), []) // no old ink crossed
})

test('smoothPath curves through midpoints and ends on the last point', () => {
  assert.deepEqual(smoothPath([[0, 0], [1, 1], [2, 0], [3, 1]]), [
    ['M', 0, 0], ['Q', 1, 1, 1.5, 0.5], ['Q', 2, 0, 2.5, 0.5], ['L', 3, 1],
  ])
})

test('farEnough drops only subpixel jitter', () => {
  assert.equal(farEnough([0.5, 0.5], [0.5004, 0.5], 1000, 1000), false) // 0.4px
  assert.equal(farEnough([0.5, 0.5], [0.501, 0.5], 1000, 1000), true) // 1px
})

test('hexToRgb', () => {
  assert.deepEqual(hexToRgb('#ff0080'), [1, 0, 128 / 255])
})

test('canvasSize: whole screen pixels, capped by the budget', () => {
  assert.deepEqual(canvasSize(900, 1273, 2), { width: 1800, height: 2546 }) // Retina
  assert.deepEqual(canvasSize(900, 1273, 2 * 2.5, 1e9), { width: 4500, height: 6365 }) // pinch ×2.5, no cap
  const capped = canvasSize(900, 1273, 5)
  assert.ok(capped.width * capped.height <= MAX_CANVAS_PIXELS)
  assert.ok(Math.abs(capped.width / capped.height - 900 / 1273) < 0.001) // keeps the aspect ratio
  assert.deepEqual(canvasSize(800, 1131, 1), { width: 800, height: 1131 })
})

test('pen width in points ↔ stored width, per page size', () => {
  const A4 = 595.28, letter = 612
  assert.ok(Math.abs(ptToWidth(1, A4) - 1 / A4) < 1e-12)
  assert.ok(Math.abs(widthToPt(ptToWidth(1.5, letter), letter) - 1.5) < 1e-9) // round trip
  assert.ok(ptToWidth(1, A4) > ptToWidth(1, letter)) // same pt is a larger share of a narrower page
  assert.equal(ptToWidth(500, 200), MAX_STROKE_WIDTH) // never what the database refuses
  assert.ok(ptToWidth(0, A4) > 0)
})

test('normalizeColor accepts what the colour input gives, refuses the rest', () => {
  assert.equal(normalizeColor('#E53935'), '#e53935')
  assert.equal(normalizeColor('#1e88e5'), '#1e88e5')
  for (const bad of ['red', '#fff', '#12345g', '', null, undefined, '#1234567']) assert.equal(normalizeColor(bad), null)
})
