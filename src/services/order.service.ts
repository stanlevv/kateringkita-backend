// Isi file: semua urusan pesanan milik pembeli, yaitu hitung harga (quote), checkout, detail, daftar, batal,
// selesai, pesan WhatsApp ke toko, dan pesan lagi. Alurnya routes/order.ts → handlers/order.handler.ts → file ini
// → database. Beberapa fungsi di sini (kode pesanan, tahan stok, bentuk respons, halaman daftar, templat WhatsApp)
// juga dipakai table.service dan merchant-order.service.
import { createHash, randomInt } from "node:crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import db from "../config/db";
import { env } from "../config/env";
import { withTransaction } from "./admin-audit.service";
import { AppError } from "../utils/errors";
import { clock, toWibTime, REMAINING_STOCK } from "./catalog.service";
import { getWibDate } from "./merchant-quota.service";
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

/**
 * Menghitung rincian harga sebelum pembeli checkout. Tidak menyimpan apa pun ke database.
 * Kalau stok menu kurang, pembeli tetap dapat rincian harga ditambah peringatan "stok habis".
 * @param userId id pembeli yang login (untuk cek jatah voucher)
 * @param data   isi keranjang: toko, menu + jumlah, kode voucher
 * @returns rincian per menu, subtotal, potongan voucher, biaya layanan, total, voucher terpakai, dan peringatan stok
 * @throws 400 isi keranjang tidak valid, 409 toko tidak menerima pesanan atau sedang tutup, 422 voucher tidak berlaku
 */
export async function quote(userId: number, data: QuoteInput) {
  const nowMs = clock.now();
  // 1. Ambil keranjang lalu cek: toko buka, menu masih dijual, stok cukup.
  const cart = validateCart(
    await loadCart(db, data, { refresh: false, day: getWibDate(new Date(nowMs)), nowMs }),
    data,
    nowMs,
  );
  // 2. Pasang voucher; potongannya dihitung ke total.
  const vouchers = await applyVouchers(db, cart, parseVoucherCodes(data), userId, nowMs);
  return {
    // 3. Kolom dipilih satu per satu supaya harga modal (hpp) tidak ikut terkirim.
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
    // 4. Stok kurang tidak menggagalkan quote; cukup jadi peringatan di layar.
    warnings: cart.shortages.map((shortage) => ({
      code: "OUT_OF_STOCK",
      menu_id: shortage.menu_id,
      available: shortage.available,
      message: `Sisa ${shortage.menu_name} tinggal ${shortage.available} ${shortage.unit_label}.`,
    })),
  };
}

// Huruf untuk kode pesanan: angka dan huruf besar tanpa I, L, O, U supaya tidak tertukar saat dibaca atau diketik.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/**
 * Pembuat 4 karakter acak untuk kode pesanan. Ditaruh di dalam objek supaya test bisa menggantinya dan
 * sengaja membuat kode kembar.
 */
export const codeGenerator = {
  random: (): string => Array.from({ length: 4 }, () => ALPHABET[randomInt(32)]).join(""),
};
/**
 * Membuat kode pesanan berbentuk `KK-YYYYMMDD-XXXX`: tanggal pesan lalu 4 karakter acak.
 * @param date tanggal hari ini menurut jam Indonesia barat (WIB), format `YYYY-MM-DD`
 * @returns kode pesanan baru; belum tentu unik, keunikan dicek saat disimpan (lihat {@link insertOrder})
 */
export const generateOrderCode = (date: string) => `KK-${date.replace(/-/g, "")}-${codeGenerator.random()}`;

const orderNotFound = () => new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
// Galat MySQL saat menyimpan nilai yang harus unik tetapi sudah ada.
const isDuplicateKey = (error: unknown) => (error as { code?: string } | null)?.code === "ER_DUP_ENTRY";

/**
 * Batas jumlah porsi yang sedang ditahan (pesanan menunggu bayar/konfirmasi) untuk satu pembeli, supaya satu akun
 * tidak memborong sisa stok toko.
 */
export const MAX_CUSTOMER_PORTIONS = 20;
/** Batas jumlah porsi yang sedang ditahan untuk satu meja QR, supaya satu meja tidak memborong sisa stok toko. */
export const MAX_TABLE_PORTIONS = 30;
/**
 * Menjumlahkan porsi dari daftar menu.
 * @param items daftar baris pesanan yang masing-masing punya `qty`
 * @returns total semua `qty`
 */
export const totalPortions = (items: { qty: number }[]) => items.reduce((sum, item) => sum + item.qty, 0);
/**
 * Menghitung porsi yang sedang ditahan pesanan `holding` (menunggu) yang belum lewat batas waktu, milik satu pembeli
 * atau satu meja. Dipakai untuk menegakkan {@link MAX_CUSTOMER_PORTIONS} dan {@link MAX_TABLE_PORTIONS}.
 * Baris dibaca dengan `FOR UPDATE`, yaitu dibaca sambil dikunci sehingga angka yang didapat adalah yang paling baru
 * dan transaksi lain harus menunggu sampai transaksi ini selesai.
 * @param conn    koneksi di dalam transaksi pemanggil. Transaksi = rangkaian perubahan database yang disimpan semua
 *                atau dibatalkan semua, tidak pernah setengah.
 * @param column  kolom pemilik pesanan: `customer_id` (pembeli) atau `table_id` (meja)
 * @param ownerId id pembeli atau id meja
 * @returns jumlah porsi yang sedang ditahan
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
// Kode kembar hanya bila yang bentrok adalah kunci unik kolom `code` di tabel orders. MySQL 8 menamainya "orders.code",
// versi lama dan TiDB menamainya "code". Kembar di kolom lain adalah galat biasa. (TiDB = database yang dipakai server
// production; bahasanya sama dengan MySQL, tetapi beberapa perilakunya sedikit berbeda.)
const isCodeCollision = (error: unknown) =>
  isDuplicateKey(error) && /for key '(orders\.)?code'/.test(String((error as Error).message));
// Penanda khusus bahwa permintaan checkout ini kiriman ulang dari permintaan sebelumnya (lihat createOrder).
const CLAIM_EXISTS = Symbol("klaim");

/**
 * Membuat galat 409 "stok tidak cukup" dengan pesan sisa stok di tiap baris yang kurang, contoh
 * `items.0.qty: "Sisa 3 porsi."`, supaya aplikasi bisa menandai baris yang bermasalah.
 * @param shortages daftar menu yang stoknya kurang
 * @returns AppError 409 OUT_OF_STOCK yang siap dilempar
 */
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
 * Menyimpan pesanan baru ke tabel `orders` dengan kode pesanan acak. Kalau kode kebetulan sudah dipakai pesanan
 * lain, dibuat kode baru dan dicoba lagi, paling banyak 5 kali. Galat kode kembar hanya membatalkan perintah INSERT
 * itu, bukan seluruh transaksi, jadi mencoba ulang aman. Dipakai checkout pembeli dan pesanan meja.
 * @param conn        koneksi di dalam transaksi pemanggil
 * @param date        tanggal WIB `YYYY-MM-DD` untuk kode pesanan
 * @param sql         perintah INSERT orders milik pemanggil
 * @param buildParams fungsi yang menerima kode pesanan dan mengembalikan nilai-nilai untuk `sql`
 * @returns id pesanan baru dan kodenya
 * @throws Error bila kode bentrok 5 kali berturut-turut (jadi 500); galat database lain diteruskan apa adanya
 */
export async function insertOrder(
  conn: PoolConnection,
  date: string,
  sql: string,
  buildParams: (orderCode: string) => unknown[],
) {
  for (let i = 0; ; i++) {
    // 1. Buat kode baru lalu coba simpan pesanannya.
    const code = generateOrderCode(date);
    try {
      const [result] = await conn.query<ResultSetHeader>(sql, buildParams(code));
      return { orderId: result.insertId, code };
    } catch (error) {
      // 2. Galat selain kode kembar diteruskan; kode kembar dicoba lagi dengan kode baru, paling banyak 5 kali.
      if (!isCodeCollision(error)) throw error;
      if (i === 4) throw new Error("Kode pesanan bentrok 5 kali.");
    }
  }
}

/**
 * Menahan stok tiap menu untuk pesanan `orderId`, lalu menyimpan baris-baris menunya ke tabel `order_items`.
 * Stok ditahan dengan satu perintah UPDATE yang hanya berhasil bila sisa stok masih cukup, jadi dua pembeli yang
 * checkout bersamaan tidak bisa sama-sama mengambil porsi terakhir. Yang dinaikkan selalu penghitung milik tanggal
 * stok pesanan, sehingga pesanan yang dibuat tepat sebelum tengah malam tidak mengurangi stok hari berikutnya.
 * `order_items` menyimpan salinan nama, harga, harga modal, dan opsi saat dipesan, supaya pesanan lama tidak ikut
 * berubah bila penjual mengubah menunya.
 * @param conn      koneksi di dalam transaksi pemanggil
 * @param orderId   id pesanan yang baru dibuat
 * @param cart      keranjang yang sudah dihitung harganya
 * @param stockDate tanggal stok pesanan (WIB, `YYYY-MM-DD`)
 * @throws 409 stok satu menu tidak cukup (berisi sisa terbaru); pemanggil lalu membatalkan seluruh transaksi
 */
export async function holdStockAndInsertItems(
  conn: PoolConnection,
  orderId: number,
  cart: PricedCart,
  stockDate: string,
) {
  // 1. Jumlahkan porsi per menu (satu menu bisa muncul di beberapa baris dengan opsi berbeda).
  const qtyByMenu = new Map<number, number>();
  for (const line of cart.lines) qtyByMenu.set(line.menu_id, (qtyByMenu.get(line.menu_id) ?? 0) + line.qty);
  // 2. Tahan stok menu satu per satu, urut id menu. Semua transaksi mengunci menu dengan urutan yang sama supaya tidak
  //    terjadi deadlock (dua transaksi saling menunggu kunci yang dipegang lawannya, selamanya).
  for (const [menuId, qty] of [...qtyByMenu].sort((left, right) => left[0] - right[0])) {
    const [result] = await conn.query<ResultSetHeader>(
      `UPDATE menus SET held_today = held_today + ?, updated_at = updated_at
       WHERE id = ? AND deleted_at IS NULL AND is_active AND stock_date = ? AND quota_today - sold_today - held_today >= ?`,
      [qty, menuId, stockDate, qty],
    );
    if (result.affectedRows === 0) {
      // 3. Stok tidak cukup: baca sisa terbaru untuk pesan galat, lalu lempar galat agar seluruh transaksi dibatalkan.
      const [[menu]] = await conn.query<RowDataPacket[]>(
        `SELECT ${REMAINING_STOCK} AS available FROM menus x WHERE id = ? FOR UPDATE`,
        [stockDate, menuId],
      );
      const lineIndex = cart.lines.findIndex((line) => line.menu_id === menuId);
      throw outOfStockError([{ ...cart.lines[lineIndex], index: lineIndex, available: Number(menu.available) }]);
    }
  }
  // 4. Simpan salinan baris menu. Harus sesudah langkah 2: menyimpan order_items ikut mengunci baris menu
  //    (karena relasi ke tabel menus), dan kunci itu bentrok dengan UPDATE di langkah 2 sehingga bisa deadlock.
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
 * Checkout pembeli: membuat pesanan berstatus `holding` (menunggu) yang menahan stok sampai batas waktu
 * `hold_until` (lama tahan diatur toko, dalam menit). Semua langkah berjalan dalam satu transaksi database: kalau
 * satu langkah gagal, semua perubahan dibatalkan sehingga tidak ada pesanan setengah jadi.
 *
 * Aturan bisnis yang dijaga:
 * - maksimal 3 pesanan menunggu per pembeli, dan maksimal {@link MAX_CUSTOMER_PORTIONS} porsi yang ditahan;
 * - stok setiap menu cukup;
 * - voucher sah dan jatah pemakaiannya dikurangi saat itu juga;
 * - bayar selain tunai hanya bisa bila Midtrans (penyedia pembayaran online) sudah disetel;
 * - nama, harga, harga modal, dan opsi menu disalin ke pesanan.
 *
 * Idempotensi: aplikasi mengirim `Idempotency-Key` yang sama bila mengulang permintaan (misalnya karena sinyal putus).
 * Kunci sama dengan isi sama menghasilkan pesanan yang sama, bukan pesanan dobel. Kunci sama dengan isi berbeda
 * ditolak 409.
 *
 * Transaksi memakai tingkat isolasi READ COMMITTED: setiap baca melihat data terbaru yang sudah disimpan. Di tingkat
 * bawaan MySQL (REPEATABLE READ), penghitungan pesanan menunggu ikut mengunci "celah" di indeks sehingga dua checkout
 * pembeli berbeda bisa saling mengunci (terbukti di test paralel). Stok tetap aman karena dijaga UPDATE bersyarat.
 *
 * @param userId         id pembeli yang login
 * @param idempotencyKey isi header Idempotency-Key (UUID huruf kecil)
 * @param data           isi checkout: keranjang, titik temu, voucher, metode bayar, nama/nomor, waktu ambil
 * @returns detail pesanan baru, bentuknya sama dengan {@link getMyOrder}
 * @throws 400 isi keranjang tidak valid; 409 sudah ada 3 pesanan menunggu, porsi menunggu melebihi batas, metode bayar
 *   belum tersedia, kunci idempotensi sudah dipakai dengan isi lain, stok tidak cukup, atau toko tidak menerima
 *   pesanan/sedang tutup; 422 voucher tidak berlaku atau jatahnya habis
 */
export async function createOrder(userId: number, idempotencyKey: string, data: OrderInput) {
  // Sidik jari isi permintaan, untuk membandingkan permintaan ulang dengan permintaan pertama.
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  let code: string;
  try {
    code = await withTransaction(async (conn) => {
      // 1. Kunci baris pembeli lebih dulu. Checkout milik pembeli yang sama jadi antre satu per satu, sehingga batas
      //    3 pesanan menunggu tidak bisa ditembus dengan mengirim banyak permintaan sekaligus. Ini harus sebelum
      //    langkah 2: catatan idempotensi berelasi ke tabel users, dan menyimpannya ikut mengunci baris pembeli.
      const [[buyer]] = await conn.query<RowDataPacket[]>(
        "SELECT full_name, phone FROM users WHERE id = ? FOR UPDATE",
        [userId],
      );
      // 2. Catat kunci idempotensi. Kalau sudah ada, berarti ini permintaan ulang: lompat ke bagian catch di bawah.
      // shortcut: order_idempotency tidak pernah dibersihkan; hapus baris lebih dari 7 hari di job harian bila tabelnya
      // sudah lebih dari 1 juta baris
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
      // 3. Tolak bila pembeli sudah punya 3 pesanan menunggu. Dibaca dengan FOR UPDATE supaya angkanya paling baru
      //    (di TiDB, baca biasa melihat data dari awal transaksi).
      // shortcut: pesanan yang lewat batas waktu tetap memakan stok sampai job kadaluarsa berikutnya (paling lama
      // 30 detik); perpendek jeda job itu bila ada keluhan stok "habis" padahal belum
      const [[holdingCount]] = await conn.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND status = 'holding' AND hold_until > UTC_TIMESTAMP() FOR UPDATE",
        [userId],
      );
      if (Number(holdingCount.n) >= 3)
        throw new AppError(409, "CONFLICT", "Masih ada 3 pesanan yang menunggu. Selesaikan atau batalkan dulu.");

      // 4. Ambil keranjang (sekalian reset kuota harian bila sudah ganti hari) lalu cek aturan dan stoknya.
      const nowMs = clock.now();
      const today = getWibDate(new Date(nowMs));
      const cart = validateCart(await loadCart(conn, data, { refresh: true, day: today, nowMs }), data, nowMs);
      if (cart.shortages.length) throw outOfStockError(cart.shortages);
      // 5. Batas 3 pesanan saja tidak cukup, karena satu pesanan bisa berisi ratusan porsi: batasi juga total porsi
      //    yang ditahan. Dicek sesudah stok, supaya stok yang memang kurang tetap dijawab "stok tidak cukup".
      if ((await getHeldPortions(conn, "customer_id", userId)) + totalPortions(data.items) > MAX_CUSTOMER_PORTIONS) {
        throw new AppError(
          409,
          "CONFLICT",
          `Maksimal ${MAX_CUSTOMER_PORTIONS} porsi menunggu per pembeli. Selesaikan atau batalkan pesanan lain dulu.`,
        );
      }
      // 6. Pasang voucher, lalu kurangi jatah pemakaiannya. UPDATE hanya berhasil bila jatah masih ada, jadi dua
      //    pembeli tidak bisa sama-sama memakai jatah terakhir. Harus sebelum pesanan disimpan: pesanan berelasi ke
      //    tabel promos, dan menyimpannya ikut mengunci baris promo sehingga UPDATE sesudahnya bisa deadlock. Promo
      //    dikunci urut id, lalu menu, sama dengan urutan saat pesanan dibatalkan.
      const vouchers = await applyVouchers(conn, cart, parseVoucherCodes(data), userId, nowMs, data.payment_method);
      const usedPromos = [vouchers.merchantPromo, vouchers.platformPromo]
        .filter((promo): promo is RowDataPacket => promo !== null)
        .sort((left, right) => left.id - right.id);
      for (const promo of usedPromos) {
        // shortcut: reset kuota harian menu berjalan sebelum ini pada checkout pertama hari itu; bila bersamaan
        // dengan pembatalan pesanan berpromo di toko yang sama bisa terjadi deadlock langka; cukup dicoba ulang
        const [result] = await conn.query<ResultSetHeader>(
          "UPDATE promos SET used_count = used_count + 1 WHERE id = ? AND (quota IS NULL OR used_count < quota)",
          [promo.id],
        );
        if (!result.affectedRows) throw promoInvalid("Kuota promo sudah habis.");
      }
      // 7. Bayar selain tunai selalu lewat Midtrans; tanpa kunci server Midtrans, metode itu belum bisa dipakai.
      if (data.payment_method !== "cod" && !env.MIDTRANS_SERVER_KEY) {
        throw new AppError(
          409,
          "CONFLICT",
          `Pembayaran ${data.payment_method === "va" ? "Virtual Account" : "online"} belum tersedia. Pilih metode lain.`,
        );
      }

      // 8. Simpan pesanan dengan kode baru, batas waktu tahan, dan tanggal stok hari ini.
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
      // 9. Tahan stok dan simpan baris menu.
      await holdStockAndInsertItems(conn, orderId, cart, today);
      // 10. Catat pemakaian tiap voucher (satu baris per voucher). Catatan ini dipakai untuk mengembalikan jatah
      //     voucher bila pesanan batal atau kadaluarsa, dan untuk menghitung batas pakai per pembeli.
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
      // 11. Catat riwayat status pertama, lalu tautkan kunci idempotensi ke pesanan ini.
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
    // 12. Permintaan ulang: langkah 2 menunggu sampai transaksi permintaan pertama selesai, lalu di sini pesanan
    //     permintaan pertama dicari. Isi sama → kembalikan pesanan itu; isi berbeda atau pesanan tidak ada → 409.
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

/**
 * Kolom SQL yang sama untuk pesanan versi pembeli dan versi penjual. Dipakai bersama alias tabel `o` (orders) dan
 * `p` (pickup_points, titik temu). `seconds_left` = sisa detik sebelum batas waktu tahan, tidak pernah negatif.
 */
export const ORDER_COLUMNS = `o.id, o.code, o.status, o.payment_method, o.payment_status, o.hold_until, o.pickup_at,
  GREATEST(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), o.hold_until), 0) AS seconds_left, o.pickup_point_id, p.name AS p_name,
  o.subtotal, o.discount, o.service_fee, o.total, o.note, o.cancel_reason, o.cancelled_by, o.created_at, o.updated_at`;
// Kolom + tabel untuk pesanan versi pembeli: ditambah data toko dan jumlah menu yang belum diulas pembeli.
const CUSTOMER_ORDER_SELECT = `${ORDER_COLUMNS}, o.merchant_id, m.business_name, m.wa_number,
  (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND NOT EXISTS
    (SELECT 1 FROM reviews r WHERE r.order_id = o.id AND r.menu_id = i.menu_id)) AS belum_diulas
  FROM orders o JOIN merchants m ON m.id = o.merchant_id JOIN pickup_points p ON p.id = o.pickup_point_id`;

/**
 * Satu menu di dalam pesanan, seperti yang dikirim ke aplikasi: salinan nama, harga, dan opsi saat dipesan,
 * tanpa harga modal.
 */
export type Item = {
  menu_id: number;
  menu_name: string;
  qty: number;
  unit_price: number;
  options: unknown[];
  line_total: number;
};

/**
 * Mengambil menu-menu dari banyak pesanan sekaligus dengan satu kueri, bukan satu kueri per pesanan (cara itu
 * lambat bila satu halaman berisi 20 pesanan). Kolom dipilih satu per satu supaya harga modal tidak ikut terkirim.
 * @param ids daftar id pesanan
 * @returns peta id pesanan → daftar menunya (urut seperti saat dipesan); pesanan tanpa menu tidak ada di peta
 */
export async function loadOrderItems(ids: number[]): Promise<Map<number, Item[]>> {
  // 1. Tanpa id pesanan tidak perlu bertanya ke database.
  const itemsByOrder = new Map<number, Item[]>();
  if (!ids.length) return itemsByOrder;
  // 2. Ambil semua menu dari pesanan-pesanan itu dalam satu kueri.
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT order_id, menu_id, menu_name, qty, unit_price, options, line_total FROM order_items WHERE order_id IN (?) ORDER BY id",
    [ids],
  );
  // 3. Kelompokkan per id pesanan, kolom dipilih satu per satu.
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
 * Menyusun bagian respons pesanan yang sama untuk pembeli dan penjual. Kolom dipilih satu per satu supaya kolom lain
 * dari database tidak ikut terkirim. `hold_until` dan `seconds_left` hanya diisi selama pesanan masih menunggu.
 * @param order baris pesanan dari database yang memuat {@link ORDER_COLUMNS}
 * @param items menu-menu pesanan ini
 * @returns objek pesanan untuk dikirim ke aplikasi
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
 * Menyusun respons pesanan versi pembeli: {@link mapOrderBase} ditambah data toko dan tanda tombol yang boleh tampil
 * (`can_cancel`, `can_complete`, `can_review`), supaya aplikasi tidak perlu menebak aturannya sendiri.
 * Aturannya: batal boleh selama pesanan menunggu dan belum lewat batas waktu, atau sudah diterima toko tetapi bayar
 * tunai; selesai boleh saat pesanan siap diambil; ulasan boleh setelah selesai bila masih ada menu yang belum diulas.
 * @param order baris pesanan dari database (kolom {@link CUSTOMER_ORDER_SELECT})
 * @param items menu-menu pesanan ini
 * @returns objek pesanan untuk pembeli, tanpa info pembayaran
 */
export const mapCustomerOrder = (order: RowDataPacket, items: Item[]) => ({
  ...mapOrderBase(order, items),
  merchant: { id: order.merchant_id, business_name: order.business_name, wa_number: order.wa_number },
  can_cancel:
    (order.status === "holding" && Number(order.seconds_left) > 0) ||
    (order.status === "confirmed" && order.payment_method === "cod"),
  can_complete: order.status === "ready",
  can_review: order.status === "completed" && Number(order.belum_diulas) > 0,
});

/**
 * Membuat pola pencarian SQL LIKE "mengandung kata ini". Tanda `%`, `_`, dan `\` dari pengguna diberi garis miring
 * supaya dibaca sebagai huruf biasa, bukan sebagai tanda khusus LIKE. Dipakai juga oleh moderasi dan tiket admin.
 * Pemanggil membandingkan `LOWER(kolom) LIKE LOWER(?)` karena di TiDB perbandingan teks membedakan huruf besar-kecil.
 * @param search kata yang dicari
 * @returns pola LIKE, contoh `%nasi%`
 */
export const likePattern = (search: string) => `%${search.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * Mengambil satu halaman daftar pesanan, dipakai daftar pesanan pembeli dan daftar pesanan toko. Hanya tiga kueri:
 * hitung total, ambil satu halaman, ambil menu-menunya. Urutan bawaan terbaru dulu. Bila `updated_since` diisi
 * (aplikasi hanya meminta yang berubah sejak waktu tertentu), urutannya waktu ubah dari yang terlama, supaya aplikasi
 * yang lanjut dari waktu ubah terakhir di halaman sebelumnya tidak melewatkan perubahan.
 * @param selectFrom daftar kolom + bagian FROM; alias tabel orders wajib `o`
 * @param where      syarat-syarat SQL yang digabung dengan AND
 * @param args       nilai untuk tanda `?` di `where`
 * @param filter     nomor halaman, jumlah per halaman, dan `updated_since` opsional
 * @param mapRow     pengubah baris database + menunya menjadi bentuk respons
 * @returns `{ data, meta: { page, limit, total } }`
 */
export async function paginateOrders<T>(
  selectFrom: string,
  where: string[],
  args: unknown[],
  filter: { page: number; limit: number; updated_since?: string },
  mapRow: (row: RowDataPacket, items: Item[]) => T,
) {
  // 1. Tentukan urutan, lalu hitung jumlah semua pesanan yang cocok (untuk info halaman).
  const orderBy = filter.updated_since ? "o.updated_at ASC, o.id ASC" : "o.created_at DESC, o.id DESC";
  const whereSql = where.join(" AND ");
  const [[countRow]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM orders o WHERE ${whereSql}`, args);
  // 2. Ambil satu halaman saja (LIMIT = jumlah per halaman, OFFSET = baris yang dilewati).
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectFrom} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...args, filter.limit, (filter.page - 1) * filter.limit],
  );
  // 3. Ambil menu-menu halaman ini sekaligus, lalu susun respons.
  const items = await loadOrderItems(rows.map((row) => row.id));
  return {
    data: rows.map((row) => mapRow(row, items.get(row.id) ?? [])),
    meta: { page: filter.page, limit: filter.limit, total: Number(countRow.n) },
  };
}

// Status pesanan yang masuk ke tiap tab di halaman "Pesanan saya".
const STATUSES_BY_TAB: Record<MyOrdersQuery["tab"], Status[]> = {
  active: ["holding", "confirmed", "cooking", "ready"],
  completed: ["completed"],
  cancelled: ["cancelled", "expired"],
};

/**
 * Daftar pesanan milik pembeli yang login, per tab (aktif, selesai, batal/kadaluarsa), dengan pencarian berdasarkan
 * kode pesanan atau nama menu. Bila `updated_since` diisi, tab diabaikan supaya pesanan yang pindah tab (misalnya
 * dari aktif ke selesai) tetap terkirim ke aplikasi.
 * @param userId id pembeli yang login
 * @param filter tab, kata cari, `updated_since`, halaman, dan jumlah per halaman
 * @returns `{ data, meta }` seperti {@link paginateOrders}; tiap pesanan berbentuk {@link mapCustomerOrder}
 */
export async function listMyOrders(userId: number, filter: MyOrdersQuery) {
  // 1. Syarat dasar: hanya pesanan milik pembeli ini.
  const where = ["o.customer_id = ?"];
  const args: unknown[] = [userId];
  // 2. Bila updated_since diisi, tab diabaikan; kalau tidak, saring status sesuai tab.
  if (filter.updated_since) {
    where.push("o.updated_at >= ?");
    args.push(new Date(filter.updated_since));
  } else {
    where.push("o.status IN (?)");
    args.push(STATUSES_BY_TAB[filter.tab]);
  }
  // 3. Pencarian kode pesanan atau nama menu.
  if (filter.q) {
    where.push(
      "(LOWER(o.code) LIKE LOWER(?) OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND LOWER(i.menu_name) LIKE LOWER(?)))",
    );
    args.push(likePattern(filter.q), likePattern(filter.q));
  }
  // 4. Ambil satu halaman.
  return paginateOrders(CUSTOMER_ORDER_SELECT, where, args, filter, mapCustomerOrder);
}

/**
 * Detail satu pesanan milik pembeli yang login: bentuk {@link mapCustomerOrder} ditambah `payment` (metode, status,
 * jumlah). Pesanan milik pembeli lain dijawab 404, seolah tidak ada, supaya kode pesanan orang lain tidak bisa diintip.
 * - Bayar `online`: ditambah `payment_url` (halaman bayar Midtrans Snap terbaru) dan `qris` (kode QR terbaru).
 *   Keduanya null bila belum dibuat, atau pesanan sudah tidak menunggu bayar (bukan `holding`, atau sudah lunas).
 * - Bayar `va` (Virtual Account, nomor rekening sementara untuk transfer bank): ditambah `va` (bank, nomor, batas
 *   bayar). Null hanya bila pembeli belum memilih bank; setelah lunas atau batal tetap dikirim.
 * - Bayar `cod` (tunai) dan `qris` lama: hanya `payment` dasar.
 * @param userId id pembeli yang login
 * @param code   kode pesanan
 * @returns detail pesanan beserta info pembayarannya
 * @throws 404 pesanan tidak ada atau milik pembeli lain
 */
export async function getMyOrder(userId: number, code: string) {
  // 1. Ambil pesanan; syarat customer_id memastikan hanya pemiliknya yang bisa melihat.
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT ${CUSTOMER_ORDER_SELECT} WHERE o.code = ? AND o.customer_id = ?`,
    [code, userId],
  );
  if (!order) throw orderNotFound();
  const items = await loadOrderItems([order.id]);
  const payment = { method: order.payment_method, status: order.payment_status, amount: order.total };
  // 2. Bayar online: ambil halaman Snap dan QRIS terbaru. Halaman Snap dibuat lewat POST /orders/:code/online,
  //    QRIS lewat POST /orders/:code/qris; untuk QRIS, kolom redirect_url berisi alamat gambar QR dari Midtrans.
  if (order.payment_method === "online") {
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
  // 3. Tunai: cukup info pembayaran dasar.
  if (order.payment_method !== "va") return { ...mapCustomerOrder(order, items.get(order.id) ?? []), payment };
  // 4. Virtual Account: ambil VA terbaru (belum ada sampai pembeli memilih bank lewat POST /orders/:code/va).
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

// Jalankan aksi pembeli (batal/selesai) lewat mesin status di dalam transaksi, lalu kirim detail pesanan terbaru.
const transitionMyOrder = async (
  userId: number,
  code: string,
  action: "cancel" | "complete",
  reason: string | null = null,
) => {
  await withTransaction((conn) => transitionOrder(conn, code, action, { kind: "customer", userId }, reason));
  return getMyOrder(userId, code);
};
/**
 * Pembeli membatalkan pesanannya. Boleh selama pesanan masih menunggu dan belum lewat batas waktu, atau sudah
 * diterima toko tetapi bayar tunai. Stok yang ditahan dan jatah voucher dikembalikan oleh mesin status.
 * @param userId id pembeli yang login
 * @param code   kode pesanan
 * @param reason alasan batal (boleh kosong)
 * @returns detail pesanan terbaru seperti {@link getMyOrder}
 * @throws 404 pesanan tidak ada atau milik pembeli lain, 409 status pesanan sudah tidak bisa dibatalkan
 */
export const cancelMyOrder = (userId: number, code: string, reason: string | null) =>
  transitionMyOrder(userId, code, "cancel", reason);
/**
 * Pembeli menandai pesanan yang siap diambil sudah ia terima. Pesanan tunai sekalian ditandai lunas.
 * @param userId id pembeli yang login
 * @param code   kode pesanan
 * @returns detail pesanan terbaru seperti {@link getMyOrder}
 * @throws 404 pesanan tidak ada atau milik pembeli lain, 409 pesanan belum siap diambil
 */
export const completeMyOrder = (userId: number, code: string) => transitionMyOrder(userId, code, "complete");

// Templat pesan WhatsApp dari pembeli ke toko (ditulis dari sudut pandang pembeli). Templat milik toko
// (wa_template, dari sudut pandang penjual) dipakai untuk arah sebaliknya, lihat merchant-order.service.
const CUSTOMER_WA_TEMPLATE =
  "Halo {toko}, saya {nama} memesan lewat KateringKita.\n\nKode: {kode}\nMenu: {menu}\nTotal: {total}\n" +
  "Cara bayar: {metode_bayar}\nAmbil di: {titik_temu}\nWaktu ambil: {waktu_ambil}";
// Nama metode bayar untuk pesan WhatsApp. `qris` hanya ada di pesanan lama, sebelum bayar online lewat Midtrans.
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  qris: "QRIS toko",
  va: "Virtual Account",
  cod: "Tunai",
  online: "Bayar online",
};

/**
 * Menyiapkan isi untuk tiap tempat kosong di templat WhatsApp (`{kode}`, `{nama}`, `{toko}`, `{menu}`, `{total}`,
 * `{titik_temu}`, `{waktu_ambil}`, `{metode_bayar}`, `{catatan}`). Dipakai pesan pembeli dan pesan penjual.
 * Formatnya sama dengan fe/lib/wa-template.ts di web: "Rp 30.000", jam "HH.MM WIB" atau "Secepatnya", "Tunai".
 * Tanggal ambil hanya ditulis bila bukan hari ini.
 * @param order data pesanan: kode, nama pembeli, nama toko, menu, total, titik temu, waktu ambil, metode bayar, catatan
 * @returns peta nama tempat kosong → teks pengisinya
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
      ? `${pickupDayPrefix(order.pickup_at)}${toWibTime(order.pickup_at.getTime()).slice(0, 5).replace(":", ".")} WIB`
      : "Secepatnya",
    metode_bayar: PAYMENT_METHOD_LABELS[order.payment_method] ?? order.payment_method,
    catatan: order.note ?? "",
  };
}

const wibDateFormat = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "long" });
// Awalan tanggal seperti "3 November " bila hari ambil (WIB) bukan hari ini; kosong bila hari ini.
const pickupDayPrefix = (date: Date) =>
  getWibDate(date) === getWibDate(new Date(clock.now())) ? "" : `${wibDateFormat.format(date)} `;

/**
 * Mengisi templat WhatsApp: setiap `{nama}` diganti `values.nama`. Tempat kosong yang tidak dikenal dibiarkan apa
 * adanya, sama dengan fungsi renderTemplate di web.
 * @param template teks templat
 * @param values   isi tiap tempat kosong, biasanya dari {@link buildWaValues}
 * @returns teks pesan yang sudah diisi
 */
export const render = (template: string, values: Record<string, string>) =>
  template.replace(/\{[^{}\n]+\}/g, (placeholder) => values[placeholder.slice(1, -1)] ?? placeholder);

/**
 * Membuat tautan `https://wa.me/<nomor>?text=<pesan>` yang membuka chat WhatsApp berisi pesan siap kirim.
 * Nomor 08…, 628…, atau +628… diubah jadi 628…, karena wa.me butuh kode negara tanpa tanda +.
 * @param phone nomor WhatsApp tujuan
 * @param text  isi pesan
 * @returns tautan wa.me
 */
export const waLink = (phone: string, text: string) =>
  `https://wa.me/${phone.replace(/\D/g, "").replace(/^0/, "62")}?text=${encodeURIComponent(text)}`;

/**
 * Menyiapkan pesan WhatsApp dari pembeli ke toko untuk pesanan miliknya. Baris catatan hanya ditambahkan bila
 * pesanan punya catatan.
 * @param userId id pembeli yang login
 * @param code   kode pesanan
 * @returns `wa_number` toko, `message` yang sudah diisi, dan `url` wa.me
 * @throws 404 pesanan tidak ada atau milik pembeli lain
 */
export async function getMyOrderWhatsapp(userId: number, code: string) {
  // 1. Ambil pesanan milik pembeli ini beserta nama dan nomor WhatsApp toko.
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.code, o.customer_name, o.total, o.pickup_at, o.payment_method, o.note, m.business_name, m.wa_number,
       p.name AS titik_temu
     FROM orders o JOIN merchants m ON m.id = o.merchant_id JOIN pickup_points p ON p.id = o.pickup_point_id
     WHERE o.code = ? AND o.customer_id = ?`,
    [code, userId],
  );
  if (!order) throw orderNotFound();
  // 2. Ambil jumlah dan nama menu untuk ditulis di pesan.
  const [items] = await db.query<RowDataPacket[]>(
    "SELECT qty, menu_name FROM order_items WHERE order_id = ? ORDER BY id",
    [order.id],
  );
  // 3. Isi templat, lalu buat tautan wa.me.
  const message = render(
    CUSTOMER_WA_TEMPLATE + (order.note ? "\nCatatan: {catatan}" : ""),
    buildWaValues({ ...order, items } as Parameters<typeof buildWaValues>[0]),
  );
  return { wa_number: order.wa_number, message, url: waLink(order.wa_number, message) };
}

/**
 * Fitur "pesan lagi": isi pesanan lama (menu, opsi, titik temu, catatan) disusun ulang menjadi keranjang baru, lalu
 * dihitung ulang lewat {@link quote} dengan harga, stok, dan promo hari ini. Tidak menyimpan apa pun. Aplikasi lalu
 * menambahkan metode bayar dan mengirim `request` ke POST /orders.
 * @param userId id pembeli yang login
 * @param code   kode pesanan lama
 * @returns `request` (keranjang siap kirim) dan `quote` (rincian harga terbarunya)
 * @throws 404 pesanan tidak ada atau milik pembeli lain; galat yang sama dengan {@link quote} (menu tidak tersedia,
 *   toko tutup, dan lain-lain)
 */
export async function reorder(userId: number, code: string) {
  // 1. Ambil pesanan lama milik pembeli ini beserta menunya.
  const [[order]] = await db.query<RowDataPacket[]>(
    "SELECT id, pickup_point_id, note FROM orders WHERE code = ? AND customer_id = ?",
    [code, userId],
  );
  if (!order) throw orderNotFound();
  const items = (await loadOrderItems([order.id])).get(order.id) ?? [];
  // 2. Susun ulang menjadi isi keranjang dan periksa dengan skema quote, sama seperti kiriman dari aplikasi.
  const request = quoteSchema.parse({
    items: items.map((item) => ({
      menu_id: item.menu_id,
      qty: item.qty,
      option_ids: (item.options as { id: number }[]).map((option) => option.id),
    })),
    pickup_point_id: order.pickup_point_id,
    note: order.note,
  });
  // 3. Hitung harganya dengan data hari ini.
  return { request, quote: await quote(userId, request) };
}
