# Panduan Kontribusi

## Konvensi nama

Kode memakai nama bahasa Inggris; teks untuk manusia tetap bahasa Indonesia.

| Objek                    | Aturan                                                  | Contoh                                                     |
| ------------------------ | ------------------------------------------------------- | ---------------------------------------------------------- |
| File layanan/handler/DTO | `<feature>[-part].{service,handler,dto}.ts`, kebab-case | `admin-keuangan.service.ts`, `auth.handler.ts`             |
| File lain                | kebab-case                                              | `rateLimiter.ts` menjadi `rate-limiter.ts`                 |
| Fungsi dan variabel      | camelCase                                               | `loadEnv`; `bacaSesi` menjadi `getSession`                 |
| Tipe dan interface       | PascalCase                                              | `Env`; `PengumumanInput` menjadi `AnnouncementInput`       |
| Konstanta                | `UPPER_SNAKE`                                           | `WA_PLACEHOLDERS`; `BANK_PENCAIRAN` menjadi `PAYOUT_BANKS` |

### Yang tidak boleh diganti namanya

Dipakai aplikasi mobile, Midtrans, database, atau pengguna:

- **Kontrak HTTP:** path API, nama field JSON di request dan response (contoh `{ aktif, pesan }`), kode error (`MAINTENANCE`, `MERCHANT_CLOSED`, dan lainnya), nama header.
- **Database:** nama tabel dan kolom, isi file migrasi SQL.
- **Konfigurasi dan URL:** nama env var. Nama folder route di `fe/app` (itu URL, contoh `/pesanan`, `/pengaturan`) serta nama file khusus Next (`page.tsx`, `layout.tsx`, `loading.tsx`, `route.ts`, `proxy.ts`).
- **Ekspor khusus Next:** `default`, `GET`/`POST`/dan sejenisnya, `metadata`, `generateMetadata`, `config`, `dynamic`, `revalidate`.
- **Teks untuk manusia:** teks UI, pesan error ke pengguna, deskripsi `it(...)`/`describe(...)`, komentar. Semuanya tetap bahasa Indonesia, karena aturan proyek DS-09 mewajibkan teks Indonesia dan komentar Indonesia lazim untuk tim lokal.
- **Nama properti objek dan tipe** (`interface X { aktif: boolean }`). Nama properti tidak diganti, karena hampir semuanya mencerminkan JSON atau kolom DB. Aturan sederhana ini mencegah kontrak rusak tanpa ketahuan.

## Glosarium

Wajib dipakai saat memberi nama baru. Mengikuti nama tabel DB dan peran PRD.

| Indonesia      | Inggris          | Indonesia           | Inggris           |
| -------------- | ---------------- | ------------------- | ----------------- |
| pesanan        | order            | ambil / baca        | get               |
| toko, penjual  | merchant         | daftar (benda/aksi) | list              |
| pembeli        | customer         | buat                | create            |
| menu           | menu             | ubah                | update            |
| kuota, stok    | quota, stock     | hapus               | delete            |
| ulasan         | review           | simpan              | save              |
| laporan        | report           | tandai              | mark              |
| unggah         | upload           | bayar               | pay               |
| pencairan      | payout           | kunci               | lock              |
| rekening       | bankAccount      | segarkan            | refresh           |
| meja           | table            | setujui / tolak     | approve / reject  |
| titik temu     | pickupPoint      | aktif / nonaktif    | active / inactive |
| keranjang      | cart             | buka / tutup        | open / close      |
| kadaluarsa     | expired / expiry | kirim               | send              |
| favorit        | favorite         | cari                | search            |
| tiket, keluhan | ticket           | hitung              | calculate / count |
| notifikasi     | notification     | pulihkan            | restore           |
| pemeliharaan   | maintenance      | sandi               | password          |
| pengumuman     | announcement     | akun                | account           |
| moderasi       | moderation       | pengaturan          | settings          |
| keuangan       | finance          | ringkasan           | summary           |
| asisten        | assistant        | galat               | error             |
| rekomendasi    | recommendation   | halaman             | page              |
| hasil AI       | aiResult         | biaya layanan       | serviceFee        |

Istilah yang belum ada di tabel: pilih padanan Inggris yang umum, lalu tambahkan ke tabel ini pada commit yang sama.

<!-- Bagian alur kerja, commit, dan PR ditambahkan di F28 Task 17. -->
