// Purges documents left in the trash for 30+ days, then deletes PDFs no document uses.
// Server-side only — the secret key bypasses RLS and must never reach the browser or the repo:
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SECRET_KEY=sb_secret_... node scripts/cleanup-orphan-pdfs.mjs [--dry-run]
import { createClient } from '@supabase/supabase-js'

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SECRET_KEY')
  process.exit(1)
}
const dryRun = process.argv.includes('--dry-run')
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } })

// 1. permanently delete documents that have been in the trash for 30+ days (their notes go with them)
if (dryRun) {
  console.log('dry run: skipping purge of trash older than 30 days')
} else {
  const purged = await supabase.rpc('purge_trashed')
  if (purged.error) {
    console.error('purge_trashed failed:', purged.error.message)
    process.exit(1)
  }
  console.log(`${purged.data} document(s) purged from the trash`)
}

// 2. delete PDF files no document points at any more
const { data, error } = await supabase.rpc('orphan_pdfs')
if (error) {
  console.error('orphan_pdfs failed:', error.message)
  process.exit(1)
}
const paths = data.map((r) => r.name)
console.log(`${paths.length} unused PDF(s)${dryRun ? ' (dry run, nothing deleted)' : ''}`)
if (dryRun) {
  paths.forEach((p) => console.log(' ', p))
  process.exit(0)
}
for (let i = 0; i < paths.length; i += 100) {
  const { error } = await supabase.storage.from('pdfs').remove(paths.slice(i, i + 100))
  if (error) {
    console.error('remove failed:', error.message)
    process.exit(1)
  }
}
console.log('done')
