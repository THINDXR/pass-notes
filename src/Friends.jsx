import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase.js'

// all friendships of `uid`, each with the other person and its state from uid's side
export async function loadFriendships(uid) {
  const { data, error } = await supabase.from('friendships').select(`id, status, requester_id, addressee_id,
    requester:profiles!friendships_requester_id_fkey(id, username, display_name),
    addressee:profiles!friendships_addressee_id_fkey(id, username, display_name)`)
  if (error) throw error
  return data.map((f) => ({
    ...f,
    other: f.requester_id === uid ? f.addressee : f.requester,
    state: f.status === 'accepted' ? 'friend' : f.addressee_id === uid ? 'incoming' : 'outgoing',
  }))
}

// Friend list kept current with Realtime, plus a notice when a new request arrives.
// Falls back to reloading on window focus and a manual reload when Realtime is down.
export function useFriendships(uid) {
  const [list, setList] = useState(null)
  const [error, setError] = useState('')
  const [live, setLive] = useState(false)
  const [notice, setNotice] = useState('')
  const seq = useRef(0) // only the newest load may set state
  const ids = useRef(new Set())

  const reload = useCallback(async () => {
    const n = ++seq.current
    setError('')
    try {
      const l = await loadFriendships(uid)
      if (n !== seq.current) return null
      ids.current = new Set(l.map((f) => f.id))
      setList(l)
      return l
    } catch (e) {
      if (n === seq.current) setError(e.message)
      return null
    }
  }, [uid])

  useEffect(() => {
    setList(null)
    setNotice('')
    if (!uid) return
    reload()
    const changed = async ({ eventType, new: row }) => {
      const l = await reload()
      if (eventType === 'INSERT' && row?.addressee_id === uid) {
        const f = l?.find((x) => x.id === row.id)
        if (f) setNotice(f.other.display_name)
      }
    }
    const channel = supabase.channel(`friends:${uid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships', filter: `addressee_id=eq.${uid}` }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships', filter: `requester_id=eq.${uid}` }, changed)
      // DELETE events can't be filtered and carry only the key: reload only for rows we have
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'friendships' },
        ({ old }) => ids.current.has(old?.id) && reload())
      .subscribe((status) => setLive(status === 'SUBSCRIBED'))
    window.addEventListener('focus', reload)
    return () => {
      seq.current++ // drop loads still in flight (sign-out, account switch)
      supabase.removeChannel(channel)
      window.removeEventListener('focus', reload)
    }
  }, [uid, reload])

  return { list, error, live, reload, notice, clearNotice: () => setNotice('') }
}

export default function Friends({ uid, friends }) {
  const { list, error, live, reload } = friends
  const [results, setResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [lastQuery, setLastQuery] = useState('')
  const [status, setStatus] = useState(null) // { saving } | { ok } | { error, retry }
  const searchSeq = useRef(0)

  useEffect(() => () => { searchSeq.current++ }, []) // ignore searches that finish after leaving the page

  async function runSearch(raw) {
    const q = raw.trim().toLowerCase().replace(/^@/, '')
    const n = ++searchSeq.current // a newer search makes older results stale
    setLastQuery(raw)
    setSearchError('')
    if (!/^[a-z0-9_]{1,20}$/.test(q)) { setSearching(false); return setResults([]) } // also keeps LIKE wildcards out
    setSearching(true)
    const { data, error } = await supabase.from('profiles').select('id, username, display_name')
      .ilike('username', `${q}%`).neq('id', uid).limit(10)
    if (n !== searchSeq.current) return
    setSearching(false)
    if (error) return setSearchError('ค้นหาไม่สำเร็จ: ' + error.message)
    setResults(data)
  }

  async function act(write, ok) {
    setStatus({ saving: true })
    const { error } = await write()
    if (error) {
      setStatus({ error: error.code === '23505' ? 'มีคำขอระหว่างคุณกับคนนี้อยู่แล้ว' : 'ไม่สำเร็จ: ' + error.message, retry: () => act(write, ok) })
    } else {
      setStatus({ ok })
    }
    reload()
  }
  const request = (p) => act(() => supabase.from('friendships').insert({ requester_id: uid, addressee_id: p.id }), `ส่งคำขอถึง ${p.display_name} แล้ว`)
  const accept = (f) => act(() => supabase.from('friendships').update({ status: 'accepted' }).eq('id', f.id), `เป็นเพื่อนกับ ${f.other.display_name} แล้ว`)
  const remove = (f, ok) => act(() => supabase.from('friendships').delete().eq('id', f.id), ok)

  const known = new Map((list ?? []).map((f) => [f.other.id, f.state]))
  const group = (state) => (list ?? []).filter((f) => f.state === state)
  const person = (p) => <span className="item"><b>{p.display_name}</b> <small className="muted">@{p.username}</small></span>
  const saving = !!status?.saving

  return (
    <section>
      <form className="row" onSubmit={(e) => { e.preventDefault(); runSearch(e.target.q.value) }}>
        <input name="q" placeholder="ค้นหา @username" aria-label="ค้นหา username" autoCapitalize="none" />
        <button className="primary" disabled={searching}>{searching ? 'กำลังค้นหา…' : 'ค้นหา'}</button>
      </form>
      {searchError && (
        <p className="error" role="alert">{searchError} <button className="link" onClick={() => runSearch(lastQuery)}>ลองใหม่</button></p>
      )}
      {results && !searching && !searchError && (
        <ul className="list">
          {results.length === 0 && <li className="muted">ไม่พบผู้ใช้</li>}
          {results.map((p) => (
            <li key={p.id}>
              {person(p)}
              {known.has(p.id)
                ? <small className="muted">{{ friend: 'เป็นเพื่อนแล้ว', incoming: 'รอคุณตอบรับ', outgoing: 'ส่งคำขอแล้ว' }[known.get(p.id)]}</small>
                : <button className="primary" disabled={saving || list === null} onClick={() => request(p)}>เพิ่มเพื่อน</button>}
            </li>
          ))}
        </ul>
      )}

      {status?.saving && <p className="muted" role="status">กำลังบันทึก…</p>}
      {status?.ok && <p className="ok" role="status">{status.ok}</p>}
      {status?.error && (
        <p className="error" role="alert">
          {status.error} <button className="link" onClick={status.retry}>ลองใหม่</button>
          <button className="link" onClick={() => setStatus(null)}>ปิด</button>
        </p>
      )}

      <div className="row">
        <small className="muted">{live ? 'อัปเดตอัตโนมัติ' : 'อัปเดตอัตโนมัติไม่ทำงาน กด “โหลดใหม่” เพื่อดูข้อมูลล่าสุด'}</small>
        <button className="link" onClick={reload}>โหลดใหม่</button>
      </div>
      {error && <p className="error" role="alert">โหลดรายชื่อเพื่อนไม่สำเร็จ: {error} <button className="link" onClick={reload}>ลองใหม่</button></p>}
      {list === null && !error && <p className="muted center">กำลังโหลด…</p>}

      {list && (
        <>
          {group('incoming').length > 0 && <h3>คำขอเป็นเพื่อน ({group('incoming').length})</h3>}
          <ul className="list">
            {group('incoming').map((f) => (
              <li key={f.id}>
                {person(f.other)}
                <button className="primary" disabled={saving} onClick={() => accept(f)}>ยอมรับ</button>
                <button className="link" disabled={saving} onClick={() => remove(f, 'ปฏิเสธคำขอแล้ว')}>ปฏิเสธ</button>
              </li>
            ))}
          </ul>

          <h3>เพื่อน ({group('friend').length})</h3>
          <ul className="list">
            {group('friend').length === 0 && <li className="muted">ยังไม่มีเพื่อน ค้นหาจาก username ด้านบน</li>}
            {group('friend').map((f) => (
              <li key={f.id}>
                {person(f.other)}
                <button className="link danger" disabled={saving}
                  onClick={() => confirm(`ลบ ${f.other.display_name} ออกจากเพื่อน?`) && remove(f, `ลบ ${f.other.display_name} ออกจากเพื่อนแล้ว`)}>ลบเพื่อน</button>
              </li>
            ))}
            {group('outgoing').map((f) => (
              <li key={f.id}>
                {person(f.other)}
                <small className="muted">รอตอบรับ</small>
                <button className="link" disabled={saving} onClick={() => remove(f, 'ยกเลิกคำขอแล้ว')}>ยกเลิก</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
