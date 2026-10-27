import test from 'node:test'
import assert from 'node:assert/strict'
import { doubleTapDetector, isStylusTouch, multiTapDetector, nextPenMode, pointerRole, touchActionFor } from './inputPolicy.js'

test('touch-action: editor handles finger pan and pinch gestures in-app', () => {
  assert.equal(touchActionFor(true, 'native'), 'none')
  assert.equal(touchActionFor(false, 'native'), 'none') // view-only
  assert.equal(touchActionFor(true, 'manual'), 'none')
})

test('each gesture is decided by its own pointer type', () => {
  for (const mode of ['native', 'manual']) {
    assert.equal(pointerRole('pen', true, mode), 'draw')
    assert.equal(pointerRole('mouse', true, mode), 'draw')
    assert.equal(pointerRole('pen', false, mode), 'ignore')
  }
  assert.equal(pointerRole('touch', true, 'native'), 'ignore') // the very first finger scrolls
  assert.equal(pointerRole('touch', true, 'manual'), 'pan')
})

test('only a cancelled pen stroke switches to the manual fallback', () => {
  assert.equal(nextPenMode('native', 'pen-cancelled'), 'manual')
  assert.equal(nextPenMode('native', 'other'), 'native')
  assert.equal(nextPenMode('manual', 'other'), 'manual')
})

test('stylus touches are recognised by touchType only', () => {
  assert.equal(isStylusTouch({ changedTouches: [{ touchType: 'stylus' }] }), true)
  assert.equal(isStylusTouch({ changedTouches: [{ touchType: 'direct' }] }), false)
  assert.equal(isStylusTouch({ changedTouches: [{}] }), false)
  assert.equal(isStylusTouch({}), false)
})

const t = (type, id, time, x = 100, y = 100, pointerType = 'touch') => ({ type, pointerId: id, timeStamp: time, clientX: x, clientY: y, pointerType })
function run(events) {
  const taps = []
  const d = multiTapDetector((n) => taps.push(n))
  for (const e of events) d[{ pointerdown: 'down', pointermove: 'move', pointerup: 'up', pointercancel: 'cancel' }[e.type]](e)
  return taps
}

test('two-finger tap = 2, three-finger tap = 3, once per gesture', () => {
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerdown', 2, 10), t('pointerup', 1, 120), t('pointerup', 2, 130)]), [2])
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerdown', 2, 5), t('pointerdown', 3, 20), t('pointerup', 2, 100), t('pointerup', 1, 110), t('pointerup', 3, 115)]), [3])
  // two taps in a row → two commands, not more
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerdown', 2, 0), t('pointerup', 1, 80), t('pointerup', 2, 80),
    t('pointerdown', 3, 400), t('pointerdown', 4, 410), t('pointerup', 3, 500), t('pointerup', 4, 500)]), [2, 2])
})

test('fingers landing slightly apart still count; too far apart do not', () => {
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerdown', 2, 140), t('pointerup', 1, 250), t('pointerup', 2, 260)]), [2])
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerdown', 2, 200), t('pointerup', 1, 280), t('pointerup', 2, 290)]), [])
})

test('not a tap: one finger, a drag, a hold, a cancel, a pen or mouse, or a changing finger count', () => {
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerup', 1, 80)]), []) // one finger
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerdown', 2, 5), t('pointermove', 2, 40, 100, 140), t('pointerup', 1, 90), t('pointerup', 2, 95)]), []) // pinch / scroll start
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerdown', 2, 5), t('pointerup', 1, 500), t('pointerup', 2, 510)]), []) // held
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerdown', 2, 5), t('pointercancel', 1, 50), t('pointercancel', 2, 50)]), []) // browser took it
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerdown', 2, 5), t('pointercancel', 1, 50), t('pointerup', 2, 80)]), [])
  assert.deepEqual(run([t('pointerdown', 1, 0, 100, 100, 'pen'), t('pointerdown', 2, 5, 100, 100, 'pen'), t('pointerup', 1, 50, 100, 100, 'pen'), t('pointerup', 2, 60, 100, 100, 'pen')]), []) // Apple Pencil
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerdown', 9, 5, 100, 100, 'pen'), t('pointerdown', 2, 10), t('pointerup', 1, 50), t('pointerup', 2, 60)]), []) // pen during the tap
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerdown', 2, 5), t('pointerup', 1, 50), t('pointerdown', 3, 60), t('pointerup', 2, 90), t('pointerup', 3, 100)]), []) // finger added after one lifted
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerdown', 2, 2), t('pointerdown', 3, 4), t('pointerdown', 4, 6), t('pointerup', 1, 50), t('pointerup', 2, 50), t('pointerup', 3, 50), t('pointerup', 4, 50)]), []) // four fingers
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerdown', 2, 5), t('pointermove', 1, 30, 105, 104), t('pointerup', 1, 80), t('pointerup', 2, 85)]), [2]) // tiny jitter is fine
})

test('a gesture whose up never arrived does not block the next one', () => {
  assert.deepEqual(run([t('pointerdown', 1, 0), t('pointerdown', 2, 5), // lost
    t('pointerdown', 3, 2000), t('pointerdown', 4, 2010), t('pointerup', 3, 2100), t('pointerup', 4, 2110)]), [2])
})

test('single-finger double tap fires once; movement and multi-touch cancel it', () => {
  const taps = []
  const d = doubleTapDetector((x, y) => taps.push([x, y]))
  d.down(t('pointerdown', 1, 0, 20, 30)); d.up(t('pointerup', 1, 80, 20, 30))
  d.down(t('pointerdown', 2, 180, 22, 31)); d.up(t('pointerup', 2, 250, 22, 31))
  assert.deepEqual(taps, [[22, 31]])

  d.down(t('pointerdown', 3, 400)); d.move(t('pointermove', 3, 420, 130, 130)); d.up(t('pointerup', 3, 450, 130, 130))
  d.down(t('pointerdown', 4, 500)); d.down(t('pointerdown', 5, 510)); d.up(t('pointerup', 4, 550)); d.up(t('pointerup', 5, 560))
  assert.deepEqual(taps, [[22, 31]])
})

