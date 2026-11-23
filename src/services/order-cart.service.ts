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

type Queryable = Pick<PoolConnection, "query">;
/** Data mentah keranjang dari DB: baris menu per id, opsi menu (`opsi`), dan toko + titik temu (`toko`, null bila menu dari >1 toko). */
export type Cart = { menus: Map<number, RowDataPacket>; options: RowDataPacket[]; merchant: RowDataPacket | null };
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
  lines: CartLine[];
  subtotal: number;
  discount: number;
  merchant_discount: number;
  platform_discount: number;
  service_fee: number;
  total: number;
  shortages: Shortage[];
};

/**
 * Muat menu, opsi, dan toko yang dirujuk keranjang dalam 3–4 kueri.
 * Baca tanpa kunci; `segarkan` (pesanan) = reset kuota harian dulu (D4). Stok yang dibaca hanya untuk pesan galat:
 * kebenaran stok pesanan dijaga UPDATE bersyarat di createOrder agar baris menu terkunci sesingkat mungkin.
 *
 * @param conn koneksi biasa (quote) atau koneksi transaksi (checkout)
 * @param options `segarkan` reset kuota harian dulu, `hari` tanggal stok WIB `YYYY-MM-DD`, `ms` waktu sekarang
 */
export async function loadCart(
  conn: Queryable,
  data: QuoteInput,
  options: { refresh: boolean; day: string; nowMs: number },
): Promise<Cart> {
  const menuIds = [...new Set(data.items.map((item) => item.menu_id))];
  if (options.refresh) {
    const [merchantIds] = await conn.query<RowDataPacket[]>("SELECT DISTINCT merchant_id FROM menus WHERE id IN (?)", [
      menuIds,
    ]);
    if (merchantIds.length === 1) await segarkanKuota(conn, merchantIds[0].merchant_id, options.day);
  }
  const [menus] = await conn.query<RowDataPacket[]>(
    `SELECT x.id, x.merchant_id, x.name, x.unit_label, x.price, x.hpp, x.is_active, x.deleted_at, x.min_order_qty, x.is_preorder,
       x.preorder_days, ${SISA} AS available
     FROM menus x WHERE x.id IN (?) ORDER BY x.id`,
    [options.day, menuIds],
  );
  const [menuOptions] = await conn.query<RowDataPacket[]>(
    `SELECT id, menu_id, name, extra_price, is_active FROM menu_options WHERE menu_id IN (?) ORDER BY id`,
    [menuIds],
  );
  const merchantIds = [...new Set(menus.map((menu) => menu.merchant_id))];
  let merchantRow: RowDataPacket | null = null;
  if (merchantIds.length === 1) {
    // ⑥ tanpa kunci: toko + pemilik + titik temu yang diminta + biaya layanan dalam satu kueri
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT m.id, m.business_name, m.verification_status, u.is_active AS pemilik_aktif, m.is_open, m.open_time, m.close_time,
         m.hold_minutes, p.id AS p_id,
         (SELECT setting_value FROM app_settings WHERE setting_key = 'service_fee') AS service_fee
       FROM merchants m JOIN users u ON u.id = m.user_id
       LEFT JOIN merchant_pickup_points mp ON mp.merchant_id = m.id AND mp.pickup_point_id = ?
       LEFT JOIN pickup_points p ON p.id = mp.pickup_point_id AND p.is_active
       WHERE m.id = ?`,
      [data.pickup_point_id, merchantIds[0]],
    );
    merchantRow = rows[0] ?? null;
  }
  return {
    menus: new Map(menus.map((menu) => [menu.id as number, menu])),
    options: menuOptions,
    merchant: merchantRow,
  };
}

const throwIfInvalid = (fields: Record<string, string[]>) => {
  if (Object.keys(fields).length) throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fields);
};
const formatHour = (time: unknown) => String(time).slice(0, 5).replace(":", ".");
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
export function validateCart(
  cart: Cart,
  data: QuoteInput,
  nowMs: number,
  settings: { skipPickupPoint?: boolean } = {},
): PricedCart {
  const fieldErrors: Record<string, string[]> = {};
  data.items.forEach((item, i) => {
    const menu = cart.menus.get(item.menu_id);
    if (!menu || !menu.is_active || menu.deleted_at) fieldErrors[`items.${i}.menu_id`] = ["Menu tidak tersedia."];
  });
  throwIfInvalid(fieldErrors);
  if (new Set([...cart.menus.values()].map((menu) => menu.merchant_id)).size > 1)
    throwIfInvalid({ items: ["Semua menu harus dari satu toko."] });
  const merchant = cart.merchant!;
  if (merchant.verification_status !== "verified" || !merchant.pemilik_aktif) {
    throw new AppError(409, "MERCHANT_UNAVAILABLE", "Toko ini sedang tidak menerima pesanan.");
  }
  if (!tokoBuka(merchant, nowMs)) {
    throw new AppError(
      409,
      "MERCHANT_CLOSED",
      `Toko sedang tutup. Buka pukul ${formatHour(merchant.open_time)}–${formatHour(merchant.close_time)} WIB.`,
    );
  }
  if (!settings.skipPickupPoint && !merchant.p_id)
    throwIfInvalid({ pickup_point_id: ["Titik temu tidak dilayani toko ini."] });

  const pickupMs = data.pickup_at ? Date.parse(data.pickup_at) : null;
  if (pickupMs !== null && (pickupMs <= nowMs || pickupMs > nowMs + 7 * DAY_MS)) {
    throwIfInvalid({ pickup_at: ["Waktu ambil harus di masa depan, paling lambat 7 hari lagi."] });
  }
  const preorderDays = Math.max(
    -1,
    ...[...cart.menus.values()].filter((menu) => menu.is_preorder).map((menu) => Number(menu.preorder_days)),
  );
  // shortcut: stok pre-order memakai kuota hari pesan; buat kuota per tanggal ambil bila penjual menjual pre-order dalam jumlah besar
  if (
    preorderDays >= 0 &&
    (pickupMs === null || pickupMs < rentangHariWib(nowMs + preorderDays * DAY_MS).from.getTime())
  ) {
    throwIfInvalid({ pickup_at: [`Menu pre-order harus diambil paling cepat H-${preorderDays}.`] });
  }

  // qty dijumlah per menu (baris boleh menu sama dengan opsi berbeda); galat di baris pertama menu itu
  const firstIndex = new Map<number, number>();
  const qtyByMenu = new Map<number, number>();
  data.items.forEach((item, i) => {
    if (!firstIndex.has(item.menu_id)) firstIndex.set(item.menu_id, i);
    qtyByMenu.set(item.menu_id, (qtyByMenu.get(item.menu_id) ?? 0) + item.qty);
  });
  for (const [menuId, totalQty] of qtyByMenu) {
    const menu = cart.menus.get(menuId)!;
    if (totalQty < menu.min_order_qty)
      fieldErrors[`items.${firstIndex.get(menuId)}.qty`] = [`Minimal pesan ${menu.min_order_qty} ${menu.unit_label}.`];
  }
  throwIfInvalid(fieldErrors);

  const lines: CartLine[] = data.items.map((item, i) => {
    const menu = cart.menus.get(item.menu_id)!;
    const options: CartOption[] = item.option_ids.map((optionId) => {
      const option = cart.options.find(
        (optionRow) => optionRow.id === optionId && optionRow.menu_id === item.menu_id && optionRow.is_active,
      );
      if (!option) fieldErrors[`items.${i}.option_ids`] = ["Pilihan tidak tersedia."];
      return { id: optionId, name: option?.name, extra_price: option?.extra_price ?? 0 };
    });
    const unit_price = menu.price + options.reduce((sum, option) => sum + option.extra_price, 0);
    return {
      menu_id: menu.id,
      menu_name: menu.name,
      unit_label: menu.unit_label,
      qty: item.qty,
      unit_price,
      hpp: menu.hpp,
      options,
      line_total: unit_price * item.qty,
      available: Number(menu.available),
    };
  });
  throwIfInvalid(fieldErrors);

  const shortages: Shortage[] = [];
  for (const [menuId, totalQty] of qtyByMenu) {
    const menu = cart.menus.get(menuId)!;
    if (totalQty > Number(menu.available)) {
      shortages.push({
        index: firstIndex.get(menuId)!,
        menu_id: menuId,
        available: Number(menu.available),
        unit_label: menu.unit_label,
        menu_name: menu.name,
      });
    }
  }
  const subtotal = lines.reduce((sum, line) => sum + line.line_total, 0);
  const service_fee = /^\d+$/.test(String(merchant.service_fee ?? "")) ? Number(merchant.service_fee) : 0;
  // kolom uang INT; total ≥ setiap line_total & subtotal, jadi satu cek cukup
  if (subtotal + service_fee > 2_147_483_647)
    throwIfInvalid({ items: ["Total pesanan terlalu besar. Kurangi jumlah pesanan."] });
  return {
    merchant,
    lines,
    subtotal,
    discount: 0,
    merchant_discount: 0,
    platform_discount: 0,
    service_fee,
    total: subtotal + service_fee,
    shortages,
  };
}

/**
 * Buat galat 422 PROMO_INVALID dengan pesan `message`.
 * Galat dikirim di promo_codes (klien baru) dan promo_code (klien lama dengan satu isian kode).
 */
export const promoInvalid = (message: string) =>
  new AppError(422, "PROMO_INVALID", message, { promo_codes: [message], promo_code: [message] });

/** Kode voucher dari body: promo_codes[] + promo_code lama → huruf besar, unik. */
export const parseVoucherCodes = (body: { promo_code?: string | null; promo_codes?: string[] }) => [
  ...new Set(
    [...(body.promo_codes ?? []), ...(body.promo_code ? [body.promo_code] : [])]
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean),
  ),
];

// Syarat satu promo (D10): aktif, periode, kuota, minimal belanja (dibanding subtotal sebelum diskon), batas per pembeli.
// Tanpa kunci: kuota diklaim atomik oleh createOrder; batas per pembeli aman karena baris users pembeli sudah dikunci.
async function validatePromo(conn: Queryable, promo: RowDataPacket, cart: PricedCart, userId: number, nowMs: number) {
  if (!promo.is_active) throw promoInvalid("Kode promo tidak ditemukan.");
  if (nowMs < new Date(promo.starts_at).getTime() || nowMs >= new Date(promo.ends_at).getTime())
    throw promoInvalid("Promo sedang tidak berlaku.");
  if (promo.quota !== null && promo.used_count >= promo.quota) throw promoInvalid("Kuota promo sudah habis.");
  if (cart.subtotal < promo.min_subtotal)
    throw promoInvalid(`Minimal belanja Rp ${Number(promo.min_subtotal).toLocaleString("id-ID")} untuk promo ini.`);
  const [[countRow]] = await conn.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM promo_redemptions WHERE promo_id = ? AND user_id = ?",
    [promo.id, userId],
  );
  if (Number(countRow.n) >= promo.per_user_limit) throw promoInvalid("Promo ini sudah mencapai batas pemakaianmu.");
}

// percent/fixed dari `base` (barang setelah potongan sebelumnya), free_service_fee = biaya layanan
const calculateDiscount = (promo: RowDataPacket, base: number, serviceFee: number) =>
  promo.type === "percent"
    ? Math.min(Math.floor((base * promo.value) / 100), promo.max_discount ?? Infinity)
    : promo.type === "fixed"
      ? Math.min(promo.value, base)
      : serviceFee;

/**
 * Voucher (rancangan 2026-11-16): maks satu voucher toko (promo toko pesanan ini) + satu voucher platform (merchant_id NULL).
 * Toko dihitung dulu dari subtotal, platform dari sisa barang. Mengisi merchant_discount, platform_discount, discount, total.
 * `paymentMethod` (pesanan): voucher platform hanya untuk non-tunai (C1); quote tanpa metode bayar tidak dicek.
 * Tiap voucher dicek aktif, periode, kuota, minimal belanja, dan batas per pembeli (D10). Kuota belum diklaim di sini:
 * klaim atomik dilakukan createOrder.
 *
 * @param cart keranjang dari {@link validateCart}; field diskon dan total-nya diubah langsung
 * @param codes kode voucher dari {@link parseVoucherCodes}
 * @returns baris promo yang dipakai: `toko` dan `platform` (null bila tidak ada)
 * @throws AppError 422 PROMO_INVALID bila kode tidak ada, lebih dari 2, slot ganda, syarat tidak terpenuhi, atau total jadi Rp 0
 */
export async function applyVouchers(
  conn: Queryable,
  cart: PricedCart,
  codes: string[],
  userId: number,
  nowMs: number,
  paymentMethod?: "cod" | "va" | "online",
) {
  let merchantPromo: RowDataPacket | null = null;
  let platformPromo: RowDataPacket | null = null;
  if (codes.length > 2) throw promoInvalid("Maksimal 2 voucher per pesanan.");
  if (codes.length) {
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT * FROM promos WHERE code IN (?) AND (merchant_id IS NULL OR merchant_id = ?)",
      [codes, cart.merchant.id],
    );
    const promosByCode = new Map(rows.map((promo) => [String(promo.code), promo]));
    for (const code of codes) {
      const promo = promosByCode.get(code);
      if (!promo) throw promoInvalid("Kode promo tidak ditemukan.");
      if (promo.merchant_id === null) {
        if (platformPromo) throw promoInvalid("Hanya satu voucher platform per pesanan.");
        platformPromo = promo;
      } else {
        if (merchantPromo) throw promoInvalid("Hanya satu voucher toko per pesanan.");
        merchantPromo = promo;
      }
    }
    for (const promo of [merchantPromo, platformPromo])
      if (promo) await validatePromo(conn, promo, cart, userId, nowMs);
    if (platformPromo && paymentMethod === "cod") throw promoInvalid("Voucher platform hanya untuk bayar non-tunai.");
    if (merchantPromo?.type === "free_service_fee" && platformPromo?.type === "free_service_fee")
      throw promoInvalid("Biaya layanan sudah digratiskan voucher lain.");
  }
  cart.merchant_discount = merchantPromo ? calculateDiscount(merchantPromo, cart.subtotal, cart.service_fee) : 0;
  const remainingSubtotal = cart.subtotal - (merchantPromo?.type === "free_service_fee" ? 0 : cart.merchant_discount);
  cart.platform_discount = platformPromo ? calculateDiscount(platformPromo, remainingSubtotal, cart.service_fee) : 0;
  cart.discount = cart.merchant_discount + cart.platform_discount;
  cart.total = Math.max(0, cart.subtotal + cart.service_fee - cart.discount);
  // voucher platform hanya non-tunai (C1), dan Midtrans tidak menerima tagihan Rp 0
  if (platformPromo && cart.platform_discount > 0 && cart.total <= 0)
    throw promoInvalid("Total pesanan jadi Rp 0. Lepas voucher platform.");
  return { merchantPromo, platformPromo };
}

/** Untuk respons quote (`vouchers_applied`): voucher yang terpakai per slot (`toko`/`platform`) beserta potongannya. */
export const appliedVouchers = (
  cart: PricedCart,
  vouchers: { merchantPromo: RowDataPacket | null; platformPromo: RowDataPacket | null },
) => [
  ...(vouchers.merchantPromo
    ? [
        {
          id: vouchers.merchantPromo.id as number,
          code: String(vouchers.merchantPromo.code),
          slot: "toko" as const,
          amount: cart.merchant_discount,
        },
      ]
    : []),
  ...(vouchers.platformPromo
    ? [
        {
          id: vouchers.platformPromo.id as number,
          code: String(vouchers.platformPromo.code),
          slot: "platform" as const,
          amount: cart.platform_discount,
        },
      ]
    : []),
];
