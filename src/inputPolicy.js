// How pen, finger and mouse input map to drawing vs. scrolling, decided per gesture from the
// pointer itself (pointerType) — no user-agent sniffing and no waiting to "discover" a pen.
//
// - pen and mouse draw / erase with the selected tool
// - the editor handles finger pan and two-finger pinch inside the PDF
//
// Safari reports Apple Pencil as touches (touchType 'stylus') that obey touch-action like fingers,
// so the canvas cancels just those touches; finger pan is handled by the editor.
//
// penMode 'manual' is a fallback for browsers that scroll with a pen anyway (they cancel the pen
// stroke): the canvas then takes all touches and a finger drag scrolls the page from JS.

export function touchActionFor(drawing, penMode) {
  return 'none' // the editor handles finger pan/pinch; browser gestures otherwise steal the two-finger start
}

// what a pointerdown on the canvas should do: 'draw' | 'pan' (scroll from JS) | 'ignore' (browser handles it)
export function pointerRole(pointerType, drawing, penMode) {
  if (!drawing) return 'ignore'
  if (pointerType !== 'touch') return 'draw'
  return penMode === 'manual' ? 'pan' : 'ignore'
}

export const isStylusTouch = (e) => [...(e.changedTouches ?? [])].some((t) => t.touchType === 'stylus')

export const nextPenMode = (mode, event) => (event === 'pen-cancelled' ? 'manual' : mode)

// Two-finger tap = undo, three-finger tap = redo. Fed with pointer events from the page area and
// only listening (never preventDefault), so scrolling, pinch zoom and writing are untouched.
// A tap counts only if: fingers only (no pen / mouse), all fingers land within `joinMs` of the
// first, none moves more than `slop` px, it's over within `maxMs`, no finger is added after one
// lifted, and nothing is cancelled (the browser cancels the touches when it starts a scroll/pinch).
export function multiTapDetector(onTap, { slop = 12, joinMs = 150, maxMs = 350 } = {}) {
  let g = null // the gesture in progress
  return {
    down(e) {
      if (g && e.timeStamp - g.start > maxMs * 2) g = null // stale: an up/cancel never arrived
      if (e.pointerType !== 'touch') { if (g) g.dead = true; return }
      g ??= { start: e.timeStamp, pts: new Map(), max: 0, lifted: false, dead: false }
      if (g.lifted || e.timeStamp - g.start > joinMs) g.dead = true
      g.pts.set(e.pointerId, [e.clientX, e.clientY])
      g.max = Math.max(g.max, g.pts.size)
    },
    move(e) {
      const p = g?.pts.get(e.pointerId)
      if (p && Math.hypot(e.clientX - p[0], e.clientY - p[1]) > slop) g.dead = true
    },
    up(e) {
      if (!g?.pts.has(e.pointerId)) return
      g.pts.delete(e.pointerId)
      g.lifted = true
      if (e.timeStamp - g.start > maxMs) g.dead = true
      if (g.pts.size) return
      const done = g
      g = null // one gesture, at most one command
      if (!done.dead && (done.max === 2 || done.max === 3)) onTap(done.max)
    },
    cancel(e) {
      if (!g?.pts.has(e.pointerId)) return
      g.dead = true
      g.pts.delete(e.pointerId)
      if (!g.pts.size) g = null
    },
  }
}

// A quick, stationary single-finger double tap. Any multi-touch or pen input cancels it.
export function doubleTapDetector(onDoubleTap, { slop = 12, interval = 300, maxTap = 250 } = {}) {
  let tap = null, previous = null
  return {
    down(e) {
      if (e.pointerType !== 'touch') { tap = null; previous = null; return }
      if (tap) { tap = null; previous = null; return } // multi-touch
      if (previous && e.timeStamp - previous.time > interval) previous = null
      tap = { id: e.pointerId, x: e.clientX, y: e.clientY, time: e.timeStamp }
    },
    move(e) {
      if (tap?.id === e.pointerId && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > slop) {
        tap = null; previous = null
      }
    },
    up(e) {
      if (tap?.id !== e.pointerId) return
      const done = tap
      tap = null
      if (e.timeStamp - done.time > maxTap || Math.hypot(e.clientX - done.x, e.clientY - done.y) > slop) { previous = null; return }
      if (previous && e.timeStamp - previous.time <= interval && Math.hypot(e.clientX - previous.x, e.clientY - previous.y) <= slop * 2) {
        previous = null
        onDoubleTap(e.clientX, e.clientY)
      } else previous = { x: e.clientX, y: e.clientY, time: e.timeStamp }
    },
    cancel(e) { if (tap?.id === e.pointerId) tap = null; previous = null },
  }
}

