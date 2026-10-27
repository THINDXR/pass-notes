// Groups per-stroke history events into editing sessions for display.
// A session is one person's consecutive changes with no pause longer than SESSION_GAP_MS — the
// closest reliable stand-in for "opened … closed", since closing a tab can't be recorded.

export const SESSION_GAP_MS = 30 * 60 * 1000

// events: [{ id, stroke_id, action, at, actor: { display_name } | null, stroke: { page, deleted } | null }]
// in any order. Returns sessions newest first:
// { key, actor, start, end, counts: { add, copy, erase, restore }, pages: [n], restorable: [stroke ids] }
export function groupSessions(events, gap = SESSION_GAP_MS) {
  const asc = [...events].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id)
  const latest = new Map() // stroke id → its newest event id
  for (const e of asc) latest.set(e.stroke_id, e.id)

  const sessions = []
  for (const e of asc) {
    const actor = e.actor?.display_name ?? null
    const t = Date.parse(e.at)
    let s = sessions.at(-1)
    if (!s || s.actor !== actor || t - Date.parse(s.end) > gap) {
      s = { key: e.id, actor, start: e.at, end: e.at, counts: { add: 0, copy: 0, erase: 0, restore: 0 }, pages: new Set(), restorable: [] }
      sessions.push(s)
    }
    s.end = e.at
    s.counts[e.action]++
    if (e.stroke?.page) s.pages.add(e.stroke.page)
    // still erased, and this erase is the last thing that happened to the note
    if (e.action === 'erase' && e.stroke?.deleted && latest.get(e.stroke_id) === e.id) s.restorable.push(e.stroke_id)
  }
  return sessions.reverse().map((s) => ({ ...s, pages: [...s.pages].sort((a, b) => a - b) }))
}
