// Text search over pdf.js getTextContent() items, kept free of pdf.js for testing.

export const MAX_HITS = 1000

// Finds `query` (case-insensitive) in a page's text items. A match may span items, so each match
// lists the parts of the items it covers: [{ parts: [{ item, from, to }] }] (character offsets).
export function findInItems(items, query, limit = MAX_HITS) {
  const q = query.trim().toLowerCase()
  if (!q) return []
  let text = ''
  const starts = []
  for (const it of items) {
    starts.push(text.length)
    text += it.str
    if (it.hasEOL) text += ' ' // a line break reads as a space; it belongs to no item
  }
  const lower = text.toLowerCase()
  const out = []
  for (let i = lower.indexOf(q); i !== -1 && out.length < limit; i = lower.indexOf(q, i + q.length)) {
    const end = i + q.length
    const parts = []
    for (let k = 0; k < items.length; k++) {
      const s = starts[k]
      if (s >= end) break
      const from = Math.max(i, s), to = Math.min(end, s + items[k].str.length)
      if (from < to) parts.push({ item: k, from: from - s, to: to - s })
    }
    out.push({ parts })
  }
  return out
}

// Rectangles (fractions of the page) for a match. `toViewport(transform)` maps an item's PDF transform
// into the scale-1 viewport (pdfjs Util.transform(viewport.transform, t)); pageW/pageH are that viewport's size.
// shortcut: assumes horizontal text; rotated pages or vertical text get approximate boxes.
export function matchRects(items, parts, toViewport, pageW, pageH) {
  return parts.map(({ item, from, to }) => {
    const it = items[item]
    const t = toViewport(it.transform)
    const h = Math.hypot(t[2], t[3]) || it.height
    const len = it.str.length || 1
    return {
      x: (t[4] + (it.width * from) / len) / pageW,
      y: (t[5] - h) / pageH,
      w: (it.width * (to - from)) / len / pageW,
      h: (h * 1.2) / pageH, // a little taller so descenders are covered
    }
  })
}

export const hasText = (items) => items.some((it) => it.str.trim())
