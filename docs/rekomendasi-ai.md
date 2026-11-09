# Rekomendasi AI pembeli (F24) — kontrak untuk aplikasi mobile

Pembeli menulis kebutuhan dalam bahasa bebas ("makan siang 5 orang, budget 100 ribu, nggak pedas"),
backend mengembalikan usulan keranjang per toko dari menu yang **benar-benar tersedia saat itu**.

## Cara kerja (RAG)

1. **Ambil (retrieval)** dari database: menu aktif, toko terverifikasi dan sedang buka, stok hari ini > 0,
   `harga × min_order_qty ≤ budget`, plus filter opsional (kategori, toko, titik temu).
   Diurutkan menurut kecocokan kata kunci kalimat pembeli, lalu terlaris, lalu rating. Maksimal 40 kandidat.
2. **Pilih (generation)**: kandidat + kalimat pembeli dikirim ke AI gateway (penyedia AI yang diatur admin
   di `/admin/ai`). AI hanya boleh menjawab id menu dari kandidat + jumlah.
3. **Validasi ulang** di backend: id di luar kandidat dibuang, `qty` dijepit ke `min_order_qty`, stok,
   dan sisa anggaran; harga dan subtotal dihitung dari database, bukan dari AI.
4. Bila AI belum diaktifkan admin, semua penyedia gagal, atau jawabannya rusak: **cadangan** tanpa AI
   (menu teratas hasil langkah 1, `qty` = `portions`). Respons tetap 200.

AI tidak "dilatih": setiap permintaan membaca menu dan stok terbaru, jadi perubahan menu/stok langsung terpakai.

## Permintaan

`POST /api/v1/assistant/recommendations` — header `Authorization: Bearer <token pembeli>`

```json
{
  "question": "makan siang 5 orang, nggak pedas",
  "budget": 100000,
  "portions": 5,
  "category": "nasi-box",
  "merchant": "dapur-siti",
  "pickup_point_id": 1
}
```

| Kolom | Wajib | Aturan |
|---|---|---|
| `question` | ya | teks 3–500 karakter |
| `budget` | tidak | angka bulat Rupiah 1.000–100.000.000 (angka JSON, bukan string) |
| `portions` | tidak | angka bulat 1–1.000 |
| `category` | tidak | slug kategori dari `GET /meta/categories` |
| `merchant` | tidak | slug toko |
| `pickup_point_id` | tidak | id dari `GET /meta/pickup-points` |

## Respons 200

```json
{
  "data": {
    "source": "ai",
    "summary": "Nasi goreng spesial untuk 5 orang plus es teh, total Rp 100.000.",
    "groups": [
      {
        "merchant": { "id": 3, "slug": "dapur-siti", "business_name": "Dapur Siti", "is_open": true },
        "items": [
          { "menu": { "...": "kartu menu, sama dengan item GET /menus" }, "qty": 5, "subtotal": 75000, "reason": "Tidak pedas, favorit" },
          { "menu": { "...": "..." }, "qty": 5, "subtotal": 25000, "reason": null }
        ],
        "total": 100000
      }
    ],
    "total": 100000
  }
}
```

- `source`: `"ai"` atau `"fallback"` (tanpa AI). Tampilkan `summary` apa adanya.
- `groups`: satu grup = satu toko (checkout per toko). Bisa kosong; `summary` menjelaskan alasannya
  (mis. anggaran tidak cukup, tidak ada menu yang cocok).
- `menu` berbentuk sama dengan kartu di `GET /menus` (id, name, image_url, price, unit_label, category,
  merchant, available, badge, rating_avg, rating_count, is_favorite), jadi komponen kartu bisa dipakai ulang.
- `subtotal` = `menu.price × qty`, belum termasuk opsi menu, promo, dan biaya layanan.
  Harga final tetap dari `POST /orders/quote`.
- Stok bisa berubah setelah rekomendasi; tombol "masukkan keranjang" tetap melewati alur checkout biasa.

## Galat

| Status | Kode | Kapan |
|---|---|---|
| 400 | `VALIDATION_ERROR` | kolom tidak valid (`error.fields.<kolom>`) |
| 401 | `UNAUTHENTICATED` | tanpa token / sesi habis |
| 403 | `FORBIDDEN` | bukan akun pembeli |
| 429 | `RATE_LIMITED` | lebih dari 10 permintaan per 10 menit per pengguna (kuota bersama asisten AI) |

AI yang tidak tersedia **tidak** menghasilkan galat; respons memakai `source: "fallback"`.
