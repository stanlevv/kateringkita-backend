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

| Modul | Cakupan Fitur | Status |
|:---:|---|:---:|
| **F00** | Fondasi arsitektur: validasi `.env` Zod, koneksi pool MySQL/TiDB SSL, migrasi DB, CORS, error handler terstandar | ✅ Selesai |
| **F01** | Otentikasi: daftar, login, logout, sesi DB + JWT token | ✅ Selesai |
| **F02** | Pengguna: profil pengguna, ganti kata sandi, unggah avatar | ✅ Selesai |
| **F03** | Manajemen Toko: profil merchant, buka/tutup toko, jam buka/tutup, titik ambil (*pickup points*), templat WhatsApp | ✅ Selesai |
| **F04** | Menu & Kuota Atomik: katalog menu, kuota harian (`daily_quota`), mutasi delta kuota atomik anti *lost-update* | ✅ Selesai |
| **F05** | Katalog Publik: pencarian menu dan toko untuk pembeli, favorit menu | ✅ Selesai |
| **F06** | Checkout & Holding: perhitungan harga server-side, idempotensi transaksi, penguncian stok/kuota 5 menit | ✅ Selesai |
| **F07** | Siklus Pesanan: transisi status `holding` ➔ `confirmed` ➔ `cooking` ➔ `ready` ➔ `completed` / `cancelled` | ✅ Selesai |
| **F08** | Worker Kedaluwarsa: cron background pelepas porsi pesanan kadaluwarsa & notifikasi otomatis | ✅ Selesai |
| **F09** | Laporan Penjualan: ringkasan penjualan, analitik per jam, rincian transaksi, ekspor CSV | ✅ Selesai |
| **F18** | Administrasi: antrean verifikasi toko, data master kategori/titik ambil, promo platform, audit logs | ✅ Selesai |
| **F10–F14** | Pembayaran QRIS/VA, OTP, Promo Merchant, Rating & Ulasan | ⏳ Roadmap |

> 🧪 **Uji Otomatis:** **51 berkas, 489 automated tests** lulus 100% pada database MySQL/TiDB lokal.

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
├── server.ts             # Entry point: start HTTP listener & background holding cleanup worker
├── app.ts                # Express app bootstrap, middleware, global error handler
├── config/
│   ├── env.ts            # Validasi ketat environment variable via Zod
│   └── db.ts             # MySQL2 connection pool dengan konfigurasi SSL TiDB
├── http/                 # Format error API terstandarisasi & helper validasi Zod
├── auth/                 # Autentikasi, registrasi, sesi, rate-limiter
├── meta/                 # Data master publik: kategori, titik jemput, pengaturan
├── katalog/              # Endpoint pencarian menu/merchant publik & favorit
├── pesanan/              # Mesin status pesanan, checkout holding, auto-expire job
├── merchant/             # Pengelolaan toko, katalog menu, kuota atomik, pesanan toko
│   └── laporan/          # Sub-modul F09: agregasi laporan, ringkasan, per-jam, riwayat
├── notifikasi/           # Pengiriman dan pembacaan notifikasi in-app
├── admin/                # Moderasi merchant, verifikasi, audit trail, promo platform
├── upload/               # Cloudflare R2 presigned URL signer
└── db/
    ├── migrate.ts        # Runner migrasi SQL otomatis
    └── seed-demo.ts      # Seeder data merchant & katalog contoh
migrations/               # Skrip migrasi terurut (001_init.sql, 002_admin.sql, ...)
test/                     # Rangkaian test suite Vitest per domain/fitur
```

---

## ⚡ Aturan Bisnis & Mekanisme Kunci

1. **Kuota Harian Atomik (AUD-04 / F04):**
   Setiap menu memiliki `daily_quota`, `sold_today`, dan `held_today`. Endpoint `PATCH /api/v1/merchant/menus/:id/quota` mendukung payload:
   - `{ "delta": 1 }` atau `{ "delta": -1 }`: Menambah/mengurangi kuota secara atomik di database (`daily_quota = daily_quota + ?`). Mencegah kondisi balapan (*race condition*) ketika beberapa admin toko mengklik tombol stepper bersamaan.
   - `{ "quota_today": 25 }`: Mengatur kuota harian mutlak dengan validasi `quota_today >= sold_today + held_today`.
2. **Penahanan Porsi 5 Menit (*Stock Holding*):**
   Checkout langsung mengunci porsi menu (`held_today += qty`). Merchant memiliki batas waktu sesuai `hold_minutes` untuk konfirmasi. Jika waktu habis, worker server otomatis membatalkan pesanan dan mengembalikan porsi tertahan.
3. **Idempotensi Checkout:**
   Header `Idempotency-Key` menjamin request ganda (misal koneksi terputus lalu submit ulang) tidak menduplikasi pesanan pembeli.
4. **Keamanan Harga & Kode Pesanan:**
   Harga pesanan dihitung 100% oleh server. Kode pesanan unik di-generate dengan format `KK-YYYYMMDD-XXXX`. Data HPP (*Harga Pokok Penjualan*) dilindungi dan tidak pernah bocor ke katalog pembeli.

---

## 📡 Koleksi Endpoint API (v1)

Semua rute diawali dengan awalan `/api/v1`. Format respons standar:
- **Sukses:** `{ "data": ... }` (ditambah `meta: { "page", "limit", "total" }` untuk list).
- **Galat:** `{ "error": { "code": "...", "message": "...", "fields": [...] } }`.

| Domain | Metode & Endpoint | Akses | Deskripsi |
|---|---|---|---|
| **System** | `GET /health` | Publik | Cek status server & koneksi database |
| **Meta** | `GET /meta/merchant-types`, `/meta/categories`, `/meta/pickup-points`, `/meta/settings` | Publik | Data referensi platform |
| **Auth** | `POST /auth/customer/register`<br>`POST /auth/merchant/register`<br>`POST /auth/login`<br>`POST /auth/logout` | Publik / Sesi | Registrasi dan otentikasi akun |
| **Profile** | `GET /me`, `PATCH /me`<br>`PUT /me/password`, `POST /me/avatar` | Autentikasi | Manajemen profil pengguna |
| **Katalog** | `GET /menus`, `/menus/:id`<br>`GET /merchants/:slug` | Publik | Pencarian menu, detail merchant & ulasan |
| **Pesanan** | `POST /orders/quote`<br>`POST /orders`<br>`GET /me/orders`, `GET /orders/:code` | Pembeli | Simulasi biaya, checkout ber-holding, status pesanan |
| **Merchant** | `GET /merchant/profile`, `PATCH /merchant/profile`<br>`PATCH /merchant/status` | Merchant | Pengaturan profil dan status buka/tutup toko |
| **Menu & Kuota** | `GET /merchant/menus`, `POST /merchant/menus`<br>`PATCH /merchant/menus/:id/quota` | Merchant | Manajemen menu & pembaruan kuota atomik |
| **Toko Pesanan** | `GET /merchant/orders`<br>`POST /merchant/orders/:code/{confirm,cook,ready,complete,reject}` | Merchant | Pemrosesan antrean pesanan toko secara langsung |
| **Laporan (F09)** | `GET /merchant/reports/summary`<br>`GET /merchant/reports/hourly`<br>`GET /merchant/reports/transactions`<br>`GET /merchant/reports/csv` | Merchant | Analitik penjualan, tren per jam, dan ekspor CSV |
| **Admin** | `GET /admin/summary`, `/admin/verification-queue`<br>`PATCH /admin/merchants/:id/verify`<br>`GET /admin/audit-logs` | Admin | Verifikasi mitra katering & pemantauan platform |

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

| Perintah | Deskripsi |
|---|---|
| `npm run dev` | Menjalankan API server dengan hot-reload (`tsx watch`) |
| `npm run build` | Melakukan kompilasi TypeScript ke `dist/` |
| `npm start` | Menjalankan hasil kompilasi production dari `dist/server.js` |
| `npm test` | Menjalankan seluruh test suite Vitest (489 tests) |
| `npm run typecheck` | Menjalankan type-checking TypeScript tanpa emit file |
| `npm run migrate` | Menjalankan migrasi SQL dari folder `migrations/` |
| `npm run admin:create` | Perintah interaktif untuk membuat user admin pertama |

---

## 📄 Lisensi

Proyek ini dilisensikan di bawah lisensi [MIT](LICENSE).
