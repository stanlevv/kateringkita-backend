# Pembayaran pesanan (F10, F26) — kontrak untuk aplikasi mobile

Sejak F26 semua pembayaran non-tunai lewat Midtrans dan masuk ke akun Midtrans platform. QRIS statis toko
(foto QRIS + penjual menekan "Verifikasi bayar") **dihapus**. Pembeli memilih salah satu dari tiga metode:

| `payment_method` | Cara bayar                                                                                                                              | Siapa yang menerima pesanan             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `cod`            | Tunai saat mengambil                                                                                                                    | Penjual menekan Konfirmasi              |
| `va`             | Virtual Account Midtrans (BCA, BNI, BRI), bank dipilih pembeli                                                                          | Otomatis saat Midtrans melaporkan lunas |
| `online`         | QRIS yang digambar langsung di aplikasi (`/qris`), atau halaman bayar Midtrans Snap: QRIS, GoPay, ShopeePay, VA BCA/BNI/BRI (`/online`) | Otomatis saat Midtrans melaporkan lunas |

`qris` hanya ada di data lama. Checkout dengan `qris` ditolak `400`.

## Alur

1. `POST /orders` dengan `payment_method`. Pesanan lahir berstatus `holding`, `payment.status = "unpaid"`.
   Porsi ditahan sampai `hold_until` (durasi = `hold_minutes` toko, 1–30 menit).
2. Untuk `va`: `POST /orders/:code/va` dengan `{ "bank": "bca" | "bni" | "bri" }`, lalu tampilkan `payment.va.va_number`.
   Untuk `online` di mobile: `POST /orders/:code/qris`, lalu gambar `payment.qris.qr_string` sebagai kode QR di layar.
   Cadangan / web: `POST /orders/:code/online`, lalu buka `payment.payment_url` di browser atau WebView.
3. Pembeli membayar. Midtrans mengirim notifikasi ke backend (`POST /payments/midtrans`, signature SHA512 dicek).
   Saat `settlement`, pesanan menjadi `confirmed` dan `payment.status = "paid"`. Pembeli mendapat notifikasi status.
4. Aplikasi mengecek hasil dengan `GET /orders/:code`, misalnya tiap 5 detik selama layar bayar terbuka dan saat
   aplikasi kembali dari browser. Berhenti saat `status` bukan `holding` lagi.

Penjual **tidak bisa** menerima pesanan VA/online sebelum lunas (`409 "Pesanan belum dibayar."`). Pesanan yang tidak
dibayar sampai `hold_until` menjadi `expired` dan porsinya kembali.

VA dan halaman Snap ditutup sebelum `hold_until` (sisa waktu dibulatkan ke bawah per menit). Bila sisa waktu kurang
dari 1 menit, permintaan VA/Snap ditolak `409 "Batas waktu pesanan sudah habis."`.

## `POST /orders/:code/online`

Header `Authorization: Bearer <token pembeli>`. Body boleh kosong. Mobile tidak perlu mengirim apa pun.

```json
{ "kembali": "https://ketringkita.edufin.app/..." }
```

`kembali` (opsional, untuk web) = halaman tujuan setelah bayar. Asalnya harus salah satu `CORS_ORIGIN` backend.

Idempoten: memanggil ulang selama pesanan masih menunggu bayar mengembalikan `payment_url` yang sama.
Respons `200` = bentuk pesanan yang sama dengan `GET /orders/:code`:

```json
{
  "data": {
    "code": "KK-20261110-AB12",
    "status": "holding",
    "payment_method": "online",
    "payment_status": "pending",
    "hold_until": "2026-11-10T03:05:00.000Z",
    "seconds_left": 287,
    "payment": {
      "method": "online",
      "status": "pending",
      "amount": 30000,
      "payment_url": "https://app.sandbox.midtrans.com/snap/..."
    }
  }
}
```

`payment.payment_url` bernilai `null` sebelum endpoint ini dipanggil, dan juga setelah pesanan lunas, batal, atau
kedaluwarsa.

## `POST /orders/:code/qris`

QRIS langsung di aplikasi (Midtrans Core API, `payment_type: "qris"`), tanpa halaman Snap. Header `Authorization: Bearer
<token pembeli>`, tanpa body. Hanya untuk pesanan `payment_method: "online"` yang masih menunggu bayar.

Idempoten: satu QRIS per pesanan; memanggil ulang mengembalikan QR yang sama tanpa membuat transaksi baru. Respons `200` =
bentuk pesanan, dengan:

```json
"payment": {
  "method": "online",
  "status": "pending",
  "amount": 30000,
  "payment_url": null,
  "qris": {
    "qr_string": "00020101021226...",
    "qr_url": "https://api.sandbox.midtrans.com/v2/qris/<transaction_id>/qr-code",
    "expires_at": "2026-11-10T03:04:00.000Z"
  }
}
```

- `qr_string` = isi QR standar QRIS; aplikasi menggambarnya sendiri (mis. `qr_flutter`).
- `qr_url` = gambar QR dari Midtrans, untuk dibuka/disimpan di browser (dan untuk simulator QRIS sandbox).
- `payment.qris` bernilai `null` sebelum endpoint ini dipanggil, dan setelah pesanan lunas, batal, atau kedaluwarsa.

QRIS dan halaman Snap memakai `order_id` Midtrans yang sama (kode pesanan). Bila pembeli sudah memilih metode di halaman
Snap, QRIS tidak bisa dibuat lagi (`409`). Sebaliknya, setelah QRIS dibuat, aplikasi tidak menawarkan halaman Snap lagi.

## `POST /orders/:code/va`

Body `{ "bank": "bca" }`. Idempoten: VA yang sudah dibuat dikembalikan (satu VA per pesanan; bank pertama yang dipakai).
Respons: bentuk pesanan dengan `payment.va = { "bank", "va_number", "expires_at" }`. Sebelum bank dipilih, `payment.va` bernilai `null`.

## Galat

| Kapan                                                                          | Status | Pesan                                                                                                                    |
| ------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| Checkout `payment_method` selain `cod`/`va`/`online`                           | 400    | `Pilih bayar tunai, Virtual Account, atau bayar online.`                                                                 |
| Checkout VA/online, Midtrans belum dipasang di server                          | 409    | `Pembayaran Virtual Account belum tersedia. Pilih metode lain.` / `Pembayaran online belum tersedia. Pilih metode lain.` |
| `/online` atau `/qris` untuk pesanan bukan `online`                            | 409    | `Pesanan ini tidak memakai bayar online.`                                                                                |
| `/online` atau `/qris` untuk pesanan yang sudah lunas, batal, atau kedaluwarsa | 409    | `Pesanan ini tidak menunggu pembayaran.`                                                                                 |
| `/qris` setelah pembeli memilih metode di halaman Snap                         | 409    | `Pembayaran pesanan ini sudah dimulai di halaman Midtrans. Lanjutkan di sana.`                                           |
| `/qris`, Midtrans menolak atau tidak menjawab                                  | 502    | `Gagal membuat QRIS. Coba lagi.`                                                                                         |
| `/va` untuk pesanan yang tidak menunggu VA                                     | 409    | `Pesanan ini tidak menunggu pembayaran Virtual Account.`                                                                 |
| Sisa waktu tahan < 1 menit                                                     | 409    | `Batas waktu pesanan sudah habis.`                                                                                       |
| `kembali` bukan alamat web KateringKita                                        | 400    | `fields.kembali`: `Alamat kembali tidak diizinkan.`                                                                      |
| Pesanan milik pembeli lain atau tidak ada                                      | 404    | `Pesanan tidak ditemukan.`                                                                                               |

## Batal dan pengembalian dana

- Pembeli boleh membatalkan pesanan `holding` dengan metode apa pun. Pesanan `confirmed` hanya bisa dibatalkan pembeli bila tunai.
- Penjual boleh menolak pesanan `holding` atau `confirmed`.
- Bila pesanan VA/online yang sudah lunas ditolak atau dibatalkan, atau pembayaran baru masuk setelah pesanan kedaluwarsa,
  pembayaran tetap tercatat lunas dan pesanan tidak dihidupkan lagi. Pesanan itu masuk daftar **Dana yang harus dikembalikan**
  di `/admin/pencairan`. Admin mengembalikan dana di luar aplikasi (dashboard Midtrans atau transfer), lalu menandainya.
  Setelah ditandai, `payment_status` pesanan menjadi `refunded`.

## Uang ke penjual

Uang VA/online masuk akun Midtrans platform. Bagian penjual per pesanan selesai = `subtotal` − diskon promo toko.
Biaya layanan, promo platform, dan biaya Midtrans ditanggung platform. Admin mentransfer bagian penjual ke rekening yang
diisi penjual di Pengaturan web (`PUT /merchant/payout-account`), lalu mencatatnya (`POST /admin/payouts`). Pesanan tunai
dibayar langsung ke penjual dan tidak ikut pencairan.

## Pesan dari meja (F21)

Pesanan meja (tanpa akun) selalu `online`. Alurnya sama, lewat `POST /guest/orders/:code/pay` dengan header `X-Guest-Token`.
