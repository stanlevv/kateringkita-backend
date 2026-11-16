# Voucher — kontrak untuk aplikasi mobile & web

Rancangan: [`docs/superpowers/specs/2026-11-16-voucher-banner-popup-design.md`](superpowers/specs/2026-11-16-voucher-banner-popup-design.md).

Voucher = promo yang `is_public` (tampil & bisa diklaim). Ada dua slot:

| Slot | Asal | Ditanggung | Catatan |
|---|---|---|---|
| `toko` | promo penjual (`merchant_id` = toko) | penjual (memotong bagian pencairan) | hanya persen / nominal (promo toko lama "gratis biaya layanan" tetap berlaku) |
| `platform` | promo admin (`merchant_id` NULL) | platform | hanya untuk bayar non-tunai (VA / online) |

Satu pesanan boleh memakai **maks 1 voucher toko + 1 voucher platform**. Klaim **tidak** mengurangi kuota; kuota
berkurang saat pesanan dibuat (rebutan di checkout) dan kembali saat pesanan batal / kedaluwarsa.

## Bentuk voucher (`VoucherKartu`)

```json
{
  "id": 12, "code": "HEMAT10", "description": "Diskon pembuka", "type": "percent", "value": 10, "max_discount": 5000,
  "min_subtotal": 20000, "starts_at": "…", "ends_at": "…", "slot": "toko",
  "merchant": { "id": 3, "slug": "dapur-siti", "business_name": "Dapur Siti" },
  "sold_out": false, "claimed": true
}
```

`type`: `percent` (`value` = persen, `max_discount` opsional) · `fixed` (`value` = Rupiah) · `free_service_fee`.
`merchant` = `null` untuk voucher platform. `claimed` hanya `true` untuk pembeli yang login.

## Endpoint

| Endpoint | Siapa | Isi |
|---|---|---|
| `GET /merchants/:slug` | publik | profil toko + `vouchers: VoucherKartu[]` (publik, aktif, dalam periode; berakhir paling cepat dulu) |
| `GET /vouchers/platform` | publik | voucher platform publik yang berlaku |
| `POST /me/vouchers/:id/claim` | pembeli | idempoten → `VoucherKartu`; `404` "Voucher tidak ditemukan."; `409` "Voucher sedang tidak tersedia." / "Kuota voucher sudah habis." |
| `GET /me/vouchers?merchant_id=&subtotal=&payment_method=` | pembeli | voucher yang diklaim (+ yang berakhir ≤ 30 hari lalu), tiap item + `usable`, `reason` |
| `POST /orders/quote`, `POST /orders` | pembeli | body `promo_codes: string[]` (maks 2); `promo_code` lama tetap diterima |
| `PATCH /merchant/promos/:id`, `PATCH /admin/promos/:id` | penjual / admin | + `is_public: boolean` |

`reason` (salah satu): "Voucher sudah berakhir.", "Belum berlaku", "Voucher sedang tidak tersedia.", "Kuota habis",
"Batas pemakaianmu habis", "Khusus <nama toko>", "Minimal belanja Rp X", "Voucher platform hanya untuk bayar non-tunai."

Respons quote menambah `merchant_discount`, `platform_discount`, dan
`vouchers_applied: [{ id, code, slot, amount }]`. Galat voucher: `422 PROMO_INVALID` dengan pesan di
`error.fields.promo_codes` **dan** `error.fields.promo_code`:
"Kode promo tidak ditemukan.", "Hanya satu voucher toko per pesanan.", "Hanya satu voucher platform per pesanan.",
"Maksimal 2 voucher per pesanan.", "Promo sedang tidak berlaku.", "Kuota promo sudah habis.",
"Minimal belanja Rp X untuk promo ini.", "Promo ini sudah mencapai batas pemakaianmu.",
"Voucher platform hanya untuk bayar non-tunai.", "Biaya layanan sudah digratiskan voucher lain."

Urutan hitung: voucher toko dari `subtotal`, voucher platform dari sisa barang (atau biaya layanan bila
"gratis biaya layanan"). `total = subtotal + service_fee − merchant_discount − platform_discount` (tidak pernah minus).
