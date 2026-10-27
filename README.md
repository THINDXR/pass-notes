# PassNotes

จดโน้ตบน PDF แล้วแชร์ให้เพื่อนในแอป: ส่งสำเนา หรือทำงานร่วมกันแบบเรียลไทม์

## พัฒนาในเครื่อง
1. สร้างโปรเจกต์ที่ https://supabase.com (ใช้โปรเจกต์ dev แยกจาก production)
2. Dashboard → **SQL Editor** → รัน `supabase/schema.sql` ก่อน แล้วรันไฟล์ใน `supabase/migrations/` เรียงตามชื่อ
3. `cp .env.example .env` แล้วใส่ Project URL และ **publishable key** (`sb_publishable_…`)
4. Authentication → URL Configuration → Redirect URLs: เพิ่ม `http://localhost:5173`

```
npm install
npm run dev     # http://localhost:5173
npm test        # unit test + ทดสอบ RLS บน Postgres จำลอง (schema.sql + migrations ทั้งหมด)
```

## กุญแจ: อะไรใส่ที่ไหน
| กุญแจ | ใช้ที่ | ห้าม |
|---|---|---|
| publishable (`sb_publishable_…`) | `.env` / ตัวแปร build ของเว็บ | ไม่มีปัญหาถ้าหลุด เพราะสิทธิ์บังคับด้วย RLS |
| secret (`sb_secret_…`) | GitHub Actions secrets หรือ cron ฝั่งเซิร์ฟเวอร์เท่านั้น | **ห้ามขึ้นต้นด้วย `VITE_`** (Vite จะฝังลงในโค้ดเว็บ) และห้าม commit |
| รหัสผ่านฐานข้อมูล / connection string | สคริปต์ backup และ migration | ห้าม commit |

ถ้า secret key หลุด ให้ลบหรือ roll ทันทีที่ Project Settings → API Keys

## ตั้งค่า Supabase สำหรับ production
1. สร้างโปรเจกต์ใหม่สำหรับ production แล้วรัน `schema.sql` และ migrations ตามลำดับ
2. **Authentication → URL Configuration**
   - Site URL: `https://your-app.example.com`
   - Redirect URLs: `https://your-app.example.com` ลิงก์ยืนยันอีเมลจะกลับมาที่ origin ของหน้าที่สมัคร (`emailRedirectTo` ใน `src/App.jsx`) origin นั้นจึงต้องอยู่ในรายการนี้ ถ้ามี preview deploy ให้เพิ่มรูปแบบของมันด้วย เช่น `https://*-yourteam.vercel.app/**` อย่าใส่ `localhost` ในโปรเจกต์ production
3. **Authentication → Sign In / Providers → Email**: เปิด *Confirm email*
4. **Authentication → Emails → SMTP Settings**: ตั้ง SMTP ของตัวเอง (เช่น Resend, Postmark, SES) เพราะเมลเริ่มต้นของ Supabase มีโควตาต่ำมากและใช้ทดสอบเท่านั้น
5. ตั้งรหัสผ่านขั้นต่ำอย่างน้อย 8 ตัวที่ Authentication → Sign In / Providers
6. **Storage**: bucket `pdfs` ต้องเป็น private ห้ามเปิด public เพราะการเข้าถึงไฟล์ทั้งหมดผ่าน RLS
7. **Database → Publications**: ตรวจว่า `supabase_realtime` มีตาราง `strokes` (schema.sql เพิ่มไว้แล้ว)

## Deploy หน้าเว็บ
แอปเป็น static site (ไม่มี router ฝั่ง server) ใช้ Vercel, Netlify หรือ Cloudflare Pages ได้
- Build command: `npm run build` · Output directory: `dist`
- Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (ใส่ publishable key)
- หลัง deploy ให้นำ URL จริงไปใส่ใน Site URL และ Redirect URLs ตามข้อ 2 ด้านบน

## ถังขยะและการเก็บกวาด
- "ลบ" ในแอปคือการย้ายไปถังขยะ (`documents.deleted_at`) โน้ตและไฟล์ PDF ยังอยู่ครบ ระหว่างนั้นคนที่ทำงานร่วมกันเปิดเอกสารไม่ได้ ไม่มีใครเขียนโน้ตเพิ่มได้ และคำเชิญที่ยังไม่ตอบจะถูกยกเลิก
- เจ้าของเท่านั้นที่ย้ายไปถังขยะ กู้คืน หรือลบถาวรได้ ฐานข้อมูลบังคับผ่าน `set_document_trashed()` และ RLS ลบถาวรได้เฉพาะเอกสารที่อยู่ในถังขยะ
- ลบถาวรแล้ว แอปจะพยายามลบไฟล์ PDF ด้วย แต่ RLS อนุญาตเฉพาะเมื่อไม่มีเอกสารอื่น (เช่นสำเนา) ใช้ไฟล์นั้นอยู่
- **ระบบไม่ได้ลบถาวรอัตโนมัติ จนกว่าจะตั้ง cron ด้านล่าง** ในแอปจึงเขียนว่า "เก็บไว้อย่างน้อย 30 วัน" ไม่ได้บอกว่าจะลบเมื่อครบ
- `scripts/cleanup-orphan-pdfs.mjs` ทำ 2 อย่าง: (1) ลบถาวรเอกสารที่อยู่ในถังขยะเกิน 30 วัน (2) ลบไฟล์ PDF ที่ไม่มีเอกสารใดอ้างถึงและเก่ากว่า 1 วัน ควรรันวันละครั้ง

```
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SECRET_KEY=sb_secret_... node scripts/cleanup-orphan-pdfs.mjs --dry-run
```
ลองแบบ `--dry-run` ก่อน (ข้ามขั้นลบถังขยะ และแสดงแค่รายการไฟล์) แล้วค่อยรันจริง ตัวอย่าง GitHub Actions (เก็บ secret ไว้ใน Settings → Secrets):
```yaml
on: { schedule: [{ cron: '0 3 * * *' }] }
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && node scripts/cleanup-orphan-pdfs.mjs
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SECRET_KEY: ${{ secrets.SUPABASE_SECRET_KEY }}
```

## สำรองและกู้คืนข้อมูล
- **ฐานข้อมูล:** แผน Pro ขึ้นไปมี backup รายวัน และซื้อ Point-in-Time Recovery เพิ่มได้ แผน Free **ไม่มี backup ให้** ต้อง dump เองเป็นประจำ ใช้ connection string จาก Project Settings → Database:
  ```
  supabase db dump --db-url "$DB_URL" -f roles.sql --role-only
  supabase db dump --db-url "$DB_URL" -f schema.sql
  supabase db dump --db-url "$DB_URL" -f data.sql --use-copy --data-only
  ```
  กู้คืนลงโปรเจกต์ใหม่:
  ```
  psql --single-transaction --variable ON_ERROR_STOP=1 --file roles.sql --file schema.sql \
    --command 'SET session_replication_role = replica' --file data.sql --dbname "$NEW_DB_URL"
  ```
- **ไฟล์ PDF ไม่รวมอยู่ใน backup ของฐานข้อมูล** ต้องสำรอง bucket `pdfs` แยกต่างหาก โดยใช้ S3 endpoint ของ Supabase Storage (Storage → Settings → S3 access keys) ร่วมกับ `rclone` หรือ `aws s3 sync`
- เก็บไฟล์ backup ไว้นอก Supabase และเข้ารหัสไว้ เพราะในนั้นมีอีเมลผู้ใช้
- ลองกู้คืนลงโปรเจกต์ทดสอบอย่างน้อยไตรมาสละครั้ง backup ที่ไม่เคยลองกู้ถือว่ายังไม่มี

## เปลี่ยน schema ในอนาคต
1. **ห้ามแก้ `schema.sql` เพื่อเปลี่ยนฐานข้อมูลที่ใช้งานอยู่** ให้เพิ่มไฟล์ใหม่ `supabase/migrations/<YYYYMMDDHHMMSS>_<ชื่อ>.sql` แทน
2. เพิ่ม test ใน `supabase/rls.test.mjs` ตัว test จะรัน schema กับทุก migration ให้เอง แล้วรัน `npm test`
3. backup ก่อนเสมอ แล้วรันบนโปรเจกต์ dev/staging ก่อน production
4. รัน migration ผ่าน SQL Editor ตามลำดับชื่อไฟล์ หรือใช้ Supabase CLI (`supabase link`, `supabase db push`) ถ้าจะใช้ CLI ให้ย้าย `schema.sql` ไปเป็น migration แรก แล้วสั่ง `supabase migration repair --status applied <version>` สำหรับไฟล์ที่รันไปแล้ว
5. เปลี่ยนแบบเข้ากันได้กับของเดิม คือเพิ่มของใหม่ → deploy เว็บ → ค่อยลบของเก่า เพราะผู้ใช้อาจเปิดแอปเวอร์ชันเก่าค้างไว้ และโน้ตที่ยังไม่ซิงก์อาจค้างอยู่ใน localStorage หลายวัน **ห้ามเปลี่ยนชื่อหรือลบคอลัมน์ของ `strokes`** ที่คิวส่งไป (`id, document_id, page, tool, color, width, points`) ถ้าไม่มีช่วงเปลี่ยนผ่าน

## นำ migration ที่มีอยู่ไปใช้กับโปรเจกต์เดิม
ถ้าเคยรันแค่ `schema.sql` ไว้ ให้ทำตามนี้ก่อน deploy เว็บเวอร์ชันนี้ เพราะหน้าเอกสารต้องใช้ตาราง `folders`
1. backup (ดูหัวข้อด้านบน)
2. SQL Editor → รันทีละไฟล์ตามลำดับ:
   1. `supabase/migrations/20261025000000_pdf_cleanup.sql`
   2. `supabase/migrations/20261025010000_folders.sql`
3. ตรวจผล: Table Editor ต้องมี `folders` และ `document_folders` และมี RLS เปิดอยู่
4. deploy เว็บ ทั้งสองไฟล์เพิ่มของใหม่เท่านั้น เว็บเวอร์ชันเก่าที่ยังเปิดค้างอยู่จึงใช้ต่อได้

### migration ชุดคำเชิญ ถังขยะ และประวัติโน้ต
1. backup
2. SQL Editor → รัน `supabase/migrations/20261026000000_invites_trash_history.sql`
3. ตรวจผล: มีตาราง `stroke_events` และ Database → Publications → `supabase_realtime` มี `strokes`, `friendships`, `invites`
4. deploy เว็บ **หลัง** migration เพราะเว็บเวอร์ชันใหม่ต้องใช้ `deleted_at`, `stroke_events` และ `friendships.id` ส่วนเว็บเวอร์ชันเก่ายังใช้ต่อได้ ยกเว้นปุ่มลบเอกสาร ซึ่งจะไม่มีผลจนกว่าจะ deploy เว็บใหม่ เพราะตอนนี้ต้องย้ายไปถังขยะก่อน

## Realtime
- ใช้ Postgres Changes ของ Supabase กับตาราง `strokes` (โน้ตในเอกสาร), `friendships` (คำขอเพื่อน) และ `invites` (คำเชิญ) ซึ่ง migration เพิ่มเข้า publication ไว้แล้ว ไม่ต้องตั้งค่าใน Dashboard เพิ่ม
- event แบบ INSERT/UPDATE ผ่าน RLS ผู้ใช้จึงได้รับเฉพาะแถวที่ตัวเองอ่านได้ ส่วน event แบบ DELETE ไม่ผ่าน RLS และมีแค่ primary key `friendships` จึงใช้ `id` แบบสุ่มเป็น primary key แทนคู่ user id
- ถ้า Realtime ใช้ไม่ได้ (เช่น เครือข่ายบล็อก WebSocket) หน้าเพื่อน กล่องรับ และคำเชิญที่ส่งแล้วจะขึ้นว่า "อัปเดตอัตโนมัติไม่ทำงาน" พร้อมปุ่ม "โหลดใหม่" รายชื่อเพื่อนจะโหลดใหม่เองทุกครั้งที่กลับมาที่หน้าต่างแอปด้วย
- ในหน้าเอกสาร event ที่ส่งมาระหว่างการเชื่อมต่อหลุด (เช่น iPad ล็อกจอ หรือสลับแอป) จะหายไป แอปจึงโหลดเส้นทั้งหมดจากเซิร์ฟเวอร์ใหม่ทุกครั้งที่ channel เชื่อมต่อสำเร็จ, กลับมาออนไลน์ หรือกลับมาที่แท็บ ถ้า socket หลุดไปแล้วจะเชื่อมต่อใหม่เอง ข้อมูลที่โหลดใหม่จะไม่ทับเส้นที่ยังรออยู่ในคิวของเครื่อง (`mergeRemote` ใน `src/saveQueue.js`) และถ้าการอัปเดตสดหยุด แถบเครื่องมือจะขึ้น "⚠ อัปเดตสดหยุดทำงาน · เชื่อมต่อใหม่"

## ปากกา นิ้ว และเมาส์
- ตัดสินจาก `pointerType` ของแต่ละ gesture ไม่ดูจาก user agent และไม่จำว่าเคยเจอปากกา (`src/inputPolicy.js`): ปากกาและเมาส์ใช้เขียนหรือลบ นิ้วใช้เลื่อนหน้าและ pinch zoom ตั้งแต่เปิดเอกสาร
- บน iPad Safari แอป cancel เฉพาะ touch ที่มี `touchType === 'stylus'` (Apple Pencil) หน้าจึงไม่เลื่อนตอนเขียน ส่วนนิ้วยังเลื่อนหน้าได้ตามปกติ
- นิ้วไม่เขียนเลย: อุปกรณ์จอสัมผัสที่ไม่มีปากกา (เช่นโทรศัพท์) ใช้ดูและเลื่อนเอกสารได้อย่างเดียว

## ประวัติโน้ต
- trigger บน `strokes` บันทึกลง `stroke_events` ทุกครั้งที่มีการเพิ่ม คัดลอกมากับสำเนา ลบ หรือกู้คืน โดยเก็บผู้ทำ (`auth.uid()`) และเวลาของเซิร์ฟเวอร์
- ผู้ใช้อ่านประวัติได้ตาม role ปัจจุบัน แต่เขียนหรือแก้ไม่ได้ เพราะไม่มี policy สำหรับ insert/update/delete และถูก revoke สิทธิ์ไว้
- การส่งซ้ำจากคิว offline ไม่สร้างประวัติซ้ำ: upsert ที่ซ้ำจะไม่ insert และการตั้งค่า `deleted` เป็นค่าเดิมจะไม่ถูกบันทึก
- โน้ตที่มีอยู่ก่อน migration ถูกบันทึกเป็น "เพิ่มโน้ต" ตามเวลาและผู้เขียนเดิม แต่โน้ตที่ถูกลบไปก่อน migration ไม่มีประวัติการลบ จึงกู้คืนจากหน้าประวัติไม่ได้

## โฟลเดอร์ ลบโฟลเดอร์ และลบบัญชี
- โฟลเดอร์เป็นของแต่ละคน คนอื่นมองไม่เห็นชื่อหรือโครงสร้าง (RLS บน `folders` และ `document_folders`)
- การจัดเอกสารเข้าโฟลเดอร์เก็บแยกต่อคนใน `document_folders` ผู้รับเอกสารที่แชร์จัดเข้าโฟลเดอร์ของตัวเองได้ โดยไม่กระทบตำแหน่งของเจ้าของ ฐานข้อมูลตรวจผ่าน foreign key ว่าโฟลเดอร์เป็นของผู้ใช้คนนั้น และผู้ใช้เป็นสมาชิกของเอกสารนั้นจริง
- **ลบโฟลเดอร์:** เอกสารข้างในกลับไปอยู่ "ไม่จัดหมวด" ตัวเอกสารไม่ถูกลบ
- **ออกจากเอกสารที่แชร์:** ลบเฉพาะตำแหน่งในโฟลเดอร์ของคนที่ออก
- **ลบบัญชี** (ทำได้จาก Dashboard → Authentication → Users เท่านั้น ในแอปไม่มีปุ่มนี้):
  - โฟลเดอร์ของบัญชีนั้นถูกลบ
  - **เอกสารที่บัญชีนั้นเป็นเจ้าของถูกลบด้วย** และคนที่ทำงานร่วมกันจะเปิดไม่ได้อีก ถ้าต้องการเก็บไว้ ให้เจ้าของ "ส่งสำเนา" ให้คนที่ต้องการก่อนลบบัญชี
  - สำเนาที่คนอื่นรับไปแล้วยังอยู่ครบ รวมถึงไฟล์ PDF ด้วย
  - โน้ตที่บัญชีนั้นเคยเขียนในเอกสารของคนอื่นยังอยู่ แค่ไม่ระบุผู้เขียน (`author_id` เป็น null)

## โครงสร้าง
- `supabase/schema.sql` + `supabase/migrations/`: ตาราง, RLS และฟังก์ชัน กฎความปลอดภัยทั้งหมดอยู่ที่นี่
- `src/Editor.jsx`: แสดง PDF, วาด, ยางลบ, undo, ซิงก์, แชร์, ส่งออก
- `src/saveQueue.js`: คิวโน้ตที่ยังไม่ซิงก์ เก็บใน localStorage แยกตามผู้ใช้และเอกสาร
- `src/folders.js`: กฎชื่อโฟลเดอร์ การค้นหา กรอง และเรียงรายการเอกสาร
- `src/pdfSearch.js`: ค้นหาข้อความใน PDF (ใช้ text layer ของ pdf.js) และคำนวณกรอบไฮไลต์
- `src/geometry.js`: คำนวณเส้น (พิกัดเก็บเป็นสัดส่วน 0–1 ของหน้า)
- `scripts/cleanup-orphan-pdfs.mjs`: ลบถังขยะเก่า และไฟล์ PDF ที่ไม่มีใครใช้ (ฝั่งเซิร์ฟเวอร์)
