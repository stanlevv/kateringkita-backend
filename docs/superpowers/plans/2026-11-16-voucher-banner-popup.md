# Voucher, Banner, Pop-up Promo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pembeli menemukan voucher (halaman toko, Voucher Saya, banner beranda, pop-up), mengklaimnya, dan memakai satu voucher toko + satu voucher platform di checkout; admin & penjual mengelola banner (dengan persetujuan admin) dan admin mengelola pop-up.

**Architecture:** Memperluas sistem `promos` yang ada (kuota, batas per pembeli, pengembalian kuota saat batal tetap dipakai). Pesanan mencatat potongan toko & platform terpisah (`merchant_discount`, `platform_discount`) agar pencairan & keuangan benar. Banner & pop-up adalah tabel konten baru dengan endpoint publik yang dibaca aplikasi mobile.

**Tech Stack:** Backend Express 5 + TypeScript + mysql2 + zod, vitest + supertest (MySQL lokal 3307). Web Next.js (App Router, server actions) + vitest/RTL. Mobile Flutter + provider + http, flutter_test.

**Spec:** `docs/superpowers/specs/2026-11-16-voucher-banner-popup-design.md` (K1–K9, C1–C3)

**Repo & path:**
- BE = `be-snap` worktree (`stanlevv/kateringkita-backend`), branch `feat/voucher` dari `origin/main` 228c0fa
- WEB = `fe-meja` worktree (`stanlevv/kateringkita-frontend`), branch baru dari `origin/main` da84bb4
- MO = `C:/PROJECT/kk-wt-fitur2` (branch `feat/tiket-bantuan`, commit lokal; push mobile butuh akses rohanrifqii)

## Global Constraints

- Uang selalu INT Rupiah; `total = subtotal + service_fee − merchant_discount − platform_discount`, tidak pernah < 0.
- Maks **2** voucher per pesanan: maks 1 slot **toko** (promo `merchant_id` = toko pesanan) + maks 1 slot **platform** (`merchant_id IS NULL`).
- Minimal belanja kedua voucher dibandingkan dengan `subtotal` sebelum diskon.
- Kuota berkurang **saat pesanan dibuat** (bukan saat klaim); batal/kedaluwarsa mengembalikan kuota kedua voucher.
- **C1** voucher platform ditolak untuk `payment_method = "cod"`: `422 PROMO_INVALID` "Voucher platform hanya untuk bayar non-tunai."
- **C2** promo toko baru tidak boleh `free_service_fee`; dua `free_service_fee` dalam satu pesanan → `422` "Biaya layanan sudah digratiskan voucher lain."
- **C3** voucher platform bisa diklaim dari Voucher Saya ("Voucher KateringKita") dan dari pemilih voucher di checkout ("Klaim & pakai").
- Pop-up: hanya admin, hanya mobile, tampil **sekali per hari per pop-up**, tidak tampil bila voucher-nya sudah diklaim.
- Banner penjual tampil setelah `disetujui` admin; maks **1** banner penjual aktif (`menunggu`/`disetujui`) per toko; publik maks **8** banner.
- Klien lama yang mengirim `promo_code` (string) tetap berfungsi; galat promo dikirim di `fields.promo_codes` **dan** `fields.promo_code`.
- Commit atas nama `stanlevv <256969117+stanlevv@users.noreply.github.com>`, tanpa trailer Co-Authored-By.
- Teks UI Bahasa Indonesia.

## Review Focus

1. Voucher toko potongan tetap ≥ subtotal + voucher platform persen → potongan platform 0, `total = service_fee`, tidak minus (Task 2).
2. Kuota voucher platform habis saat checkout dua voucher → seluruh pesanan ditolak dan `used_count` voucher toko **tidak** bertambah (rollback) (Task 2).
3. Pesanan dua voucher dibatalkan → kuota & baris `promo_redemptions` kedua voucher kembali, pembeli bisa memakai lagi bila batas per pembeli 1 (Task 2).
4. Klien lama hanya mengirim `promo_code` → diskon & galat sama seperti sebelumnya (Task 2).
5. Banner/pop-up yang menunjuk promo yang sudah nonaktif/kedaluwarsa, atau toko yang disuspend, tidak tampil di endpoint publik (Task 10, 14).

---

## TAHAP 1 — Inti voucher

### Task 1: Migrasi voucher + backfill potongan pesanan (BE)

**Files:**
- Create: `database/migrations/014_voucher.sql`
- Modify: `test/migrate.test.ts` (jumlah tabel 32 → 33, komentar "014 promo_claims")
- Test: `test/voucher-migrasi.test.ts`

**Interfaces:**
- Produces: `promos.is_public BOOLEAN NOT NULL DEFAULT TRUE`; tabel `promo_claims(id BIGINT PK, promo_id INT FK promos ON DELETE CASCADE, user_id INT FK users ON DELETE CASCADE, claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(promo_id,user_id), INDEX(user_id))`; `orders.merchant_promo_id INT NULL FK`, `orders.merchant_discount INT NOT NULL DEFAULT 0`, `orders.platform_promo_id INT NULL FK`, `orders.platform_discount INT NOT NULL DEFAULT 0`.

- [ ] **Step 1: Tes gagal** `test/voucher-migrasi.test.ts`: sisipkan (lewat SQL setelah `migrate` hanya sampai 013 tidak praktis) → cukup uji backfill dengan fungsi SQL yang sama: buat pesanan berpromo toko & berpromo platform lewat `pesanDulu`-gaya checkout, `UPDATE orders SET merchant_promo_id=NULL, merchant_discount=0, platform_promo_id=NULL, platform_discount=0`, jalankan ulang isi bagian backfill (`database/migrations/014_voucher.sql` bagian `-- backfill` diekspor sebagai string dari berkas), lalu `expect(row).toMatchObject({ merchant_promo_id: <id toko>, merchant_discount: <discount> })` dan sebaliknya untuk platform.
- [ ] **Step 2:** Jalankan `TEST_DATABASE_URL=mysql://root:root@127.0.0.1:3307/kateringkita_test npx vitest run test/voucher-migrasi.test.ts test/migrate.test.ts` → GAGAL (kolom belum ada / 32≠33).
- [ ] **Step 3:** Tulis migrasi: `ALTER TABLE promos ADD COLUMN is_public …`; `CREATE TABLE promo_claims …`; `ALTER TABLE orders ADD …` 4 kolom + FK; backfill:
  `UPDATE orders o JOIN promos p ON p.id = o.promo_id SET o.merchant_promo_id = IF(p.merchant_id IS NULL, NULL, p.id), o.merchant_discount = IF(p.merchant_id IS NULL, 0, o.discount), o.platform_promo_id = IF(p.merchant_id IS NULL, p.id, NULL), o.platform_discount = IF(p.merchant_id IS NULL, o.discount, 0);`
- [ ] **Step 4:** Tes lulus.
- [ ] **Step 5:** Commit `feat(voucher): migrasi 014 is_public, promo_claims, potongan toko/platform per pesanan`.

### Task 2: Dua voucher di quote & checkout + pengembalian kuota (BE)

**Files:**
- Modify: `src/dto/pesanan.dto.ts` (quoteSchema), `src/services/pesanan-keranjang.service.ts` (`Hasil`, `periksa`, ganti `terapkanPromo` → `terapkanVoucher`, `tolakPromo`), `src/services/pesanan.service.ts` (quote, buatPesanan), `src/services/pesanan-status.service.ts:51-79`, `src/services/meja.service.ts:132` (`promo_codes: []`)
- Test: `test/voucher-checkout.test.ts`; sesuaikan `test/checkout-*.test.ts` hanya bila bentuk galat berubah

**Interfaces:**
- Produces:
  - DTO: `promo_codes: string[]` (trim, upper, unik, maks 2, tiap 1–30) — `promo_code` lama digabung ke `promo_codes` di `transform`.
  - `type Hasil` + `merchant_discount: number; platform_discount: number` (0 dari `periksa`).
  - `terapkanVoucher(conn: Q, h: Hasil, codes: string[], userId: number, ms: number, bayar?: "cod" | "va" | "online"): Promise<{ toko: RowDataPacket | null; platform: RowDataPacket | null }>` — mengisi `h.merchant_discount`, `h.platform_discount`, `h.discount` (jumlah), `h.total`.
  - `tolakPromo(pesan)` → `422 PROMO_INVALID`, `fields: { promo_codes: [pesan], promo_code: [pesan] }`.
  - Respons quote + `merchant_discount`, `platform_discount`, `vouchers_applied: { id: number; code: string; slot: "toko" | "platform"; amount: number }[]`.
  - INSERT orders mengisi `merchant_promo_id, merchant_discount, platform_promo_id, platform_discount`, `promo_id = NULL`; satu baris `promo_redemptions` per voucher (amount = potongan voucher itu).
  - Batal/kedaluwarsa: kembalikan `used_count` untuk `merchant_promo_id`, `platform_promo_id`, dan `promo_id` lama (pesanan sebelum migrasi).

- [ ] **Step 1: Tes gagal** (`test/voucher-checkout.test.ts`, setup `siapCheckout` + promo toko `TOKO10` percent 10 max 5000, platform `HEMAT3K` fixed 3000, platform `GRATISLAYANAN` free_service_fee, toko B `LAINB` fixed 1000):
  - `quote dua voucher: toko dihitung dari subtotal, platform dari sisa` → subtotal 30000, service_fee F: `merchant_discount 3000`, `platform_discount 3000`, `total = 30000 + F − 6000`, `vouchers_applied` dua slot.
  - `dua voucher slot sama / promo toko lain → 422 fields.promo_codes` (`["TOKO10","TOKO10B"]` toko sama; `["LAINB"]`).
  - `minimal belanja dibanding subtotal` (platform min 31000 → 422 untuk subtotal 30000).
  - `fixed toko ≥ subtotal + platform persen → potongan platform 0, total = service_fee` (Review Focus 1).
  - `C1: voucher platform + cod → 422 "Voucher platform hanya untuk bayar non-tunai."`; voucher toko + cod tetap boleh.
  - `C2: dua free_service_fee → 422 "Biaya layanan sudah digratiskan voucher lain."` (promo toko lama berjenis free_service_fee disisipkan via SQL).
  - `kuota platform habis → seluruh pesanan 422, used_count toko tetap` (Review Focus 2).
  - `batal mengembalikan kuota & redemption kedua voucher; dipakai lagi` (Review Focus 3).
  - `klien lama promo_code tunggal tetap jalan; galat di fields.promo_code juga` (Review Focus 4).
  - `pesanan tersimpan: merchant/platform_promo_id & discount, promo_id NULL, 2 baris redemption`.
- [ ] **Step 2:** Jalankan → GAGAL.
- [ ] **Step 3:** Implementasi. `terapkanVoucher`: muat semua kode sekaligus (`WHERE code IN (?) AND (merchant_id IS NULL OR merchant_id = ?)`), kode tak ditemukan → "Kode promo tidak ditemukan.", validasi per promo (pindahkan isi `terapkanPromo` ke `cekPromo(conn, p, h, userId, ms)`), hitung toko dulu lalu platform (spec 5.2 butir 4). `buatPesanan`: klaim kuota tiap voucher urut `id` naik (`UPDATE … WHERE id = ? AND (quota IS NULL OR used_count < quota)`), 0 baris → `tolakPromo("Kuota promo sudah habis.")` (transaksi rollback).
- [ ] **Step 4:** Tes voucher + `test/checkout-*.test.ts`, `test/pembayaran-*.test.ts`, `test/meja.test.ts`, `test/kadaluarsa.test.ts` lulus.
- [ ] **Step 5:** Commit `feat(voucher): satu voucher toko + satu voucher platform per pesanan`.

### Task 3: Pencairan & keuangan memakai potongan terpisah (BE)

**Files:**
- Modify: `src/services/pencairan.service.ts:12-13`, `src/services/admin-keuangan.service.ts:16-22`
- Test: `test/pencairan.test.ts`, `test/admin-keuangan.test.ts` (tambah kasus dua voucher)

**Interfaces:**
- Consumes: kolom Task 1, pesanan dua voucher dari Task 2.
- Produces: `BAGIAN = "o.subtotal - o.merchant_discount"` (tanpa JOIN promos); keuangan `discount_merchant = SUM(o.merchant_discount)`, `discount_platform = SUM(o.platform_discount)`.

- [ ] **Step 1: Tes gagal:** pesanan selesai dengan TOKO10 (3000) + HEMAT3K (3000), subtotal 30000 → saldo pencairan toko = 27000; rekap keuangan `discount_merchant 3000`, `discount_platform 3000`, `merchant_net 27000`.
- [ ] **Step 2:** GAGAL. **Step 3:** ubah SQL. **Step 4:** lulus (+ seluruh `test/pencairan.test.ts`, `test/admin-keuangan.test.ts`).
- [ ] **Step 5:** Commit `fix(pencairan): bagian penjual hanya dipotong voucher toko`.

### Task 4: Klaim & daftar voucher; is_public; larangan free_service_fee toko (BE)

**Files:**
- Create: `src/services/voucher.service.ts`, `src/handlers/voucher.handler.ts`, `src/dto/voucher.dto.ts`
- Modify: `src/routes/katalog.ts`, `src/services/katalog.service.ts` (`profilToko` + `vouchers`), `src/services/admin-promo.service.ts` (`FIELD`/`skema` + `is_public`), `src/services/merchant-promo.service.ts` (tolak `free_service_fee` saat buat & saat ubah jenis), `docs/` (`docs/voucher.md` kontrak singkat), `README.md` tabel endpoint
- Test: `test/voucher.test.ts`, `test/merchant-promo*.test.ts` / `test/admin-promos.test.ts` (is_public)

**Interfaces:**
- Produces:
  - `type VoucherKartu = { id: number; code: string; description: string | null; type: "percent" | "fixed" | "free_service_fee"; value: number; max_discount: number | null; min_subtotal: number; starts_at: Date; ends_at: Date; slot: "toko" | "platform"; merchant: { id: number; slug: string; business_name: string } | null; sold_out: boolean; claimed: boolean }`
  - `voucherToko(merchantId: number, userId: number | null, ms: number): Promise<VoucherKartu[]>` — `is_public AND is_active AND starts_at ≤ now < ends_at`, urut `ends_at`.
  - `voucherPlatform(userId: number | null, ms: number): Promise<VoucherKartu[]>`
  - `klaimVoucher(userId: number, idRaw: unknown): Promise<VoucherKartu>` — idempoten; 404 "Voucher tidak ditemukan."; 409 "Voucher sedang tidak tersedia." (nonaktif/tidak publik/di luar periode); 409 "Kuota voucher sudah habis."
  - `voucherSaya(userId: number, f: { merchant_id?: number; subtotal?: number; payment_method?: "cod" \| "va" \| "online" }): Promise<(VoucherKartu & { usable: boolean; reason: string | null })[]>` — klaim yang belum kedaluwarsa; `reason` salah satu: "Khusus <toko>", "Minimal belanja Rp X", "Kuota habis", "Batas pemakaianmu habis", "Belum berlaku", "Voucher platform hanya untuk bayar non-tunai."
  - Rute: `GET /vouchers/platform` (authOpsional), `POST /me/vouchers/:id/claim`, `GET /me/vouchers?merchant_id=&subtotal=&payment_method=` (pembeli). `GET /merchants/:slug` + `vouchers: VoucherKartu[]`.
- [ ] **Step 1: Tes gagal** (`test/voucher.test.ts`): profil toko memuat voucher publik saja (privat/nonaktif/kedaluwarsa tidak), `claimed` true setelah klaim (login) / false (tamu); klaim idempoten (2× → 1 baris); klaim kuota habis 409; klaim privat 409; `GET /me/vouchers?merchant_id=A&subtotal=10000` → TOKO10 `usable:false reason "Minimal belanja Rp 20.000"`, voucher toko B `reason "Khusus Dapur Andi"`; `GET /vouchers/platform` hanya platform publik aktif; penjual buat `free_service_fee` → 400 `fields.type` "Promo toko hanya potongan persen atau nominal."; `PATCH is_public:false` menyembunyikan dari profil.
- [ ] **Step 2:** GAGAL. **Step 3:** implementasi. **Step 4:** lulus + suite promo lama.
- [ ] **Step 5:** Commit `feat(voucher): klaim voucher, Voucher Saya, voucher di halaman toko`.

### Task 5: Web — sakelar "Tampilkan di halaman toko", form promo toko tanpa gratis biaya layanan (WEB)

**Files:**
- Modify: `types/promo.ts` (+ `is_public: boolean`), `lib/schemas.ts:149-180`, `app/components/promo/PromoForm.tsx`, `app/components/promo/PromoList.tsx` (lencana "Tersembunyi"), `lib/fixtures/promos.ts`
- Test: `app/components/promo/PromoForm.test.tsx`, `PromoList.test.tsx`

**Interfaces:** Consumes BE Task 4 (`is_public` di body/respons promo).

- [ ] **Step 1: Tes gagal:** form penjual tidak punya opsi "Gratis biaya layanan" (admin tetap punya); sakelar "Tampilkan di halaman toko" (bawaan menyala) ikut terkirim `is_public`; daftar menampilkan lencana "Tersembunyi" bila `is_public=false`.
- [ ] **Step 2–4:** GAGAL → implementasi → lulus (`npx vitest run app/components/promo`).
- [ ] **Step 5:** Commit `feat(promo): voucher bisa disembunyikan dari halaman toko`.

### Task 6: Mobile — model & repositori voucher (MO)

**Files:**
- Create: `lib/models/voucher.dart`, `lib/data/voucher_repository.dart`
- Modify: `lib/models/order_api_model.dart` (`Quote` + `merchantDiscount`, `platformDiscount`, `vouchersApplied`), `lib/models/` model profil toko (+ `vouchers`), `lib/main.dart` (Provider `VoucherRepository`)
- Test: `test/models/voucher_test.dart`, `test/data/voucher_repository_test.dart`

**Interfaces:**
- Produces: `enum VoucherSlot { toko, platform }`; `class Voucher { int id; String code; String? description; String type; int value; int? maxDiscount; int minSubtotal; DateTime endsAt; VoucherSlot slot; VoucherMerchant? merchant; bool soldOut; bool claimed; bool? usable; String? reason; String get label /* "Diskon 10% s.d. Rp 5.000", "Potongan Rp 3.000", "Gratis biaya layanan" */ }`; `VoucherRepository(ApiClient)`: `Future<Voucher> claim(int id)`, `Future<List<Voucher>> mine({int? merchantId, int? subtotal, String? paymentMethod})`, `Future<List<Voucher>> platform()`.
- [ ] **Step 1–5:** tes parse (label 3 jenis, `usable/reason` opsional) & jalur HTTP (`POST /me/vouchers/7/claim`, `GET /me/vouchers?merchant_id=1&subtotal=30000&payment_method=online`, `GET /vouchers/platform`) → GAGAL → implementasi → `flutter test test/models/voucher_test.dart test/data/voucher_repository_test.dart` lulus → commit.

### Task 7: Mobile — voucher di halaman toko (MO)

**Files:** Create `lib/widgets/voucher_card.dart`; Modify `lib/screens/home/store_profile_screen.dart`; Test `test/screens/store_vouchers_test.dart`

**Interfaces:** `VoucherCard({required Voucher voucher, required Future<void> Function() onClaim})` — tombol "Klaim" / "Diklaim" (nonaktif) / "Habis" (nonaktif).

- [ ] Tes: profil dengan 2 voucher → 2 kartu; ketuk Klaim → `POST …/claim`, kartu jadi "Diklaim", snackbar "Voucher disimpan ke Voucher Saya"; tamu → diarahkan ke login (pola `requireLogin`); galat 409 → snackbar pesan server. GAGAL → implementasi → lulus → commit.

### Task 8: Mobile — layar Voucher Saya (MO)

**Files:** Create `lib/screens/profile/my_vouchers_screen.dart`; Modify `lib/core/app_routes.dart`, `lib/core/app_router.dart`, `lib/screens/profile/profile_screen.dart` (menu "Voucher Saya"); Test `test/screens/my_vouchers_test.dart`

- [ ] Tes: bagian atas "Voucher KateringKita" berisi voucher platform belum diklaim dengan tombol Klaim (C3); tab "Bisa dipakai" (klaim yang masih berlaku) & "Kedaluwarsa"; kosong → "Belum ada voucher. Klaim dari halaman toko atau Voucher KateringKita."; tarik untuk muat ulang. GAGAL → implementasi → lulus → commit.

### Task 9: Mobile — pemilih voucher di checkout (MO)

**Files:** Create `lib/widgets/voucher_picker_sheet.dart`; Modify `lib/screens/orders/checkout_screen.dart` (ganti isian kode tunggal), `test/screens/checkout_screen_test.dart`

**Interfaces:** `showVoucherPicker(context, {required VoucherSlot slot, required int merchantId, required int subtotal, required String paymentMethod}) → Future<Voucher?>`; body checkout `promo_codes: [kodeToko?, kodePlatform?]` (hapus `promo_code`).

- [ ] Tes: baris "Voucher toko" & "Voucher platform" dengan teks "Pilih voucher"; lembar daftar dari `GET /me/vouchers?merchant_id&subtotal&payment_method` — yang `usable:false` abu-abu + alasan & tak bisa dipilih; voucher platform publik yang belum diklaim muncul dengan "Klaim & pakai" (C3); pilih dua → quote dikirim `promo_codes` 2 kode, ringkasan menampilkan "Voucher toko −Rp 3.000" & "Voucher platform −Rp 3.000"; "Pakai kode" manual tetap ada; galat `fields.promo_codes` tampil di bagian voucher. GAGAL → implementasi → `flutter test` penuh + `flutter analyze` → commit.

## TAHAP 2 — Banner

### Task 10: Banner backend + unggah gambar (BE)

**Files:**
- Create: `database/migrations/015_banner.sql`, `src/services/banner.service.ts`, `src/dto/banner.dto.ts`, `src/handlers/banner.handler.ts`
- Modify: `src/routes/merchant.ts`, `src/routes/admin.ts`, `src/routes/katalog.ts`, `src/dto/upload.dto.ts` (`purpose` + `"banner"`; `adminUploadSchema` purpose `"banner" | "popup"`), `test/migrate.test.ts` (34 tabel)
- Test: `test/banner.test.ts`

**Interfaces:**
- Produces: tabel `banners` (spec 5.4); `type BannerPublik = { id: number; title: string; image_url: string; target: "promo" | "merchant" | "none"; promo: VoucherKartu | null; merchant: { id: number; slug: string; business_name: string } | null }`.
  - Penjual `GET/POST /merchant/banners`, `PATCH/DELETE /merchant/banners/:id` (target hanya tokonya/promo tokonya; ubah → status `menunggu`; >1 banner aktif → 409 "Toko ini sudah punya banner aktif.").
  - Admin `GET /admin/banners?status=`, `POST /admin/banners` (langsung `disetujui`), `PATCH /admin/banners/:id` `{ status?: "disetujui"|"ditolak"|"nonaktif", catatan?, sort_order?, title?, image_url?, … }` (tolak wajib catatan 3–300; diaudit `banner.*`), `POST /admin/uploads` (prefix `platform/<purpose>/`).
  - Publik `GET /banners` (authOpsional, `claimed` di promo): maks 8, `disetujui` dalam periode, admin dulu (`sort_order`, id) lalu penjual (`reviewed_at` DESC); disembunyikan bila promo target nonaktif/kedaluwarsa atau toko tidak tampil (Review Focus 5).
- [ ] Tes (tiap aturan di atas + gambar harus dari prefix pemilik via `cekUrlGambar`) → GAGAL → implementasi → lulus + suite penuh → commit `feat(banner): banner beranda, pengajuan penjual, persetujuan admin`.

### Task 11: Web penjual — halaman Banner (WEB)

**Files:** Create `app/(dashboard)/banner/{page.tsx,loading.tsx,components/BannerToko.tsx,components/BannerToko.test.tsx}`, `app/actions/banner.ts` (+ test); Modify `app/components/shell/nav.ts` (grup Pemasaran: "Banner"), `app/actions/menus.ts` `requestUpload` purpose `"banner"`

- [ ] Tes: tanpa banner → form (judul, gambar via FileDrop rasio 2:1, tujuan "Halaman toko" / "Voucher toko" pilih promo publik, periode); terkirim → status "Menunggu persetujuan"; ditolak → alasan admin tampil + tombol "Ajukan ulang"; disetujui → "Tayang"; tes rangka & nav diperbarui. → commit.

### Task 12: Web admin — halaman Banner (WEB)

**Files:** Create `app/(admin)/admin/banner/{page.tsx,loading.tsx,components/*}`, `app/actions/admin/banner.ts` (+ test); Modify `nav.ts` ("Banner"), `app/(admin)/admin/admin.test.tsx`

- [ ] Tes: tab Menunggu/Tayang/Semua; Setujui / Tolak (wajib alasan) / Nonaktifkan; buat banner platform (unggah lewat `POST /admin/uploads`), ubah urutan; support hanya melihat. → commit.

### Task 13: Mobile — carousel dari server (MO)

**Files:** Create `lib/models/promo_banner.dart`, `lib/data/promo_content_repository.dart` (`Future<List<PromoBanner>> banners()`, `Future<PromoPopup?> popup()`); Modify `lib/screens/home/home_screen.dart`, `lib/main.dart`; Test `test/screens/home_banner_test.dart`

- [ ] Tes: `GET /banners` 2 item → carousel menampilkan gambar & judul server; kosong/gagal → 3 kartu informasi lama; ketuk banner promo → lembar voucher dengan tombol Klaim; ketuk banner toko → halaman toko. → commit.

## TAHAP 3 — Pop-up

### Task 14: Pop-up backend (BE)

**Files:** Create `database/migrations/016_popup.sql`, `src/services/popup.service.ts`, `src/dto/popup.dto.ts`, `src/handlers/popup.handler.ts`; Modify routes admin & katalog, `test/migrate.test.ts` (35 tabel); Test `test/popup.test.ts`

**Interfaces:** `GET /popup` → `{ id, title, image_url, promo: VoucherKartu | null } | null` (terbaru yang `is_active` dalam periode; null bila promo target tidak tersedia); admin `GET/POST /admin/popups`, `PATCH /admin/popups/:id` (diaudit `popup.*`).

- [ ] Tes: periode & is_active dihormati, terbaru menang, promo nonaktif → null, `promo.claimed` untuk pembeli login. → commit.

### Task 15: Web admin — halaman Pop-up (WEB)

**Files:** Create `app/(admin)/admin/popup/{page.tsx,loading.tsx,components/*}`, `app/actions/admin/popup.ts` (+ test); Modify nav & admin.test.

- [ ] Tes: daftar + status (Tayang / Terjadwal / Berakhir / Nonaktif), buat/ubah (judul, gambar 3:4, voucher platform opsional, periode), nonaktifkan; pratinjau bingkai ponsel. → commit.

### Task 16: Mobile — pop-up saat aplikasi dibuka (MO)

**Files:** Create `lib/widgets/promo_popup.dart`; Modify `lib/screens/home/home_screen.dart`; Test `test/screens/promo_popup_test.dart`

- [ ] Tes: tampil setelah beranda termuat; tutup → tidak tampil lagi hari yang sama (kunci `popup_seen_<id>` = tanggal WIB di SharedPreferences), tampil lagi besok; `promo.claimed` → tidak tampil; tombol "Klaim" → klaim lalu tutup + snackbar; tanpa promo → tombol "Lihat". → commit.

## Rilis

### Task 17: Verifikasi penuh, push, uji production

- [ ] BE: `npx vitest run` penuh (MySQL lokal) + `npx tsc --noEmit` → lulus semua → push `main` → tunggu Heroku (migrasi 014–016).
- [ ] WEB: `npx vitest run`, `npx tsc --noEmit`, `npx eslint .` → push `main` (Vercel).
- [ ] MO: `flutter analyze` + `flutter test` → commit lokal → `node tool/demo_wifi.mjs --build`.
- [ ] Production: buat voucher toko & platform uji (toko [UJI]) → klaim di HP → checkout dua voucher → batal → kuota kembali; banner penjual diajukan → disetujui → tampil di beranda; pop-up admin tampil sekali sehari.
