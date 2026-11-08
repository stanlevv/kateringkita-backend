# KateringKita — Backend REST API

REST API untuk **KateringKita**, marketplace katering di sekitar kampus. Satu API melayani tiga pemakai:

- **Dashboard web penjual dan admin** ([kateringkita-frontend](https://github.com/stanlevv/kateringkita-frontend))
- **Aplikasi mobile pembeli** (Flutter, dibuat tim lain)
- **Job internal** yang menjalankan pembatalan otomatis pesanan yang tidak dikonfirmasi

| | Alamat |
|---|---|
| API production | https://ketring-45f82aef1ca0.herokuapp.com/api/v1 |
| Cek kesehatan | https://ketring-45f82aef1ca0.herokuapp.com/api/v1/health → `{"data":{"status":"ok","db":"ok"}}` |
| Web penjual | https://ketringkita.edufin.app |

---

## Status per November 2026

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
| F09 | Laporan penjualan | Sedang dikerjakan |
| F10–F14 | Pembayaran QRIS/VA, lupa sandi OTP, promo toko, ulasan, pesan lagi | Belum |
| F17, F19, F20 | Asisten AI dan HPP, moderasi admin, keuangan admin | Belum |

Uji otomatis: **51 berkas, 472 test**, semuanya lulus di database MySQL lokal.

---

## Teknologi

| Bagian | Pilihan |
|---|---|
| Bahasa | TypeScript 5.8, dikompilasi ke JavaScript (`tsc`) |
| Runtime | Node.js ≥ 22.12 (Heroku memakai Node 24) |
| Framework | Express 5.2 |
| Database | MySQL lewat `mysql2`; production di **TiDB Cloud** (kompatibel MySQL, SSL otomatis) |
| Validasi | Zod 4 |
| Keamanan | `jsonwebtoken` (JWT), `bcryptjs` (hash sandi), pembatas laju buatan sendiri |
| Penyimpanan foto | Cloudflare R2 lewat URL unggah bertanda tangan (AWS Signature V4, tanpa SDK) |
| Uji | Vitest 5 + Supertest, terhadap database MySQL sungguhan |

Tidak ada ORM. Semua kueri SQL ditulis langsung dengan parameter (`?`).

---

## Struktur folder

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
├── utils/             errors.ts (AppError), r2.ts (penanda tangan URL Cloudflare R2)
└── scripts/           migrate.ts, seed-demo.ts, create-admin.ts (dijalankan lewat npm run)
database/
└── migrations/        001_init.sql, 002_admin.sql, 003_checkout.sql
test/                  Uji integrasi per fitur (satu DB uji, berjalan berurutan)
```

Alur satu request: `routes/` → `handlers/` → `services/` → database. Nama fitur yang dipakai: `auth`, `admin`, `merchant`, `katalog`, `pesanan`, `notifikasi`, `meta`, dan `upload`. Fitur yang logikanya besar dipecah per bagian, misalnya `pesanan-status.service.ts` untuk mesin status pesanan dan `merchant-menu.service.ts` untuk menu toko.

---

## Aturan bisnis penting

- **Kuota porsi harian.** Setiap menu punya `daily_quota`. Penghitung `sold_today` dan `held_today` direset otomatis saat tanggal WIB berganti, saat menu pertama kali dibaca hari itu.
- **Penahanan 5 menit.** Checkout langsung mengunci porsi (`held_today`). Penjual punya waktu menurut `hold_minutes` toko (bawaan 5 menit) untuk mengonfirmasi. Dua checkout bersamaan untuk sisa 1 porsi hanya menghasilkan satu pesanan.
- **Status pesanan:** `holding → confirmed → cooking → ready → completed`, dengan cabang `cancelled` dan `expired`. Transisi yang tidak sah dijawab `409`. Setiap perubahan dicatat di `order_status_logs`.
- **Kedaluwarsa otomatis.** Job di dalam proses server memeriksa pesanan `holding` yang lewat batas waktu. Pesanan itu menjadi `expired`, porsinya kembali, dan pembeli mendapat notifikasi.
- **Harga dan kode pesanan dihitung server.** Nilai total dari aplikasi diabaikan. Kode pesanan berbentuk `KK-YYYYMMDD-XXXX`.
- **HPP tidak pernah keluar ke publik.** Katalog pembeli memakai pemetaan sendiri tanpa `hpp`.
- **Toko harus diverifikasi admin** sebelum tampil di katalog dan bisa menerima pesanan.
- **Idempotensi checkout.** Header `Idempotency-Key` yang sama menghasilkan pesanan yang sama, bukan pesanan ganda.

---

## Endpoint

Semua rute ada di bawah `/api/v1`. Respons sukses `{ "data": ... }` (daftar ditambah `meta: { page, limit, total }`); respons galat `{ "error": { "code", "message", "fields"? } }` dengan pesan berbahasa Indonesia.

| Kelompok | Rute | Akses |
|---|---|---|
| Kesehatan | `GET /health` | publik |
| Data referensi | `GET /meta/merchant-types`, `/meta/categories`, `/meta/pickup-points`, `/meta/settings` | publik |
| Akun | `POST /auth/customer/register`, `/auth/merchant/register`, `/auth/login`, `/auth/logout` | publik / masuk |
| Profil | `GET /me`, `PATCH /me`, `PUT /me/password`, `POST /me/avatar` | masuk |
| Katalog | `GET /menus`, `/menus/:id`, `/menus/:id/reviews`, `/merchants/:slug` | publik |
| Favorit | `GET /me/favorites`, `PUT` dan `DELETE /me/favorites/:menuId` | pembeli |
| Pesanan pembeli | `POST /orders/quote`, `POST /orders`, `GET /me/orders`, `GET /orders/:code`, `GET /orders/:code/whatsapp`, `POST /orders/:code/cancel`, `/complete` | pembeli |
| Notifikasi | `GET /me/notifications`, `POST /me/notifications/read` | masuk |
| Toko | `GET` dan `PATCH /merchant/profile`, `PATCH /merchant/status` | penjual |
| Menu | `GET` dan `POST /merchant/menus`, `GET`, `PATCH`, dan `DELETE /merchant/menus/:id`, `PATCH /merchant/menus/:id/quota` | penjual |
| Pesanan toko | `GET /merchant/orders`, `/merchant/orders/:code`, `/merchant/orders/:code/whatsapp`, `POST /merchant/orders/:code/{confirm,cook,ready,complete,reject}` | penjual |
| Unggah foto | `POST /merchant/uploads` | penjual |
| Admin | `GET /admin/summary`, `/admin/verification-queue`, `/admin/merchants`, `/admin/merchants/:id`, `/admin/master/:kind` (+ `POST`, `PATCH`), `/admin/promos` (+ `POST`, `PATCH`), `/admin/settings`, `PUT /admin/settings/service-fee`, `GET /admin/audit-logs` | admin |

Kontrak lengkap (bentuk setiap respons, pesan galat, batasan) ada di dokumen `docs/API.md` pada monorepo tim.

**Polling.** `GET /merchant/orders?updated_since=<ISO>` hanya mengembalikan pesanan yang berubah sejak waktu itu, dipakai dashboard web setiap 5 detik.

---

## Variabel lingkungan

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
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL` | tidak | Isi kelimanya untuk mengaktifkan unggah foto. Kosong semua berarti endpoint unggah menjawab `503` |
| `TEST_DATABASE_URL` | untuk uji | Nama database harus berakhiran `_test`, karena isinya dihapus setiap uji |

---

## Menjalankan di komputer sendiri

Prasyarat: Node.js ≥ 22.12 dan MySQL 8 (lokal atau Docker).

```bash
git clone https://github.com/stanlevv/kateringkita-backend.git
cd kateringkita-backend
npm install
cp .env.example .env        # lalu isi DATABASE_URL dan JWT_SECRET
npm run migrate             # membuat semua tabel dan data referensi
npm run dev                 # http://localhost:5000/api/v1/health
```

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

## Deploy

- **Heroku** (app `ketring`) tersambung ke repo ini. Setiap push ke `main` otomatis di-build (`npm run build`) lalu dijalankan dengan `web: node dist/server.js` dari `Procfile`.
- **TiDB Cloud** (cluster `pbl-ketring`, database `kateringkita`) menyimpan data production. Migrasi 001–003 sudah diterapkan.
- **Migrasi baru tidak berjalan otomatis.** Setelah menambah berkas di `database/migrations/`, jalankan `npm run migrate` sekali terhadap database production sebelum atau segera setelah deploy.
- **Unggah foto** belum aktif di production karena variabel R2 belum diisi.

---

## Lisensi

[MIT](LICENSE)
