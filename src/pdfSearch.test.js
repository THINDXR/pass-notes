import test from 'node:test'
import assert from 'node:assert/strict'
import { findInItems, hasText, matchRects } from './pdfSearch.js'

const items = [{ str: 'Hello Wor' }, { str: 'ld again', hasEOL: true }, { str: 'hello กฎหมาย' }]

test('finds matches case-insensitively, including across items', () => {
  const m = findInItems(items, 'hello')
  assert.equal(m.length, 2)
  assert.deepEqual(m[0].parts, [{ item: 0, from: 0, to: 5 }])
  assert.deepEqual(m[1].parts, [{ item: 2, from: 0, to: 5 }])
  assert.deepEqual(findInItems(items, 'world')[0].parts, [{ item: 0, from: 6, to: 9 }, { item: 1, from: 0, to: 2 }])
})

test('line breaks read as spaces; Thai text works', () => {
  assert.equal(findInItems(items, 'again hello').length, 1)
  assert.deepEqual(findInItems(items, 'กฎหมาย')[0].parts, [{ item: 2, from: 6, to: 12 }])
})

test('empty query, no match and the hit limit', () => {
  assert.deepEqual(findInItems(items, '   '), [])
  assert.deepEqual(findInItems(items, 'zzz'), [])
  assert.equal(findInItems([{ str: 'aaaaaa' }], 'a', 4).length, 4)
})

test('scanned pages have no text', () => {
  assert.equal(hasText([]), false)
  assert.equal(hasText([{ str: '  ' }]), false)
  assert.equal(hasText(items), true)
})

test('rects are page fractions', () => {
  // item at x=100, baseline y=200 (viewport, y down), font size 10, 50 units wide for 5 chars
  const it = [{ str: 'abcde', width: 50, height: 10, transform: [10, 0, 0, 10, 100, 200] }]
  const [r] = matchRects(it, [{ item: 0, from: 1, to: 3 }], (t) => t, 1000, 1000)
  assert.deepEqual(r, { x: 0.11, y: 0.19, w: 0.02, h: 0.012 })
})
