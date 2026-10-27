import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { supabase } from './supabase.js'
import { loadFriendships } from './Friends.jsx'
import { canvasSize, drawStroke, farEnough, normalizeColor, ptToWidth, hitsStroke, scribbleEraseTargets, hexToRgb, pdfPageMapper, toPdfPath } from './geometry.js'
import { applyOps, applyRemoteEvent, browserStorage, loadQueue, mergeRemote, saveQueue } from './saveQueue.js'
import { MAX_HITS, findInItems, hasText, matchRects } from './pdfSearch.js'
import { groupSessions } from './history.js'
import { doubleTapDetector, isStylusTouch, multiTapDetector, nextPenMode, pointerRole, touchActionFor } from './inputPolicy.js'
import { FAB_POSITIONS, loadFabPosition, longPress, placePalette, saveFabPosition } from './toolPalette.js'
import { anchorAt, anchorPan, anchorScroll, clampZoom, previewTransform } from './zoom.js'
import { flushSync } from 'react-dom'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
const storage = browserStorage()

const COLORS = [
  ['#111111', 'ดำ'], ['#757575', 'เทา'], ['#e53935', 'แดง'], ['#d81b60', 'ชมพู'], ['#fb8c00', 'ส้ม'],
  ['#ffeb3b', 'เหลือง'], ['#43a047', 'เขียว'], ['#1e88e5', 'น้ำเงิน'], ['#8e24aa', 'ม่วง'], ['#6d4c41', 'น้ำตาล'],
]
const colorName = (c) => COLORS.find(([hex]) => hex === c)?.[1] ?? c
// line width in PDF points, per tool: [min, max, step, default]
const WIDTHS = { pen: [0.3, 10, 0.1, 2.4], highlighter: [4, 30, 0.5, 12] }
const ERASER_RADIUS = 0.01
const MAX_POINTS = 5000
const PAN_SPEED = 0.8
const PAGE_GAP = 16 // px at zoom 1; scales with zoom so the pinch preview and the real layout match

// Page point under (x, y), from the untransformed layout. Works in margins and gaps too (see anchorAt).
// shortcut: reads every page rect once per gesture start; fine for hundreds of pages, index by offsetTop if that gets slow
function pageAnchor(container, x, y) {
  const pages = [...container.querySelectorAll('.page')]
  const a = anchorAt(pages.map((p) => p.getBoundingClientRect()), x, y)
  return a && { page: pages[a.index].dataset.page, u: a.u, v: a.v, x, y }
}

export default function Editor({ uid, docId, onBack }) {
  const [doc, setDoc] = useState(null)
  const [members, setMembers] = useState([])
  const [pdf, setPdf] = useState(null)
  const [error, setError] = useState('')
  const [strokes, setStrokes] = useState({}) // id → row, including erased ones (needed for undo)
  const [tool, setTool] = useState('pen')
  const [color, setColor] = useState(COLORS[0][0])
  const [widths, setWidths] = useState({ pen: WIDTHS.pen[3], highlighter: WIDTHS.highlighter[3] }) // pt, for the next stroke
  const [previewScale, setPreviewScale] = useState(800 / 595) // screen px per pt on page 1, for the size preview
  const [palette, setPalette] = useState(null) // { x, y, target } while the tool panel is open
  const press = useRef(null)
  // opens the panel above the floating tool button, wherever on the button the press was
  const openPalette = (target) => {
    const r = target.getBoundingClientRect()
    setPalette({ x: r.left + r.width / 2, y: r.bottom, top: r.top, target }) // below the button, or above if no room
  }
  press.current ??= longPress(({ target }) => openPalette(target))
  useEffect(() => () => press.current.cancel(), [])
  const [fabPos, setFabPos] = useState(() => loadFabPosition(storage, uid)) // this device only, never synced
  const editorRef = useRef(null)
  const [baseWidth, setBaseWidth] = useState(800)
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(1)
  zoomRef.current = zoom
  const zoomAnchor = useRef(null) // { page, u, v, x, y }: page point to put back under (x, y) once the next zoom renders
  const zoomPan = useRef({ x: 0, y: 0 }) // keeps the focal point reachable when scroll is clamped at an edge
  const suppressMultiTapUntil = useRef(0)
  const [pixelRatio, setPixelRatio] = useState(() => window.devicePixelRatio || 1)
  const pageWidth = Math.round(baseWidth * zoom)
  const [penMode, setPenMode] = useState('native') // see inputPolicy.js
  const [live, setLive] = useState(true) // realtime channel joined
  const wakeRef = useRef(null)
  const [unsaved, setUnsaved] = useState(0)
  const [saveFailed, setSaveFailed] = useState(false) // the badge only shows after a real failure, not while saving
  const [sharing, setSharing] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [search, setSearch] = useState(null) // null = closed; { query, status, hits, index, progress }
  const textCache = useRef(new Map()) // page number → { items, toViewport, w, h }
  const searchSeq = useRef(0)
  const bytes = useRef(null)
  const loadingTask = useRef(null)
  const scroller = useRef(null)
  const queue = useRef([]) // writes not yet confirmed by the server, in order; mirrored to localStorage
  const persisted = useRef(true) // false if the browser refused to store the queue
  const flushing = useRef(false)
  const undoStack = useRef([])
  const redoStack = useRef([])

  const role = members.find((m) => m.user_id === uid)?.role
  const canEdit = role === 'owner' || role === 'editor'

  const merge = (rows) => setStrokes((s) => {
    const next = { ...s }
    for (const r of rows) next[r.id] = r
    return next
  })

  // load document, members, notes and the PDF; subscribe first so no change is missed in between
  useEffect(() => {
    let cancelled = false
    queue.current = loadQueue(storage, uid, docId) // notes left unsaved last time
    setUnsaved(queue.current.length)

    // catch up from the server: events missed while the channel was down or not ready yet
    const resync = async () => {
      const rows = await fetchAllStrokes(docId, true)
      if (!cancelled && !rows.error) setStrokes((s) => mergeRemote(s, rows.data, queue.current))
    }
    let channel
    const subscribe = () => {
      for (const c of supabase.getChannels()) if (c.topic === `realtime:doc:${docId}`) supabase.removeChannel(c) // never two
      channel = supabase.channel(`doc:${docId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'strokes', filter: `document_id=eq.${docId}` },
          (ev) => setStrokes((s) => applyRemoteEvent(s, ev, queue.current)))
        .subscribe((status) => {
          if (cancelled) return
          if (status === 'SUBSCRIBED') {
            setLive(true)
            setTimeout(() => { if (!cancelled) resync() }, 1500) // events only start flowing a moment after joining
          } else {
            setLive(false) // CHANNEL_ERROR / TIMED_OUT / CLOSED; supabase-js retries on its own
          }
        })
    }
    subscribe()
    // A suspended tab (iPad screen lock, switching apps) can lose its socket and every event sent
    // meanwhile. On return: reconnect if needed, send queued notes, and refetch.
    const wake = () => {
      if (cancelled || document.visibilityState !== 'visible') return
      if (supabase.realtime.connectionState() !== 'open' || !['joined', 'joining'].includes(channel.state)) {
        supabase.realtime.connect()
        subscribe() // reports SUBSCRIBED (live again) once joined
      } else {
        setLive(channel.state === 'joined') // the socket survived (brief offline): no new SUBSCRIBED will come
      }
      flush()
      resync()
    }
    const offline = () => setLive(false)
    wakeRef.current = wake
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    window.addEventListener('offline', offline)

    ;(async () => {
      const { data: d, error } = await supabase.from('documents').select('title, pdf_path, owner_id, deleted_at').eq('id', docId).single()
      // queued notes stay in localStorage: the document may only be in the trash and come back
      if (error) return setError('เปิดเอกสารไม่ได้ (อาจถูกลบ อยู่ในถังขยะ หรือคุณไม่มีสิทธิ์แล้ว)')
      if (d.deleted_at) return setError('เอกสารนี้อยู่ในถังขยะ กู้คืนจากแท็บ “ถังขยะ” ก่อนเปิด')
      setDoc(d)
      flush()
      const [mem, rows, file] = await Promise.all([
        supabase.from('document_members').select('user_id, role, profiles(display_name)').eq('document_id', docId),
        fetchAllStrokes(docId),
        supabase.storage.from('pdfs').download(d.pdf_path),
      ])
      if (cancelled) return
      if (mem.error || rows.error || file.error) return setError('โหลดเอกสารไม่สำเร็จ ลองใหม่อีกครั้ง')
      setMembers(mem.data)
      // live events are newer than the fetch; queued writes aren't on the server yet
      setStrokes((live) => applyOps({ ...Object.fromEntries(rows.data.map((r) => [r.id, r])), ...live }, queue.current, uid))
      bytes.current = new Uint8Array(await file.data.arrayBuffer())
      if (cancelled) return
      try {
        // pdf.js takes ownership of the buffer, so give it a copy and keep the original for export
        loadingTask.current = pdfjs.getDocument({ data: bytes.current.slice() })
        const loaded = await loadingTask.current.promise
        if (!cancelled) setPdf(loaded)
      } catch {
        if (!cancelled) setError('ไฟล์ PDF เสียหรือเปิดไม่ได้')
      }
    })()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      window.removeEventListener('offline', offline)
      loadingTask.current?.destroy().catch(() => {})
      loadingTask.current = null
    }
  }, [docId, uid])

  useEffect(() => { // size preview in the panel: page-1 screen px per PDF point
    pdf?.getPage(1).then((p) => setPreviewScale(pageWidth / p.getViewport({ scale: 1 }).width), () => {})
  }, [pdf, pageWidth])

  useLayoutEffect(() => {
    const el = editorRef.current
    if (!el) return
    const set = () => el.style.setProperty('--chrome-top', `${Math.round(scroller.current.getBoundingClientRect().top)}px`)
    set()
    const ro = new ResizeObserver(set) // toolbar wraps on narrow screens; the search bar opens and closes
    for (const c of el.children) if (c !== scroller.current) ro.observe(c)
    return () => ro.disconnect()
  }, [!!search, !!error])

  useEffect(() => {
    const measure = () => setBaseWidth(Math.max(200, Math.min(900, (scroller.current?.clientWidth ?? 800) - 32)))
    measure()
    const onResize = () => { measure(); setPixelRatio(window.devicePixelRatio || 1) }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])

  // Pinch on the document itself: suppress browser-page zoom and resize the PDF pages in-app.
  // One-finger scrolling stays native. Two fingers pan and zoom around their midpoint: while they are
  // down the whole page stack gets one CSS transform (no PDF re-render); on release the real zoom renders
  // and the scroll puts the same page point back under the last midpoint (applyZoomAnchor).
  // iPad Safari sends touch events and gesture events for the same pinch; only the touch events drive it.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const stackEl = () => el.querySelector('.page-stack')
    const points = (touches) => {
      const a = touches[0], b = touches[1]
      const x = (a.clientX + b.clientX) / 2, y = (a.clientY + b.clientY) / 2
      return { x, y, distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) }
    }
    let g = null // pinch in progress: start state, then the latest midpoint (x, y) and zoom
    let frame = 0, fingers = 0, oneFinger = null
    const begin = (x, y, distance) => {
      const stack = stackEl(), a = pageAnchor(el, x, y)
      if (!stack || !a) return null
      const r = stack.getBoundingClientRect() // no transform yet: the previous pinch cleared it synchronously
      return { ...a, left: r.left, top: r.top, x0: x, y0: y, distance, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop,
        startZoom: zoomRef.current, zoom: zoomRef.current, moved: false }
    }
    const paint = () => {
      frame = 0
      const stack = stackEl()
      if (!g || !stack) return
      const k = g.zoom / g.startZoom
      const { tx, ty } = previewTransform(g, g.x, g.y, k, el.scrollLeft - g.scrollLeft, el.scrollTop - g.scrollTop)
      stack.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint) }
    // keep the preview's zoom and position: render that zoom, then scroll the anchor back under (x, y)
    const finish = () => {
      if (!g) return
      cancelAnimationFrame(frame)
      frame = 0
      const { page, u, v, x, y, zoom: next } = g
      g = null
      zoomAnchor.current = { page, u, v, x, y }
      if (next === zoomRef.current) return applyZoomAnchor() // pan only
      zoomRef.current = next
      flushSync(() => setZoom(next)) // the transform is swapped for the real size in the same task: no frame at the old size
    }
    const start = (e) => {
      fingers = e.touches.length
      if (e.touches.length === 1) {
        oneFinger = isStylusTouch(e) ? null : [e.touches[0].clientX, e.touches[0].clientY]
        return
      }
      oneFinger = null
      if (e.touches.length !== 2) return finish() // a third finger: keep what the pinch did so far
      e.preventDefault()
      if (g) return
      const p = points(e.touches)
      g = begin(p.x, p.y, p.distance)
    }
    const move = (e) => {
      if (e.touches.length === 1 && oneFinger && penMode !== 'manual') {
        e.preventDefault()
        const t = e.touches[0]
        el.scrollBy((oneFinger[0] - t.clientX) * PAN_SPEED, (oneFinger[1] - t.clientY) * PAN_SPEED)
        oneFinger = [t.clientX, t.clientY]
        return
      }
      if (e.touches.length !== 2 || !g?.distance) return
      e.preventDefault()
      const p = points(e.touches)
      if (Math.abs(p.distance - g.distance) > 6) g.moved = true
      if (g.moved) {
        g.zoom = clampZoom(g.startZoom * p.distance / g.distance) // at a limit the fingers still pan
        suppressMultiTapUntil.current = Date.now() + 500
      }
      g.x = p.x; g.y = p.y
      schedule()
    }
    const end = (e) => {
      fingers = e.touches.length
      if (!e.touches.length) oneFinger = null
      if (e.touches.length < 2 && g?.distance) finish()
    }
    // Chrome on Mac reports trackpad pinch as ctrl+wheel; prevent the browser zoom and scale the PDF.
    const wheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const anchor = pageAnchor(el, e.clientX, e.clientY)
      if (!anchor) return
      const next = clampZoom(zoomRef.current * Math.exp(-e.deltaY * 0.01))
      zoomAnchor.current = anchor
      suppressMultiTapUntil.current = Date.now() + 500
      if (Math.abs(next - zoomRef.current) > 0.002) setZoom(next)
      else zoomAnchor.current = null
    }
    // Safari: gesture events are the only pinch signal from a Mac trackpad. On iPad a finger is always
    // down first, so the touch handlers own the pinch and these only block Safari's own page zoom.
    const gestureStart = (e) => {
      e.preventDefault()
      if (fingers || g || !el.contains(e.target)) return
      const r = el.getBoundingClientRect()
      g = begin(e.clientX || r.left + r.width / 2, e.clientY || r.top + r.height / 2, 0) // distance 0 marks a trackpad pinch
    }
    const gestureChange = (e) => {
      e.preventDefault()
      if (!g || g.distance) return
      g.zoom = clampZoom(g.startZoom * e.scale)
      suppressMultiTapUntil.current = Date.now() + 500
      schedule()
    }
    const gestureEnd = (e) => { e.preventDefault(); if (g && !g.distance) finish() }
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('touchstart', start, { passive: false })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end, { passive: true })
    el.addEventListener('touchcancel', end, { passive: true })
    el.addEventListener('gesturestart', gestureStart, { passive: false })
    el.addEventListener('gesturechange', gestureChange, { passive: false })
    el.addEventListener('gestureend', gestureEnd, { passive: false })
    return () => {
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
      el.removeEventListener('gesturestart', gestureStart)
      el.removeEventListener('gesturechange', gestureChange)
      el.removeEventListener('gestureend', gestureEnd)
      cancelAnimationFrame(frame)
      const stack = stackEl()
      if (stack) stack.style.transform = ''
    }
  }, [penMode])

  // Drop the pinch preview and scroll so the anchored page point is back under the fingers.
  // Runs in the same task as the size change, so no frame shows the old size or a jump.
  function applyZoomAnchor() {
    const el = scroller.current, a = zoomAnchor.current
    zoomAnchor.current = null
    const stack = el?.querySelector('.page-stack')
    if (stack) stack.style.transform = ''
    const page = a && el.querySelector(`[data-page="${a.page}"]`)
    if (!page) return
    const { dx, dy } = anchorScroll(page.getBoundingClientRect(), a, a.x, a.y)
    const beforeX = el.scrollLeft, beforeY = el.scrollTop
    el.scrollLeft += dx // if the browser clamps at an edge, shift the stack by the unapplied remainder
    el.scrollTop += dy
    zoomPan.current.x -= anchorPan(dx, beforeX, el.scrollLeft)
    zoomPan.current.y -= anchorPan(dy, beforeY, el.scrollTop)
    if (stack) { stack.style.left = `${zoomPan.current.x}px`; stack.style.top = `${zoomPan.current.y}px` }
  }
  useLayoutEffect(applyZoomAnchor, [zoom])

  // ── saving: every change goes through the queue so nothing is lost when offline ──
  async function flush() {
    if (flushing.current) return
    flushing.current = true
    let failed = false
    try {
      while (queue.current.length) {
        const op = queue.current[0]
        const { error } = op.row
          ? await supabase.from('strokes').upsert(op.row, { ignoreDuplicates: true }) // idempotent retry
          : await supabase.from('strokes').update({ deleted: op.deleted }).in('id', op.ids)
        if (error) { failed = true; break } // stays queued; retried on the next change, on reopen, when back online, or via the badge
        queue.current.shift()
        persist()
      }
    } finally {
      flushing.current = false
      setUnsaved(queue.current.length)
      setSaveFailed(failed && queue.current.length > 0)
    }
  }
  const persist = () => { persisted.current = saveQueue(storage, uid, docId, queue.current) }
  const enqueue = (op) => { queue.current.push(op); persist(); setUnsaved(queue.current.length); flush() }

  useEffect(() => {
    const warn = (e) => { if (queue.current.length && !persisted.current) e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  function addStroke(s) {
    const op = { row: { ...s, document_id: docId }, at: new Date().toISOString() }
    setStrokes((cur) => applyOps(cur, [op], uid))
    enqueue(op)
    undoStack.current.push({ type: 'add', ids: [s.id] })
    redoStack.current = []
  }

  function setDeleted(ids, deleted) {
    setStrokes((s) => {
      const next = { ...s }
      for (const id of ids) if (next[id]) next[id] = { ...next[id], deleted }
      return next
    })
    enqueue({ ids, deleted })
  }

  function erase(ids, gesture) {
    setDeleted(ids, true)
    const last = undoStack.current.at(-1)
    if (last?.gesture === gesture) last.ids.push(...ids) // one undo per eraser swipe
    else undoStack.current.push({ type: 'erase', ids: [...ids], gesture })
    redoStack.current = []
  }

  function undo() {
    const e = undoStack.current.pop()
    if (!e) return
    setDeleted(e.ids, e.type === 'add')
    redoStack.current.push(e)
  }
  function redo() {
    const e = redoStack.current.pop()
    if (!e) return
    setDeleted(e.ids, e.type === 'erase')
    undoStack.current.push(e)
  }

  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || !canEdit) return
      e.preventDefault()
      e.shiftKey ? redo() : undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // iPad: one-finger double tap resets zoom; two-finger tap = undo, three-finger tap = redo.
  const [toast, setToast] = useState('')
  const toastTimer = useRef(null)
  const tapActions = useRef(null)
  tapActions.current = (fingers) => {
    if (Date.now() < suppressMultiTapUntil.current) return
    const [stack, run, done] = fingers === 2 ? [undoStack, undo, 'เลิกทำแล้ว'] : [redoStack, redo, 'ทำซ้ำแล้ว']
    if (!canEdit || !stack.current.length) return
    run()
    setToast(done)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 1200)
  }
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const d = multiTapDetector((n) => tapActions.current(n))
    const reset = doubleTapDetector(() => {
      const r = el.getBoundingClientRect()
      const anchor = pageAnchor(el, r.left + el.clientWidth / 2, r.top + el.clientHeight / 2)
      if (!anchor) return
      zoomAnchor.current = anchor // keep the current reading position/page under the viewport centre
      zoomPan.current = { x: 0, y: 0 }
      const stack = el.querySelector('.page-stack')
      if (stack) { stack.style.left = '0px'; stack.style.top = '0px'; stack.style.transform = '' }
      zoomRef.current = 1
      if (zoom !== 1) flushSync(() => setZoom(1))
      else applyZoomAnchor()
    })
    const handlers = [d, reset]
    const on = { pointerdown: 'down', pointermove: 'move', pointerup: 'up', pointercancel: 'cancel' }
    for (const [type, method] of Object.entries(on)) for (const handler of handlers) el.addEventListener(type, handler[method], { passive: true })
    return () => {
      for (const [type, method] of Object.entries(on)) for (const handler of handlers) el.removeEventListener(type, handler[method])
      clearTimeout(toastTimer.current)
    }
  }, [zoom])

  const byPage = useMemo(() => {
    const pages = {}
    for (const s of Object.values(strokes).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
      if (!s.deleted) (pages[s.page] ??= []).push(s)
    }
    return pages
  }, [strokes])

  // restore erased notes from the history; goes through the queue like any other change
  async function restoreStrokes(ids) {
    const missing = ids.filter((id) => !strokes[id]) // erased before this visit, so not loaded
    if (missing.length) {
      const { data } = await supabase.from('strokes').select().in('id', missing)
      if (data) merge(data)
    }
    setDeleted(ids, false)
  }

  // ── text search: reads each page's text once (in the pdf.js worker), never touches rendering ──
  async function runSearch(query) {
    const n = ++searchSeq.current
    if (!query.trim()) return setSearch({ query, status: 'idle', hits: [], index: 0 })
    setSearch({ query, status: 'searching', hits: [], index: 0, progress: 0 })
    const hits = []
    let anyText = false
    try {
      for (let p = 1; p <= pdf.numPages && hits.length < MAX_HITS; p++) {
        let t = textCache.current.get(p)
        if (!t) {
          const page = await pdf.getPage(p)
          const vp = page.getViewport({ scale: 1 })
          const { items } = await page.getTextContent()
          t = { items: items.filter((i) => 'str' in i), toViewport: (m) => pdfjs.Util.transform(vp.transform, m), w: vp.width, h: vp.height }
          textCache.current.set(p, t)
        }
        if (n !== searchSeq.current) return // a newer search started
        anyText ||= hasText(t.items)
        for (const m of findInItems(t.items, query, MAX_HITS - hits.length)) {
          hits.push({ page: p, rects: matchRects(t.items, m.parts, t.toViewport, t.w, t.h) })
        }
        if (p % 10 === 0) setSearch((s) => s && { ...s, progress: p })
      }
    } catch (e) {
      if (n === searchSeq.current) setSearch({ query, status: 'error', hits: [], index: 0, message: e.message })
      return
    }
    setSearch({ query, status: anyText ? 'done' : 'notext', hits, index: 0 })
    if (hits.length) goTo(hits[0])
  }

  function goTo(hit) {
    const el = scroller.current?.querySelector(`[data-page="${hit.page}"]`)
    if (!el) return
    const { x = 0, y = 0 } = hit.rects[0] ?? {}
    const sc = scroller.current // zoomed in, the hit can be off to the side too
    sc.scrollTo({ left: el.offsetLeft + x * el.offsetWidth - sc.clientWidth / 3, top: el.offsetTop + y * el.offsetHeight - sc.clientHeight / 3, behavior: 'smooth' })
  }
  function step(delta) {
    if (!search?.hits.length) return
    const index = (search.index + delta + search.hits.length) % search.hits.length
    setSearch({ ...search, index })
    goTo(search.hits[index])
  }
  function closeSearch() { searchSeq.current++; setSearch(null) }

  const hitsByPage = useMemo(() => {
    const pages = {}
    search?.hits.forEach((h, i) => (pages[h.page] ??= []).push({ rects: h.rects, current: i === search.index }))
    return pages
  }, [search])

  async function exportPdf() {
    try {
      const { PDFDocument, rgb, BlendMode, LineCapStyle, LineJoinStyle, pushGraphicsState, popGraphicsState, setLineJoin } = await import('pdf-lib')
      const out = await PDFDocument.load(bytes.current)
      const pages = out.getPages()
      for (const [num, list] of Object.entries(byPage)) {
        const page = pages[num - 1]
        if (!page) continue
        const { map, displayWidth } = pdfPageMapper(page.getCropBox(), page.getRotation().angle)
        // drawSvgPath sets the cap but not the join; PDF's default miter join draws spikes at sharp
        // turns where the canvas draws round joins
        page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round))
        for (const s of list) {
          const highlighter = s.tool === 'highlighter'
          page.drawSvgPath(toPdfPath(s.points, map), {
            x: 0, y: 0, borderColor: rgb(...hexToRgb(s.color)), borderWidth: s.width * displayWidth,
            borderLineCap: LineCapStyle.Round, borderOpacity: highlighter ? 0.35 : 1,
            blendMode: highlighter ? BlendMode.Multiply : undefined, // same as the canvas
          })
        }
        page.pushOperators(popGraphicsState())
      }
      const url = URL.createObjectURL(new Blob([await out.save()], { type: 'application/pdf' }))
      Object.assign(document.createElement('a'), { href: url, download: `${doc.title}.pdf` }).click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    } catch (e) {
      alert('ส่งออกไม่สำเร็จ (PDF นี้อาจถูกเข้ารหัส): ' + e.message)
    }
  }

  function back() {
    if (queue.current.length && !confirm(persisted.current
      ? 'ยังมีโน้ตที่ส่งไม่สำเร็จ ระบบเก็บไว้ในเครื่องนี้และจะส่งอีกครั้งเมื่อเปิดเอกสารนี้ ออกเลยไหม?'
      : 'ยังมีโน้ตที่บันทึกไม่สำเร็จ และเบราว์เซอร์ไม่ให้เก็บไว้ในเครื่อง ถ้าออกตอนนี้โน้ตจะหาย ออกเลยไหม?')) return
    onBack()
  }

  if (error) return <div className="center"><p className="error">{error}</p><button onClick={onBack}>กลับ</button></div>

  // the floating tool button: a tap opens the panel right away; a long-press (Apple Pencil) does too,
  // and the click that follows it must not toggle the panel shut again
  const { consumeClick, cancel: cancelPress, ...pressHandlers } = press.current
  const closePalette = () => { cancelPress(); palette?.target?.focus(); setPalette(null) }
  return (
    <div className={fabPos[0] === 't' ? 'editor fab-top' : 'editor'} ref={editorRef}>
      <header className="toolbar">
        <button onClick={back} aria-label="กลับ">←</button>
        <strong className="title">{doc?.title ?? '…'}</strong>
        {role && !canEdit && <span className="muted">ดูอย่างเดียว</span>}
        <span className="spacer" />
        {!live && <button className="warn" onClick={() => wakeRef.current?.()} title="โน้ตจากคนอื่นจะไม่ขึ้นจนกว่าจะเชื่อมต่อใหม่">⚠ อัปเดตสดหยุดทำงาน · เชื่อมต่อใหม่</button>}
        {saveFailed && unsaved > 0 && <button className="warn" onClick={flush} title="กดเพื่อลองบันทึกอีกครั้ง">ยังไม่บันทึก {unsaved}</button>}
        <span className="muted" title={members.map((m) => m.profiles.display_name).join(', ')}>👥 {members.length}</span>
        <button onClick={() => (search ? closeSearch() : setSearch({ query: '', status: 'idle', hits: [], index: 0 }))}
          disabled={!pdf} aria-pressed={!!search} aria-label="ค้นหาข้อความใน PDF">🔍</button>
        <button onClick={() => setShowHistory(true)}>ประวัติ</button>
        <button onClick={exportPdf} disabled={!pdf}>ส่งออก</button>
        {role === 'owner' && <button className="primary" onClick={() => setSharing(true)}>แชร์</button>}
      </header>
      {search && <SearchBar search={search} total={pdf?.numPages ?? 0} onSearch={runSearch} onStep={step} onClose={closeSearch} />}

      <div className={toast ? 'toast show' : 'toast'} role="status" aria-live="polite">{toast}</div>
      <div className="pages" ref={scroller}>
        {!pdf && <p className="center muted">กำลังเปิด PDF…</p>}
        {pdf && <div className={zoom === 1 ? 'page-stack fit' : 'page-stack'} style={{ gap: Math.round(PAGE_GAP * zoom) }}>{Array.from({ length: pdf.numPages }, (_, i) => (
          <Page key={i} pdf={pdf} num={i + 1} width={pageWidth} strokes={byPage[i + 1]} hits={hitsByPage[i + 1]}
            ratio={pixelRatio} tool={canEdit ? tool : null} color={color} widthPt={widths[tool]} penMode={penMode}
            onPenEvent={(ev) => setPenMode((m) => nextPenMode(m, ev))}
            onPan={(dx, dy) => scroller.current?.scrollBy(dx * PAN_SPEED, dy * PAN_SPEED)} onStroke={addStroke} onErase={erase} />
        ))}</div>}
      </div>

      {canEdit && (
        <button className={`fab pos-${fabPos}`} aria-haspopup="dialog" aria-expanded={!!palette}
          aria-label={`เครื่องมือ: ${TOOLS[tool]}${tool === 'eraser' ? '' : ` สี${colorName(color)} ${widths[tool].toFixed(1)} pt`} (แตะเพื่อเปลี่ยน)`}
          {...pressHandlers}
          onClick={(e) => { if (consumeClick()) return; palette ? closePalette() : openPalette(e.currentTarget) }}
          onContextMenu={(e) => e.preventDefault()}>
          <span aria-hidden="true">{ICONS[tool]}</span>
          {tool !== 'eraser' && <span className="dot" aria-hidden="true" style={{ background: color }} />}
        </button>
      )}
      {palette && (
        <ToolPalette at={palette} tool={tool} color={color} onClose={closePalette} previewScale={previewScale}
          onPick={(change) => { change(); closePalette() }} setTool={setTool} setColor={setColor}
          width={widths[tool]} setWidth={(pt) => setWidths((w) => ({ ...w, [tool]: pt }))}
          onUndo={undo} onRedo={redo} canUndo={undoStack.current.length > 0} canRedo={redoStack.current.length > 0}
          fabPos={fabPos} setFabPos={(k) => { setFabPos(k); saveFabPosition(storage, uid, k) }} />
      )}
      {showHistory && <HistoryDialog uid={uid} docId={docId} canEdit={canEdit} unsaved={unsaved}
        onRestore={restoreStrokes} onClose={() => setShowHistory(false)} />}
      {sharing && <ShareDialog uid={uid} docId={docId} title={doc.title} members={members}
        onMembers={setMembers} onClose={() => setSharing(false)} />}
    </div>
  )
}

// PostgREST returns at most 1000 rows per request. includeDeleted: a resync must also see erases.
async function fetchAllStrokes(docId, includeDeleted = false) {
  const all = []
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('strokes').select().eq('document_id', docId)
    if (!includeDeleted) q = q.eq('deleted', false)
    const { data, error } = await q.order('created_at').order('id').range(from, from + 999)
    if (error) return { error }
    all.push(...data)
    if (data.length < 1000) return { data: all }
  }
}

const Page = memo(function Page({ pdf, num, width, ratio, strokes = [], hits, tool, color, widthPt, penMode, onPenEvent, onPan, onStroke, onErase }) {
  const box = useRef(null)
  const pageWidthPt = useRef(595.28) // this page's width in PDF points as displayed; set once loaded
  const pdfCanvas = useRef(null)
  const inkCanvas = useRef(null)
  const liveCanvas = useRef(null)
  const current = useRef(null) // stroke being drawn
  const currentMeta = useRef(null) // pointer type and start time; kept out of persisted stroke rows
  const drawFrame = useRef(0)
  const gesture = useRef(null) // eraser swipe in progress
  const active = useRef(null) // pointerId that owns the gesture; other pointers (2nd finger, palm) are ignored
  const panFrom = useRef(null) // [x, y] while a finger scrolls the page from JS ('manual' pen mode)
  const [visible, setVisible] = useState(false)
  const [aspect, setAspect] = useState(1.414) // height / width, known once the page loads
  const height = Math.round(width * aspect) // same render as a width change, so zoom anchoring sees real sizes

  useEffect(() => {
    // entries can queue up (e.g. quick zoom in/out): the newest one is the current state
    const io = new IntersectionObserver((entries) => setVisible(entries.at(-1).isIntersecting), { rootMargin: '1200px 0px' })
    io.observe(box.current)
    return () => io.disconnect()
  }, [])

  // render only pages near the viewport; free the bitmap otherwise (large PDFs on tablets)
  useEffect(() => {
    const c = pdfCanvas.current
    if (!visible) { c.width = c.height = 0; return }
    let task, cancelled = false
    pdf.getPage(num).then((page) => {
      if (cancelled) return
      const base = page.getViewport({ scale: 1 })
      pageWidthPt.current = base.width
      setAspect(base.height / base.width)
      const cssHeight = Math.round((base.height * width) / base.width) // whole px, or later pages sit off the pixel grid
      const px = canvasSize(width, cssHeight, ratio)
      if (!px.width || !px.height) return
      // render off-screen, then swap: no blank flash on zoom, and a newer render never shares a canvas with an older one
      const off = document.createElement('canvas')
      off.width = px.width
      off.height = px.height
      task = page.render({ canvas: off, viewport: page.getViewport({ scale: px.width / base.width }) })
      task.promise.then(() => {
        if (cancelled) return
        c.width = px.width
        c.height = px.height
        c.getContext('2d').drawImage(off, 0, 0)
        off.width = off.height = 0
      }, () => {}) // rejected when cancelled by a newer render
    })
    return () => { cancelled = true; task?.cancel() }
  }, [pdf, num, width, visible, ratio])

  useEffect(() => {
    const c = inkCanvas.current
    const px = visible ? canvasSize(width, height, ratio) : { width: 0, height: 0 }
    c.width = px.width
    c.height = px.height
    liveCanvas.current.width = liveCanvas.current.height = 0 // only holds a stroke in progress; redrawLive sizes it
    if (!visible) return
    const ctx = c.getContext('2d')
    ctx.setTransform(px.width / width, 0, 0, px.height / height, 0, 0)
    for (const s of strokes) drawStroke(ctx, s, width, height)
  }, [strokes, width, height, visible, ratio])

  const drawing = !!tool // null for view-only members
  const drawingRef = useRef(drawing)
  drawingRef.current = drawing

  // Safari delivers Apple Pencil as touches (touchType 'stylus') that obey touch-action like fingers.
  // Cancelling just those keeps the page still under the pen while fingers keep native one-finger scroll.
  // Non-passive so preventDefault works; pointer events still fire.
  useEffect(() => {
    const el = liveCanvas.current
    const stop = (e) => { if (drawingRef.current && isStylusTouch(e)) e.preventDefault() }
    el.addEventListener('touchstart', stop, { passive: false })
    el.addEventListener('touchmove', stop, { passive: false })
    return () => { el.removeEventListener('touchstart', stop); el.removeEventListener('touchmove', stop) }
  }, [])

  // switching tools (or leaving) mid-gesture ends it cleanly: the stroke so far is kept
  useEffect(() => () => finish(), [tool])
  const pos = (e) => {
    const r = liveCanvas.current.getBoundingClientRect()
    return [+((e.clientX - r.left) / r.width).toFixed(4), +((e.clientY - r.top) / r.height).toFixed(4)]
  }
  const eraseAt = ([x, y]) => {
    const ids = strokes.filter((s) => !gesture.current.done.has(s.id) && hitsStroke(s, x, y, ERASER_RADIUS)).map((s) => s.id)
    ids.forEach((id) => gesture.current.done.add(id))
    if (ids.length) onErase(ids, gesture.current.id)
  }
  const redrawLive = () => {
    const c = liveCanvas.current, ink = inkCanvas.current
    if (c.width !== ink.width || c.height !== ink.height) { c.width = ink.width; c.height = ink.height }
    const ctx = c.getContext('2d')
    ctx.setTransform(c.width / width, 0, 0, c.height / height, 0, 0)
    ctx.clearRect(0, 0, width, height)
    drawStroke(ctx, current.current, width, height)
  }

  function down(e) {
    if (active.current !== null) return
    const role = pointerRole(e.pointerType, drawing, penMode)
    if (role === 'ignore') return
    // keep receiving moves outside the canvas; throws if the pointer is already gone, which is harmless
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    active.current = e.pointerId
    if (role === 'pan') {
      panFrom.current = [e.clientX, e.clientY]
    } else if (tool === 'eraser') {
      gesture.current = { id: crypto.randomUUID(), done: new Set() }
      eraseAt(pos(e))
    } else {
      current.current = {
        id: crypto.randomUUID(), page: num, tool, color,
        width: ptToWidth(widthPt, pageWidthPt.current), points: [pos(e)], // pt → share of this page's width
      }
      currentMeta.current = { pointerType: e.pointerType, startedAt: e.timeStamp }
      redrawLive()
    }
  }
  function move(e) {
    if (e.pointerId !== active.current) return
    if (panFrom.current) {
      onPan(panFrom.current[0] - e.clientX, panFrom.current[1] - e.clientY)
      panFrom.current = [e.clientX, e.clientY]
      return
    }
    if (gesture.current) return eraseAt(pos(e))
    const s = current.current
    if (!s) return
    const coalesced = e.nativeEvent.getCoalescedEvents?.()
    for (const ev of coalesced?.length ? [...coalesced, e] : [e]) {
      const pt = pos(ev)
      if (s.points.length < MAX_POINTS && farEnough(s.points.at(-1), pt, width, height)) s.points.push(pt)
    }
    if (!drawFrame.current) drawFrame.current = requestAnimationFrame(() => { drawFrame.current = 0; if (current.current) redrawLive() })
  }
  function end(e) {
    if (e.pointerId !== active.current) return
    // the browser took a pen stroke to scroll: stop letting it (see inputPolicy.js 'manual')
    if (e.type === 'pointercancel' && e.pointerType === 'pen' && current.current) onPenEvent('pen-cancelled')
    const s = current.current
    if (e.type === 'pointerup' && s && s.points.length < MAX_POINTS) {
      const pt = pos(e) // end exactly where the pen lifted, even if that move was filtered as jitter
      const last = s.points.at(-1)
      if (pt[0] !== last[0] || pt[1] !== last[1]) s.points.push(pt)
    }
    finish(e.type === 'pointerup', e.timeStamp)
  }
  function finish(completed = false, endedAt = 0) {
    if (drawFrame.current) cancelAnimationFrame(drawFrame.current)
    drawFrame.current = 0
    active.current = null
    panFrom.current = null
    gesture.current = null
    if (current.current) {
      const scribble = current.current, meta = currentMeta.current
      const erased = completed && meta?.pointerType === 'pen' && scribble.tool === 'pen'
        ? scribbleEraseTargets(scribble, strokes, width, height, endedAt - meta.startedAt) : []
      if (erased.length) onErase(erased, crypto.randomUUID())
      else onStroke(scribble) // unrecognized gestures remain normal ink
    }
    current.current = null
    currentMeta.current = null
  }

  return (
    <div className="page" ref={box} data-page={num} style={{ width, height }}>
      <canvas ref={pdfCanvas} style={{ width, height }} />
      {hits?.flatMap((h, i) => h.rects.map((r, j) => (
        <div key={`${i}-${j}`} className={h.current ? 'hit current' : 'hit'}
          style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />
      )))}
      <canvas ref={inkCanvas} style={{ width, height }} />
      <canvas ref={liveCanvas}
        style={{ width, height, touchAction: touchActionFor(drawing, penMode), cursor: drawing ? 'crosshair' : 'default' }}
        onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} />
    </div>
  )
})

function ShareDialog({ uid, docId, title, members, onMembers, onClose }) {
  const [friends, setFriends] = useState(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    loadFriendships(uid).then((l) => setFriends(l.filter((f) => f.state === 'friend').map((f) => f.other)), (e) => setMsg(e.message))
  }, [uid])

  async function send(e) {
    e.preventDefault()
    const [mode, role] = e.target.how.value.split(':')
    const { error } = await supabase.from('invites').insert({ document_id: docId, title, to_id: e.target.friend.value, mode, role })
    setMsg(error ? 'ส่งไม่สำเร็จ: ' + error.message : 'ส่งคำเชิญแล้ว เพื่อนจะเห็นในกล่องรับ')
  }

  async function removeMember(m) {
    const { error } = await supabase.from('document_members').delete().eq('document_id', docId).eq('user_id', m.user_id)
    if (error) return setMsg(error.message)
    onMembers(members.filter((x) => x.user_id !== m.user_id))
  }

  return (
    <div className="backdrop" onClick={onClose}>
      <form className="card dialog" role="dialog" aria-label="แชร์เอกสาร" onSubmit={send} onClick={(e) => e.stopPropagation()}>
        <h2>แชร์ “{title}”</h2>
        {friends?.length === 0 ? <p className="muted">ยังไม่มีเพื่อน เพิ่มเพื่อนในแท็บ “เพื่อน” ก่อน</p> : (
          <>
            <label>ส่งให้
              <select name="friend" required>
                {friends?.map((f) => <option key={f.id} value={f.id}>{f.display_name} (@{f.username})</option>)}
              </select>
            </label>
            <fieldset>
              <label className="radio"><input type="radio" name="how" value="copy:editor" defaultChecked />
                <span><b>ส่งสำเนา</b><br /><small className="muted">เพื่อนได้เอกสารของตัวเอง แก้ไขแล้วไม่กระทบของคุณ</small></span></label>
              <label className="radio"><input type="radio" name="how" value="collab:editor" />
                <span><b>ทำงานร่วมกัน</b><br /><small className="muted">เขียนในเอกสารเดียวกัน เห็นกันแบบเรียลไทม์</small></span></label>
            </fieldset>
            <button className="primary" disabled={!friends}>ส่งคำเชิญ</button>
          </>
        )}
        {msg && <p className="muted" role="status">{msg}</p>}
        <h3>คนที่เข้าถึงได้</h3>
        <ul className="list">
          {members.map((m) => (
            <li key={m.user_id}>
              <span className="item">{m.profiles.display_name}</span>
              <small className="muted">{{ owner: 'เจ้าของ', editor: 'แก้ไขได้', viewer: 'ดูอย่างเดียว' }[m.role]}</small>
              {m.role !== 'owner' && <button type="button" className="link danger" onClick={() => removeMember(m)}>นำออก</button>}
            </li>
          ))}
        </ul>
        <button type="button" onClick={onClose}>ปิด</button>
      </form>
    </div>
  )
}

function SearchBar({ search, total, onSearch, onStep, onClose }) {
  const [text, setText] = useState(search.query)
  const { status, hits, index } = search
  function onKeyDown(e) {
    if (e.key === 'Escape') return onClose()
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (text !== search.query || status === 'idle') onSearch(text)
    else onStep(e.shiftKey ? -1 : 1)
  }
  const message = {
    idle: '',
    searching: `กำลังค้นหา… ${search.progress ?? 0}/${total} หน้า`,
    done: hits.length
      ? `${index + 1}/${hits.length}${hits.length >= MAX_HITS ? '+' : ''} · หน้า ${hits[index]?.page}`
      : `ไม่พบ “${search.query}”`,
    notext: 'PDF นี้ไม่มีข้อความให้ค้นหา (อาจเป็นไฟล์สแกนหรือรูปภาพ)',
    error: `ค้นหาไม่สำเร็จ: ${search.message ?? ''}`,
  }[status]
  return (
    <div className="searchbar" role="search">
      <input autoFocus type="search" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
        placeholder="ค้นหาข้อความใน PDF (Enter = ถัดไป)" aria-label="ค้นหาข้อความใน PDF" />
      <button onClick={() => onSearch(text)} disabled={!text.trim()}>ค้นหา</button>
      <button onClick={() => onStep(-1)} disabled={!hits.length} aria-label="ผลก่อนหน้า">↑</button>
      <button onClick={() => onStep(1)} disabled={!hits.length} aria-label="ผลถัดไป">↓</button>
      <small className={status === 'error' ? 'error' : 'muted'} aria-live="polite">{message}</small>
      <button className="link" onClick={onClose} aria-label="ปิดการค้นหา">✕</button>
    </div>
  )
}

function HistoryDialog({ uid, docId, canEdit, unsaved, onRestore, onClose }) {
  const [events, setEvents] = useState(null)
  const [error, setError] = useState('')
  const [restored, setRestored] = useState(new Set()) // session keys restored in this dialog

  async function load() {
    setError('')
    const { data, error } = await supabase.from('stroke_events')
      .select('id, stroke_id, action, at, actor:profiles(display_name), stroke:strokes(page, deleted)')
      .eq('document_id', docId).eq('actor_id', uid).order('at', { ascending: false }).order('id', { ascending: false }).limit(1000)
    if (error) return setError(error.message)
    setEvents(data)
    setRestored(new Set())
  }
  useEffect(() => { load() }, [docId, uid])

  const sessions = useMemo(() => groupSessions(events ?? []), [events])

  async function restore(s) {
    await onRestore(s.restorable)
    setRestored((r) => new Set(r).add(s.key))
  }

  const when = (s) => {
    const a = new Date(s.start), b = new Date(s.end)
    const day = a.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })
    const t = (d) => d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
    return a.toDateString() === b.toDateString()
      ? `${day} ${t(a)}${t(a) === t(b) ? '' : `–${t(b)}`}`
      : `${day} ${t(a)} – ${b.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })} ${t(b)}`
  }
  const summary = ({ counts: c, pages }) => [
    c.add && `เพิ่ม ${c.add} เส้น`,
    c.copy && `คัดลอกมากับสำเนา ${c.copy} เส้น`,
    c.erase && `ลบ ${c.erase} เส้น`,
    c.restore && `กู้คืน ${c.restore} เส้น`,
    pages.length && `หน้า ${pages.slice(0, 6).join(', ')}${pages.length > 6 ? ` และอีก ${pages.length - 6} หน้า` : ''}`,
  ].filter(Boolean).join(' · ')

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="card dialog" role="dialog" aria-label="ประวัติโน้ต" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>ประวัติโน้ตของฉัน</h2>
        {unsaved > 0 && <p className="muted">มี {unsaved} รายการในเครื่องนี้ที่ยังไม่ซิงก์ จะแสดงในประวัติเมื่อซิงก์แล้ว</p>}
        {error && <p className="error" role="alert">โหลดประวัติไม่สำเร็จ: {error} <button className="link" onClick={load}>ลองใหม่</button></p>}
        {events === null && !error && <p className="muted">กำลังโหลด…</p>}
        {events?.length === 0 && <p className="muted">ยังไม่มีประวัติ</p>}
        {sessions.length > 0 && (
          <ul className="list">
            {sessions.map((s) => (
              <li key={s.key}>
                <span className="item">
                  <b>{s.actor ?? 'ผู้ใช้ที่ลบบัญชีแล้ว'}</b> <small className="muted">· {when(s)}</small>
                  <br /><small>{summary(s)}</small>
                </span>
                {canEdit && s.restorable.length > 0 && (restored.has(s.key)
                  ? <small className="ok">กู้คืนแล้ว</small>
                  : <button className="link" onClick={() => restore(s)}>กู้คืนเส้นที่ลบ ({s.restorable.length})</button>)}
              </li>
            ))}
          </ul>
        )}
        <p className="muted"><small>เฉพาะที่คุณแก้ รวมเป็นรอบตามช่วงที่แก้ไขต่อเนื่อง (เว้นไม่เกิน 30 นาที) · การลบด้วยยางลบและการเลิกทำนับเป็น “ลบ” · แสดง 1,000 การเปลี่ยนแปลงล่าสุด</small></p>
        <div className="row">
          <button onClick={load}>โหลดใหม่</button>
          <button autoFocus onClick={onClose}>ปิด</button>
        </div>
      </div>
    </div>
  )
}

const TOOLS = { pen: 'ปากกา', highlighter: 'ไฮไลต์', eraser: 'ยางลบ' }
const ICONS = { pen: '✏️', highlighter: '🖍️', eraser: '🧽' }

function ToolPalette({ at, tool, color, onPick, onClose, setTool, setColor, width, setWidth, previewScale, onUndo, onRedo, canUndo, canRedo, fabPos, setFabPos }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect()
    setPos(placePalette(at, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }))
  }, [at])
  // once placed (a hidden element can't take focus), so the keyboard starts inside the palette
  useEffect(() => { if (pos) ref.current.querySelector('[aria-pressed="true"]')?.focus() }, [pos])

  useEffect(() => {
    // a tap outside only dismisses: it must not also draw or erase on the page underneath
    // (the button that opened the panel toggles it itself)
    const outside = (e) => {
      if (ref.current?.contains(e.target) || at.target?.contains(e.target)) return
      e.stopPropagation()
      onClose()
    }
    const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc) }
  })

  const pick = (label, active, change, extra = {}) => (
    <button key={label} aria-pressed={active} aria-label={label} onClick={() => onPick(change)} {...extra} />
  )
  return (
    <div ref={ref} className="palette card" role="dialog" aria-label="เลือกเครื่องมือ"
      style={pos ?? { visibility: 'hidden', left: 0, top: 0 }}>
      <div role="group" aria-label="เครื่องมือ" className="row">
        {Object.entries(TOOLS).map(([k, label]) =>
          pick(label, tool === k, () => setTool(k), { className: tool === k ? 'tool active' : 'tool', children: label }))}
      </div>
      <div role="group" aria-label="สี" className="colors">
        {COLORS.map(([hex, name]) => pick(`สี${name}`, color === hex, () => setColor(hex), { className: color === hex ? 'swatch active' : 'swatch', style: { background: hex } }))}
        {/* any colour: the browser's own picker; stays open while choosing */}
        <label className={COLORS.some(([hex]) => hex === color) ? 'swatch custom' : 'swatch custom active'} title="เลือกสีเอง"
          style={{ background: COLORS.some(([hex]) => hex === color) ? undefined : color }}>
          <input type="color" value={color} aria-label="เลือกสีเอง" onChange={(e) => { const c = normalizeColor(e.target.value); if (c) setColor(c) }} />
        </label>
      </div>
      {tool !== 'eraser' && (
        <div className="row width">
          <label htmlFor="pen-width">ขนาด</label>
          {/* changes the next stroke only; existing strokes keep the width they were drawn with */}
          <input id="pen-width" type="range" min={WIDTHS[tool][0]} max={WIDTHS[tool][1]} step={WIDTHS[tool][2]} value={width}
            aria-valuetext={`${width.toFixed(1)} พอยต์`} onChange={(e) => setWidth(Number(e.target.value))} />
          <output htmlFor="pen-width">{width.toFixed(1)} pt</output>
          <svg width="56" height="24" aria-hidden="true">
            <rect width="56" height="24" rx="4" fill="#fff" /> {/* on paper, as on the page */}
            <line x1="8" y1="12" x2="48" y2="12" stroke={color} strokeLinecap="round"
              strokeWidth={Math.min(22, Math.max(1, width * previewScale))} opacity={tool === 'highlighter' ? 0.35 : 1} />
          </svg>
        </div>
      )}
      {/* undo/redo keep the panel open, so several steps can be undone in a row */}
      <div role="group" aria-label="เลิกทำและทำซ้ำ" className="row">
        <button onClick={onUndo} disabled={!canUndo} aria-label="เลิกทำ">↶ เลิกทำ</button>
        <button onClick={onRedo} disabled={!canRedo} aria-label="ทำซ้ำ">↷ ทำซ้ำ</button>
      </div>
      <div className="row">
        <small className="muted" id="fab-pos-label">ตำแหน่งแถบเครื่องมือ</small>
        <div role="group" aria-labelledby="fab-pos-label" className="pos-grid">
          {['tl', 'tc', 'tr', 'ml', null, 'mr', 'bl', 'bc', 'br'].map((k) => k
            ? pick(`ตำแหน่ง: ${FAB_POSITIONS[k]}`, fabPos === k, () => setFabPos(k), { className: fabPos === k ? 'cell active' : 'cell' })
            : <button key="centre" className="cell" disabled aria-label="ตรงกลาง (ใช้ไม่ได้ เพื่อไม่บังหน้าเอกสาร)" />)}
        </div>
      </div>
    </div>
  )
}
