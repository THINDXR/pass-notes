// Long-press on a toolbar tool button opens the tool palette. Web pages can't see an
// Apple Pencil Pro squeeze (only a native iPad app can), so long-press is the trigger here.

// Pointer Events long-press: fires once after `delay` ms if the press stays down and within
// `slop` px. Lifting, cancelling, leaving or dragging clears the timer, so the palette can't
// open after the pen is already up.
export function longPress(onLongPress, { delay = 450, slop = 10 } = {}) {
  let timer = null
  let start = null
  let fired = false
  let releasedAt = 0
  const clear = () => { clearTimeout(timer); timer = null; start = null }
  const release = () => { if (fired) releasedAt = Date.now(); clear() }
  return {
    onPointerDown(e) {
      clear()
      fired = false
      if (e.button > 0) return // primary press only: pen tip, finger, left mouse
      const at = { x: e.clientX, y: e.clientY }
      start = at
      const target = e.currentTarget
      timer = setTimeout(() => { timer = null; start = null; fired = true; onLongPress({ ...at, target }) }, delay)
    },
    onPointerMove(e) { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > slop) clear() },
    onPointerUp: release,
    onPointerCancel: release,
    onPointerLeave: clear,
    cancel: clear, // closing the panel or leaving the page must not leave a timer running
    // the click that ends a long-press belongs to it: the button must not also handle it. Touch may
    // not send that click at all, so only a click right after the release counts.
    consumeClick() { const f = fired && Date.now() - releasedAt < 500; fired = false; return f },
  }
}

// Where to put the palette (fixed position) for a press at `at`: centred under the press point
// so the hand doesn't cover it, above it if there's no room below, always inside the viewport.
// Anchored to a button, `at.y` is its bottom and `at.top` its top, so the panel never covers it.
export function placePalette(at, size, view, gap = 16, margin = 8) {
  let x = at.x - size.width / 2
  let y = at.y + gap
  if (y + size.height > view.height - margin) y = (at.top ?? at.y) - gap - size.height
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi))
  return {
    left: Math.round(clamp(x, margin, view.width - size.width - margin)),
    top: Math.round(clamp(y, margin, view.height - size.height - margin)),
  }
}

// Where the floating tool button sits: 8 spots around the edge. The centre is never allowed,
// it would cover the page being read or written on. Saved per user on this device only.
export const FAB_POSITIONS = {
  tl: 'ซ้ายบน', tc: 'กลางบน', tr: 'ขวาบน',
  ml: 'ซ้ายกลาง', mr: 'ขวากลาง',
  bl: 'ซ้ายล่าง', bc: 'กลางล่าง', br: 'ขวาล่าง',
}
export const DEFAULT_FAB_POSITION = 'br'
const fabKey = (uid) => `passnotes:fab-position:${uid}`

export function loadFabPosition(storage, uid) {
  try {
    const v = storage?.getItem(fabKey(uid))
    return Object.hasOwn(FAB_POSITIONS, v) ? v : DEFAULT_FAB_POSITION // unknown / centre / corrupt → default
  } catch {
    return DEFAULT_FAB_POSITION
  }
}

// false if the position isn't one of the 8 (e.g. the centre) or the browser refused to store it
export function saveFabPosition(storage, uid, pos) {
  if (!Object.hasOwn(FAB_POSITIONS, pos)) return false
  try { storage.setItem(fabKey(uid), pos); return true } catch { return false }
}
