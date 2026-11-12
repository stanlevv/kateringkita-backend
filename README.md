# 🍽️ KateringKita — Backend REST API

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-22.x%20|%2024.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Express](https://img.shields.io/badge/Express-5.2-000000?style=for-the-badge&logo=express&logoColor=white)
![MySQL / TiDB](https://img.shields.io/badge/TiDB%20Cloud-MySQL%208-4479A1?style=for-the-badge&logo=mysql&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-489%20Passed-6E9F18?style=for-the-badge&logo=vitest&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

**RESTful API tangguh dan berkinerja tinggi untuk KateringKita — platform marketplace katering kampus terpercaya.**

[Live Production API](https://ketring-45f82aef1ca0.herokuapp.com/api/v1/health) • [Dashboard Frontend](https://github.com/stanlevv/kateringkita-frontend) • [Dokumentasi API](#-koleksi-endpoint-api-v1)

</div>

---

## 📖 Gambaran Umum

**KateringKita Backend** melayani ekosistem lengkap marketplace katering dalam satu arsitektur terpadu:
1. **Web Dashboard Merchant & Admin** ([kateringkita-frontend](https://github.com/stanlevv/kateringkita-frontend)) — manajemen katalog, kuota atomik, pemrosesan pesanan real-time, verifikasi toko, dan laporan penjualan.
2. **Aplikasi Mobile Pembeli** — pemesanan instan mahasiswa, penahanan porsi otomatis 5 menit, pelacakan pesanan, dan integrasi WhatsApp.
3. **Internal Background Cron / Worker** — pembatalan otomatis pesanan kedaluwarsa (*holding expired*) dan pelepasan porsi tertahan secara aman dan konsisten.

| Lingkungan | Alamat / Endpoint |
|---|---|
| **Production API Base** | `https://ketring-45f82aef1ca0.herokuapp.com/api/v1` |
| **Health Check** | `https://ketring-45f82aef1ca0.herokuapp.com/api/v1/health` → `{"data":{"status":"ok","db":"ok"}}` |
| **Merchant Dashboard** | `https://ketringkita.edufin.app` |

---

## 🚀 Status Implementasi Fitur

| ID | Fitur | Status |
|---|---|---|
| F00 | Fondasi: konfigurasi, migrasi, format galat, CORS | Selesai |
| F01 | Daftar, masuk, keluar, sesi (JWT + daftar sesi di DB) | Selesai |
| F02 | Profil pengguna, ganti kata sandi, foto profil | Selesai |
| F03 | Toko: profil, buka/tutup, jam operasional, titik ambil, templat WhatsApp | Selesai |
| F04 | Menu dan kuota porsi harian | Selesai |
| F05 | Katalog publik dan favorit | Selesai |
| F06 | Checkout dengan penahanan porsi 5 menit | Selesai |
| F07 | Proses pesanan oleh penjual dan pembeli | Selesai |
| F08 | Kedaluwarsa otomatis pesanan tertahan + notifikasi | Selesai |
| F18 | Admin: verifikasi penjual, data master, promo platform, log | Selesai |
| F09 | Laporan penjualan (ringkasan, per jam, transaksi) | Selesai |
| F10 | Pembayaran Virtual Account Midtrans (QRIS toko manual dihapus di F26) | Selesai |
| F11 | Lupa sandi lewat OTP email | Selesai |
| F12 | Promo toko + kode promo di checkout | Selesai |
| F13 | Ulasan pembeli dan rating menu/toko | Selesai |
| F14 | Pesan lagi | Selesai |
| F17 | Asisten AI toko (Gemini) | Selesai |
| F19 | Moderasi admin: ulasan, menu (suspend toko dari F18) | Selesai |
| F20 | Rekap keuangan admin | Selesai |
| F21 | Pesan dari meja: QR per meja, menu tanpa login, bayar online (Midtrans Snap) | Selesai |
| F22 | AI gateway: penyedia AI gratis (Gemini, Groq, OpenRouter, NVIDIA NIM) dikelola admin, fallback otomatis | Selesai |
| F23 | Log server: error 5xx & request lambat (> 2 dtk) tercatat, dashboard admin, simpan 30 hari | Selesai |
| F24 | Rekomendasi AI pembeli (RAG dari menu & stok terkini, divalidasi ulang backend, cadangan tanpa AI) | Selesai |
| F25 | Pemakaian AI: token, panggilan, gagal, latensi per penyedia/fitur/hari (simpan 90 hari) | Selesai |
| F26 | Semua non-tunai lewat Midtrans (VA + bayar online Snap untuk pre-order), rekening & pencairan dana toko, daftar refund admin | Selesai |
| — | Broadcast pengumuman, notifikasi promo, kontak CS | Selesai |

Uji otomatis dijalankan terhadap database MySQL lokal (`npm test`).

---

## 🛠️ Arsitektur & Tumpukan Teknologi

- **Bahasa & Runtime:** TypeScript 5.8 & Node.js ≥ 22.12 (Production di Heroku dengan Node 24).
- **Web Framework:** Express 5.2.
- **Basis Data:** MySQL lewat driver `mysql2/promise` dengan pooling tangguh, diuji pada **TiDB Cloud** (MySQL 8 compatible, SSL aktif).
- **Validasi Data:** Zod 4 (*runtime schema validation*).
- **Keamanan:** JWT (`jsonwebtoken`), hash kata sandi `bcryptjs`, in-memory rate limiting, CORS terisolasi.
- **Penyimpanan Media:** Integrasi Cloudflare R2 dengan URL bertanda tangan (AWS Signature V4, zero external heavy SDK).
- **Pengujian:** Vitest 5 + Supertest dengan pengujian end-to-end terintegrasi database nyata.
- **Kueri SQL:** Murni SQL terparameterisasi (`?`) tanpa ORM overhead demi performa maksimal dan kendali transaksi penuh.

---

## 📁 Struktur Direktori

```text
src/
├── server.ts          Membuka port lalu menyalakan job kedaluwarsa
├── app.ts             Express, CORS, urutan pemasangan router, penanganan galat
├── config/            env.ts (validasi .env dengan zod), db.ts (pool mysql2 + SSL TiDB)
├── routes/            <fitur>.ts: path, middleware, dan handler per route
├── handlers/          <fitur>.handler.ts: baca request, panggil service, kirim respons
├── services/          <fitur>[-bagian].service.ts: aturan bisnis dan kueri SQL
├── dto/               <fitur>[-bagian].dto.ts: skema zod untuk body/query dan tipe inputnya
├── middleware/        auth.ts (sesi & peran), rateLimiter.ts, validate.ts, errorHandler.ts, requestLogger.ts
├── utils/             errors.ts (AppError), r2.ts (URL Cloudflare R2), mail.ts (SMTP), gemini.ts (Gemini REST)
└── scripts/           migrate.ts, seed-demo.ts, create-admin.ts (dijalankan lewat npm run)
database/
└── migrations/        001_init.sql … 010_pencairan.sql (berurutan, satu kali jalan per database)
test/                  Uji integrasi per fitur (satu DB uji, berjalan berurutan)
```

Alur satu request: `routes/` → `handlers/` → `services/` → database. Nama fitur yang dipakai: `auth`, `admin`, `merchant`, `katalog`, `pesanan`, `notifikasi`, `meta`, dan `upload`. Fitur yang logikanya besar dipecah per bagian, misalnya `pesanan-status.service.ts` untuk mesin status pesanan dan `merchant-menu.service.ts` untuk menu toko.

---

## ⚡ Aturan Bisnis & Mekanisme Kunci

- **Kuota porsi harian.** Setiap menu punya `daily_quota`. Penghitung `sold_today` dan `held_today` direset otomatis saat tanggal WIB berganti, saat menu pertama kali dibaca hari itu.
- **Penahanan 5 menit.** Checkout langsung mengunci porsi (`held_today`). Penjual punya waktu menurut `hold_minutes` toko (bawaan 5 menit) untuk mengonfirmasi. Dua checkout bersamaan untuk sisa 1 porsi hanya menghasilkan satu pesanan.
- **Status pesanan:** `holding → confirmed → cooking → ready → completed`, dengan cabang `cancelled` dan `expired`. Transisi yang tidak sah dijawab `409`. Setiap perubahan dicatat di `order_status_logs`.
- **Kedaluwarsa otomatis.** Job di dalam proses server memeriksa pesanan `holding` yang lewat batas waktu. Pesanan itu menjadi `expired`, porsinya kembali, dan pembeli mendapat notifikasi.
- **Harga dan kode pesanan dihitung server.** Nilai total dari aplikasi diabaikan. Kode pesanan berbentuk `KK-YYYYMMDD-XXXX`.
- **HPP tidak pernah keluar ke publik.** Katalog pembeli memakai pemetaan sendiri tanpa `hpp`.
- **Toko harus diverifikasi admin** sebelum tampil di katalog dan bisa menerima pesanan.
- **Idempotensi checkout.** Header `Idempotency-Key` yang sama menghasilkan pesanan yang sama, bukan pesanan ganda.
- **Metode bayar (F10, F26).** Checkout `payment_method`: `cod` (tunai, penjual menekan Konfirmasi), `va`, atau `online`. QRIS statis toko dengan verifikasi manual penjual dihapus di F26; `qris` hanya ada di data lama dan ditolak `400` di checkout. Kontrak mobile: [`docs/pembayaran.md`](docs/pembayaran.md).
- **Virtual Account Midtrans (F10).** Checkout `payment_method: "va"`, lalu pembeli memilih bank (BCA, BNI, BRI) lewat `POST /orders/:code/va`; masa berlaku VA tidak melewati batas tahan pesanan. Notifikasi `settlement` dari Midtrans (signature SHA512 dicek) menandai lunas dan mengonfirmasi pesanan otomatis. Tanpa `MIDTRANS_SERVER_KEY`, checkout VA/online ditolak `409`.
- **Bayar online pre-order (F26).** Checkout `payment_method: "online"`, lalu `POST /orders/:code/online` membuat halaman Snap (QRIS, GoPay, ShopeePay, VA) dan mengembalikan `payment.payment_url`. Idempoten; halaman bayar tutup sebelum batas tahan. Penjual tidak bisa mengonfirmasi pesanan VA/online yang belum lunas (`409`).
- **Pencairan dana (F26).** Uang VA/online masuk akun Midtrans platform. Bagian toko per pesanan selesai = `subtotal` − diskon promo toko; biaya layanan, promo platform, dan biaya Midtrans milik/ditanggung platform. Tunai tidak ikut. Penjual mengisi rekening (`PUT /merchant/payout-account`, wajib kata sandi). Admin super melihat saldo per toko (`GET /admin/payouts/balances`, berisi `as_of`), mentransfer lewat bank, lalu mencatat (`POST /admin/payouts` dengan `amount` dan `until` = `as_of`). Saldo yang berubah atau catatan ganda ditolak `409`; pesanan yang tercatat diberi `payout_id`.
- **Pengembalian dana (F26).** Pembayaran Midtrans yang lunas pada pesanan `cancelled`/`expired` (ditolak, dibatalkan, atau lunas setelah batas waktu) tetap lunas dan muncul di `GET /admin/refunds`. Admin mengembalikan dana di luar aplikasi lalu menandai `POST /admin/refunds/:code` dengan nomor referensi; status menjadi `refunded`.
- **Pesan dari meja (F21).** Penjual menyalakan `dine_in_enabled` dan membuat meja; tiap meja punya token QR (`/meja/<token>` di web). Tamu memesan tanpa akun: pesanan tanpa `customer_id` dan titik temu, menyimpan `table_id` dan hash token tamu, maksimal 5 pesanan menunggu per meja. Bayar lewat halaman Snap (QRIS, e-wallet, VA); notifikasi `settlement` mengonfirmasi pesanan otomatis. Menu pre-order tidak dijual di meja.
- **AI gateway (F22).** Semua fitur AI lewat satu pintu (`ai.tanya`). Admin mengatur penyedia di `/admin/ai-providers`: jenis penyedia dari daftar tetap (alamat API dikunci di kode), model, prioritas, aktif. API key disimpan terenkripsi AES-256-GCM (kunci turunan `JWT_SECRET`) dan hanya `key_hint` (4 karakter terakhir) yang keluar. Penyedia dicoba urut prioritas; 429 (pakai Retry-After), key ditolak, error, atau timeout → penyedia diistirahatkan lalu yang berikutnya dicoba. `GEMINI_API_KEY` env = cadangan terakhir.
- **Promo (F12).** Promo platform berlaku di semua toko, promo toko hanya di tokonya. Diperiksa: aktif, periode, kuota (diklaim atomik), minimal belanja, batas per pembeli. Kuota kembali saat pesanan batal atau kedaluwarsa.
- **Ulasan (F13).** Satu ulasan per menu per pesanan selesai. Rating menu dan toko dihitung ulang setiap ulasan masuk atau dimoderasi.
- **Moderasi (F19).** Ulasan yang disembunyikan admin tidak tampil dan tidak dihitung. Menu yang diturunkan admin nonaktif dan tidak bisa diaktifkan penjual sampai dipulihkan.
- **Lupa sandi (F11).** OTP 6 digit lewat email, berlaku 10 menit, maksimal 5 percobaan, sekali pakai. Jawaban permintaan kode selalu sama agar keberadaan email tidak bocor.

---

## 📡 Koleksi Endpoint API (v1)

Semua rute ada di bawah `/api/v1`. Respons sukses `{ "data": ... }` (daftar ditambah `meta: { page, limit, total }`); respons galat `{ "error": { "code", "message", "fields"? } }` dengan pesan berbahasa Indonesia.

| Kelompok | Rute | Akses |
|---|---|---|
| Kesehatan | `GET /health` | publik |
| Data referensi | `GET /meta/merchant-types`, `/meta/categories`, `/meta/pickup-points`, `/meta/settings` | publik |
| Akun | `POST /auth/customer/register`, `/auth/merchant/register`, `/auth/login`, `/auth/logout` | publik / masuk |
| Lupa sandi | `POST /auth/password/forgot`, `/auth/password/verify`, `/auth/password/reset` | publik |
| Profil | `GET /me`, `PATCH /me`, `PUT /me/password`, `POST /me/avatar` | masuk |
| Katalog | `GET /menus`, `/menus/:id`, `/menus/:id/reviews`, `/merchants/:slug` | publik |
| Favorit | `GET /me/favorites`, `PUT` dan `DELETE /me/favorites/:menuId` | pembeli |
| Toko favorit | `GET /me/favorite-merchants`, `PUT` dan `DELETE /me/favorite-merchants/:merchantId` (kartu = profil `GET /merchants/:slug`) | pembeli |
| Pesanan pembeli | `POST /orders/quote`, `POST /orders`, `GET /me/orders`, `GET /orders/:code`, `GET /orders/:code/whatsapp`, `POST /orders/:code/cancel`, `/complete`, `/reviews`, `/reorder` | pembeli |
| Pembayaran Midtrans | `POST /orders/:code/va`, `POST /orders/:code/online` (kontrak: [`docs/pembayaran.md`](docs/pembayaran.md)) | pembeli |
| Meja (penjual) | `GET` dan `POST /merchant/tables`, `PATCH /merchant/tables/:id` | penjual |
| Pesan dari meja | `GET /tables/:token`, `POST /tables/:token/orders`, `GET /guest/orders/:code`, `POST /guest/orders/:code/pay` (header `X-Guest-Token`) | publik |
| Notifikasi Midtrans | `POST /payments/midtrans` (diverifikasi signature) | publik |
| Notifikasi | `GET /me/notifications`, `POST /me/notifications/read` | masuk |
| Toko | `GET` dan `PATCH /merchant/profile`, `PATCH /merchant/status` | penjual |
| Menu | `GET` dan `POST /merchant/menus`, `GET`, `PATCH`, dan `DELETE /merchant/menus/:id`, `PATCH /merchant/menus/:id/quota` | penjual |
| Pesanan toko | `GET /merchant/orders`, `/merchant/orders/:code`, `/merchant/orders/:code/whatsapp`, `POST /merchant/orders/:code/{confirm,cook,ready,complete,reject}` | penjual |
| Laporan toko | `GET /merchant/reports/summary`, `/hourly`, `/transactions` | penjual |
| Promo & ulasan toko | `GET` dan `POST /merchant/promos`, `PATCH` dan `DELETE /merchant/promos/:id`, `GET /merchant/reviews` | penjual |
| Rekening & pencairan | `GET /merchant/payouts`, `PUT /merchant/payout-account` | penjual |
| Asisten AI | `POST /merchant/assistant` | penjual |
| Rekomendasi AI | `POST /assistant/recommendations` (kontrak: [`docs/rekomendasi-ai.md`](docs/rekomendasi-ai.md)) | pembeli |
| Unggah foto | `POST /merchant/uploads` | penjual |
| Admin | `GET /admin/summary`, `/admin/verification-queue`, `/admin/merchants`, `/admin/merchants/:id`, `/admin/master/:kind` (+ `POST`, `PATCH`), `/admin/promos` (+ `POST`, `PATCH`), `/admin/settings`, `PUT /admin/settings/service-fee`, `GET /admin/audit-logs` | admin |
| AI gateway | `GET` dan `POST /admin/ai-providers`, `PATCH` dan `DELETE /admin/ai-providers/:id`, `POST /admin/ai-providers/:id/test`, `GET /admin/ai-usage?days=1..90` | admin |
| Server | `GET /admin/server-status`, `GET /admin/server-logs?level=&q=&page=&limit=` | admin |
| Pencairan & refund | `GET /admin/payouts/balances`, `GET` dan `POST /admin/payouts`, `GET /admin/refunds`, `POST /admin/refunds/:code` | admin super |
| Admin (lanjutan) | `GET /admin/reviews`, `POST /admin/reviews/:id/{hide,unhide}`, `GET /admin/menus`, `POST /admin/menus/:id/{takedown,restore}`, `GET /admin/finance`, `POST /admin/broadcasts`, `PUT /admin/settings/cs-contact` | admin |

Kontrak lengkap (bentuk setiap respons, pesan galat, batasan) ada di dokumen `docs/API.md` pada monorepo tim.

**Polling.** `GET /merchant/orders?updated_since=<ISO>` hanya mengembalikan pesanan yang berubah sejak waktu itu, dipakai dashboard web setiap 5 detik.

---

## 🔐 Variabel Lingkungan

Salin `.env.example` menjadi `.env`. Server menolak menyala bila nilai wajib kosong atau salah format.

| Variabel | Wajib | Keterangan |
|---|---|---|
| `DATABASE_URL` | ya | `mysql://user:sandi@host:port/nama_db`. Untuk TiDB Cloud, SSL aktif otomatis |
| `JWT_SECRET` | ya | Minimal 32 karakter acak |
| `CORS_ORIGIN` | ya di production | Daftar origin web, dipisah koma |
| `PORT` | tidak | Bawaan 5000 (Heroku mengisinya sendiri) |
| `NODE_ENV` | tidak | `development`, `test`, atau `production` |
| `TZ` | disarankan | `Asia/Jakarta` |
| `JWT_TTL_WEB`, `JWT_TTL_MOBILE` | tidak | Masa berlaku token, bawaan `1d` dan `30d` |
| `INTERNAL_API_SECRET` | tidak | Rahasia bersama dengan server web agar pembatas laju menghitung per alamat pengunjung |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL` | tidak | Isi kelimanya untuk mengaktifkan unggah foto (cara mengisi: bagian Deploy). Bila ada yang kosong, endpoint unggah menjawab `503` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | tidak | Isi kelimanya untuk mengirim OTP lupa sandi lewat email. Kosong: kode ditulis ke log (development), `503` di production |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | tidak | Cadangan terakhir AI gateway (penyedia utama diatur admin di dashboard); model bawaan `gemini-2.5-flash`. Tanpa penyedia sama sekali: asisten menjawab `503`. Mengganti `JWT_SECRET` membuat API key AI tersimpan harus diisi ulang |
| `MIDTRANS_SERVER_KEY` | tidak | Server key Midtrans untuk VA dan bayar online Snap (Settings → Access Keys → Server Key, bukan Client Key). Kosong: checkout VA/online menjawab `409`, hanya tunai yang jalan |
| `MIDTRANS_SIGNATURE_KEY` | tidak | Signature Secret Key Midtrans (Settings → Access Keys → General Credentials) untuk memverifikasi notifikasi pembayaran. Sejak 28 Okt 2026 notifikasi ditandatangani kunci ini, bukan Server Key; tanpa ini notifikasi ditolak `403` dan pesanan tidak pernah lunas bila Server Key sudah dibuat ulang. Kosong: pakai `MIDTRANS_SERVER_KEY` |
| `MIDTRANS_IS_PRODUCTION` | tidak | `true` untuk transaksi sungguhan. Bawaan `false` (sandbox), jadi key production yang salah pasang hanya gagal, tidak menarik uang |
| `TEST_DATABASE_URL` | untuk uji | Nama database harus berakhiran `_test`, karena isinya dihapus setiap uji |

---

## 💻 Panduan Instalasi Lokal

### Prasyarat
- Node.js ≥ 22.12
- MySQL 8.x (atau TiDB Cloud Serverless)

### Langkah Pemasangan
```bash
# 1. Clone repositori
git clone https://github.com/stanlevv/kateringkita-backend.git
cd kateringkita-backend

# 2. Pasang dependensi
npm install

# 3. Konfigurasi file environment
cp .env.example .env
# Edit file .env: isi DATABASE_URL, TEST_DATABASE_URL, dan JWT_SECRET

# 4. Jalankan migrasi database
npm run migrate

# 5. (Opsional) Jalankan data seeder demo
npm run seed:demo

# 6. Jalankan server mode development
npm run dev
# Server aktif di http://localhost:5000/api/v1/health
```

---

## 🧪 Skrip & Pengujian

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Server dengan muat ulang otomatis (`tsx watch`) |
| `npm run build` lalu `npm start` | Kompilasi ke `dist/` lalu jalankan seperti di production |
| `npm run migrate` | Menjalankan migrasi yang belum tercatat di tabel `schema_migrations` |
| `npm run migrate:prod` | Sama, dari hasil kompilasi (`dist/`) |
| `npm run admin:create` | Membuat akun admin pertama. Sandi diambil dari `ADMIN_INITIAL_PASSWORD`, isi hanya saat menjalankan |
| `npm run seed:demo` | Mengisi toko dan menu contoh. Hanya untuk database lokal; sandi dari `DEMO_PASSWORD` |
| `npm test` | Seluruh uji (butuh MySQL; memakai `TEST_DATABASE_URL`) |
| `npm run typecheck` | Pemeriksaan tipe TypeScript |

---

## ☁️ Deploy

- **Heroku** (app `ketring`) tersambung ke repo ini. Setiap push ke `main` otomatis di-build (`npm run build`) lalu fase `release` di `Procfile` menjalankan `npm run migrate:prod` sebelum `web: node dist/server.js` dinyalakan.
- **TiDB Cloud** (cluster `pbl-ketring`, database `kateringkita`) menyimpan data production. Migrasi 001–004 sudah diterapkan. TiDB tidak mendukung `FOR SHARE`, trigger, dan `ALTER` yang memakai `AFTER` ke kolom baru di pernyataan yang sama; hindari di kode dan migrasi.
- **Migrasi berjalan otomatis saat deploy** lewat fase `release`. Bila migrasi gagal, Heroku membatalkan rilis dan versi lama tetap jalan; periksa dengan `heroku releases` dan `heroku logs --ps release`.
- **Unggah foto (Cloudflare R2):** backend hanya membuat URL PUT bertanda tangan (`POST /merchant/uploads`, berlaku 300 detik);
  browser mengunggah berkas langsung ke bucket. Siapkan bucket sekali:
  1. **Kunci S3:** R2 → Manage API tokens → Create API token, izin *Object Read & Write* untuk bucket ini. Salin **Access Key ID**
     (32 karakter) ke `R2_ACCESS_KEY_ID` dan **Secret Access Key** (64 karakter heks) ke `R2_SECRET_ACCESS_KEY`.
     Nilai token `cfat_…` bukan kunci S3. `R2_ACCOUNT_ID` = ID akun Cloudflare pemilik bucket, `R2_BUCKET` = nama bucket.
  2. **Akses publik:** bucket → Settings → aktifkan Public Development URL (`https://pub-….r2.dev`) atau sambungkan domain sendiri
     (disarankan untuk production; r2.dev dibatasi lajunya). Alamat itu diisi ke `R2_PUBLIC_URL`.
  3. **CORS bucket:** bucket → Settings → CORS policy. Tanpa ini browser menolak PUT dan web menampilkan "Foto gagal diunggah".
     ```json
     [{ "AllowedOrigins": ["https://ketringkita.edufin.app", "https://ketringkita-frontend.vercel.app"],
        "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
     ```
     Tambahkan `http://localhost:3000` bila menguji dari lokal.

  Bila sebagian `R2_*` kosong, log release menulis `R2 terisi sebagian (...)` dan unggah menjawab `503`. Mengubah Config Vars
  me-restart app, tidak perlu push.
- **Midtrans:** isi `MIDTRANS_SERVER_KEY` dan `MIDTRANS_SIGNATURE_KEY` di Heroku, lalu di dashboard Midtrans (Settings → Payment → Notification URL) isi `https://ketring-45f82aef1ca0.herokuapp.com/api/v1/payments/midtrans`.

---

## 📄 Lisensi

Proyek ini dilisensikan di bawah lisensi [MIT](LICENSE).
