import { useEffect, useState } from 'react'
import { supabase } from './supabase.js'
import Library from './Library.jsx'
import Friends, { useFriendships } from './Friends.jsx'
import Editor from './Editor.jsx'

export default function App() {
  const [session, setSession] = useState(undefined)
  const [profile, setProfile] = useState(undefined) // undefined = loading, null = not created yet
  const [profileError, setProfileError] = useState('')
  const [profileAttempt, setProfileAttempt] = useState(0)
  const [view, setView] = useState('library')
  const [docId, setDocId] = useState(null)
  const uid = session?.user.id
  // subscribed for the whole signed-in session (badge + notice); unsubscribes on sign-out
  const friends = useFriendships(profile ? uid : undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    setProfile(undefined)
    setProfileError('')
    if (!uid) return
    let cancelled = false
    // only a successful "no row" answer means the profile doesn't exist; errors must not open the setup form
    supabase.from('profiles').select().eq('id', uid).maybeSingle().then(
      ({ data, error }) => { if (!cancelled) error ? setProfileError(error.message) : setProfile(data) },
      (e) => { if (!cancelled) setProfileError(e.message) },
    )
    return () => { cancelled = true }
  }, [uid, profileAttempt])

  if (session === undefined) return <p className="center">กำลังโหลด…</p>
  if (!session) return <Auth />
  if (profileError) return (
    <div className="center">
      <p className="error" role="alert">โหลดโปรไฟล์ไม่สำเร็จ: {profileError}</p>
      <button className="primary" onClick={() => setProfileAttempt((n) => n + 1)}>ลองใหม่</button>
      <button className="link" onClick={() => supabase.auth.signOut()}>ออกจากระบบ</button>
    </div>
  )
  if (profile === undefined) return <p className="center">กำลังโหลด…</p>
  if (profile === null) return <ProfileForm uid={uid} onSaved={setProfile} />
  if (docId) return <Editor uid={uid} docId={docId} onBack={() => setDocId(null)} />

  const incoming = friends.list?.filter((f) => f.state === 'incoming').length ?? 0
  const tab = (name, label) => (
    <button className={view === name ? 'tab active' : 'tab'} onClick={() => setView(name)}>{label}</button>
  )
  return (
    <div className="app">
      <header>
        <strong>PassNotes</strong>
        <nav>
          {tab('library', 'เอกสาร')}
          {tab('friends', incoming ? `เพื่อน (${incoming})` : 'เพื่อน')}
          {tab('profile', 'โปรไฟล์')}
        </nav>
      </header>
      {friends.notice && (
        <div className="notice" role="status">
          <span>📩 {friends.notice} ส่งคำขอเป็นเพื่อนถึงคุณ</span>
          {view !== 'friends' && <button className="link" onClick={() => { setView('friends'); friends.clearNotice() }}>ดูคำขอ</button>}
          <button className="link" onClick={friends.clearNotice} aria-label="ปิดการแจ้งเตือน">✕</button>
        </div>
      )}
      <main>
        {view === 'library' && <Library uid={uid} onOpen={setDocId} />}
        {view === 'friends' && <Friends uid={uid} friends={friends} />}
        {view === 'profile' && <ProfileForm uid={uid} profile={profile} onSaved={setProfile} />}
      </main>
    </div>
  )
}

function Auth() {
  const [signUp, setSignUp] = useState(false)
  const [msg, setMsg] = useState('')

  async function submit(e) {
    e.preventDefault()
    const creds = { email: e.target.email.value, password: e.target.password.value }
    // the confirmation link returns here; this origin must be in Supabase's Redirect URLs (see README)
    const { data, error } = signUp
      ? await supabase.auth.signUp({ ...creds, options: { emailRedirectTo: window.location.origin } })
      : await supabase.auth.signInWithPassword(creds)
    if (error) setMsg(error.message)
    else if (signUp && !data.session) setMsg('ส่งลิงก์ยืนยันไปที่อีเมลแล้ว กดยืนยันแล้วกลับมาเข้าสู่ระบบ')
  }

  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>PassNotes</h1>
      <p className="muted">จดโน้ตบน PDF แล้วแชร์ให้เพื่อน</p>
      <label>อีเมล<input name="email" type="email" required autoComplete="email" /></label>
      <label>รหัสผ่าน<input name="password" type="password" required minLength={6}
        autoComplete={signUp ? 'new-password' : 'current-password'} /></label>
      {msg && <p className="error" role="alert">{msg}</p>}
      <button className="primary">{signUp ? 'สมัครสมาชิก' : 'เข้าสู่ระบบ'}</button>
      <button type="button" className="link" onClick={() => { setSignUp(!signUp); setMsg('') }}>
        {signUp ? 'มีบัญชีแล้ว? เข้าสู่ระบบ' : 'ยังไม่มีบัญชี? สมัครสมาชิก'}
      </button>
    </form>
  )
}

// first-time setup when `profile` is absent, otherwise the profile page
function ProfileForm({ uid, profile, onSaved }) {
  const [msg, setMsg] = useState('')

  async function submit(e) {
    e.preventDefault()
    const display_name = e.target.display_name.value.trim()
    const { data, error } = profile
      ? await supabase.from('profiles').update({ display_name }).eq('id', uid).select().single()
      : await supabase.from('profiles').insert({ id: uid, username: e.target.username.value, display_name }).select().single()
    if (error) setMsg(error.code === '23505' ? 'username นี้มีคนใช้แล้ว' : error.message)
    else { onSaved(data); setMsg(profile ? 'บันทึกแล้ว' : '') }
  }

  return (
    <form className="card narrow" onSubmit={submit}>
      <h2>{profile ? 'โปรไฟล์' : 'ตั้งค่าโปรไฟล์'}</h2>
      {profile
        ? <p className="muted">@{profile.username}</p>
        : <label>username (เพื่อนใช้ค้นหาคุณ)
            <input name="username" required pattern="[a-z0-9_]{3,20}" title="a-z, 0-9, _ ยาว 3–20 ตัว"
              autoCapitalize="none" placeholder="เช่น somchai_k" />
          </label>}
      <label>ชื่อที่แสดง<input name="display_name" required maxLength={50} defaultValue={profile?.display_name} /></label>
      {msg && <p className="muted" role="status">{msg}</p>}
      <button className="primary">บันทึก</button>
      <button type="button" className="link" onClick={() => supabase.auth.signOut()}>ออกจากระบบ</button>
    </form>
  )
}
