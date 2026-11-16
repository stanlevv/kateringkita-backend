# Voucher, Banner, dan Pop-up Promo — Rancangan

Tanggal: 16 Nov 2026 · Pemilik: stanlevv · Status: draf untuk disetujui

## 1. Maksud dan alasan

Pembeli KateringKita sekarang hanya bisa memakai promo dengan **mengetik kode** saat checkout, padahal kode itu tidak
pernah ditampilkan di aplikasi. Beranda mobile memang punya carousel, tetapi isinya 3 kartu informasi yang tertanam di
aplikasi. Pemilik ingin pengalaman seperti Shopee: pembeli **menemukan** promo (banner beranda, pop-up saat aplikasi
dibuka, daftar voucher di halaman toko), **mengklaim** voucher dengan satu ketukan, lalu memakainya di checkout tanpa
mengetik. Fitur ini ikut didemokan saat UAS, setelah butir rubrik selesai.

## 2. Keputusan pemilik (dari diskusi)

| # | Keputusan |
|---|---|
| K1 | Admin **dan** penjual boleh memasang promo. |
| K2 | **Pop-up** hanya dipasang admin, hanya di aplikasi **mobile**, satu kampanye aktif pada satu waktu. |
| K3 | **Banner carousel** beranda mobile: admin dan penjual; banner penjual tampil setelah **disetujui admin**. |
| K4 | Promo **bisa diklaim** seperti voucher Shopee → masuk "Voucher Saya" → dipilih di checkout. |
| K5 | Satu pesanan boleh memakai **dua voucher**: satu voucher **toko** + satu voucher **platform**. |
| K6 | Kuota **habis saat dipakai** (rebutan di checkout), bukan saat diklaim. |
| K7 | Voucher toko tampil di **halaman toko** dengan tombol Klaim. |
| K8 | Urutan kerja: rubrik dulu; voucher dibangun bertahap (1 inti voucher → 2 banner → 3 pop-up). |
| K9 | **Ketiga tahap wajib siap untuk demo UAS minggu depan** — tidak ada tahap yang dipangkas. |

## 3. Tujuan, bukan tujuan, anti-tujuan

**Tujuan**
- Pembeli bisa menemukan, mengklaim, dan memakai voucher tanpa mengetik kode.
- Diskon toko dan platform tercatat terpisah per pesanan sehingga **pencairan penjual dan laporan keuangan tetap benar**.
- Admin bisa mengatur isi beranda (banner) dan pop-up tanpa rilis aplikasi baru.

**Bukan tujuan (versi ini)**
- Push notification promo (butuh FCM, butir rubrik 6 terpisah).
- Banner berbayar / lelang slot, penargetan per pengguna, statistik klik banner.
- Voucher untuk pesanan dari meja (web tamu tanpa akun) — tetap tanpa promo seperti sekarang.
- Voucher ongkir (KateringKita tidak mengantar; titik temu).

**Anti-tujuan (gagal walau "jalan")**
- Diskon melebihi yang seharusnya (dua voucher menumpuk salah, total minus, kuota bocor).
- Bagian penjual di pencairan ikut terpotong voucher platform.
- Pop-up muncul setiap kali aplikasi dibuka sampai pembeli terbiasa menutupnya.
- Gambar asal-asalan / promo palsu penjual muncul di beranda tanpa ditinjau.

## 4. Pendekatan

| Pendekatan | Untung | Rugi | Keputusan |
|---|---|---|---|
| **A. Perluas sistem `promos` yang ada** (kolom `is_public`, tabel klaim, banner, pop-up; checkout menerima 2 kode) | Kuota, batas per pembeli, pengembalian kuota saat batal, validasi tanggal sudah ada & teruji; pencairan sudah membedakan promo toko/platform | Kolom diskon pesanan harus dipecah dua (migrasi + ubah pencairan & keuangan) | **Dipilih** |
| B. Sistem voucher terpisah dari promo | Bebas desain ulang | Duplikasi logika kuota/diskon, rawan selisih hitung dengan promo lama | Dibuang |
| C. Pop-up lewat Firebase In-App Messaging | Cepat untuk pop-up | Tidak diatur dari panel admin web (melanggar K2) | Dibuang |

## 5. Rancangan

### 5.1 Data (migrasi `014_voucher.sql`, tahap 1)

- `promos.is_public BOOLEAN NOT NULL DEFAULT TRUE` — tampil di halaman toko / bisa diklaim. Penjual bisa mematikan
  (kode tetap bisa diketik, mis. dibagikan lewat WhatsApp). Promo platform: diatur admin (bawaan TRUE).
- `promo_claims (id, promo_id FK, user_id FK, claimed_at, UNIQUE(promo_id, user_id))` — dompet "Voucher Saya".
  Klaim **tidak** mengurangi kuota (K6).
- `orders`: tambah `merchant_promo_id NULL FK promos`, `merchant_discount INT NOT NULL DEFAULT 0`,
  `platform_promo_id NULL FK promos`, `platform_discount INT NOT NULL DEFAULT 0`.
  `discount` = jumlah keduanya (dipertahankan untuk kompatibilitas). Backfill dari `promo_id` lama menurut
  `promos.merchant_id`. `promo_id` lama tidak dipakai lagi untuk pesanan baru (diisi NULL) setelah semua pembaca pindah.
- `promo_redemptions` tetap satu baris per promo per pesanan (bisa 2 baris per pesanan).

### 5.2 Aturan diskon checkout (tahap 1)

1. Body checkout/quote menerima `promo_codes: string[]` (maks 2). `promo_code` lama tetap diterima (= daftar 1 kode).
2. Tiap kode diselesaikan ke promo: milik **toko pesanan ini** → slot toko; `merchant_id IS NULL` → slot platform.
   Dua kode di slot yang sama, atau promo toko lain → `422 PROMO_INVALID` dengan `fields.promo_codes`.
3. Validasi per promo sama dengan sekarang (aktif, periode, kuota, minimal belanja, batas per pembeli).
   **Minimal belanja dibandingkan dengan `subtotal`** (sebelum diskon) untuk kedua voucher (sama seperti Shopee).
4. Urutan hitung: voucher toko dari `subtotal` (percent dengan `max_discount` / fixed ≤ subtotal); lalu voucher
   platform dari `subtotal − merchant_discount` (percent/fixed) atau `service_fee` (free_service_fee).
   `total = subtotal + service_fee − merchant_discount − platform_discount`, tidak pernah < 0.
5. Kuota diklaim atomik per promo di `buatPesanan` (pola sekarang), urutan kunci promo id naik agar tanpa deadlock.
   Batal/kedaluwarsa mengembalikan kuota **kedua** promo dan menghapus baris redemption-nya.
6. Pencairan: `BAGIAN = subtotal − merchant_discount`. Keuangan admin: diskon toko = Σ merchant_discount,
   diskon platform = Σ platform_discount.

### 5.3 API (tahap 1)

| Endpoint | Siapa | Isi |
|---|---|---|
| `GET /merchants/:slug` (diperluas) | publik | + `vouchers[]`: promo toko `is_public`, aktif, dalam periode: `{id, code, description, type, value, max_discount, min_subtotal, ends_at, sold_out, claimed}` (`claimed` hanya bila login) |
| `GET /vouchers/platform` | publik | voucher platform publik yang aktif (untuk banner/pop-up & halaman "Voucher") |
| `POST /me/vouchers/:promoId/claim` | pembeli | idempoten; 409 bila tidak aktif/di luar periode/kuota habis/tidak publik |
| `GET /me/vouchers?merchant_id=&subtotal=` | pembeli | voucher yang diklaim (+ belum kedaluwarsa), tiap item `{…, slot: "toko"\|"platform", usable, reason}`; tanpa filter = semua untuk layar Voucher Saya |
| `POST /orders/quote`, `POST /orders` | pembeli | `promo_codes[]`; respons + `merchant_discount`, `platform_discount`, `vouchers_applied[]` |
| `PATCH /merchant/promos/:id` | penjual | + `is_public` |

### 5.4 Banner (tahap 2, migrasi `015_banner.sql`)

- `banners (id, merchant_id NULL=admin, title, image_url, target ENUM('promo','merchant','none'), promo_id NULL,
  status ENUM('menunggu','disetujui','ditolak','nonaktif'), catatan, starts_at, ends_at, sort_order, created_by,
  reviewed_by, reviewed_at, created_at)`.
- Penjual: `POST/GET/PATCH/DELETE /merchant/banners` (target hanya tokonya / promo tokonya), status awal `menunggu`;
  diubah setelah disetujui → kembali `menunggu`. Admin: `GET /admin/banners`, `POST /admin/banners` (langsung
  `disetujui`), `PATCH /admin/banners/:id` (setujui / tolak + alasan / nonaktifkan / urutan), diaudit.
- Publik: `GET /banners` → maks 8 banner `disetujui` dalam periode: admin dulu (sort_order), lalu penjual (terbaru disetujui).
- Gambar lewat unggah R2 yang ada (rasio 2:1, maks 1 MB, jpg/png/webp).

### 5.5 Pop-up (tahap 3, migrasi `016_popup.sql`)

- `popups (id, title, image_url, promo_id NULL, starts_at, ends_at, is_active, created_by, created_at)`; admin saja
  (`/admin/popups` CRUD, diaudit). Publik: `GET /popup` → satu pop-up aktif dalam periode (terbaru), atau `null`.
- Mobile: tampil setelah beranda termuat, **sekali per hari per pop-up** (disimpan lokal), tidak tampil lagi bila
  voucher-nya sudah diklaim. Tombol "Klaim" (bila ada promo) / "Lihat" / tutup (X).

### 5.6 Layar

**Mobile (pembeli)**
- Halaman toko: baris kartu voucher toko + tombol Klaim / "Diklaim" / "Habis".
- Profil → **Voucher Saya**: tab Bisa dipakai / Kedaluwarsa.
- Checkout: bagian "Voucher" dengan pemilih **Voucher toko** dan **Voucher platform** (yang tidak memenuhi syarat
  tampil abu-abu + alasan); "Pakai kode" manual tetap ada.
- Beranda: carousel dari `GET /banners` (bila kosong → 3 kartu informasi lama); pop-up (tahap 3).

**Web penjual**: Promo → sakelar "Tampilkan di halaman toko"; menu **Banner** (ajukan, lihat status/alasan).
**Web admin**: Promo platform + `is_public`; **Banner** (tinjau, buat, urutkan); **Pop-up** (tahap 3).

### 5.7 Keputusan tambahan dari pengecekan pembangun (keputusan Claude, silakan dikoreksi)

- **C1. Voucher platform hanya untuk pembayaran non-tunai (VA/online).** Pesanan tunai dibayar langsung ke penjual dan
  tidak ikut pencairan, jadi voucher platform di pesanan tunai berarti penjual yang menanggung diskon platform.
  Checkout tunai dengan voucher platform → `422 PROMO_INVALID` ("Voucher platform hanya untuk bayar non-tunai.").
  Aplikasi mobile memang hanya menawarkan VA dan bayar online, jadi pembeli tidak merasakan batasan ini;
  `GET /me/vouchers` tetap menandai alasannya bila nanti tunai dibuka lagi.
- **C2. Voucher toko tidak lagi boleh berjenis "gratis biaya layanan"** (biaya layanan milik platform). Form promo
  penjual hanya persen/potongan tetap. Promo toko jenis itu yang sudah ada tetap berlaku sampai berakhir (ditanggung
  penjual seperti sekarang), tetapi tidak bisa digabung dengan voucher platform yang juga menggratiskan biaya layanan
  (`422`, "Biaya layanan sudah digratiskan voucher lain.").
- **C3. Klaim voucher platform di tahap 1:** layar Voucher Saya punya bagian atas **"Voucher KateringKita"** berisi
  voucher platform publik yang bisa diklaim; pemilih voucher platform di checkout juga menampilkan voucher platform
  yang belum diklaim dengan tombol "Klaim & pakai". Banner/pop-up (tahap 2–3) menjadi pintu tambahan.

## 6. Batasan
- Mobile tidak bisa di-push ke repo (butuh akses rohanrifqii); demo lewat build web WiFi.
- Semua uang INT Rupiah; TiDB production (MySQL 8 kompatibel).
- Endpoint lama (`promo_code`) harus tetap jalan sampai mobile ter-update.

## 7. Diserahkan ke pembangun
- Nama kolom/endpoint persis, pesan galat, tata letak kartu voucher.
- Cara backfill & kapan `promo_id` lama berhenti ditulis (selama semua pembaca sudah pindah).
- Ukuran/kompresi gambar banner, jumlah maks banner aktif per toko (usul: 1).
