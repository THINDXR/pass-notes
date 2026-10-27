import test from 'node:test'
import assert from 'node:assert/strict'
import { groupSessions } from './history.js'

const alice = { display_name: 'alice' }, bob = { display_name: 'bob' }
let id = 0
const ev = (actor, action, at, stroke_id, stroke = { page: 1, deleted: false }) => ({ id: ++id, actor, action, at, stroke_id, stroke })

test('one session per person per uninterrupted stretch of work', () => {
  const events = [
    ev(alice, 'add', '2026-10-26T10:00:00Z', 's1'),
    ev(alice, 'add', '2026-10-26T10:20:00Z', 's2', { page: 3, deleted: false }),
    ev(alice, 'erase', '2026-10-26T10:45:00Z', 's1', { page: 1, deleted: true }), // 25 min later: same session
    ev(bob, 'add', '2026-10-26T10:46:00Z', 's3'),
    ev(alice, 'add', '2026-10-26T12:00:00Z', 's4'), // 75 min after alice's last: new session
  ]
  const s = groupSessions([...events].reverse()) // input order doesn't matter
  assert.deepEqual(s.map((x) => [x.actor, x.start, x.end]), [
    ['alice', '2026-10-26T12:00:00Z', '2026-10-26T12:00:00Z'],
    ['bob', '2026-10-26T10:46:00Z', '2026-10-26T10:46:00Z'],
    ['alice', '2026-10-26T10:00:00Z', '2026-10-26T10:45:00Z'],
  ])
  assert.deepEqual(s[2].counts, { add: 2, copy: 0, erase: 1, restore: 0 })
  assert.deepEqual(s[2].pages, [1, 3])
  assert.deepEqual(s[2].restorable, ['s1'])
})

test('only notes that are still erased, by their latest event, can be restored', () => {
  const events = [
    ev(alice, 'erase', '2026-10-26T10:00:00Z', 'a', { page: 1, deleted: false }),
    ev(bob, 'restore', '2026-10-26T10:05:00Z', 'a', { page: 1, deleted: false }), // a was restored later
    ev(bob, 'erase', '2026-10-26T10:06:00Z', 'b', { page: 1, deleted: true }),
    ev(bob, 'erase', '2026-10-26T10:07:00Z', 'c', { page: 1, deleted: true }),
    ev(alice, 'erase', '2026-10-26T10:08:00Z', 'b', { page: 1, deleted: true }), // b erased again later
  ]
  const s = groupSessions(events)
  assert.deepEqual(s.map((x) => [x.actor, x.restorable]), [['alice', ['b']], ['bob', ['c']], ['alice', []]])
})

test('deleted accounts group together as an unknown actor', () => {
  const s = groupSessions([ev(null, 'copy', '2026-10-26T10:00:00Z', 'x'), ev(null, 'copy', '2026-10-26T10:00:00Z', 'y')])
  assert.equal(s.length, 1)
  assert.equal(s[0].actor, null)
  assert.equal(s[0].counts.copy, 2)
})
