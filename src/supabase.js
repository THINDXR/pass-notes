import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY
if (!url || !key) throw new Error('Copy .env.example to .env and fill in your Supabase URL and anon key')

export const supabase = createClient(url, key)

// dev only (stripped from production builds): lets browser tests inspect and drop realtime channels
if (import.meta.env.DEV) window.__supabase = supabase
