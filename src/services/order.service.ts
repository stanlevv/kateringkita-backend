// Layanan pesanan pembeli: quote, checkout, detail, daftar, batal/selesai, pesan WhatsApp, dan pesan lagi.
// Lapisan services dari alur routes/order.ts → handlers/order.handler.ts → di sini → database; sebagian fungsinya
// (kode pesanan, tahan stok, mapper, paginasi, templat WA) dipakai ulang oleh table.service dan merchant-order.service.
import { createHash, randomInt } from "node:crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import db from "../config/db";
import { env } from "../config/env";
import { dalamTransaksi } from "./admin-audit.service";
import { AppError } from "../utils/errors";
import { jam, jamWib, SISA } from "./katalog.service";
import { hariIniWib } from "./merchant-kuota.service";
import {
  PricedCart,
  Shortage,
  parseVoucherCodes,
  loadCart,
  validateCart,
  applyVouchers,
  promoInvalid,
  appliedVouchers,
} from "./order-cart.service";
import { MyOrdersQuery, OrderInput, QuoteInput, quoteSchema } from "../dto/order.dto";
import { Status, transitionOrder } from "./order-status.service";

// F06 pesanan pembeli (C-09, C-11, C-13)

/**
 * Hitung pratinjau pesanan (`POST /orders/quote`): harga per baris, subtotal, diskon voucher, biaya layanan, dan total.
 * D2: validasi sama dengan pesanan, tanpa tulis/kunci; stok kurang = peringatan (`warnings` OUT_OF_STOCK), bukan galat.
 *
 * @throws AppError 400 VALIDATION_ERROR, 409 MERCHANT_UNAVAILABLE / MERCHANT_CLOSED, 422 PROMO_INVALID
 */
export async function quote(userId: number, data: QuoteInput) {
  const nowMs = jam.sekarang();
  const cart = validateCart(
    await loadCart(db, data, { refresh: false, day: hariIniWib(new Date(nowMs)), nowMs }),
    data,
    nowMs,
  );
  const vouchers = await applyVouchers(db, cart, parseVoucherCodes(data), userId, nowMs);
  return {
    // mapper eksplisit (R-11): hpp tidak keluar
    items: cart.lines.map((line) => ({
      menu_id: line.menu_id,
      menu_name: line.menu_name,
      qty: line.qty,
      unit_price: line.unit_price,
      options: line.options,
      line_total: line.line_total,
      available: line.available,
    })),
    subtotal: cart.subtotal,
    discount: cart.discount,
    merchant_discount: cart.merchant_discount,
    platform_discount: cart.platform_discount,
    service_fee: cart.service_fee,
    total: cart.total,
    vouchers_applied: appliedVouchers(cart, vouchers),
    warnings: cart.shortages.map((shortage) => ({
      code: "OUT_OF_STOCK",
      menu_id: shortage.menu_id,
      available: shortage.available,
      message: `Sisa ${shortage.menu_name} tinggal ${shortage.available} ${shortage.unit_label}.`,
    })),
  };
}

// D7: base32 Crockford; `acak` diganti test untuk memaksa tabrakan
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Pembangkit 4 karakter acak kode pesanan; dibungkus objek agar `acak` bisa diganti test. */
export const codeGenerator = {
  random: (): string => Array.from({ length: 4 }, () => ALPHABET[randomInt(32)]).join(""),
};
/** Kode pesanan `KK-YYYYMMDD-XXXX` dari tanggal WIB `YYYY-MM-DD` dan 4 karakter acak (D7). */
export const generateOrderCode = (date: string) => `KK-${date.replace(/-/g, "")}-${codeGenerator.random()}`;

const orderNotFound = () => new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
const isDuplicateKey = (error: unknown) => (error as { code?: string } | null)?.code === "ER_DUP_ENTRY";

// AUD-31/32: porsi yang boleh ditahan sekaligus, agar satu akun atau satu meja QR tidak memborong sisa stok toko
/** Batas porsi tertahan (pesanan holding) per pembeli (AUD-31). */
export const MAX_CUSTOMER_PORTIONS = 20;
/** Batas porsi tertahan per meja QR (AUD-32). */
export const MAX_TABLE_PORTIONS = 30;
/** Jumlah porsi (total `qty`) dari daftar baris. */
export const totalPortions = (items: { qty: number }[]) => items.reduce((sum, item) => sum + item.qty, 0);
/**
 * Total porsi yang sedang ditahan pesanan holding yang belum lewat waktu milik satu pembeli atau satu meja.
 * Baca berkunci (FOR UPDATE) seperti hitungan pesanan menunggu: data terbaru, dan pemanggil sudah serial per pembeli/meja.
 *
 * @param column kolom pemilik: `customer_id` atau `table_id`
 * @param ownerId id pembeli atau meja
 */
export async function getHeldPortions(
  conn: PoolConnection,
  column: "customer_id" | "table_id",
  ownerId: number,
): Promise<number> {
  const [[row]] = await conn.query<RowDataPacket[]>(
    `SELECT COALESCE(SUM(i.qty), 0) AS porsi FROM orders o JOIN order_items i ON i.order_id = o.id
     WHERE o.${column} = ? AND o.status = 'holding' AND o.hold_until > UTC_TIMESTAMP() FOR UPDATE`,
    [ownerId],
  );
  return Number(row.porsi);
}
// D7: hanya duplikat pada kunci unik orders.code yang berarti tabrakan kode (MySQL 8 "orders.code", lama/TiDB "code")
const isCodeCollision = (error: unknown) =>
  isDuplicateKey(error) && /for key '(orders\.)?code'/.test(String((error as Error).message));
const CLAIM_EXISTS = Symbol("klaim");

/** Galat 409 OUT_OF_STOCK dengan pesan sisa porsi per baris (`items.<index>.qty`) untuk tiap kekurangan stok. */
export const outOfStockError = (shortages: Shortage[]) =>
  new AppError(
    409,
    "OUT_OF_STOCK",
    "Sisa porsi tidak cukup.",
    Object.fromEntries(
      shortages.map((shortage) => [
        `items.${shortage.index}.qty`,
        [`Sisa ${Math.max(shortage.available, 0)} ${shortage.unit_label}.`],
      ]),
    ),
  );

/**
 * Jalankan INSERT orders dengan kode pesanan baru.
 * D7: galat duplikat hanya membatalkan pernyataan, bukan transaksi → coba kode baru, maks 5 kali. `buildParams(orderCode)` = parameter INSERT.
 * Dipakai checkout pembeli (F06) dan pesanan meja (F21).
 *
 * @param date tanggal WIB untuk kode pesanan
 * @returns id pesanan baru dan kodenya
 * @throws Error bila kode bentrok 5 kali berturut-turut; galat DB lain diteruskan
 */
export async function insertOrder(
  conn: PoolConnection,
  date: string,
  sql: string,
  buildParams: (orderCode: string) => unknown[],
) {
  for (let i = 0; ; i++) {
    const code = generateOrderCode(date);
    try {
      const [result] = await conn.query<ResultSetHeader>(sql, buildParams(code));
      return { orderId: result.insertId, code };
    } catch (error) {
      if (!isCodeCollision(error)) throw error;
      if (i === 4) throw new Error("Kode pesanan bentrok 5 kali.");
    }
  }
}

/**
 * Tahan porsi tiap menu lalu simpan baris order_items untuk pesanan `orderId`.
 * R-02: tahan porsi dengan UPDATE bersyarat atomik, urut id (kunci menu baru diambil di sini, sesingkat mungkin).
 * stock_date = stockDate: penghitung yang dinaikkan selalu milik tanggal stok pesanan (aman dari balapan tengah malam, D14).
 * Harus sebelum INSERT order_items: FK item → menus mengambil kunci bersama yang lalu minta dinaikkan → deadlock.
 * R-05: order_items menyimpan salinan nama, harga, hpp, dan opsi saat dipesan.
 *
 * @throws AppError 409 OUT_OF_STOCK dengan sisa terbaru bila satu menu tidak cukup; pemanggil me-rollback transaksi
 */
export async function holdStockAndInsertItems(
  conn: PoolConnection,
  orderId: number,
  cart: PricedCart,
  stockDate: string,
) {
  const qtyByMenu = new Map<number, number>();
  for (const line of cart.lines) qtyByMenu.set(line.menu_id, (qtyByMenu.get(line.menu_id) ?? 0) + line.qty);
  for (const [menuId, qty] of [...qtyByMenu].sort((left, right) => left[0] - right[0])) {
    const [result] = await conn.query<ResultSetHeader>(
      `UPDATE menus SET held_today = held_today + ?, updated_at = updated_at
       WHERE id = ? AND deleted_at IS NULL AND is_active AND stock_date = ? AND quota_today - sold_today - held_today >= ?`,
      [qty, menuId, stockDate, qty],
    );
    if (result.affectedRows === 0) {
      // sisa terbaru untuk pesan galat (baca berkunci = data terbaru, bukan snapshot); seluruh transaksi lalu di-rollback
      const [[menu]] = await conn.query<RowDataPacket[]>(
        `SELECT ${SISA} AS available FROM menus x WHERE id = ? FOR UPDATE`,
        [stockDate, menuId],
      );
      const lineIndex = cart.lines.findIndex((line) => line.menu_id === menuId);
      throw outOfStockError([{ ...cart.lines[lineIndex], index: lineIndex, available: Number(menu.available) }]);
    }
  }
  // R-05: salinan nama, harga, hpp, opsi
  await conn.query(
    "INSERT INTO order_items (order_id, menu_id, menu_name, unit_price, hpp, qty, options, line_total) VALUES ?",
    [
      cart.lines.map((line) => [
        orderId,
        line.menu_id,
        line.menu_name,
        line.unit_price,
        line.hpp,
        line.qty,
        JSON.stringify(line.options),
        line.line_total,
      ]),
    ],
  );
}

/**
 * Checkout pembeli (F06, C-09): buat pesanan `holding` yang menahan stok sampai `hold_until` (menit tahan toko).
 * Aturan yang dijaga: maks 3 pesanan menunggu per pembeli (D11) dan maks {@link MAX_CUSTOMER_PORTIONS} porsi
 * tertahan (AUD-31), stok cukup (R-02), voucher sah dan kuotanya diklaim atomik (F12), metode non-tunai butuh
 * Midtrans aktif (F26), serta salinan nama/harga/hpp/opsi menu di order_items (R-05).
 * Idempotensi (D6): `Idempotency-Key` yang sama dengan isi sama mengembalikan pesanan yang sama, isi berbeda → 409.
 *
 * D3–D8, D11, D12 dalam satu transaksi. Urutan kunci: users (pembeli) → klaim idempotensi → menu (UPDATE bersyarat, urut id).
 * READ COMMITTED: hitung holding (baca berkunci) tanpa gap lock; di REPEATABLE READ gap lock indeks pesanan pembeli baru
 * saling mengunci INSERT orders → deadlock (terbukti di uji paralel). Stok dijaga UPDATE bersyarat, tidak butuh snapshot.
 *
 * @param idempotencyKey nilai header Idempotency-Key (UUID huruf kecil)
 * @returns detail pesanan seperti {@link getMyOrder}
 * @throws AppError 400 VALIDATION_ERROR, 409 CONFLICT (batas menunggu, metode bayar belum tersedia, kunci dipakai isi
 *   lain), 409 OUT_OF_STOCK, 409 MERCHANT_UNAVAILABLE / MERCHANT_CLOSED, 422 PROMO_INVALID
 */
export async function createOrder(userId: number, idempotencyKey: string, data: OrderInput) {
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  let code: string;
  try {
    code = await dalamTransaksi(async (conn) => {
      // Kunci baris pembeli lebih dulu: checkout satu pembeli jadi serial sehingga batas 3 holding (D11) tidak bisa dilampaui
      // request paralel. Harus sebelum INSERT klaim: FK klaim → users mengambil kunci bersama, dan dua transaksi yang sama-sama
      // memegangnya lalu meminta FOR UPDATE akan deadlock.
      const [[buyer]] = await conn.query<RowDataPacket[]>(
        "SELECT full_name, phone FROM users WHERE id = ? FOR UPDATE",
        [userId],
      );
      // shortcut: order_idempotency tidak dibersihkan; hapus baris > 7 hari di job harian F08 bila tabel > 1 juta baris
      try {
        await conn.query("INSERT INTO order_idempotency (customer_id, idem_key, request_hash) VALUES (?, ?, ?)", [
          userId,
          idempotencyKey,
          hash,
        ]);
      } catch (error) {
        if (isDuplicateKey(error)) throw CLAIM_EXISTS;
        throw error;
      }
      // baca berkunci = data terbaru (TiDB: baca biasa memakai snapshot awal transaksi). Tanpa gap lock: transaksi ini READ COMMITTED.
      // shortcut: hold lewat waktu tetap memakan stok sampai sapuan berikutnya (≤ 30 dtk, D1 F08); kurangi interval bila keluhan stok "habis" palsu
      const [[holdingCount]] = await conn.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND status = 'holding' AND hold_until > UTC_TIMESTAMP() FOR UPDATE",
        [userId],
      );
      if (Number(holdingCount.n) >= 3)
        throw new AppError(409, "CONFLICT", "Masih ada 3 pesanan yang menunggu. Selesaikan atau batalkan dulu.");

      const nowMs = jam.sekarang();
      const today = hariIniWib(new Date(nowMs));
      const cart = validateCart(await loadCart(conn, data, { refresh: true, day: today, nowMs }), data, nowMs);
      if (cart.shortages.length) throw outOfStockError(cart.shortages);
      // AUD-31: batas 3 pesanan saja tidak cukup (satu pesanan bisa berisi ratusan porsi): batasi juga porsi yang tertahan.
      // Setelah cek stok: stok yang memang kurang tetap dijawab OUT_OF_STOCK
      if ((await getHeldPortions(conn, "customer_id", userId)) + totalPortions(data.items) > MAX_CUSTOMER_PORTIONS) {
        throw new AppError(
          409,
          "CONFLICT",
          `Maksimal ${MAX_CUSTOMER_PORTIONS} porsi menunggu per pembeli. Selesaikan atau batalkan pesanan lain dulu.`,
        );
      }
      const vouchers = await applyVouchers(conn, cart, parseVoucherCodes(data), userId, nowMs, data.payment_method);
      const usedPromos = [vouchers.merchantPromo, vouchers.platformPromo]
        .filter((promo): promo is RowDataPacket => promo !== null)
        .sort((left, right) => left.id - right.id);
      for (const promo of usedPromos) {
        // F12: klaim kuota atomik sebelum INSERT orders (FK orders → promos mengambil kunci bersama yang lalu minta dinaikkan → deadlock).
        // Urutan kunci promos (id naik) → menus, sama dengan transisi (lepasPromo sebelum releaseStock). Satu gagal → transaksi batal semua.
        // shortcut: reset kuota harian (segarkanKuota, menus) berjalan sebelum ini pada checkout pertama hari itu; deadlock langka bila
        // bersamaan dengan batal berpromo di toko yang sama, coba ulang di klien cukup
        const [result] = await conn.query<ResultSetHeader>(
          "UPDATE promos SET used_count = used_count + 1 WHERE id = ? AND (quota IS NULL OR used_count < quota)",
          [promo.id],
        );
        if (!result.affectedRows) throw promoInvalid("Kuota promo sudah habis.");
      }
      // F26: semua non-tunai lewat Midtrans
      if (data.payment_method !== "cod" && !env.MIDTRANS_SERVER_KEY) {
        throw new AppError(
          409,
          "CONFLICT",
          `Pembayaran ${data.payment_method === "va" ? "Virtual Account" : "online"} belum tersedia. Pilih metode lain.`,
        );
      }

      const { orderId, code: createdCode } = await insertOrder(
        conn,
        today,
        `INSERT INTO orders (code, customer_id, merchant_id, pickup_point_id, status, customer_name, customer_phone, note, subtotal,
           discount, merchant_promo_id, merchant_discount, platform_promo_id, platform_discount, service_fee, total, promo_id, payment_method,
           payment_status, hold_until, stock_date, pickup_at)
         VALUES (?, ?, ?, ?, 'holding', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'unpaid', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?, ?)`,
        (orderCode) => [
          orderCode,
          userId,
          cart.merchant.id,
          data.pickup_point_id,
          data.customer_name ?? buyer.full_name,
          data.customer_phone ?? buyer.phone,
          data.note,
          cart.subtotal,
          cart.discount,
          vouchers.merchantPromo?.id ?? null,
          cart.merchant_discount,
          vouchers.platformPromo?.id ?? null,
          cart.platform_discount,
          cart.service_fee,
          cart.total,
          data.payment_method,
          cart.merchant.hold_minutes,
          today,
          data.pickup_at ? new Date(data.pickup_at) : null,
        ],
      );
      await holdStockAndInsertItems(conn, orderId, cart, today);
      // F12: dikembalikan bila pesanan batal/kedaluwarsa (transisi); satu baris per voucher
      for (const [promo, amount] of [
        [vouchers.merchantPromo, cart.merchant_discount],
        [vouchers.platformPromo, cart.platform_discount],
      ] as const) {
        if (promo)
          await conn.query("INSERT INTO promo_redemptions (promo_id, order_id, user_id, amount) VALUES (?, ?, ?, ?)", [
            promo.id,
            orderId,
            userId,
            amount,
          ]);
      }
      await conn.query(
        "INSERT INTO order_status_logs (order_id, from_status, to_status, actor_user_id) VALUES (?, NULL, 'holding', ?)",
        [orderId, userId],
      );
      await conn.query("UPDATE order_idempotency SET order_id = ? WHERE customer_id = ? AND idem_key = ?", [
        orderId,
        userId,
        idempotencyKey,
      ]);
      return createdCode;
    }, "READ COMMITTED");
  } catch (error) {
    if (error !== CLAIM_EXISTS) throw error;
    // D6: request kembar menunggu klaim pertama commit → pesanan yang sama bila isi sama
    const [[claim]] = await db.query<RowDataPacket[]>(
      `SELECT k.request_hash, o.code FROM order_idempotency k LEFT JOIN orders o ON o.id = k.order_id
       WHERE k.customer_id = ? AND k.idem_key = ?`,
      [userId, idempotencyKey],
    );
    if (!claim || claim.request_hash !== hash || !claim.code) {
      throw new AppError(409, "CONFLICT", "Pesanan ini sudah dikirim dengan isi berbeda. Muat ulang lalu coba lagi.");
    }
    code = claim.code;
  }
  return getMyOrder(userId, code);
}

/** Kolom SELECT bersama Order (pembeli) & MerchantOrder (penjual); o = orders, p = pickup_points. */
export const ORDER_COLUMNS = `o.id, o.code, o.status, o.payment_method, o.payment_status, o.hold_until, o.pickup_at,
  GREATEST(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), o.hold_until), 0) AS seconds_left, o.pickup_point_id, p.name AS p_name,
  o.subtotal, o.discount, o.service_fee, o.total, o.note, o.cancel_reason, o.cancelled_by, o.created_at, o.updated_at`;
const CUSTOMER_ORDER_SELECT = `${ORDER_COLUMNS}, o.merchant_id, m.business_name, m.wa_number,
  (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND NOT EXISTS
    (SELECT 1 FROM reviews r WHERE r.order_id = o.id AND r.menu_id = i.menu_id)) AS belum_diulas
  FROM orders o JOIN merchants m ON m.id = o.merchant_id JOIN pickup_points p ON p.id = o.pickup_point_id`;

/** Item pesanan di respons API: salinan nama, harga, dan opsi saat dipesan (R-05), tanpa hpp. */
export type Item = {
  menu_id: number;
  menu_name: string;
  qty: number;
  unit_price: number;
  options: unknown[];
  line_total: number;
};

/**
 * Item seluruh halaman dalam satu kueri (tanpa N+1); mapper eksplisit tanpa hpp (R-11).
 *
 * @param ids id pesanan
 * @returns peta id pesanan → item (urut id item); pesanan tanpa item tidak ada di peta
 */
export async function loadOrderItems(ids: number[]): Promise<Map<number, Item[]>> {
  const itemsByOrder = new Map<number, Item[]>();
  if (!ids.length) return itemsByOrder;
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT order_id, menu_id, menu_name, qty, unit_price, options, line_total FROM order_items WHERE order_id IN (?) ORDER BY id",
    [ids],
  );
  for (const row of rows) {
    const list = itemsByOrder.get(row.order_id) ?? itemsByOrder.set(row.order_id, []).get(row.order_id)!;
    list.push({
      menu_id: row.menu_id,
      menu_name: row.menu_name,
      qty: row.qty,
      unit_price: row.unit_price,
      options: row.options ?? [],
      line_total: row.line_total,
    });
  }
  return itemsByOrder;
}

/**
 * Bagian respons yang sama untuk pesanan pembeli dan penjual (D13), dari baris yang memuat {@link ORDER_COLUMNS}.
 * hold_until/seconds_left null bila bukan holding. Mapper eksplisit: kolom lain tidak ikut keluar (R-11).
 */
export const mapOrderBase = (order: RowDataPacket, items: Item[]) => {
  const holding = order.status === "holding";
  return {
    code: order.code,
    status: order.status,
    payment_method: order.payment_method,
    payment_status: order.payment_status,
    hold_until: holding ? order.hold_until : null,
    seconds_left: holding ? Number(order.seconds_left) : null,
    pickup_point: { id: order.pickup_point_id, name: order.p_name },
    items,
    subtotal: order.subtotal,
    discount: order.discount,
    service_fee: order.service_fee,
    total: order.total,
    note: order.note,
    pickup_at: order.pickup_at,
    cancel_reason: order.cancel_reason,
    cancelled_by: order.cancelled_by,
    created_at: order.created_at,
    updated_at: order.updated_at,
  };
};

/**
 * Bentuk respons pesanan untuk pembeli (Order §1, tanpa payment): {@link mapOrderBase} + data toko + flag aksi
 * `can_cancel`, `can_complete`, `can_review` agar aplikasi tidak menebak aturan sendiri.
 * D2: holding yang lewat waktu tidak bisa dibatalkan; confirmed hanya bisa dibatalkan bila tunai.
 */
export const mapCustomerOrder = (order: RowDataPacket, items: Item[]) => ({
  ...mapOrderBase(order, items),
  merchant: { id: order.merchant_id, business_name: order.business_name, wa_number: order.wa_number },
  can_cancel:
    (order.status === "holding" && Number(order.seconds_left) > 0) ||
    (order.status === "confirmed" && order.payment_method === "cod"),
  // F13: masih ada menu yang belum diulas
  can_complete: order.status === "ready",
  can_review: order.status === "completed" && Number(order.belum_diulas) > 0,
});

/**
 * Pola LIKE "mengandung `q`" dengan % _ \ di-escape. Dipakai juga moderasi dan tiket admin.
 * Pemanggil membandingkan LOWER(kolom) LIKE LOWER(?) karena TiDB bawaan utf8mb4_bin (peka huruf).
 */
export const likePattern = (search: string) => `%${search.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * Ambil satu halaman pesanan untuk daftar pembeli dan penjual.
 * D10–D12: satu COUNT + satu halaman + satu kueri item; urut terbaru. Dengan updated_since urut updated_at naik agar klien yang
 * maju memakai updated_at terbesar halaman sebelumnya tidak melompati perubahan.
 *
 * @param selectFrom daftar kolom + klausa FROM (alias tabel orders wajib `o`)
 * @param where syarat SQL yang digabung AND; `args` = nilai parameternya
 * @param mapRow pengubah baris DB + item menjadi bentuk respons
 * @returns `{ data, meta: { page, limit, total } }`
 */
export async function paginateOrders<T>(
  selectFrom: string,
  where: string[],
  args: unknown[],
  filter: { page: number; limit: number; updated_since?: string },
  mapRow: (row: RowDataPacket, items: Item[]) => T,
) {
  const orderBy = filter.updated_since ? "o.updated_at ASC, o.id ASC" : "o.created_at DESC, o.id DESC";
  const whereSql = where.join(" AND ");
  const [[countRow]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM orders o WHERE ${whereSql}`, args);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectFrom} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...args, filter.limit, (filter.page - 1) * filter.limit],
  );
  const items = await loadOrderItems(rows.map((row) => row.id));
  return {
    data: rows.map((row) => mapRow(row, items.get(row.id) ?? [])),
    meta: { page: filter.page, limit: filter.limit, total: Number(countRow.n) },
  };
}

const STATUSES_BY_TAB: Record<MyOrdersQuery["tab"], Status[]> = {
  active: ["holding", "confirmed", "cooking", "ready"],
  completed: ["completed"],
  cancelled: ["cancelled", "expired"],
};

/**
 * Daftar pesanan pembeli per tab (aktif, selesai, batal/kadaluarsa) dengan pencarian kode atau nama menu.
 * C-14 (D10, D11): updated_since mengabaikan tab agar pesanan yang pindah tab tetap terkirim.
 *
 * @returns `{ data, meta }` seperti {@link paginateOrders}, tiap baris berbentuk {@link mapCustomerOrder}
 */
export async function listMyOrders(userId: number, filter: MyOrdersQuery) {
  const where = ["o.customer_id = ?"];
  const args: unknown[] = [userId];
  if (filter.updated_since) {
    where.push("o.updated_at >= ?");
    args.push(new Date(filter.updated_since));
  } else {
    where.push("o.status IN (?)");
    args.push(STATUSES_BY_TAB[filter.tab]);
  }
  if (filter.q) {
    where.push(
      "(LOWER(o.code) LIKE LOWER(?) OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND LOWER(i.menu_name) LIKE LOWER(?)))",
    );
    args.push(likePattern(filter.q), likePattern(filter.q));
  }
  return paginateOrders(CUSTOMER_ORDER_SELECT, where, args, filter, mapCustomerOrder);
}

/**
 * Detail satu pesanan pembeli: bentuk {@link mapCustomerOrder} ditambah `payment` (metode, status, jumlah).
 * Metode `online`: ditambah `payment_url` (halaman Snap terbaru) dan `qris` (QR terbaru); keduanya null bila belum
 * dibuat atau pesanan tidak lagi menunggu bayar (bukan holding, atau sudah lunas).
 * Metode `va`: ditambah `va` (bank, nomor, kedaluwarsa VA terbaru), null hanya bila VA belum dibuat; setelah lunas
 * atau batal tetap dikirim. Metode `cod` (dan `qris` lama): hanya `payment` dasar.
 * D16: Order §1 + payment; R-10 customer_id dari sesi, bukan milik → 404.
 *
 * @throws AppError 404 NOT_FOUND bila pesanan tidak ada atau milik pembeli lain
 */
export async function getMyOrder(userId: number, code: string) {
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT ${CUSTOMER_ORDER_SELECT} WHERE o.code = ? AND o.customer_id = ?`,
    [code, userId],
  );
  if (!order) throw orderNotFound();
  const items = await loadOrderItems([order.id]);
  const payment = { method: order.payment_method, status: order.payment_status, amount: order.total };
  if (order.payment_method === "online") {
    // F26: halaman bayar Snap; null sampai POST /orders/:code/online, dan setelah lunas/tidak menunggu bayar lagi
    // QRIS di aplikasi: null sampai POST /orders/:code/qris; redirect_url baris qris = gambar QR Midtrans
    const [[snapPayment]] = await db.query<RowDataPacket[]>(
      "SELECT redirect_url FROM payments WHERE order_id = ? AND method = 'online' ORDER BY id DESC LIMIT 1",
      [order.id],
    );
    const [[qrisPayment]] = await db.query<RowDataPacket[]>(
      "SELECT qr_string, redirect_url, expires_at FROM payments WHERE order_id = ? AND method = 'qris' ORDER BY id DESC LIMIT 1",
      [order.id],
    );
    const awaitingPayment = order.status === "holding" && order.payment_status !== "paid";
    return {
      ...mapCustomerOrder(order, items.get(order.id) ?? []),
      payment: {
        ...payment,
        payment_url: awaitingPayment ? (snapPayment?.redirect_url ?? null) : null,
        qris:
          awaitingPayment && qrisPayment
            ? { qr_string: qrisPayment.qr_string, qr_url: qrisPayment.redirect_url, expires_at: qrisPayment.expires_at }
            : null,
      },
    };
  }
  if (order.payment_method !== "va") return { ...mapCustomerOrder(order, items.get(order.id) ?? []), payment };
  // F10: VA null sampai pembeli memilih bank lewat POST /orders/:code/va
  const [[vaPayment]] = await db.query<RowDataPacket[]>(
    "SELECT bank, va_number, expires_at FROM payments WHERE order_id = ? AND method = 'va' ORDER BY id DESC LIMIT 1",
    [order.id],
  );
  return {
    ...mapCustomerOrder(order, items.get(order.id) ?? []),
    payment: {
      ...payment,
      va: vaPayment ? { bank: vaPayment.bank, va_number: vaPayment.va_number, expires_at: vaPayment.expires_at } : null,
    },
  };
}

// C-15, C-16 (D1, D8): transisi lalu bentuk terkini milik pembeli
const transitionMyOrder = async (
  userId: number,
  code: string,
  action: "cancel" | "complete",
  reason: string | null = null,
) => {
  await dalamTransaksi((conn) => transitionOrder(conn, code, action, { kind: "customer", userId }, reason));
  return getMyOrder(userId, code);
};
/**
 * Pembeli membatalkan pesanannya (C-15): boleh saat holding belum lewat waktu, atau confirmed bila tunai.
 * Porsi stok dan kuota promo dikembalikan oleh transisi.
 *
 * @returns detail pesanan terkini seperti {@link getMyOrder}
 * @throws AppError 404 NOT_FOUND, 409 CONFLICT bila status tidak bisa dibatalkan
 */
export const cancelMyOrder = (userId: number, code: string, reason: string | null) =>
  transitionMyOrder(userId, code, "cancel", reason);
/**
 * Pembeli menandai pesanan `ready` sudah diambil (C-16); pesanan tunai sekalian ditandai lunas.
 *
 * @returns detail pesanan terkini seperti {@link getMyOrder}
 * @throws AppError 404 NOT_FOUND, 409 CONFLICT bila pesanan belum siap ambil
 */
export const completeMyOrder = (userId: number, code: string) => transitionMyOrder(userId, code, "complete");

// D15 (C-13): teks tetap bersuara pembeli; wa_template toko (bersuara penjual) dipakai GET /merchant/orders/:code/whatsapp di F07
const CUSTOMER_WA_TEMPLATE =
  "Halo {toko}, saya {nama} memesan lewat KateringKita.\n\nKode: {kode}\nMenu: {menu}\nTotal: {total}\n" +
  "Cara bayar: {metode_bayar}\nAmbil di: {titik_temu}\nWaktu ambil: {waktu_ambil}";
// qris: pesanan lama sebelum F26
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  qris: "QRIS toko",
  va: "Virtual Account",
  cod: "Tunai",
  online: "Bayar online",
};

/**
 * Nilai placeholder templat WhatsApp (`kode`, `nama`, `toko`, `menu`, `total`, `titik_temu`, `waktu_ambil`,
 * `metode_bayar`, `catatan`) dari data pesanan. Dipakai pesan pembeli dan pesan penjual.
 * Format sama dengan fe/lib/wa-template.ts (Rp 30.000, HH.MM WIB / Secepatnya, Tunai); tanggal ambil ditulis
 * hanya bila bukan hari ini (WIB).
 */
export function buildWaValues(order: {
  code: string;
  customer_name: string;
  business_name: string;
  items: { qty: number; menu_name: string }[];
  total: number;
  titik_temu: string;
  pickup_at: Date | null;
  payment_method: string;
  note: string | null;
}): Record<string, string> {
  return {
    kode: order.code,
    nama: order.customer_name,
    toko: order.business_name,
    menu: order.items.map((item) => `${item.qty}x ${item.menu_name}`).join(", "),
    total: `Rp ${order.total.toLocaleString("id-ID")}`,
    titik_temu: order.titik_temu,
    waktu_ambil: order.pickup_at
      ? `${pickupDayPrefix(order.pickup_at)}${jamWib(order.pickup_at.getTime()).slice(0, 5).replace(":", ".")} WIB`
      : "Secepatnya",
    metode_bayar: PAYMENT_METHOD_LABELS[order.payment_method] ?? order.payment_method,
    catatan: order.note ?? "",
  };
}

const wibDateFormat = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "long" });
// "3 November " bila hari ambil (WIB) bukan hari ini
const pickupDayPrefix = (date: Date) =>
  hariIniWib(date) === hariIniWib(new Date(jam.sekarang())) ? "" : `${wibDateFormat.format(date)} `;

/**
 * Isi templat WhatsApp: `{nama}` diganti `values.nama`.
 * Placeholder dikenal diganti, yang tidak dikenal dibiarkan (sama dengan fe renderTemplate).
 */
export const render = (template: string, values: Record<string, string>) =>
  template.replace(/\{[^{}\n]+\}/g, (placeholder) => values[placeholder.slice(1, -1)] ?? placeholder);

/**
 * Tautan `https://wa.me/<nomor>?text=<pesan>`.
 * wa_number 08… / 628… / +628… → 628… (wa.me butuh kode negara tanpa +)
 */
export const waLink = (phone: string, text: string) =>
  `https://wa.me/${phone.replace(/\D/g, "").replace(/^0/, "62")}?text=${encodeURIComponent(text)}`;

/**
 * Pesan WhatsApp pembeli ke toko untuk pesanan miliknya (C-13, D15), memakai templat bersuara pembeli;
 * baris catatan hanya ditambah bila pesanan punya catatan.
 *
 * @returns `wa_number` toko, `message` yang sudah diisi, dan `url` wa.me
 * @throws AppError 404 NOT_FOUND bila pesanan tidak ada atau bukan milik pembeli
 */
export async function getMyOrderWhatsapp(userId: number, code: string) {
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.code, o.customer_name, o.total, o.pickup_at, o.payment_method, o.note, m.business_name, m.wa_number,
       p.name AS titik_temu
     FROM orders o JOIN merchants m ON m.id = o.merchant_id JOIN pickup_points p ON p.id = o.pickup_point_id
     WHERE o.code = ? AND o.customer_id = ?`,
    [code, userId],
  );
  if (!order) throw orderNotFound();
  const [items] = await db.query<RowDataPacket[]>(
    "SELECT qty, menu_name FROM order_items WHERE order_id = ? ORDER BY id",
    [order.id],
  );
  const message = render(
    CUSTOMER_WA_TEMPLATE + (order.note ? "\nCatatan: {catatan}" : ""),
    buildWaValues({ ...order, items } as Parameters<typeof buildWaValues>[0]),
  );
  return { wa_number: order.wa_number, message, url: waLink(order.wa_number, message) };
}

/**
 * F14 pesan lagi: isi pesanan lama disusun ulang lalu dicek quote (harga, opsi, stok, promo terkini; tanpa tulis).
 * Klien menambah payment_method lalu mengirim `request` ke POST /orders.
 *
 * @returns `request` (body quote dari menu, opsi, titik temu, dan catatan pesanan lama) dan `quote` hasil {@link quote}
 * @throws AppError 404 NOT_FOUND bila pesanan bukan milik pembeli; galat quote (menu tidak tersedia, toko tutup, dll.)
 */
export async function reorder(userId: number, code: string) {
  const [[order]] = await db.query<RowDataPacket[]>(
    "SELECT id, pickup_point_id, note FROM orders WHERE code = ? AND customer_id = ?",
    [code, userId],
  );
  if (!order) throw orderNotFound();
  const items = (await loadOrderItems([order.id])).get(order.id) ?? [];
  const request = quoteSchema.parse({
    items: items.map((item) => ({
      menu_id: item.menu_id,
      qty: item.qty,
      option_ids: (item.options as { id: number }[]).map((option) => option.id),
    })),
    pickup_point_id: order.pickup_point_id,
    note: order.note,
  });
  return { request, quote: await quote(userId, request) };
}
