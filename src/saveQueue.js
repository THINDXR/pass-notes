// Unsaved stroke writes, persisted per user + document so a closed tab or reload doesn't lose notes.
// Ops: { row, at } inserts a stroke; { ids, deleted } flips the erase flag. Order matters.

const VERSION = 1
const keyFor = (uid, docId) => `passnotes:queue:${uid}:${docId}`

export function browserStorage() {
  try { return window.localStorage } catch { return null } // blocked in some private modes
}

const isUuidish = (s) => typeof s === 'string' && s.length > 0 && s.length <= 64
function validOp(op, docId) {
  if (!op || typeof op !== 'object') return false
  if (op.row) {
    const r = op.row
    return isUuidish(r.id) && r.document_id === docId && Number.isInteger(r.page) && Array.isArray(r.points)
      && typeof r.tool === 'string' && typeof r.color === 'string' && typeof r.width === 'number'
  }
  return Array.isArray(op.ids) && op.ids.every(isUuidish) && typeof op.deleted === 'boolean'
}

// Returns the saved ops, or [] if nothing is saved, the data is corrupt or belongs to someone else.
export function loadQueue(storage, uid, docId) {
  const key = keyFor(uid, docId)
  try {
    const raw = storage?.getItem(key)
    if (!raw) return []
    const saved = JSON.parse(raw)
    if (saved?.v !== VERSION || saved.uid !== uid || saved.docId !== docId || !Array.isArray(saved.ops)) {
      storage.removeItem(key)
      return []
    }
    return saved.ops.filter((op) => validOp(op, docId))
  } catch {
    try { storage?.removeItem(key) } catch {}
    return []
  }
}

// Returns false when the browser refused to store (quota, disabled storage).
export function saveQueue(storage, uid, docId, ops) {
  if (!storage) return false
  const key = keyFor(uid, docId)
  try {
    if (ops.length) storage.setItem(key, JSON.stringify({ v: VERSION, uid, docId, ops }))
    else storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

export const clearQueue = (storage, uid, docId) => saveQueue(storage, uid, docId, [])

// Shows queued ops on top of what the server returned (id → stroke row).
export function applyOps(strokes, ops, uid) {
  const next = { ...strokes }
  for (const op of ops) {
    if (op.row) next[op.row.id] = { ...op.row, author_id: uid, deleted: false, created_at: op.at ?? new Date().toISOString() }
    else for (const id of op.ids) if (next[id]) next[id] = { ...next[id], deleted: op.deleted }
  }
  return next
}

// Notes with a write still in `ops` (not yet confirmed by the server)
const pendingIds = (ops) => new Set(ops.flatMap((op) => (op.row ? [op.row.id] : op.ids)))

// Merges server rows (a realtime event or a full refetch) into local state. A note with a change
// still in the local queue keeps its local state: the server hasn't seen that change yet.
// Returns the same object when nothing changed, so React skips the re-render.
export function mergeRemote(strokes, rows, ops) {
  const pending = pendingIds(ops)
  let next = null
  for (const r of rows) {
    const local = strokes[r.id]
    if (local && (pending.has(r.id) || local.deleted === r.deleted)) continue
    next ??= { ...strokes }
    next[r.id] = local ? { ...local, deleted: r.deleted } : r
  }
  return next ?? strokes
}

// A realtime INSERT/UPDATE on strokes. An INSERT echo of a note we already have can arrive after
// we changed it (e.g. erased right after drawing) and carries nothing newer, so it is ignored;
// UPDATEs arrive in commit order.
export function applyRemoteEvent(strokes, { eventType, new: row }, ops) {
  if (!row?.id) return strokes
  if (eventType === 'INSERT' && strokes[row.id]) return strokes
  return mergeRemote(strokes, [row], ops)
}
