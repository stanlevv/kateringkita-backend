import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import { rentangHariWib } from "./admin-summary.service";
import { AppError } from "../utils/errors";
import { SISA, tokoBuka } from "./katalog.service";
import { segarkanKuota } from "./merchant-kuota.service";
import { QuoteInput } from "../dto/pesanan.dto";

// F06 keranjang (C-09, R-07): muat → periksa (urutan D3) → hitung (D1). Dipakai quote (tanpa kunci) dan buatPesanan (dalam transaksi).

type Q = Pick<PoolConnection, "query">;
export type Keranjang = { menus: Map<number, RowDataPacket>; opsi: RowDataPacket[]; toko: RowDataPacket | null };
export type Opsi = { id: number; name: string; extra_price: number };
export type Baris = {
  menu_id: number; menu_name: string; unit_label: string; qty: number; unit_price: number; hpp: number; options: Opsi[]; line_total: number; available: number;
};
export type Kurang = { index: number; menu_id: number; available: number; unit_label: string; menu_name: string };
export type Hasil = {
  merchant: RowDataPacket; baris: Baris[]; subtotal: number; discount: number; service_fee: number; total: number; kurang: Kurang[];
};

// Baca tanpa kunci; `segarkan` (pesanan) = reset kuota harian dulu (D4). Stok yang dibaca hanya untuk pesan galat:
// kebenaran stok pesanan dijaga UPDATE bersyarat di buatPesanan agar baris menu terkunci sesingkat mungkin.
export async function muatKeranjang(conn: Q, data: QuoteInput, o: { segarkan: boolean; hari: string; ms: number }): Promise<Keranjang> {
  const ids = [...new Set(data.items.map((i) => i.menu_id))];
  if (o.segarkan) {
    const [mids] = await conn.query<RowDataPacket[]>("SELECT DISTINCT merchant_id FROM menus WHERE id IN (?)", [ids]);
    if (mids.length === 1) await segarkanKuota(conn, mids[0].merchant_id, o.hari);
  }
  const [menus] = await conn.query<RowDataPacket[]>(
    `SELECT x.id, x.merchant_id, x.name, x.unit_label, x.price, x.hpp, x.is_active, x.deleted_at, x.min_order_qty, x.is_preorder,
       x.preorder_days, ${SISA} AS available
     FROM menus x WHERE x.id IN (?) ORDER BY x.id`,
    [o.hari, ids],
  );
  const [opsi] = await conn.query<RowDataPacket[]>(
    `SELECT id, menu_id, name, extra_price, is_active FROM menu_options WHERE menu_id IN (?) ORDER BY id`, [ids],
  );
  const mids = [...new Set(menus.map((m) => m.merchant_id))];
  let toko: RowDataPacket | null = null;
  if (mids.length === 1) {
    // ⑥ tanpa kunci: toko + pemilik + titik temu yang diminta + biaya layanan dalam satu kueri
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT m.id, m.business_name, m.verification_status, u.is_active AS pemilik_aktif, m.is_open, m.open_time, m.close_time,
         m.hold_minutes, m.qris_image_url, p.id AS p_id,
         (SELECT setting_value FROM app_settings WHERE setting_key = 'service_fee') AS service_fee
       FROM merchants m JOIN users u ON u.id = m.user_id
       LEFT JOIN merchant_pickup_points mp ON mp.merchant_id = m.id AND mp.pickup_point_id = ?
       LEFT JOIN pickup_points p ON p.id = mp.pickup_point_id AND p.is_active
       WHERE m.id = ?`,
      [data.pickup_point_id, mids[0]],
    );
    toko = rows[0] ?? null;
  }
  return { menus: new Map(menus.map((m) => [m.id as number, m])), opsi, toko };
}

const salah = (fields: Record<string, string[]>) => {
  if (Object.keys(fields).length) throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fields);
};
const jamTitik = (t: unknown) => String(t).slice(0, 5).replace(":", ".");
const HARI = 86400e3;

// Urutan D3 tanpa stok & promo: stok dikembalikan di `kurang` (quote = peringatan, pesanan = 409), promo dicek pemanggil.
export function periksa(k: Keranjang, data: QuoteInput, ms: number): Hasil {
  const f: Record<string, string[]> = {};
  data.items.forEach((it, i) => {
    const m = k.menus.get(it.menu_id);
    if (!m || !m.is_active || m.deleted_at) f[`items.${i}.menu_id`] = ["Menu tidak tersedia."];
  });
  salah(f);
  if (new Set([...k.menus.values()].map((m) => m.merchant_id)).size > 1) salah({ items: ["Semua menu harus dari satu toko."] });
  const t = k.toko!;
  if (t.verification_status !== "verified" || !t.pemilik_aktif) {
    throw new AppError(409, "MERCHANT_UNAVAILABLE", "Toko ini sedang tidak menerima pesanan.");
  }
  if (!tokoBuka(t, ms)) {
    throw new AppError(409, "MERCHANT_CLOSED", `Toko sedang tutup. Buka pukul ${jamTitik(t.open_time)}–${jamTitik(t.close_time)} WIB.`);
  }
  if (!t.p_id) salah({ pickup_point_id: ["Titik temu tidak dilayani toko ini."] });

  const ambil = data.pickup_at ? Date.parse(data.pickup_at) : null;
  if (ambil !== null && (ambil <= ms || ambil > ms + 7 * HARI)) {
    salah({ pickup_at: ["Waktu ambil harus di masa depan, paling lambat 7 hari lagi."] });
  }
  const po = Math.max(-1, ...[...k.menus.values()].filter((m) => m.is_preorder).map((m) => Number(m.preorder_days)));
  // shortcut: stok pre-order memakai kuota hari pesan; buat kuota per tanggal ambil bila penjual menjual pre-order dalam jumlah besar
  if (po >= 0 && (ambil === null || ambil < rentangHariWib(ms + po * HARI).from.getTime())) {
    salah({ pickup_at: [`Menu pre-order harus diambil paling cepat H-${po}.`] });
  }

  // qty dijumlah per menu (baris boleh menu sama dengan opsi berbeda); galat di baris pertama menu itu
  const pertama = new Map<number, number>();
  const jumlah = new Map<number, number>();
  data.items.forEach((it, i) => {
    if (!pertama.has(it.menu_id)) pertama.set(it.menu_id, i);
    jumlah.set(it.menu_id, (jumlah.get(it.menu_id) ?? 0) + it.qty);
  });
  for (const [mid, n] of jumlah) {
    const m = k.menus.get(mid)!;
    if (n < m.min_order_qty) f[`items.${pertama.get(mid)}.qty`] = [`Minimal pesan ${m.min_order_qty} ${m.unit_label}.`];
  }
  salah(f);

  const baris: Baris[] = data.items.map((it, i) => {
    const m = k.menus.get(it.menu_id)!;
    const options: Opsi[] = it.option_ids.map((oid) => {
      const o = k.opsi.find((x) => x.id === oid && x.menu_id === it.menu_id && x.is_active);
      if (!o) f[`items.${i}.option_ids`] = ["Pilihan tidak tersedia."];
      return { id: oid, name: o?.name, extra_price: o?.extra_price ?? 0 };
    });
    const unit_price = m.price + options.reduce((s, o) => s + o.extra_price, 0);
    return {
      menu_id: m.id, menu_name: m.name, unit_label: m.unit_label, qty: it.qty, unit_price, hpp: m.hpp, options, line_total: unit_price * it.qty,
      available: Number(m.available),
    };
  });
  salah(f);

  const kurang: Kurang[] = [];
  for (const [mid, n] of jumlah) {
    const m = k.menus.get(mid)!;
    if (n > Number(m.available)) {
      kurang.push({ index: pertama.get(mid)!, menu_id: mid, available: Number(m.available), unit_label: m.unit_label, menu_name: m.name });
    }
  }
  const subtotal = baris.reduce((s, b) => s + b.line_total, 0);
  const service_fee = /^\d+$/.test(String(t.service_fee ?? "")) ? Number(t.service_fee) : 0;
  // kolom uang INT; total ≥ setiap line_total & subtotal, jadi satu cek cukup
  if (subtotal + service_fee > 2_147_483_647) salah({ items: ["Total pesanan terlalu besar. Kurangi jumlah pesanan."] });
  return { merchant: t, baris, subtotal, discount: 0, service_fee, total: subtotal + service_fee, kurang };
}

export const tolakPromo = (pesan: string) => new AppError(422, "PROMO_INVALID", pesan, { promo_code: [pesan] });

// F12 (D10): promo platform (merchant_id NULL) atau promo toko ini; posisi setelah stok (D3). Mengisi discount & total di `h`.
// Tanpa kunci: kuota diklaim atomik oleh buatPesanan; batas per pembeli aman karena baris users pembeli sudah dikunci.
export async function terapkanPromo(conn: Q, h: Hasil, code: string | null, userId: number, ms: number) {
  if (!code) return null;
  const [[p]] = await conn.query<RowDataPacket[]>(
    "SELECT * FROM promos WHERE code = ? AND (merchant_id IS NULL OR merchant_id = ?)", [code.toUpperCase(), h.merchant.id],
  );
  if (!p || !p.is_active) throw tolakPromo("Kode promo tidak ditemukan.");
  if (ms < new Date(p.starts_at).getTime() || ms >= new Date(p.ends_at).getTime()) throw tolakPromo("Promo sedang tidak berlaku.");
  if (p.quota !== null && p.used_count >= p.quota) throw tolakPromo("Kuota promo sudah habis.");
  if (h.subtotal < p.min_subtotal) throw tolakPromo(`Minimal belanja Rp ${Number(p.min_subtotal).toLocaleString("id-ID")} untuk promo ini.`);
  const [[n]] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM promo_redemptions WHERE promo_id = ? AND user_id = ?", [p.id, userId]);
  if (Number(n.n) >= p.per_user_limit) throw tolakPromo("Promo ini sudah mencapai batas pemakaianmu.");
  h.discount = p.type === "percent" ? Math.min(Math.floor((h.subtotal * p.value) / 100), p.max_discount ?? Infinity)
    : p.type === "fixed" ? Math.min(p.value, h.subtotal) : h.service_fee;
  h.total = h.subtotal + h.service_fee - h.discount;
  return p.id as number;
}
