import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_FAB_POSITION, FAB_POSITIONS, loadFabPosition, longPress, placePalette, saveFabPosition } from './toolPalette.js'

const ev = (x = 100, y = 100, button = 0) => ({ clientX: x, clientY: y, button, currentTarget: 'btn' })

test('long-press fires after the delay and swallows the click that ends it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const opened = []
  const lp = longPress((p) => opened.push(p))
  lp.onPointerDown(ev())
  t.mock.timers.tick(449)
  assert.equal(opened.length, 0)
  t.mock.timers.tick(1)
  assert.deepEqual(opened, [{ x: 100, y: 100, target: 'btn' }])
  lp.onPointerUp()
  assert.equal(lp.consumeClick(), true) // the click after the long-press is ignored
  assert.equal(lp.consumeClick(), false) // only once
})

test('a quick tap is a normal click and never opens later', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const opened = []
  const lp = longPress(() => opened.push(1))
  lp.onPointerDown(ev())
  t.mock.timers.tick(200)
  lp.onPointerUp()
  t.mock.timers.tick(1000)
  assert.equal(opened.length, 0)
  assert.equal(lp.consumeClick(), false)
})

test('cancel, leave and dragging away clear the timer; small jitter does not', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let n = 0
  const lp = longPress(() => n++)
  for (const end of ['onPointerCancel', 'onPointerLeave']) {
    lp.onPointerDown(ev()); t.mock.timers.tick(300); lp[end](); t.mock.timers.tick(1000)
  }
  lp.onPointerDown(ev()); lp.onPointerMove(ev(115, 100)); t.mock.timers.tick(1000) // dragged 15px
  assert.equal(n, 0)
  lp.onPointerDown(ev()); lp.onPointerMove(ev(105, 104)); t.mock.timers.tick(450) // 6px pen jitter
  assert.equal(n, 1)
  lp.onPointerDown(ev(100, 100, 2)); t.mock.timers.tick(1000) // right/secondary button
  assert.equal(n, 1)
})

const view = { width: 800, height: 600 }
const size = { width: 300, height: 200 }

test('palette goes under the press point, centred', () => {
  assert.deepEqual(placePalette({ x: 400, y: 40 }, size, view), { left: 250, top: 56 })
})

test('palette stays inside the screen', () => {
  assert.deepEqual(placePalette({ x: 20, y: 40 }, size, view), { left: 8, top: 56 }) // left edge
  assert.deepEqual(placePalette({ x: 790, y: 40 }, size, view), { left: 492, top: 56 }) // right edge
  assert.deepEqual(placePalette({ x: 400, y: 500 }, size, view), { left: 250, top: 284 }) // no room below: above
  assert.deepEqual(placePalette({ x: 400, y: 300 }, { width: 300, height: 590 }, view), { left: 250, top: 8 }) // taller than room
})

test('a long-press without a following click does not swallow a later click', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const lp = longPress(() => {})
  lp.onPointerDown(ev()); t.mock.timers.tick(450); lp.onPointerUp() // touch: no click arrives
  t.mock.timers.tick(2000)
  assert.equal(lp.consumeClick(), false) // e.g. a later keyboard Enter on the button still works
})

test('cancel() (panel closed, page left) stops a pending long-press', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let n = 0
  const lp = longPress(() => n++)
  lp.onPointerDown(ev()); t.mock.timers.tick(300); lp.cancel(); t.mock.timers.tick(1000)
  assert.equal(n, 0)
})

test('anchored to a button: below its bottom, or above its top when there is no room', () => {
  // button at the top of the screen (y 60..116): panel goes under it
  assert.deepEqual(placePalette({ x: 400, y: 116, top: 60 }, size, view), { left: 250, top: 132 })
  // button at the bottom (y 520..576): no room below → above its top, not overlapping it
  assert.deepEqual(placePalette({ x: 400, y: 576, top: 520 }, size, view), { left: 250, top: 304 })
})

const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m } }

test('button position: 8 edge spots, saved per user, centre and junk rejected', () => {
  assert.equal(Object.keys(FAB_POSITIONS).length, 8)
  assert.ok(!('mc' in FAB_POSITIONS) && !('center' in FAB_POSITIONS))
  const s = store()
  assert.equal(loadFabPosition(s, 'u1'), DEFAULT_FAB_POSITION)
  assert.equal(saveFabPosition(s, 'u1', 'tl'), true)
  assert.equal(loadFabPosition(s, 'u1'), 'tl')
  assert.equal(loadFabPosition(s, 'u2'), DEFAULT_FAB_POSITION) // another user on this device
  assert.equal(saveFabPosition(s, 'u1', 'mc'), false) // centre
  assert.equal(saveFabPosition(s, 'u1', 'toString'), false) // not an own key
  assert.equal(loadFabPosition(s, 'u1'), 'tl')
  s.m.set('passnotes:fab-position:u1', 'mc') // edited by hand
  assert.equal(loadFabPosition(s, 'u1'), DEFAULT_FAB_POSITION)
  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } }
  assert.equal(loadFabPosition(broken, 'u1'), DEFAULT_FAB_POSITION)
  assert.equal(saveFabPosition(broken, 'u1', 'tl'), false)
  assert.equal(loadFabPosition(null, 'u1'), DEFAULT_FAB_POSITION)
})
