import { createHash, randomInt } from "node:crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { env } from "../config/env";
import { dalamTransaksi } from "./admin-audit.service";
import { AppError } from "../utils/errors";
import { jam, jamWib, SISA } from "./katalog.service";
import { hariIniWib } from "./merchant-kuota.service";
import { Kurang, muatKeranjang, periksa, terapkanPromo, tolakPromo } from "./pesanan-keranjang.service";
import { DaftarSaya, PesananInput, QuoteInput, quoteSchema } from "../dto/pesanan.dto";
import { Status, transisi } from "./pesanan-status.service";

// F06 pesanan pembeli (C-09, C-11, C-13)

// D2: validasi sama dengan pesanan, tanpa tulis/kunci; stok kurang = peringatan
export async function quote(userId: number, data: QuoteInput) {
  const ms = jam.sekarang();
  const h = periksa(await muatKeranjang(db, data, { segarkan: false, hari: hariIniWib(new Date(ms)), ms }), data, ms);
  await terapkanPromo(db, h, data.promo_code, userId, ms);
  return {
    // mapper eksplisit (R-11): hpp tidak keluar
    items: h.baris.map((b) => ({
      menu_id: b.menu_id, menu_name: b.menu_name, qty: b.qty, unit_price: b.unit_price, options: b.options, line_total: b.line_total,
      available: b.available,
    })),
    subtotal: h.subtotal, discount: h.discount, service_fee: h.service_fee, total: h.total,
    warnings: h.kurang.map((k) => ({
      code: "OUT_OF_STOCK", menu_id: k.menu_id, available: k.available,
      message: `Sisa ${k.menu_name} tinggal ${k.available} ${k.unit_label}.`,
    })),
  };
}

// D7: base32 Crockford; `acak` diganti test untuk memaksa tabrakan
const ALFABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const kode = { acak: (): string => Array.from({ length: 4 }, () => ALFABET[randomInt(32)]).join("") };
export const kodePesanan = (hari: string) => `KK-${hari.replace(/-/g, "")}-${kode.acak()}`;

const tidakAda = () => new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
const dup = (e: unknown) => (e as { code?: string } | null)?.code === "ER_DUP_ENTRY";
// D7: hanya duplikat pada kunci unik orders.code yang berarti tabrakan kode (MySQL 8 "orders.code", lama/TiDB "code")
const bentrokKode = (e: unknown) => dup(e) && /for key '(orders\.)?code'/.test(String((e as Error).message));
const KLAIM_ADA = Symbol("klaim");

// D3–D8, D11, D12 dalam satu transaksi. Urutan kunci: users (pembeli) → klaim idempotensi → menu (UPDATE bersyarat, urut id).
// READ COMMITTED: hitung holding (baca berkunci) tanpa gap lock; di REPEATABLE READ gap lock indeks pesanan pembeli baru
// saling mengunci INSERT orders → deadlock (terbukti di uji paralel). Stok dijaga UPDATE bersyarat, tidak butuh snapshot.
export async function buatPesanan(userId: number, kunci: string, data: PesananInput) {
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  let code: string;
  try {
    code = await dalamTransaksi(async (conn) => {
      // Kunci baris pembeli lebih dulu: checkout satu pembeli jadi serial sehingga batas 3 holding (D11) tidak bisa dilampaui
      // request paralel. Harus sebelum INSERT klaim: FK klaim → users mengambil kunci bersama, dan dua transaksi yang sama-sama
      // memegangnya lalu meminta FOR UPDATE akan deadlock.
      const [[u]] = await conn.query<RowDataPacket[]>("SELECT full_name, phone FROM users WHERE id = ? FOR UPDATE", [userId]);
      // shortcut: order_idempotency tidak dibersihkan; hapus baris > 7 hari di job harian F08 bila tabel > 1 juta baris
      try {
        await conn.query("INSERT INTO order_idempotency (customer_id, idem_key, request_hash) VALUES (?, ?, ?)", [userId, kunci, hash]);
      } catch (e) {
        if (dup(e)) throw KLAIM_ADA;
        throw e;
      }
      // baca berkunci = data terbaru (TiDB: baca biasa memakai snapshot awal transaksi). Tanpa gap lock: transaksi ini READ COMMITTED.
      // shortcut: hold lewat waktu tetap memakan stok sampai sapuan berikutnya (≤ 30 dtk, D1 F08); kurangi interval bila keluhan stok "habis" palsu
      const [[n]] = await conn.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND status = 'holding' AND hold_until > UTC_TIMESTAMP() FOR UPDATE",
        [userId],
      );
      if (Number(n.n) >= 3) throw new AppError(409, "CONFLICT", "Masih ada 3 pesanan yang menunggu. Selesaikan atau batalkan dulu.");

      const ms = jam.sekarang();
      const hari = hariIniWib(new Date(ms));
      const h = periksa(await muatKeranjang(conn, data, { segarkan: true, hari, ms }), data, ms);
      const habis = (kurang: Kurang[]) => new AppError(409, "OUT_OF_STOCK", "Sisa porsi tidak cukup.",
        Object.fromEntries(kurang.map((k) => [`items.${k.index}.qty`, [`Sisa ${Math.max(k.available, 0)} ${k.unit_label}.`]])));
      if (h.kurang.length) throw habis(h.kurang);
      const promoId = await terapkanPromo(conn, h, data.promo_code, userId, ms);
      if (promoId) {
        // F12: klaim kuota atomik sebelum INSERT orders (FK orders → promos mengambil kunci bersama yang lalu minta dinaikkan → deadlock).
        // Urutan kunci promos → menus, sama dengan transisi (lepasPromo sebelum lepasStok).
        // shortcut: reset kuota harian (segarkanKuota, menus) berjalan sebelum ini pada checkout pertama hari itu; deadlock langka bila
        // bersamaan dengan batal berpromo di toko yang sama, coba ulang di klien cukup
        const [r] = await conn.query<ResultSetHeader>(
          "UPDATE promos SET used_count = used_count + 1 WHERE id = ? AND (quota IS NULL OR used_count < quota)", [promoId],
        );
        if (!r.affectedRows) throw tolakPromo("Kuota promo sudah habis.");
      }
      if (data.payment_method === "qris" && !h.merchant.qris_image_url) {
        throw new AppError(409, "CONFLICT", "Toko belum memasang QRIS. Pilih bayar tunai.");
      }
      if (data.payment_method === "va" && !env.MIDTRANS_SERVER_KEY) {
        throw new AppError(409, "CONFLICT", "Pembayaran Virtual Account belum tersedia. Pilih metode lain.");
      }

      // D7: galat duplikat hanya membatalkan pernyataan, bukan transaksi → coba kode baru, maks 5 kali
      let orderId = 0;
      let c = "";
      for (let i = 0; !orderId; i++) {
        c = kodePesanan(hari);
        try {
          const [r] = await conn.query<ResultSetHeader>(
            `INSERT INTO orders (code, customer_id, merchant_id, pickup_point_id, status, customer_name, customer_phone, note, subtotal,
               discount, service_fee, total, promo_id, payment_method, payment_status, hold_until, stock_date, pickup_at)
             VALUES (?, ?, ?, ?, 'holding', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?, ?)`,
            [c, userId, h.merchant.id, data.pickup_point_id, data.customer_name ?? u.full_name, data.customer_phone ?? u.phone, data.note,
              h.subtotal, h.discount, h.service_fee, h.total, promoId, data.payment_method, h.merchant.hold_minutes, hari,
              data.pickup_at ? new Date(data.pickup_at) : null],
          );
          orderId = r.insertId;
        } catch (e) {
          if (!bentrokKode(e)) throw e;
          if (i === 4) throw new Error("Kode pesanan bentrok 5 kali.");
        }
      }
      // R-02: tahan porsi dengan UPDATE bersyarat atomik, urut id (kunci menu baru diambil di sini, sesingkat mungkin).
      // stock_date = hari: penghitung yang dinaikkan selalu milik tanggal stok pesanan (aman dari balapan tengah malam, D14).
      // Harus sebelum INSERT order_items: FK item → menus mengambil kunci bersama yang lalu minta dinaikkan → deadlock.
      const perMenu = new Map<number, number>();
      for (const b of h.baris) perMenu.set(b.menu_id, (perMenu.get(b.menu_id) ?? 0) + b.qty);
      for (const [mid, qty] of [...perMenu].sort((a, b) => a[0] - b[0])) {
        const [r] = await conn.query<ResultSetHeader>(
          `UPDATE menus SET held_today = held_today + ?, updated_at = updated_at
           WHERE id = ? AND deleted_at IS NULL AND is_active AND stock_date = ? AND quota_today - sold_today - held_today >= ?`,
          [qty, mid, hari, qty],
        );
        if (r.affectedRows === 0) {
          // sisa terbaru untuk pesan galat (baca berkunci = data terbaru, bukan snapshot); seluruh transaksi lalu di-rollback
          const [[m]] = await conn.query<RowDataPacket[]>(
            `SELECT ${SISA} AS available FROM menus x WHERE id = ? FOR UPDATE`, [hari, mid],
          );
          const i = h.baris.findIndex((x) => x.menu_id === mid);
          throw habis([{ ...h.baris[i], index: i, available: Number(m.available) }]);
        }
      }
      // R-05: salinan nama, harga, hpp, opsi
      await conn.query(
        "INSERT INTO order_items (order_id, menu_id, menu_name, unit_price, hpp, qty, options, line_total) VALUES ?",
        [h.baris.map((b) => [orderId, b.menu_id, b.menu_name, b.unit_price, b.hpp, b.qty, JSON.stringify(b.options), b.line_total])],
      );
      // F12: dikembalikan bila pesanan batal/kedaluwarsa (transisi)
      if (promoId) {
        await conn.query("INSERT INTO promo_redemptions (promo_id, order_id, user_id, amount) VALUES (?, ?, ?, ?)", [promoId, orderId, userId, h.discount]);
      }
      await conn.query("INSERT INTO order_status_logs (order_id, from_status, to_status, actor_user_id) VALUES (?, NULL, 'holding', ?)",
        [orderId, userId]);
      await conn.query("UPDATE order_idempotency SET order_id = ? WHERE customer_id = ? AND idem_key = ?", [orderId, userId, kunci]);
      return c;
    }, "READ COMMITTED");
  } catch (e) {
    if (e !== KLAIM_ADA) throw e;
    // D6: request kembar menunggu klaim pertama commit → pesanan yang sama bila isi sama
    const [[r]] = await db.query<RowDataPacket[]>(
      `SELECT k.request_hash, o.code FROM order_idempotency k LEFT JOIN orders o ON o.id = k.order_id
       WHERE k.customer_id = ? AND k.idem_key = ?`,
      [userId, kunci],
    );
    if (!r || r.request_hash !== hash || !r.code) {
      throw new AppError(409, "CONFLICT", "Pesanan ini sudah dikirim dengan isi berbeda. Muat ulang lalu coba lagi.");
    }
    code = r.code;
  }
  return bacaPesanan(userId, code);
}

// Kolom bersama Order (pembeli) & MerchantOrder (penjual); o = orders, p = pickup_points
export const KOLOM = `o.id, o.code, o.status, o.payment_method, o.payment_status, o.hold_until, o.pickup_at,
  GREATEST(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), o.hold_until), 0) AS seconds_left, o.pickup_point_id, p.name AS p_name,
  o.subtotal, o.discount, o.service_fee, o.total, o.note, o.cancel_reason, o.cancelled_by, o.created_at, o.updated_at`;
const DARI_PEMBELI = `${KOLOM}, o.merchant_id, m.business_name, m.wa_number, m.qris_image_url,
  (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND NOT EXISTS
    (SELECT 1 FROM reviews r WHERE r.order_id = o.id AND r.menu_id = i.menu_id)) AS belum_diulas
  FROM orders o JOIN merchants m ON m.id = o.merchant_id JOIN pickup_points p ON p.id = o.pickup_point_id`;

export type Item = { menu_id: number; menu_name: string; qty: number; unit_price: number; options: unknown[]; line_total: number };

// Item seluruh halaman dalam satu kueri (tanpa N+1); mapper eksplisit tanpa hpp (R-11)
export async function muatItem(ids: number[]): Promise<Map<number, Item[]>> {
  const per = new Map<number, Item[]>();
  if (!ids.length) return per;
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT order_id, menu_id, menu_name, qty, unit_price, options, line_total FROM order_items WHERE order_id IN (?) ORDER BY id", [ids],
  );
  for (const i of rows) {
    const daftar = per.get(i.order_id) ?? per.set(i.order_id, []).get(i.order_id)!;
    daftar.push({ menu_id: i.menu_id, menu_name: i.menu_name, qty: i.qty, unit_price: i.unit_price, options: i.options ?? [], line_total: i.line_total });
  }
  return per;
}

// D13: bagian yang sama untuk Order & MerchantOrder; hold_until/seconds_left null bila bukan holding
export const dasarPesanan = (o: RowDataPacket, items: Item[]) => {
  const holding = o.status === "holding";
  return {
    code: o.code, status: o.status, payment_method: o.payment_method, payment_status: o.payment_status,
    hold_until: holding ? o.hold_until : null, seconds_left: holding ? Number(o.seconds_left) : null,
    pickup_point: { id: o.pickup_point_id, name: o.p_name }, items,
    subtotal: o.subtotal, discount: o.discount, service_fee: o.service_fee, total: o.total, note: o.note, pickup_at: o.pickup_at,
    cancel_reason: o.cancel_reason, cancelled_by: o.cancelled_by, created_at: o.created_at, updated_at: o.updated_at,
  };
};

// Order §1 (tanpa payment). D2: holding yang lewat waktu tidak bisa dibatalkan
export const petaPesanan = (o: RowDataPacket, items: Item[]) => ({
  ...dasarPesanan(o, items),
  // F10: QRIS toko untuk dibayar pembeli, diverifikasi manual penjual
  merchant: { id: o.merchant_id, business_name: o.business_name, wa_number: o.wa_number, qris_image_url: o.qris_image_url },
  can_cancel: (o.status === "holding" && Number(o.seconds_left) > 0) || (o.status === "confirmed" && o.payment_method === "cod"),
  // F13: masih ada menu yang belum diulas
  can_complete: o.status === "ready", can_review: o.status === "completed" && Number(o.belum_diulas) > 0,
});

// pola LIKE sebagian dengan % _ \ di-escape; pemanggil membandingkan LOWER(kolom) LIKE LOWER(?) karena TiDB bawaan utf8mb4_bin (peka huruf)
export const pola = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

// D10–D12: satu COUNT + satu halaman + satu kueri item; urut terbaru. Dengan updated_since urut updated_at naik agar klien yang
// maju memakai updated_at terbesar halaman sebelumnya tidak melompati perubahan.
export async function halaman<T>(
  dari: string, where: string[], args: unknown[], f: { page: number; limit: number; updated_since?: string },
  peta: (o: RowDataPacket, items: Item[]) => T,
) {
  const urut = f.updated_since ? "o.updated_at ASC, o.id ASC" : "o.created_at DESC, o.id DESC";
  const w = where.join(" AND ");
  const [[n]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM orders o WHERE ${w}`, args);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${dari} WHERE ${w} ORDER BY ${urut} LIMIT ? OFFSET ?`, [...args, f.limit, (f.page - 1) * f.limit],
  );
  const items = await muatItem(rows.map((o) => o.id));
  return { data: rows.map((o) => peta(o, items.get(o.id) ?? [])), meta: { page: f.page, limit: f.limit, total: Number(n.n) } };
}

const TAB: Record<DaftarSaya["tab"], Status[]> = {
  active: ["holding", "confirmed", "cooking", "ready"], completed: ["completed"], cancelled: ["cancelled", "expired"],
};

// C-14 (D10, D11): updated_since mengabaikan tab agar pesanan yang pindah tab tetap terkirim
export async function daftarPesananSaya(userId: number, f: DaftarSaya) {
  const where = ["o.customer_id = ?"];
  const args: unknown[] = [userId];
  if (f.updated_since) {
    where.push("o.updated_at >= ?");
    args.push(new Date(f.updated_since));
  } else {
    where.push("o.status IN (?)");
    args.push(TAB[f.tab]);
  }
  if (f.q) {
    where.push("(LOWER(o.code) LIKE LOWER(?) OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND LOWER(i.menu_name) LIKE LOWER(?)))");
    args.push(pola(f.q), pola(f.q));
  }
  return halaman(DARI_PEMBELI, where, args, f, petaPesanan);
}

// D16: Order §1 + payment; R-10 customer_id dari sesi, bukan milik → 404
export async function bacaPesanan(userId: number, code: string) {
  const [[o]] = await db.query<RowDataPacket[]>(`SELECT ${DARI_PEMBELI} WHERE o.code = ? AND o.customer_id = ?`, [code, userId]);
  if (!o) throw tidakAda();
  const items = await muatItem([o.id]);
  const payment = { method: o.payment_method, status: o.payment_status, amount: o.total };
  if (o.payment_method !== "va") return { ...petaPesanan(o, items.get(o.id) ?? []), payment };
  // F10: VA null sampai pembeli memilih bank lewat POST /orders/:code/va
  const [[va]] = await db.query<RowDataPacket[]>(
    "SELECT bank, va_number, expires_at FROM payments WHERE order_id = ? AND method = 'va' ORDER BY id DESC LIMIT 1", [o.id],
  );
  return { ...petaPesanan(o, items.get(o.id) ?? []), payment: { ...payment, va: va ? { bank: va.bank, va_number: va.va_number, expires_at: va.expires_at } : null } };
}

// C-15, C-16 (D1, D8): transisi lalu bentuk terkini milik pembeli
const ubahSaya = async (userId: number, code: string, aksi: "cancel" | "complete", reason: string | null = null) => {
  await dalamTransaksi((c) => transisi(c, code, aksi, { jenis: "customer", userId }, reason));
  return bacaPesanan(userId, code);
};
export const batalkan = (userId: number, code: string, reason: string | null) => ubahSaya(userId, code, "cancel", reason);
export const selesaikan = (userId: number, code: string) => ubahSaya(userId, code, "complete");

// D15 (C-13): teks tetap bersuara pembeli; wa_template toko (bersuara penjual) dipakai GET /merchant/orders/:code/whatsapp di F07
const PESAN_PEMBELI = "Halo {toko}, saya {nama} memesan lewat KateringKita.\n\nKode: {kode}\nMenu: {menu}\nTotal: {total}\n"
  + "Cara bayar: {metode_bayar}\nAmbil di: {titik_temu}\nWaktu ambil: {waktu_ambil}";
const METODE: Record<string, string> = { qris: "QRIS", va: "Virtual Account", cod: "Tunai" };

// Nilai placeholder; format sama dengan fe/lib/wa-template.ts (Rp 30.000, HH.MM WIB / Secepatnya, Tunai)
export function nilaiWa(o: {
  code: string; customer_name: string; business_name: string; items: { qty: number; menu_name: string }[]; total: number;
  titik_temu: string; pickup_at: Date | null; payment_method: string; note: string | null;
}): Record<string, string> {
  return {
    kode: o.code, nama: o.customer_name, toko: o.business_name,
    menu: o.items.map((i) => `${i.qty}x ${i.menu_name}`).join(", "),
    total: `Rp ${o.total.toLocaleString("id-ID")}`, titik_temu: o.titik_temu,
    waktu_ambil: o.pickup_at ? `${hariAmbil(o.pickup_at)}${jamWib(o.pickup_at.getTime()).slice(0, 5).replace(":", ".")} WIB` : "Secepatnya",
    metode_bayar: METODE[o.payment_method] ?? o.payment_method, catatan: o.note ?? "",
  };
}

const fmtTanggal = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "long" });
// "3 November " bila hari ambil (WIB) bukan hari ini
const hariAmbil = (d: Date) => (hariIniWib(d) === hariIniWib(new Date(jam.sekarang())) ? "" : `${fmtTanggal.format(d)} `);

// Placeholder dikenal diganti, yang tidak dikenal dibiarkan (sama dengan fe renderTemplate)
export const render = (teks: string, nilai: Record<string, string>) => teks.replace(/\{[^{}\n]+\}/g, (k) => nilai[k.slice(1, -1)] ?? k);

// wa_number 08… / 628… / +628… → 628… (wa.me butuh kode negara tanpa +)
export const tautanWa = (nomor: string, pesan: string) =>
  `https://wa.me/${nomor.replace(/\D/g, "").replace(/^0/, "62")}?text=${encodeURIComponent(pesan)}`;

export async function waPesanan(userId: number, code: string) {
  const [[o]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.code, o.customer_name, o.total, o.pickup_at, o.payment_method, o.note, m.business_name, m.wa_number,
       p.name AS titik_temu
     FROM orders o JOIN merchants m ON m.id = o.merchant_id JOIN pickup_points p ON p.id = o.pickup_point_id
     WHERE o.code = ? AND o.customer_id = ?`,
    [code, userId],
  );
  if (!o) throw tidakAda();
  const [items] = await db.query<RowDataPacket[]>("SELECT qty, menu_name FROM order_items WHERE order_id = ? ORDER BY id", [o.id]);
  const message = render(PESAN_PEMBELI + (o.note ? "\nCatatan: {catatan}" : ""), nilaiWa({ ...o, items } as Parameters<typeof nilaiWa>[0]));
  return { wa_number: o.wa_number, message, url: tautanWa(o.wa_number, message) };
}

// F14 pesan lagi: isi pesanan lama disusun ulang lalu dicek quote (harga, opsi, stok, promo terkini; tanpa tulis).
// Klien menambah payment_method lalu mengirim `request` ke POST /orders.
export async function pesanLagi(userId: number, code: string) {
  const [[o]] = await db.query<RowDataPacket[]>("SELECT id, pickup_point_id, note FROM orders WHERE code = ? AND customer_id = ?", [code, userId]);
  if (!o) throw tidakAda();
  const items = (await muatItem([o.id])).get(o.id) ?? [];
  const request = quoteSchema.parse({
    items: items.map((i) => ({ menu_id: i.menu_id, qty: i.qty, option_ids: (i.options as { id: number }[]).map((x) => x.id) })),
    pickup_point_id: o.pickup_point_id, note: o.note,
  });
  return { request, quote: await quote(userId, request) };
}
