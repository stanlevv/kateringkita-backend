// Logika keranjang bersama untuk quote, checkout pembeli, dan pesanan meja: muat data menu/toko, periksa aturan,
// hitung harga, dan terapkan voucher. Dipanggil order.service dan table.service. Satu-satunya tulisan ke database:
// loadCart dengan `segarkan: true` (checkout dan pesanan meja) memanggil segarkanKuota, yang me-reset kuota harian
// menu toko (UPDATE menus) bila tanggal stoknya sudah lewat; quote tidak menulis apa pun.
import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import { rentangHariWib } from "./admin-summary.service";
import { AppError } from "../utils/errors";
import { SISA, tokoBuka } from "./katalog.service";
import { segarkanKuota } from "./merchant-kuota.service";
import { QuoteInput } from "../dto/order.dto";

// F06 keranjang (C-09, R-07): muat → periksa (urutan D3) → hitung (D1). Dipakai quote (tanpa kunci) dan createOrder (dalam transaksi).

type Q = Pick<PoolConnection, "query">;
/** Data mentah keranjang dari DB: baris menu per id, opsi menu (`opsi`), dan toko + titik temu (`toko`, null bila menu dari >1 toko). */
export type Cart = { menus: Map<number, RowDataPacket>; opsi: RowDataPacket[]; toko: RowDataPacket | null };
/** Opsi yang dipilih pada satu baris, dengan harga tambahannya. */
export type CartOption = { id: number; name: string; extra_price: number };
/** Satu baris keranjang yang sudah dihargai; `hpp` hanya untuk disalin ke order_items, tidak pernah dikirim ke klien (R-11). */
export type CartLine = {
  menu_id: number;
  menu_name: string;
  unit_label: string;
  qty: number;
  unit_price: number;
  hpp: number;
  options: CartOption[];
  line_total: number;
  available: number;
};
/** Menu yang jumlah pesanannya melebihi sisa stok; `index` = baris pertama menu itu di body (untuk kunci galat). */
export type Shortage = { index: number; menu_id: number; available: number; unit_label: string; menu_name: string };
/**
 * Hasil {@link validateCart}: toko, baris (`baris`), rincian uang, dan daftar kekurangan stok (`kurang`).
 * Field diskon dan total diisi ulang oleh {@link applyVouchers}.
 */
export type PricedCart = {
  merchant: RowDataPacket;
  baris: CartLine[];
  subtotal: number;
  discount: number;
  merchant_discount: number;
  platform_discount: number;
  service_fee: number;
  total: number;
  kurang: Shortage[];
};

/**
 * Muat menu, opsi, dan toko yang dirujuk keranjang dalam 3–4 kueri.
 * Baca tanpa kunci; `segarkan` (pesanan) = reset kuota harian dulu (D4). Stok yang dibaca hanya untuk pesan galat:
 * kebenaran stok pesanan dijaga UPDATE bersyarat di createOrder agar baris menu terkunci sesingkat mungkin.
 *
 * @param conn koneksi biasa (quote) atau koneksi transaksi (checkout)
 * @param o `segarkan` reset kuota harian dulu, `hari` tanggal stok WIB `YYYY-MM-DD`, `ms` waktu sekarang
 */
export async function loadCart(
  conn: Q,
  data: QuoteInput,
  o: { segarkan: boolean; hari: string; ms: number },
): Promise<Cart> {
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
  const [menuOptions] = await conn.query<RowDataPacket[]>(
    `SELECT id, menu_id, name, extra_price, is_active FROM menu_options WHERE menu_id IN (?) ORDER BY id`,
    [ids],
  );
  const mids = [...new Set(menus.map((m) => m.merchant_id))];
  let merchantRow: RowDataPacket | null = null;
  if (mids.length === 1) {
    // ⑥ tanpa kunci: toko + pemilik + titik temu yang diminta + biaya layanan dalam satu kueri
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT m.id, m.business_name, m.verification_status, u.is_active AS pemilik_aktif, m.is_open, m.open_time, m.close_time,
         m.hold_minutes, p.id AS p_id,
         (SELECT setting_value FROM app_settings WHERE setting_key = 'service_fee') AS service_fee
       FROM merchants m JOIN users u ON u.id = m.user_id
       LEFT JOIN merchant_pickup_points mp ON mp.merchant_id = m.id AND mp.pickup_point_id = ?
       LEFT JOIN pickup_points p ON p.id = mp.pickup_point_id AND p.is_active
       WHERE m.id = ?`,
      [data.pickup_point_id, mids[0]],
    );
    merchantRow = rows[0] ?? null;
  }
  return { menus: new Map(menus.map((m) => [m.id as number, m])), opsi: menuOptions, toko: merchantRow };
}

const throwIfInvalid = (fields: Record<string, string[]>) => {
  if (Object.keys(fields).length) throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fields);
};
const formatHour = (t: unknown) => String(t).slice(0, 5).replace(":", ".");
const DAY_MS = 86400e3;

/**
 * Periksa keranjang lalu hitung harganya. Urutan cek (D3): menu ada & aktif, satu toko, toko terverifikasi dan
 * pemiliknya aktif, toko sedang buka, titik temu dilayani toko, waktu ambil (masa depan, maks 7 hari; pre-order
 * paling cepat H-n), minimal pesan per menu, opsi valid, dan total muat di kolom INT.
 * Urutan D3 tanpa stok & promo: stok dikembalikan di `kurang` (quote = peringatan, pesanan = 409), promo dicek pemanggil.
 * F21: pesanan meja tidak memakai titik temu (`tanpaTitikTemu`).
 *
 * @returns keranjang berharga dengan diskon 0 dan total = subtotal + biaya layanan
 * @throws AppError 400 VALIDATION_ERROR (galat per field), 409 MERCHANT_UNAVAILABLE, 409 MERCHANT_CLOSED
 */
export function validateCart(k: Cart, data: QuoteInput, ms: number, o: { tanpaTitikTemu?: boolean } = {}): PricedCart {
  const f: Record<string, string[]> = {};
  data.items.forEach((it, i) => {
    const m = k.menus.get(it.menu_id);
    if (!m || !m.is_active || m.deleted_at) f[`items.${i}.menu_id`] = ["Menu tidak tersedia."];
  });
  throwIfInvalid(f);
  if (new Set([...k.menus.values()].map((m) => m.merchant_id)).size > 1)
    throwIfInvalid({ items: ["Semua menu harus dari satu toko."] });
  const t = k.toko!;
  if (t.verification_status !== "verified" || !t.pemilik_aktif) {
    throw new AppError(409, "MERCHANT_UNAVAILABLE", "Toko ini sedang tidak menerima pesanan.");
  }
  if (!tokoBuka(t, ms)) {
    throw new AppError(
      409,
      "MERCHANT_CLOSED",
      `Toko sedang tutup. Buka pukul ${formatHour(t.open_time)}–${formatHour(t.close_time)} WIB.`,
    );
  }
  if (!o.tanpaTitikTemu && !t.p_id) throwIfInvalid({ pickup_point_id: ["Titik temu tidak dilayani toko ini."] });

  const pickupMs = data.pickup_at ? Date.parse(data.pickup_at) : null;
  if (pickupMs !== null && (pickupMs <= ms || pickupMs > ms + 7 * DAY_MS)) {
    throwIfInvalid({ pickup_at: ["Waktu ambil harus di masa depan, paling lambat 7 hari lagi."] });
  }
  const po = Math.max(-1, ...[...k.menus.values()].filter((m) => m.is_preorder).map((m) => Number(m.preorder_days)));
  // shortcut: stok pre-order memakai kuota hari pesan; buat kuota per tanggal ambil bila penjual menjual pre-order dalam jumlah besar
  if (po >= 0 && (pickupMs === null || pickupMs < rentangHariWib(ms + po * DAY_MS).from.getTime())) {
    throwIfInvalid({ pickup_at: [`Menu pre-order harus diambil paling cepat H-${po}.`] });
  }

  // qty dijumlah per menu (baris boleh menu sama dengan opsi berbeda); galat di baris pertama menu itu
  const firstIndex = new Map<number, number>();
  const qtyByMenu = new Map<number, number>();
  data.items.forEach((it, i) => {
    if (!firstIndex.has(it.menu_id)) firstIndex.set(it.menu_id, i);
    qtyByMenu.set(it.menu_id, (qtyByMenu.get(it.menu_id) ?? 0) + it.qty);
  });
  for (const [mid, n] of qtyByMenu) {
    const m = k.menus.get(mid)!;
    if (n < m.min_order_qty)
      f[`items.${firstIndex.get(mid)}.qty`] = [`Minimal pesan ${m.min_order_qty} ${m.unit_label}.`];
  }
  throwIfInvalid(f);

  const lines: CartLine[] = data.items.map((it, i) => {
    const m = k.menus.get(it.menu_id)!;
    const options: CartOption[] = it.option_ids.map((oid) => {
      const o = k.opsi.find((x) => x.id === oid && x.menu_id === it.menu_id && x.is_active);
      if (!o) f[`items.${i}.option_ids`] = ["Pilihan tidak tersedia."];
      return { id: oid, name: o?.name, extra_price: o?.extra_price ?? 0 };
    });
    const unit_price = m.price + options.reduce((s, o) => s + o.extra_price, 0);
    return {
      menu_id: m.id,
      menu_name: m.name,
      unit_label: m.unit_label,
      qty: it.qty,
      unit_price,
      hpp: m.hpp,
      options,
      line_total: unit_price * it.qty,
      available: Number(m.available),
    };
  });
  throwIfInvalid(f);

  const shortages: Shortage[] = [];
  for (const [mid, n] of qtyByMenu) {
    const m = k.menus.get(mid)!;
    if (n > Number(m.available)) {
      shortages.push({
        index: firstIndex.get(mid)!,
        menu_id: mid,
        available: Number(m.available),
        unit_label: m.unit_label,
        menu_name: m.name,
      });
    }
  }
  const subtotal = lines.reduce((s, b) => s + b.line_total, 0);
  const service_fee = /^\d+$/.test(String(t.service_fee ?? "")) ? Number(t.service_fee) : 0;
  // kolom uang INT; total ≥ setiap line_total & subtotal, jadi satu cek cukup
  if (subtotal + service_fee > 2_147_483_647)
    throwIfInvalid({ items: ["Total pesanan terlalu besar. Kurangi jumlah pesanan."] });
  return {
    merchant: t,
    baris: lines,
    subtotal,
    discount: 0,
    merchant_discount: 0,
    platform_discount: 0,
    service_fee,
    total: subtotal + service_fee,
    kurang: shortages,
  };
}

/**
 * Buat galat 422 PROMO_INVALID dengan pesan `message`.
 * Galat dikirim di promo_codes (klien baru) dan promo_code (klien lama dengan satu isian kode).
 */
export const promoInvalid = (message: string) =>
  new AppError(422, "PROMO_INVALID", message, { promo_codes: [message], promo_code: [message] });

/** Kode voucher dari body: promo_codes[] + promo_code lama → huruf besar, unik. */
export const parseVoucherCodes = (d: { promo_code?: string | null; promo_codes?: string[] }) => [
  ...new Set(
    [...(d.promo_codes ?? []), ...(d.promo_code ? [d.promo_code] : [])]
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean),
  ),
];

// Syarat satu promo (D10): aktif, periode, kuota, minimal belanja (dibanding subtotal sebelum diskon), batas per pembeli.
// Tanpa kunci: kuota diklaim atomik oleh createOrder; batas per pembeli aman karena baris users pembeli sudah dikunci.
async function validatePromo(conn: Q, p: RowDataPacket, h: PricedCart, userId: number, ms: number) {
  if (!p.is_active) throw promoInvalid("Kode promo tidak ditemukan.");
  if (ms < new Date(p.starts_at).getTime() || ms >= new Date(p.ends_at).getTime())
    throw promoInvalid("Promo sedang tidak berlaku.");
  if (p.quota !== null && p.used_count >= p.quota) throw promoInvalid("Kuota promo sudah habis.");
  if (h.subtotal < p.min_subtotal)
    throw promoInvalid(`Minimal belanja Rp ${Number(p.min_subtotal).toLocaleString("id-ID")} untuk promo ini.`);
  const [[n]] = await conn.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM promo_redemptions WHERE promo_id = ? AND user_id = ?",
    [p.id, userId],
  );
  if (Number(n.n) >= p.per_user_limit) throw promoInvalid("Promo ini sudah mencapai batas pemakaianmu.");
}

// percent/fixed dari `base` (barang setelah potongan sebelumnya), free_service_fee = biaya layanan
const calculateDiscount = (p: RowDataPacket, base: number, fee: number) =>
  p.type === "percent"
    ? Math.min(Math.floor((base * p.value) / 100), p.max_discount ?? Infinity)
    : p.type === "fixed"
      ? Math.min(p.value, base)
      : fee;

/**
 * Voucher (rancangan 2026-11-16): maks satu voucher toko (promo toko pesanan ini) + satu voucher platform (merchant_id NULL).
 * Toko dihitung dulu dari subtotal, platform dari sisa barang. Mengisi merchant_discount, platform_discount, discount, total.
 * `paymentMethod` (pesanan): voucher platform hanya untuk non-tunai (C1); quote tanpa metode bayar tidak dicek.
 * Tiap voucher dicek aktif, periode, kuota, minimal belanja, dan batas per pembeli (D10). Kuota belum diklaim di sini:
 * klaim atomik dilakukan createOrder.
 *
 * @param h keranjang dari {@link validateCart}; field diskon dan total-nya diubah langsung
 * @param codes kode voucher dari {@link parseVoucherCodes}
 * @returns baris promo yang dipakai: `toko` dan `platform` (null bila tidak ada)
 * @throws AppError 422 PROMO_INVALID bila kode tidak ada, lebih dari 2, slot ganda, syarat tidak terpenuhi, atau total jadi Rp 0
 */
export async function applyVouchers(
  conn: Q,
  h: PricedCart,
  codes: string[],
  userId: number,
  ms: number,
  paymentMethod?: "cod" | "va" | "online",
) {
  let merchantPromo: RowDataPacket | null = null;
  let platform: RowDataPacket | null = null;
  if (codes.length > 2) throw promoInvalid("Maksimal 2 voucher per pesanan.");
  if (codes.length) {
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT * FROM promos WHERE code IN (?) AND (merchant_id IS NULL OR merchant_id = ?)",
      [codes, h.merchant.id],
    );
    const promosByCode = new Map(rows.map((p) => [String(p.code), p]));
    for (const c of codes) {
      const p = promosByCode.get(c);
      if (!p) throw promoInvalid("Kode promo tidak ditemukan.");
      if (p.merchant_id === null) {
        if (platform) throw promoInvalid("Hanya satu voucher platform per pesanan.");
        platform = p;
      } else {
        if (merchantPromo) throw promoInvalid("Hanya satu voucher toko per pesanan.");
        merchantPromo = p;
      }
    }
    for (const p of [merchantPromo, platform]) if (p) await validatePromo(conn, p, h, userId, ms);
    if (platform && paymentMethod === "cod") throw promoInvalid("Voucher platform hanya untuk bayar non-tunai.");
    if (merchantPromo?.type === "free_service_fee" && platform?.type === "free_service_fee")
      throw promoInvalid("Biaya layanan sudah digratiskan voucher lain.");
  }
  h.merchant_discount = merchantPromo ? calculateDiscount(merchantPromo, h.subtotal, h.service_fee) : 0;
  const remainingSubtotal = h.subtotal - (merchantPromo?.type === "free_service_fee" ? 0 : h.merchant_discount);
  h.platform_discount = platform ? calculateDiscount(platform, remainingSubtotal, h.service_fee) : 0;
  h.discount = h.merchant_discount + h.platform_discount;
  h.total = Math.max(0, h.subtotal + h.service_fee - h.discount);
  // voucher platform hanya non-tunai (C1), dan Midtrans tidak menerima tagihan Rp 0
  if (platform && h.platform_discount > 0 && h.total <= 0)
    throw promoInvalid("Total pesanan jadi Rp 0. Lepas voucher platform.");
  return { toko: merchantPromo, platform };
}

/** Untuk respons quote (`vouchers_applied`): voucher yang terpakai per slot (`toko`/`platform`) beserta potongannya. */
export const appliedVouchers = (h: PricedCart, v: { toko: RowDataPacket | null; platform: RowDataPacket | null }) => [
  ...(v.toko
    ? [{ id: v.toko.id as number, code: String(v.toko.code), slot: "toko" as const, amount: h.merchant_discount }]
    : []),
  ...(v.platform
    ? [
        {
          id: v.platform.id as number,
          code: String(v.platform.code),
          slot: "platform" as const,
          amount: h.platform_discount,
        },
      ]
    : []),
];
