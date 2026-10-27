// Export geometry checked against pdf.js itself: pdf.js decides where a page point appears on
// screen, so mapping that screen position back must land on the same PDF point.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument, degrees } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pdfPageMapper, smoothPath, toPdfPath } from './geometry.js'

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

for (const rotation of [0, 90, 180, 270, -90]) {
  test(`page mapping matches pdf.js: CropBox offset, /Rotate ${rotation}`, async () => {
    const doc = await PDFDocument.create()
    const p = doc.addPage([300, 500])
    p.setCropBox(10, 20, 200, 400)
    p.setRotation(degrees(rotation))
    const bytes = await doc.save()

    const shown = await (await getDocument({ data: bytes.slice(), verbosity: 0 }).promise).getPage(1)
    const vp = shown.getViewport({ scale: 1 })
    const page = (await PDFDocument.load(bytes)).getPage(0)
    const { map, displayWidth } = pdfPageMapper(page.getCropBox(), page.getRotation().angle)

    close(displayWidth, vp.width) // stroke widths are a fraction of this
    for (const [X, Y] of [[10, 20], [210, 420], [60, 300], [205, 25]]) {
      const [dx, dy] = vp.convertToViewportPoint(X, Y)
      const [mx, my] = map(dx / vp.width, dy / vp.height)
      close(mx, X)
      close(my, Y)
    }
  })
}

// evaluate a path string from toPdfPath (y is negated for drawSvgPath; undo that here)
function parse(path) {
  return path.match(/[MLC][^MLC]*/g).map((seg) => {
    const n = seg.slice(1).trim().split(/\s+/).map(Number)
    const pts = []
    for (let i = 0; i < n.length; i += 2) pts.push([n[i], -n[i + 1]])
    return { c: seg[0], pts }
  })
}
const quad = (p0, q, p1, t) => p0.map((_, i) => (1 - t) ** 2 * p0[i] + 2 * (1 - t) * t * q[i] + t ** 2 * p1[i])
const cubic = (p0, c1, c2, p1, t) => p0.map((_, i) =>
  (1 - t) ** 3 * p0[i] + 3 * (1 - t) ** 2 * t * c1[i] + 3 * (1 - t) * t ** 2 * c2[i] + t ** 3 * p1[i])

test('exported curves are exactly the curves drawn on the canvas', () => {
  const identity = (u, v) => [u * 1000, v * 1000]
  // a sharp zigzag and a reversal: the shapes that came out as spikes / wrong curves
  const points = [[0.1, 0.1], [0.3, 0.4], [0.2, 0.1], [0.5, 0.5], [0.5, 0.5], [0.45, 0.2], [0.9, 0.3]]
  const canvas = smoothPath(points).map(([c, ...v]) => ({ c, v: v.map((x) => x * 1000) }))
  const pdf = parse(toPdfPath(points, identity))
  assert.equal(pdf.length, canvas.length)
  let cur
  pdf.forEach((seg, i) => {
    const ref = canvas[i]
    if (ref.c === 'Q') {
      assert.equal(seg.c, 'C') // never "Q": pdf-lib would turn it into a different curve
      const [c1, c2, end] = seg.pts
      for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        const a = quad(cur, ref.v.slice(0, 2), ref.v.slice(2), t)
        const b = cubic(cur, c1, c2, end, t)
        close(a[0], b[0], 2e-3); close(a[1], b[1], 2e-3) // within rounding of 3 decimals
      }
      cur = end
    } else {
      assert.equal(seg.c, ref.c)
      close(seg.pts[0][0], ref.v[0], 1e-3); close(seg.pts[0][1], ref.v[1], 1e-3)
      cur = seg.pts[0]
    }
  })
  assert.ok(!/NaN|Infinity/.test(toPdfPath(points, identity)))
})

test('short strokes: a dot and a two-point line stay a dot and a straight line', () => {
  const id = (u, v) => [u * 100, v * 100]
  assert.equal(toPdfPath([[0.5, 0.5]], id), 'M50.000 -50.000 L50.000 -50.000') // drawn as a round-capped dot
  assert.equal(toPdfPath([[0.1, 0.2], [0.3, 0.2]], id), 'M10.000 -20.000 L30.000 -20.000')
  assert.ok(!/NaN/.test(toPdfPath([[0.1, 0.1], [0.1, 0.1], [0.1, 0.1]], id))) // repeated points
})

test('rotated page: a stroke along the top of the screen lands on the PDF left edge', () => {
  // /Rotate 90 turns the page clockwise, so the PDF's left edge is shown along the top
  const { map } = pdfPageMapper({ x: 0, y: 0, width: 200, height: 400 }, 90)
  const ends = parse(toPdfPath([[0, 0], [0.5, 0], [1, 0]], map)).map((s) => s.pts.at(-1))
  ;[[0, 0], [0, 400]].forEach((want, i) => { close(ends.at(i ? -1 : 0)[0], want[0]); close(ends.at(i ? -1 : 0)[1], want[1]) })
})

test('a stroke set to N pt is N pt wide in the exported PDF, on any page size or rotation', async () => {
  const { ptToWidth } = await import('./geometry.js')
  for (const [w, h, rot] of [[595.28, 841.89, 0], [612, 792, 0], [500, 300, 90]]) {
    const doc = await PDFDocument.create()
    const p = doc.addPage([w, h]); p.setRotation(degrees(rot))
    const shown = await (await getDocument({ data: (await doc.save()).slice(), verbosity: 0 }).promise).getPage(1)
    const pageWidthPt = shown.getViewport({ scale: 1 }).width // what the editor converts with
    const { displayWidth } = pdfPageMapper(p.getCropBox(), p.getRotation().angle) // what exportPdf multiplies by
    for (const pt of [0.5, 1, 2.4, 12]) close(ptToWidth(pt, pageWidthPt) * displayWidth, pt, 1e-9)
  }
})
