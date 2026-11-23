// Isi file: logika keranjang yang dipakai bersama oleh quote, checkout pembeli, dan pesanan meja: ambil data menu
// dan toko, periksa aturan, hitung harga, lalu pasang voucher. Dipanggil order.service dan table.service (lapisan
// services, di antara handlers dan database). File ini hampir tidak menulis ke database; satu-satunya tulisan adalah
// reset kuota harian menu (lewat segarkanKuota) saat loadCart dipanggil dengan `refresh: true` oleh checkout.
import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import { rentangHariWib } from "./admin-summary.service";
import { AppError } from "../utils/errors";
import { SISA, tokoBuka } from "./katalog.service";
import { segarkanKuota } from "./merchant-kuota.service";
import { QuoteInput } from "../dto/order.dto";

// Apa saja yang bisa menjalankan kueri: koneksi biasa (quote) atau koneksi di dalam transaksi (checkout). Transaksi =
// rangkaian perubahan database yang disimpan semua atau dibatalkan semua.
type Queryable = Pick<PoolConnection, "query">;
/**
 * Data mentah keranjang dari database: baris menu per id (`menus`), opsi tambahan menu (`options`), dan data toko
 * beserta titik temu yang diminta (`merchant`; null bila menu berasal dari lebih dari satu toko).
 */
export type Cart = { menus: Map<number, RowDataPacket>; options: RowDataPacket[]; merchant: RowDataPacket | null };
/** Opsi tambahan yang dipilih pada satu baris (misalnya "pedas"), dengan harga tambahannya. */
export type CartOption = { id: number; name: string; extra_price: number };
/**
 * Satu baris keranjang yang sudah dihitung harganya. `hpp` (harga modal) hanya untuk disalin ke pesanan dan tidak
 * pernah dikirim ke aplikasi.
 */
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
/**
 * Menu yang jumlah pesanannya melebihi sisa stok. `index` = nomor baris pertama menu itu di keranjang, dipakai untuk
 * menunjuk baris yang salah di pesan galat.
 */
export type Shortage = { index: number; menu_id: number; available: number; unit_label: string; menu_name: string };
/**
 * Hasil {@link validateCart}: data toko, baris-baris yang sudah dihitung (`lines`), rincian uang, dan daftar menu yang
 * stoknya kurang (`shortages`). Kolom potongan dan total diisi ulang oleh {@link applyVouchers}.
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
 * Mengambil menu, opsi, dan toko yang disebut di keranjang: 3 kueri untuk quote; saat checkout (`refresh: true`)
 * ditambah kueri reset kuota harian, jadi 5–6. Data dibaca tanpa dikunci. Sisa stok yang dibaca di sini hanya untuk
 * pesan galat; kepastian stok saat checkout dijaga oleh UPDATE bersyarat di order.service (UPDATE yang hanya mengubah
 * baris bila stoknya masih cukup), supaya baris menu dikunci sesingkat mungkin.
 * @param conn    koneksi biasa (quote) atau koneksi di dalam transaksi (checkout)
 * @param data    isi keranjang
 * @param options `refresh` = reset kuota harian dulu bila sudah ganti hari (checkout), `day` = tanggal stok WIB
 *                `YYYY-MM-DD`, `nowMs` = waktu sekarang dalam milidetik
 * @returns data mentah keranjang ({@link Cart})
 */
export async function loadCart(
  conn: Queryable,
  data: QuoteInput,
  options: { refresh: boolean; day: string; nowMs: number },
): Promise<Cart> {
  const menuIds = [...new Set(data.items.map((item) => item.menu_id))];
  // 1. Checkout: reset kuota harian menu toko bila tanggal stoknya sudah lewat (hanya bila semua menu dari satu toko).
  if (options.refresh) {
    const [merchantIds] = await conn.query<RowDataPacket[]>("SELECT DISTINCT merchant_id FROM menus WHERE id IN (?)", [
      menuIds,
    ]);
    if (merchantIds.length === 1) await segarkanKuota(conn, merchantIds[0].merchant_id, options.day);
  }
  // 2. Ambil menu beserta sisa stoknya untuk tanggal `day`, lalu opsi tambahannya.
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
  // 3. Bila semua menu dari satu toko: ambil toko, status akun pemiliknya, titik temu yang diminta, dan biaya
  //    layanan dalam satu kueri. Bila lebih dari satu toko, toko dibiarkan null dan validateCart menolaknya.
  const merchantIds = [...new Set(menus.map((menu) => menu.merchant_id))];
  let merchantRow: RowDataPacket | null = null;
  if (merchantIds.length === 1) {
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

// Lempar galat 400 berisi pesan per kolom bila ada kolom yang salah.
const throwIfInvalid = (fields: Record<string, string[]>) => {
  if (Object.keys(fields).length) throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fields);
};
// "08:00:00" dari database → "08.00" untuk pesan.
const formatHour = (time: unknown) => String(time).slice(0, 5).replace(":", ".");
const DAY_MS = 86400e3;

/**
 * Memeriksa keranjang lalu menghitung harganya. Urutan pemeriksaan: menu ada dan masih dijual, semua menu dari satu
 * toko, toko terverifikasi dan akun pemiliknya aktif, toko sedang buka, titik temu dilayani toko, waktu ambil (harus
 * di masa depan, paling lambat 7 hari; menu pre-order paling cepat H-n, yaitu n hari setelah hari pesan), jumlah
 * minimal pesan per menu, opsi tambahan valid, dan total masih muat di kolom angka database.
 * Stok dan voucher tidak menggagalkan fungsi ini: menu yang stoknya kurang dikumpulkan di `shortages` (quote
 * menjadikannya peringatan, checkout menjadikannya galat 409), dan voucher diperiksa oleh {@link applyVouchers}.
 * @param cart     data mentah dari {@link loadCart}
 * @param data     isi keranjang dari aplikasi
 * @param nowMs    waktu sekarang dalam milidetik
 * @param settings `skipPickupPoint: true` untuk pesanan meja, yang tidak memakai titik temu
 * @returns keranjang yang sudah dihitung, dengan potongan 0 dan total = subtotal + biaya layanan
 * @throws 400 ada kolom yang salah (pesan per kolom), 409 toko tidak menerima pesanan, 409 toko sedang tutup
 */
export function validateCart(
  cart: Cart,
  data: QuoteInput,
  nowMs: number,
  settings: { skipPickupPoint?: boolean } = {},
): PricedCart {
  // 1. Semua menu harus ada, aktif, dan belum dihapus.
  const fieldErrors: Record<string, string[]> = {};
  data.items.forEach((item, i) => {
    const menu = cart.menus.get(item.menu_id);
    if (!menu || !menu.is_active || menu.deleted_at) fieldErrors[`items.${i}.menu_id`] = ["Menu tidak tersedia."];
  });
  throwIfInvalid(fieldErrors);
  // 2. Semua menu dari satu toko, toko layak menerima pesanan, sedang buka, dan melayani titik temu yang dipilih.
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

  // 3. Waktu ambil: di masa depan dan paling lambat 7 hari lagi. Bila ada menu pre-order, waktu ambil wajib diisi dan
  //    paling cepat awal hari ke-n setelah hari ini (n = hari pre-order terbesar di keranjang).
  const pickupMs = data.pickup_at ? Date.parse(data.pickup_at) : null;
  if (pickupMs !== null && (pickupMs <= nowMs || pickupMs > nowMs + 7 * DAY_MS)) {
    throwIfInvalid({ pickup_at: ["Waktu ambil harus di masa depan, paling lambat 7 hari lagi."] });
  }
  const preorderDays = Math.max(
    -1,
    ...[...cart.menus.values()].filter((menu) => menu.is_preorder).map((menu) => Number(menu.preorder_days)),
  );
  // shortcut: stok pre-order memakai kuota hari pesan; buat kuota per tanggal ambil bila penjual menjual pre-order
  // dalam jumlah besar
  if (
    preorderDays >= 0 &&
    (pickupMs === null || pickupMs < rentangHariWib(nowMs + preorderDays * DAY_MS).from.getTime())
  ) {
    throwIfInvalid({ pickup_at: [`Menu pre-order harus diambil paling cepat H-${preorderDays}.`] });
  }

  // 4. Jumlahkan porsi per menu (satu menu boleh muncul di beberapa baris dengan opsi berbeda), lalu cek jumlah
  //    minimal pesan. Galat ditaruh di baris pertama menu itu.
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

  // 5. Hitung harga tiap baris: harga menu + harga opsi tambahan, dikali jumlah. Opsi harus milik menu itu dan aktif.
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

  // 6. Kumpulkan menu yang jumlah pesanannya melebihi sisa stok.
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
  // 7. Subtotal + biaya layanan (dari pengaturan aplikasi; bila isinya bukan angka bulat, dianggap 0).
  const subtotal = lines.reduce((sum, line) => sum + line.line_total, 0);
  const service_fee = /^\d+$/.test(String(merchant.service_fee ?? "")) ? Number(merchant.service_fee) : 0;
  // Kolom uang di database bertipe INT (maksimal 2.147.483.647). Total selalu ≥ setiap harga baris dan ≥ subtotal,
  // jadi cukup total yang dicek.
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
 * Membuat galat 422 "voucher tidak berlaku". Pesannya ditaruh di dua kolom: `promo_codes` (aplikasi versi baru,
 * bisa dua voucher) dan `promo_code` (aplikasi versi lama, satu isian kode).
 * @param message pesan untuk pembeli
 * @returns AppError 422 PROMO_INVALID yang siap dilempar
 */
export const promoInvalid = (message: string) =>
  new AppError(422, "PROMO_INVALID", message, { promo_codes: [message], promo_code: [message] });

/**
 * Mengambil kode voucher dari isi permintaan: gabungan `promo_codes` dan `promo_code` (versi lama), dirapikan menjadi
 * huruf besar, yang kosong dibuang, dan kode kembar dihapus.
 * @param body isi permintaan yang memuat `promo_codes` dan/atau `promo_code`
 * @returns daftar kode voucher unik
 */
export const parseVoucherCodes = (body: { promo_code?: string | null; promo_codes?: string[] }) => [
  ...new Set(
    [...(body.promo_codes ?? []), ...(body.promo_code ? [body.promo_code] : [])]
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean),
  ),
];

// Syarat satu voucher: aktif, dalam masa berlaku, jatah pakai belum habis, belanja minimal tercapai (dibanding subtotal
// sebelum potongan), dan pembeli belum melewati batas pakai per orang. Tidak mengunci apa pun: jatah dikurangi
// belakangan oleh createOrder, dan batas per pembeli aman karena baris pembeli sudah dikunci di sana.
async function validatePromo(conn: Queryable, promo: RowDataPacket, cart: PricedCart, userId: number, nowMs: number) {
  // 1. Syarat dari data voucher itu sendiri: aktif, masa berlaku, jatah pakai, dan belanja minimal.
  if (!promo.is_active) throw promoInvalid("Kode promo tidak ditemukan.");
  if (nowMs < new Date(promo.starts_at).getTime() || nowMs >= new Date(promo.ends_at).getTime())
    throw promoInvalid("Promo sedang tidak berlaku.");
  if (promo.quota !== null && promo.used_count >= promo.quota) throw promoInvalid("Kuota promo sudah habis.");
  if (cart.subtotal < promo.min_subtotal)
    throw promoInvalid(`Minimal belanja Rp ${Number(promo.min_subtotal).toLocaleString("id-ID")} untuk promo ini.`);
  // 2. Batas pakai per pembeli: hitung berapa kali pembeli ini sudah memakai voucher ini.
  const [[countRow]] = await conn.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM promo_redemptions WHERE promo_id = ? AND user_id = ?",
    [promo.id, userId],
  );
  if (Number(countRow.n) >= promo.per_user_limit) throw promoInvalid("Promo ini sudah mencapai batas pemakaianmu.");
}

// Besar potongan satu voucher: `percent` = persen dari `base` (dibatasi max_discount), `fixed` = nominal tetap (tidak
// lebih dari `base`), selain itu (gratis biaya layanan) = sebesar biaya layanan. `base` = harga barang setelah
// potongan voucher sebelumnya.
const calculateDiscount = (promo: RowDataPacket, base: number, serviceFee: number) =>
  promo.type === "percent"
    ? Math.min(Math.floor((base * promo.value) / 100), promo.max_discount ?? Infinity)
    : promo.type === "fixed"
      ? Math.min(promo.value, base)
      : serviceFee;

/**
 * Memasang voucher ke keranjang dan menghitung potongannya. Satu pesanan boleh memakai paling banyak satu voucher
 * toko (promo milik toko pesanan ini) dan satu voucher platform (promo dari KateringKita, merchant_id NULL).
 * Potongan voucher toko dihitung dulu dari subtotal, lalu voucher platform dari sisa harga barang. Hasilnya mengisi
 * merchant_discount, platform_discount, discount, dan total di `cart`.
 * Voucher platform hanya untuk bayar non-tunai; quote yang belum punya metode bayar tidak dicek soal ini.
 * Jatah pakai voucher belum dikurangi di sini; itu dilakukan createOrder saat checkout.
 * @param conn          koneksi biasa atau koneksi di dalam transaksi
 * @param cart          keranjang dari {@link validateCart}; kolom potongan dan totalnya diubah langsung
 * @param codes         kode voucher dari {@link parseVoucherCodes}
 * @param userId        id pembeli (untuk cek batas pakai per orang)
 * @param nowMs         waktu sekarang dalam milidetik (untuk cek masa berlaku)
 * @param paymentMethod metode bayar saat checkout; kosong saat quote
 * @returns baris voucher yang dipakai: `merchantPromo` dan `platformPromo` (null bila tidak ada)
 * @throws 422 kode tidak ditemukan, lebih dari 2 voucher, dua voucher di slot yang sama, syarat voucher tidak
 *   terpenuhi, voucher platform dipakai untuk bayar tunai, dua voucher gratis biaya layanan, atau total jadi Rp 0
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
    // 1. Cari voucher berdasarkan kode (hanya voucher platform atau voucher toko ini), lalu masukkan ke slotnya.
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
    // 2. Cek syarat tiap voucher dan aturan gabungan keduanya.
    for (const promo of [merchantPromo, platformPromo])
      if (promo) await validatePromo(conn, promo, cart, userId, nowMs);
    if (platformPromo && paymentMethod === "cod") throw promoInvalid("Voucher platform hanya untuk bayar non-tunai.");
    if (merchantPromo?.type === "free_service_fee" && platformPromo?.type === "free_service_fee")
      throw promoInvalid("Biaya layanan sudah digratiskan voucher lain.");
  }
  // 3. Hitung potongan: voucher toko dari subtotal, voucher platform dari sisa harga barang.
  cart.merchant_discount = merchantPromo ? calculateDiscount(merchantPromo, cart.subtotal, cart.service_fee) : 0;
  const remainingSubtotal = cart.subtotal - (merchantPromo?.type === "free_service_fee" ? 0 : cart.merchant_discount);
  cart.platform_discount = platformPromo ? calculateDiscount(platformPromo, remainingSubtotal, cart.service_fee) : 0;
  cart.discount = cart.merchant_discount + cart.platform_discount;
  cart.total = Math.max(0, cart.subtotal + cart.service_fee - cart.discount);
  // 4. Voucher platform hanya untuk bayar non-tunai lewat Midtrans (penyedia pembayaran online), dan Midtrans tidak
  //    menerima tagihan Rp 0.
  if (platformPromo && cart.platform_discount > 0 && cart.total <= 0)
    throw promoInvalid("Total pesanan jadi Rp 0. Lepas voucher platform.");
  return { merchantPromo, platformPromo };
}

/**
 * Menyusun daftar voucher terpakai untuk respons quote (`vouchers_applied`): id, kode, slot (`toko` atau `platform`),
 * dan besar potongannya.
 * @param cart     keranjang yang sudah dipasangi voucher
 * @param vouchers hasil {@link applyVouchers}
 * @returns daftar voucher terpakai (0–2 item)
 */
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
