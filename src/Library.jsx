import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase.js'
import { ALL, FOLDER_NAME_MAX, UNFILED, folderCounts, folderNameProblem, normalizeFolderName, visibleDocs } from './folders.js'

const MAX_BYTES = 50 * 1024 * 1024 // same limit as the storage bucket
const INVITE_STATUS = { pending: 'รอตอบ', accepted: 'รับแล้ว', declined: 'ปฏิเสธ', cancelled: 'ยกเลิกแล้ว' }

export default function Library({ uid, onOpen }) {
  const [tab, setTab] = useState('mine')
  const [docs, setDocs] = useState(null) // every document the user can open, with their own filing
  const [folders, setFolders] = useState([])
  const [inbox, setInbox] = useState([])
  const [sent, setSent] = useState([])
  const [live, setLive] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [folder, setFolder] = useState(ALL)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('date')
  const [status, setStatus] = useState(null) // { saving: true } | { error, retry }
  const [editing, setEditing] = useState(null) // { id (when renaming), name, problem }

  async function load() {
    const [m, f, p, i, o] = await Promise.all([
      supabase.from('document_members')
        .select('role, added_at, documents(id, title, pdf_path, deleted_at, owner:profiles!documents_owner_id_fkey(display_name))').eq('user_id', uid),
      supabase.from('folders').select('id, name').order('name'),
      supabase.from('document_folders').select('document_id, folder_id'),
      supabase.from('invites').select('id, title, mode, role, from:profiles!invites_from_id_fkey(display_name, username)')
        .eq('to_id', uid).eq('status', 'pending').order('created_at', { ascending: false }),
      supabase.from('invites').select('id, title, mode, role, status, created_at, to:profiles!invites_to_id_fkey(display_name, username)')
        .eq('from_id', uid).order('created_at', { ascending: false }).limit(100),
    ])
    const err = m.error || f.error || p.error || i.error || o.error
    if (err) return setLoadError(err.message)
    setLoadError('')
    const filed = new Map(p.data.map((r) => [r.document_id, r.folder_id]))
    setDocs(m.data
      .filter((r) => r.documents) // hidden by RLS, e.g. someone else's document in their trash
      .map(({ role, added_at, documents: d }) => ({ ...d, role, added_at, folderId: filed.get(d.id) ?? null })))
    setFolders(f.data)
    setInbox(i.data)
    setSent(o.data)
    if (folder !== ALL && folder !== UNFILED && !f.data.some((x) => x.id === folder)) setFolder(ALL)
  }
  useEffect(() => {
    load()
    // new invites to me, and answers to invites I sent; manual reload is the fallback
    const channel = supabase.channel(`invites:${uid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invites', filter: `to_id=eq.${uid}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invites', filter: `from_id=eq.${uid}` }, () => load())
      .subscribe((status) => setLive(status === 'SUBSCRIBED'))
    return () => { supabase.removeChannel(channel) }
  }, [uid])

  // runs a write, shows progress, and offers a retry on failure
  async function save(write) {
    setStatus({ saving: true })
    const { error } = await write()
    if (error) {
      const msg = error.code === '23505' ? 'มีโฟลเดอร์ชื่อนี้อยู่แล้ว'
        : error.code === '23514' ? `ชื่อโฟลเดอร์ต้องยาว 1–${FOLDER_NAME_MAX} ตัวอักษร`
        : 'บันทึกไม่สำเร็จ: ' + error.message
      setStatus({ error: msg, retry: () => save(write) })
      return false
    }
    setStatus(null)
    await load()
    return true
  }

  async function submitFolder(e) {
    e.preventDefault()
    const name = normalizeFolderName(editing.name)
    const problem = folderNameProblem(name, folders, editing.id)
    if (problem) return setEditing({ ...editing, problem })
    const ok = await save(() => editing.id
      ? supabase.from('folders').update({ name }).eq('id', editing.id)
      : supabase.from('folders').insert({ name }))
    if (ok) setEditing(null)
  }

  async function deleteFolder(f) {
    const n = docs.filter((d) => d.folderId === f.id).length
    const note = n ? `\nเอกสาร ${n} รายการในโฟลเดอร์นี้จะย้ายไป “ไม่จัดหมวด” (เอกสารไม่ถูกลบ)` : ''
    if (!confirm(`ลบโฟลเดอร์ “${f.name}”?${note}`)) return
    if (await save(() => supabase.from('folders').delete().eq('id', f.id))) setFolder(ALL)
  }

  // filing is per user: this never changes the document or anyone else's folders
  const move = (doc, folderId) => save(() => folderId
    ? supabase.from('document_folders').upsert({ user_id: uid, document_id: doc.id, folder_id: folderId })
    : supabase.from('document_folders').delete().eq('user_id', uid).eq('document_id', doc.id))

  async function importPdf(file) {
    if (!file) return
    if (file.type !== 'application/pdf') return alert('รองรับเฉพาะไฟล์ PDF')
    if (file.size > MAX_BYTES) return alert('ไฟล์ใหญ่เกิน 50MB')
    setBusy(true)
    const path = `${uid}/${crypto.randomUUID()}.pdf`
    const up = await supabase.storage.from('pdfs').upload(path, file, { contentType: 'application/pdf' })
    if (up.error) { setBusy(false); return alert('อัปโหลดไม่สำเร็จ: ' + up.error.message) }
    const title = file.name.replace(/\.pdf$/i, '').slice(0, 200) || 'ไม่มีชื่อ'
    const { data, error } = await supabase.from('documents').insert({ title, pdf_path: path }).select('id').single()
    if (error) {
      // the file has a fresh name so nothing else uses it; RLS refuses anyway if something does
      const rm = await supabase.storage.from('pdfs').remove([path])
      setBusy(false)
      const removed = !rm.error && rm.data?.length === 1 // a refused delete returns an empty list, not an error
      return alert('บันทึกเอกสารไม่สำเร็จ: ' + error.message +
        (removed ? '' : '\nและลบไฟล์ที่อัปโหลดไว้ไม่สำเร็จ (ไฟล์นี้ไม่มีใครเปิดได้ และจะถูกลบในรอบเก็บกวาดถัดไป)'))
    }
    setBusy(false)
    onOpen(data.id)
  }

  async function respond(invite, accept) {
    const { data, error } = await supabase.rpc('respond_invite', { invite_id: invite.id, accept })
    if (error) {
      alert(/trash/.test(error.message) ? 'เจ้าของย้ายเอกสารนี้ไปถังขยะแล้ว'
        : /not found/.test(error.message) ? 'คำเชิญนี้ถูกยกเลิกหรือตอบไปแล้ว' : error.message)
      return load()
    }
    if (accept) onOpen(data)
    else load()
  }

  // owner only, enforced by set_document_trashed() and the documents_delete policy
  const trash = (doc) => confirm(`ย้าย “${doc.title}” ไปถังขยะ?\nคนที่ทำงานร่วมกันจะเปิดไม่ได้จนกว่าคุณจะกู้คืน และคำเชิญที่ยังไม่ตอบจะถูกยกเลิก`) &&
    act(() => supabase.rpc('set_document_trashed', { doc: doc.id, trashed: true }), `ย้าย “${doc.title}” ไปถังขยะแล้ว`)
  const restore = (doc) => act(() => supabase.rpc('set_document_trashed', { doc: doc.id, trashed: false }), `กู้คืน “${doc.title}” แล้ว`)

  async function purge(doc) {
    if (!confirm(`ลบ “${doc.title}” ถาวร?\nโน้ตทั้งหมดในเอกสารนี้จะหายและกู้คืนไม่ได้ (สำเนาที่ส่งให้เพื่อนไปแล้วไม่ได้รับผลกระทบ)`)) return
    const ok = await act(async () => {
      const r = await supabase.from('documents').delete().eq('id', doc.id).select('id')
      return r.error || r.data.length ? r : { error: { message: 'ไม่มีสิทธิ์ลบ หรือเอกสารไม่ได้อยู่ในถังขยะ' } }
    }, `ลบ “${doc.title}” ถาวรแล้ว`)
    // RLS only lets this succeed when no other document (e.g. a copy) still uses the file
    if (ok) await supabase.storage.from('pdfs').remove([doc.pdf_path])
  }

  const cancelInvite = (inv) => act(async () => {
    const r = await supabase.from('invites').update({ status: 'cancelled' }).eq('id', inv.id).eq('status', 'pending').select('id')
    return r.error || r.data.length ? r : { error: { message: 'ยกเลิกไม่ได้ เพราะคำเชิญถูกตอบไปแล้ว' } }
  }, 'ยกเลิกคำเชิญแล้ว')

  // like save(), for actions that aren't about folders
  async function act(write, ok) {
    setStatus({ saving: true })
    const { error } = await write()
    if (error) { setStatus({ error: 'ไม่สำเร็จ: ' + error.message, retry: () => act(write, ok) }); await load(); return false }
    setStatus({ ok })
    await load()
    return true
  }

  async function leave(doc) {
    if (!confirm(`ออกจาก "${doc.title}"?`)) return
    const { error } = await supabase.from('document_members').delete().eq('document_id', doc.id).eq('user_id', uid)
    if (error) alert(error.message)
    load()
  }

  const active = useMemo(() => (docs ?? []).filter((d) => !d.deleted_at), [docs])
  const trashed = useMemo(() => (docs ?? []).filter((d) => d.deleted_at && d.role === 'owner')
    .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at)), [docs])
  const shown = useMemo(() => visibleDocs(active, { tab, folder, query, sort }), [active, tab, folder, query, sort])
  const counts = useMemo(() => folderCounts(active, tab), [active, tab])
  const docTab = tab === 'mine' || tab === 'shared'
  const current = folders.find((f) => f.id === folder)
  const saving = !!status?.saving

  const tabBtn = (name, label) => (
    <button className={tab === name ? 'tab active' : 'tab'} onClick={() => setTab(name)}>{label}</button>
  )
  const chip = (key, label) => (
    <button key={key} className={folder === key ? 'chip active' : 'chip'} aria-pressed={folder === key} onClick={() => setFolder(key)}>
      {label} <small>{counts[key] ?? 0}</small>
    </button>
  )
  return (
    <section>
      <div className="row">
        <nav>
          {tabBtn('mine', 'ของฉัน')}
          {tabBtn('shared', 'แชร์กับฉัน')}
          {tabBtn('inbox', `กล่องรับ${inbox.length ? ` (${inbox.length})` : ''}`)}
          {tabBtn('sent', 'ส่งแล้ว')}
          {tabBtn('trash', `ถังขยะ${trashed.length ? ` (${trashed.length})` : ''}`)}
        </nav>
        <label className={busy ? 'button primary disabled' : 'button primary'}>
          {busy ? 'กำลังอัปโหลด…' : '+ นำเข้า PDF'}
          <input type="file" accept="application/pdf" hidden disabled={busy}
            onChange={(e) => { importPdf(e.target.files[0]); e.target.value = '' }} />
        </label>
      </div>

      {loadError && (
        <p className="error" role="alert">
          โหลดข้อมูลไม่สำเร็จ: {loadError} <button className="link" onClick={load}>ลองใหม่</button>
        </p>
      )}
      {status?.saving && <p className="muted" role="status">กำลังบันทึก…</p>}
      {status?.ok && <p className="ok" role="status">{status.ok}</p>}
      {status?.error && (
        <p className="error" role="alert">
          {status.error} <button className="link" onClick={status.retry}>ลองใหม่</button>
          <button className="link" onClick={() => setStatus(null)}>ปิด</button>
        </p>
      )}

      {docTab && docs !== null && ( // counts would read "0" before the list has loaded
        <>
          <div className="chips" role="group" aria-label="โฟลเดอร์">
            {chip(ALL, 'ทั้งหมด')}
            {chip(UNFILED, 'ไม่จัดหมวด')}
            {folders.map((f) => chip(f.id, f.name))}
            <button className="chip" onClick={() => setEditing({ name: '' })} disabled={saving}>+ โฟลเดอร์</button>
          </div>
          {current && !editing && (
            <div className="row">
              <span className="muted">โฟลเดอร์ “{current.name}”</span>
              <span>
                <button className="link" onClick={() => setEditing({ id: current.id, name: current.name })} disabled={saving}>เปลี่ยนชื่อ</button>
                <button className="link danger" onClick={() => deleteFolder(current)} disabled={saving}>ลบโฟลเดอร์</button>
              </span>
            </div>
          )}
          {editing && (
            <form className="row" onSubmit={submitFolder} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}>
              <input autoFocus value={editing.name} maxLength={FOLDER_NAME_MAX} aria-label="ชื่อโฟลเดอร์"
                aria-invalid={!!editing.problem} aria-describedby="folder-problem"
                placeholder={editing.id ? 'ชื่อใหม่' : 'ชื่อโฟลเดอร์ใหม่'}
                onChange={(e) => setEditing({ ...editing, name: e.target.value, problem: '' })} />
              <button className="primary" disabled={saving}>{editing.id ? 'บันทึกชื่อ' : 'สร้าง'}</button>
              <button type="button" onClick={() => setEditing(null)}>ยกเลิก</button>
              {editing.problem && <p id="folder-problem" className="error full" role="alert">{editing.problem}</p>}
            </form>
          )}
          <div className="row">
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="ค้นหาชื่อเอกสาร" aria-label="ค้นหาชื่อเอกสาร" />
            <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="เรียงตาม" className="auto">
              <option value="date">วันที่เพิ่ม (ใหม่สุด)</option>
              <option value="name">ชื่อ (ก–ฮ, A–Z)</option>
            </select>
          </div>
        </>
      )}

      {docs === null && !loadError && <p className="muted center">กำลังโหลด…</p>}
      {docTab && docs !== null && (
        counts[ALL] === 0
          ? <p className="muted center">{tab === 'mine' ? 'ยังไม่มีเอกสาร กด “นำเข้า PDF” เพื่อเริ่ม' : 'ยังไม่มีเอกสารที่แชร์กับคุณ'}</p>
          : shown.length === 0
            ? (
              <div className="muted center">
                <p>ไม่พบเอกสาร{query.trim() ? ` ที่ชื่อมีคำว่า “${query.trim()}”` : ''}{folder !== ALL ? ' ในโฟลเดอร์นี้' : ''}</p>
                <button onClick={() => { setQuery(''); setFolder(ALL) }}>ล้างการค้นหาและตัวกรอง</button>
              </div>
            )
            : (
              <ul className="list">
                {shown.map((d) => (
                  <li key={d.id}>
                    <button className="item" onClick={() => onOpen(d.id)}>
                      {d.title}
                      {d.role !== 'owner' && <small className="muted"> · จาก {d.owner.display_name} · {d.role === 'editor' ? 'แก้ไขได้' : 'ดูอย่างเดียว'}</small>}
                    </button>
                    <select className="auto" value={d.folderId ?? ''} disabled={saving} aria-label={`โฟลเดอร์ของ “${d.title}”`}
                      onChange={(e) => move(d, e.target.value || null)}>
                      <option value="">ไม่จัดหมวด</option>
                      {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                    {d.role === 'owner'
                      ? <button className="link danger" disabled={saving} onClick={() => trash(d)}>ลบ</button>
                      : <button className="link" onClick={() => leave(d)}>ออก</button>}
                  </li>
                ))}
              </ul>
            )
      )}

      {tab === 'inbox' && (inbox.length ? (
        <ul className="list">
          {inbox.map((inv) => (
            <li key={inv.id}>
              <span className="item">
                <b>{inv.from.display_name}</b> {inv.mode === 'copy' ? 'ส่งสำเนา' : 'ชวนทำงานร่วมกันใน'} “{inv.title}”
                {inv.mode === 'collab' && <small className="muted"> ({inv.role === 'editor' ? 'แก้ไขได้' : 'ดูอย่างเดียว'})</small>}
              </span>
              <button className="primary" onClick={() => respond(inv, true)}>รับ</button>
              <button className="link" onClick={() => respond(inv, false)}>ปฏิเสธ</button>
            </li>
          ))}
        </ul>
      ) : <p className="muted center">ไม่มีคำเชิญใหม่</p>)}

      {(tab === 'inbox' || tab === 'sent') && docs !== null && (
        <div className="row">
          <small className="muted">{live ? 'อัปเดตอัตโนมัติ' : 'อัปเดตอัตโนมัติไม่ทำงาน กด “โหลดใหม่” เพื่อดูสถานะล่าสุด'}</small>
          <button className="link" onClick={load}>โหลดใหม่</button>
        </div>
      )}

      {tab === 'sent' && docs !== null && (sent.length ? (
        <ul className="list">
          {sent.map((inv) => (
            <li key={inv.id}>
              <span className="item">
                “{inv.title}” → <b>{inv.to.display_name}</b>
                <small className="muted"> · {inv.mode === 'copy' ? 'ส่งสำเนา' : `ทำงานร่วมกัน (${inv.role === 'editor' ? 'แก้ไขได้' : 'ดูอย่างเดียว'})`}
                  {' · '}{new Date(inv.created_at).toLocaleDateString('th-TH')}</small>
              </span>
              <span className={`badge ${inv.status}`}>{INVITE_STATUS[inv.status]}</span>
              {inv.status === 'pending' && <button className="link danger" disabled={saving} onClick={() => cancelInvite(inv)}>ยกเลิก</button>}
            </li>
          ))}
        </ul>
      ) : <p className="muted center">ยังไม่เคยส่งคำเชิญ</p>)}

      {tab === 'trash' && docs !== null && (
        <>
          <p className="muted">เอกสารในถังขยะเปิดไม่ได้ทั้งคุณและคนที่แชร์ด้วย จนกว่าจะกู้คืน ระบบเก็บไว้อย่างน้อย 30 วัน หลังจากนั้นอาจถูกลบถาวร</p>
          {trashed.length ? (
            <ul className="list">
              {trashed.map((d) => (
                <li key={d.id}>
                  <span className="item">{d.title}<small className="muted"> · ลบเมื่อ {new Date(d.deleted_at).toLocaleString('th-TH')}</small></span>
                  <button className="primary" disabled={saving} onClick={() => restore(d)}>กู้คืน</button>
                  <button className="link danger" disabled={saving} onClick={() => purge(d)}>ลบถาวร</button>
                </li>
              ))}
            </ul>
          ) : <p className="muted center">ถังขยะว่าง</p>}
        </>
      )}
    </section>
  )
}
