# Panduan Kontribusi

## Konvensi nama

Kode di `src/` dan `test/` memakai nama bahasa Inggris; teks untuk manusia tetap bahasa Indonesia.

| Objek                    | Aturan                                                  | Contoh                                                     |
| ------------------------ | ------------------------------------------------------- | ---------------------------------------------------------- |
| File layanan/handler/DTO | `<feature>[-part].{service,handler,dto}.ts`, kebab-case | `admin-finance.service.ts`, `auth.handler.ts`              |
| File lain                | kebab-case                                              | `orderStatus.ts` menjadi `order-status.ts`                 |
| Fungsi dan variabel      | camelCase                                               | `loadEnv`; `ambilMenu` menjadi `getMenu`                   |
| Tipe dan interface       | PascalCase                                              | `Env`; `PengumumanInput` menjadi `AnnouncementInput`       |
| Konstanta                | `UPPER_SNAKE`                                           | `WA_PLACEHOLDERS`; `BANK_PENCAIRAN` menjadi `PAYOUT_BANKS` |

Konstanta berisi teks pesan galat/validasi diberi akhiran `_MSG` (contoh `REASON_MSG`).

### Yang tidak boleh diganti namanya

Dipakai aplikasi mobile, Midtrans, database, atau pengguna:

- **Kontrak HTTP:** path API, nama field JSON di request dan response (contoh `{ aktif, pesan }`), kode error (`MAINTENANCE`, `MERCHANT_CLOSED`, dan lainnya), nama header.
- **Database:** nama tabel dan kolom, isi file migrasi SQL.
- **Konfigurasi:** nama env var.
- **Teks untuk manusia:** teks UI, pesan error ke pengguna, deskripsi `it(...)`/`describe(...)`, komentar. Semuanya tetap bahasa Indonesia, karena aturan desain proyek mewajibkan teks Indonesia dan komentar Indonesia lazim untuk tim lokal.
- **Kunci kontrak API:** kunci JSON request/response, nama field di skema zod untuk body/query, nama kolom dan alias SQL, nama cookie dan header. Properti objek internal (yang tidak keluar ke JSON dan tidak dibaca dari database) boleh dan sebaiknya di-rename ke bahasa Inggris.

## Nama yang jelas

- Tidak ada nama 1–2 huruf selain `i`/`j` untuk indeks perulangan. Parameter callback diberi nama benda yang diwakilinya (`orders.map((order) => …)`), `catch (e)` menjadi `catch (error)`.
- Singkatan ditulis kata utuh (`cfg` menjadi `config`, `ms` menjadi `durationMs`), kecuali `id`, `url`, `db`, `conn`, `req`, `res`, `qty`, `sql`, `env`, `jwt`.
- Konstanta teks pesan galat/validasi berakhiran `_MSG`; konstanta templat pesan WhatsApp berakhiran `_TEMPLATE`.

## Aturan keterangan (komentar)

Pembaca sasaran: mahasiswa yang belum pernah membaca kode ini.

- Komentar pembuka tiap file (1–3 baris): isi file dan perannya dalam alur `request masuk → middleware → routes → handlers → services → database`.
- Setiap ekspor punya JSDoc: apa yang dilakukan, `@param` tiap parameter, `@returns`, dan `@throws` bila bisa melempar galat, semuanya dalam kata-kata.
- Fungsi dengan badan lebih dari ±10 baris diberi langkah bernomor (`// 1. …`, `// 2. …`) di dalam badannya.
- Tanpa kode catatan internal (`D2`, `R-11`, `AUD-31`, `F06`, …): tulis alasannya dalam kalimat.
- Istilah teknis (JWT, rate limit, hash sandi, transaksi, …) dijelaskan sekali dengan kalimat sederhana di file tempat istilah itu pertama muncul.
- Keterangan harus sesuai dengan yang benar-benar dilakukan kode.

## Glosarium

Wajib dipakai saat memberi nama baru. Mengikuti nama tabel DB dan peran PRD.

| Indonesia               | Inggris           | Indonesia                    | Inggris            |
| ----------------------- | ----------------- | ---------------------------- | ------------------ |
| pesanan                 | order             | ambil / baca                 | get                |
| toko, penjual           | merchant          | daftar (benda/aksi)          | list               |
| pembeli                 | customer          | buat                         | create             |
| menu                    | menu              | ubah                         | update             |
| kuota, stok             | quota, stock      | hapus                        | delete             |
| ulasan                  | review            | simpan                       | save               |
| laporan                 | report            | tandai                       | mark               |
| unggah                  | upload            | bayar                        | pay                |
| pencairan               | payout            | kunci                        | lock               |
| rekening                | bankAccount       | segarkan                     | refresh            |
| meja                    | table             | setujui / tolak              | approve / reject   |
| titik temu              | pickupPoint       | aktif / nonaktif             | active / inactive  |
| keranjang               | cart              | buka / tutup                 | open / close       |
| kadaluarsa              | expired / expiry  | kirim                        | send               |
| favorit                 | favorite          | cari                         | search             |
| tiket, keluhan          | ticket            | hitung                       | calculate / count  |
| notifikasi              | notification      | pulihkan                     | restore            |
| pemeliharaan            | maintenance       | sandi                        | password           |
| pengumuman              | announcement      | akun                         | account            |
| moderasi                | moderation        | pengaturan                   | settings           |
| keuangan                | finance           | ringkasan                    | summary            |
| asisten                 | assistant         | galat                        | error              |
| rekomendasi             | recommendation    | halaman                      | page               |
| hasil AI                | aiResult          | biaya layanan                | serviceFee         |
| porsi                   | portion           | tahan (stok)                 | hold               |
| tamu                    | guest             | lepas (stok)                 | release            |
| aksi                    | action            | muat                         | load               |
| aktor                   | actor             | periksa (validasi isi)       | validate           |
| alasan                  | reason            | terapkan                     | apply              |
| opsi, pilihan           | option            | sisipkan                     | insert             |
| templat                 | template          | peta (mapper)                | map                |
| kekurangan stok         | shortage          | transisi                     | transition         |
| kunci (Idempotency-Key) | idempotencyKey    | saya (milik pengguna login)  | my                 |
| sesi                    | session           | jalankan                     | run                |
| enkripsi / dekripsi     | encrypt / decrypt | samarkan                     | anonymize          |
| surel, email            | mail / mailer     | sah (tanda tangan)           | valid              |
| tanda tangan            | signature         | akses, boleh akses           | access / canAccess |
| injeksi (prompt)        | injection         | pola (regex)                 | pattern            |
| baris keranjang         | line              | klaim (idempotensi, voucher) | claim              |
| cek (benar/salah)       | check             | ditahan (stok)               | held               |
| akar (kunci galat)      | root              | paksa (opsi CLI)             | force              |
| log server              | serverLog         | opsional                     | optional           |
| katalog                 | catalog           | tampil (lolos syarat)        | visible            |
| kandidat                | candidate         | sisa (porsi)                 | remaining          |
| kata kunci              | keyword           | jam (waktu sekarang)         | clock              |
| galeri (foto tambahan)  | gallery           | sinkronkan                   | sync               |
| HPP (harga pokok)       | costPrice         | siapkan                      | prepare            |
| isian templat `{…}`     | placeholder       | basi (lewat hari)            | stale              |
| alamat kembali          | returnUrl         | belum dibaca                 | unread             |
| asal web yang diizinkan | allowedOrigin     | terima (webhook)             | handle             |
| saldo                   | balance           | riwayat                      | history            |
| pencairan dicatat admin | record            | verifikasi (OTP, hasil AI)   | verify             |
| tinjau (banner)         | review            | balas (tiket)                | reply              |
| rentang (tanggal)       | range             | publik (tampil umum)         | public             |

`review` punya dua arti yang dibedakan dari konteks: ulasan pembeli (`createReview`, tabel `reviews`) dan keputusan admin
setuju/tolak atas banner (`reviewBanner`, kolom `reviewed_at`).

Istilah yang belum ada di tabel: pilih padanan Inggris yang umum, lalu tambahkan ke tabel ini pada commit yang sama.

## Alur kerja

1. **Branch.** Buat branch dari `main` dengan awalan `feat/`, `fix/`, `docs/`, `chore/`, atau `refactor/`, lalu ID fitur
   dan ringkasan kebab-case, misalnya `feat/F27-mode-pemeliharaan` atau `chore/F28-standar-kode`. Jangan commit
   langsung ke `main`.
2. **Commit.** Pakai Conventional Commits berbahasa Indonesia: `tipe(scope): deskripsi (Fxx)`. Tipe yang dipakai:
   `feat`, `fix`, `refactor`, `docs`, `test`, `style`, `chore`. Scope adalah area kode (`pesanan`, `admin`, `auth`,
   `test`, …). Contoh nyata: `refactor(pesanan): nama file bahasa Inggris (F28)`,
   `docs(dasar): komentar pembuka app.ts dan server.ts, kode catatan diganti kata-kata (F28)`. Commit kecil dan sering;
   satu commit satu maksud.
3. **Jangan commit rahasia.** File `.env`, kunci API, sandi, dan kredensial database tidak boleh masuk commit (lihat
   `.gitignore`). Nama variabel env baru cukup ditambahkan ke `.env.example` dan tabel env di README, tanpa nilai asli.
4. **Cek lokal sebelum push**, urutannya sama dengan CI:

   ```bash
   npm run format:check && npm run lint && npm run typecheck && npm run build
   npm run migrate && npm test   # butuh MySQL lokal dan TEST_DATABASE_URL
   ```

5. **Pull request** ke `main` dengan template `.github/pull_request_template.md` (ringkasan, jenis perubahan, checklist,
   cara menguji). CI (`.github/workflows/ci.yml`) harus hijau: `format:check` → `lint` → `typecheck` → `build` →
   `migrate` → `test`.
6. **Review.** Minimal satu orang lain membaca dan menyetujui PR sebelum merge. Komentar review dijawab dengan commit
   baru, bukan dengan menimpa riwayat.
7. **Commit refactor dan format tidak mengubah perilaku.** Commit `refactor` dan `style` hanya mengganti nama, memindah
   file, atau merapikan format: test dan kontrak API harus tetap sama. Hash lengkapnya ditambahkan ke
   `.git-blame-ignore-revs` supaya `git blame` menunjuk commit yang benar-benar mengubah isi. Aktifkan sekali per
   salinan repo:

   ```bash
   git config blame.ignoreRevsFile .git-blame-ignore-revs
   ```
