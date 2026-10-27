// Folder rules and the document list's search / filter / sort, kept free of React for testing.

export const FOLDER_NAME_MAX = 60 // same limit as the folders table
export const ALL = 'all'
export const UNFILED = 'unfiled'

// collapses inner whitespace too, so "  Math   1 " and "Math 1" count as the same name
export const normalizeFolderName = (s) => s.trim().replace(/\s+/g, ' ')

// error message for a folder name, or '' if it's fine; `id` is the folder being renamed
export function folderNameProblem(name, folders, id) {
  if (!name) return 'กรุณาใส่ชื่อโฟลเดอร์'
  if (name.length > FOLDER_NAME_MAX) return `ชื่อโฟลเดอร์ยาวได้ไม่เกิน ${FOLDER_NAME_MAX} ตัวอักษร`
  if (folders.some((f) => f.id !== id && f.name.toLowerCase() === name.toLowerCase())) return `มีโฟลเดอร์ชื่อ “${name}” อยู่แล้ว`
  return ''
}

// docs: [{ id, title, role, added_at, folderId }]; tab 'mine' = documents the user owns
const inTab = (d, tab) => (tab === 'mine') === (d.role === 'owner')

export function visibleDocs(docs, { tab, folder, query, sort }) {
  const q = query.trim().toLowerCase()
  return docs
    .filter((d) => inTab(d, tab))
    .filter((d) => folder === ALL || (folder === UNFILED ? !d.folderId : d.folderId === folder))
    .filter((d) => !q || d.title.toLowerCase().includes(q))
    .sort(sort === 'name'
      ? (a, b) => a.title.localeCompare(b.title, 'th', { numeric: true }) || a.id.localeCompare(b.id)
      : (a, b) => b.added_at.localeCompare(a.added_at) || a.id.localeCompare(b.id))
}

// documents per folder key (ALL, UNFILED, folder id) within a tab
export function folderCounts(docs, tab) {
  const counts = { [ALL]: 0, [UNFILED]: 0 }
  for (const d of docs) {
    if (!inTab(d, tab)) continue
    counts[ALL]++
    const key = d.folderId ?? UNFILED
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}
