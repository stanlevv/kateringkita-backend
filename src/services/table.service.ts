// Isi file: fitur pesan dari meja. Penjual mengelola meja dan kode QR-nya; tamu memindai QR, memesan tanpa login,
// lalu membayar online lewat Midtrans Snap (halaman bayar milik penyedia pembayaran Midtrans). Alurnya
// routes/table.ts dan routes/merchant.ts → handlers/table.handler.ts → file ini → database.
import { createHash, randomBytes } from "node:crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { TableOrderInput, UpdateTableInput } from "../dto/table.dto";
import { dalamTransaksi } from "./admin-audit.service";
import { asalSah, bukaSnap, KOLOM_SNAP, URL_BAYAR } from "./pembayaran-va.service";
import {
  MENU_FROM,
  clock,
  JOIN_FAVORITE,
  mapMenuCard,
  MENU_CARD_COLUMNS,
  MENU_VISIBLE,
  isMerchantOpen,
  MERCHANT_VISIBLE,
} from "./catalog.service";
import { getWibDate } from "./merchant-quota.service";
import { getMerchantId } from "./merchant-menu.service";
import { loadCart, validateCart } from "./order-cart.service";
import {
  outOfStockError,
  MAX_TABLE_PORTIONS,
  loadOrderItems,
  getHeldPortions,
  insertOrder,
  holdStockAndInsertItems,
  totalPortions,
} from "./order.service";

// Urutan pakai: pindai QR meja → lihat menu tanpa login → buat pesanan tamu → bayar lewat Snap → pantau status
// dengan "token tamu". Token tamu adalah kata sandi acak yang hanya disimpan peramban tamu; database hanya menyimpan
// hash-nya (sidik jari satu arah dengan algoritma SHA256), jadi orang yang membaca database tetap tidak tahu
// token aslinya.

const MAX_TABLES = 100;
// shortcut: batas pesanan menunggu per meja menahan stok dari pesanan iseng; naikkan bila satu meja dipakai
// rombongan besar
const MAX_HOLDING_ORDERS = 5;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const conflict = (message: string) => new AppError(409, "CONFLICT", message);
const tableNotFound = () => new AppError(404, "NOT_FOUND", "Meja tidak ditemukan atau tidak aktif.");
const orderNotFound = () => new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
// "08:00:00" dari database → "08:00".
const formatHourMinute = (time: unknown) => String(time).slice(0, 5);

// ---------- bagian penjual: kelola meja ----------
const mapTable = (row: RowDataPacket) => ({
  id: row.id,
  label: row.label,
  token: row.token,
  is_active: Boolean(row.is_active),
});
// Nama meja unik per toko; galat "nilai kembar" dari MySQL berarti nama sudah dipakai.
const isLabelTaken = (error: unknown) => (error as { code?: string }).code === "ER_DUP_ENTRY";
const labelTakenError = () =>
  new AppError(409, "CONFLICT", "Nama meja sudah dipakai.", { label: ["Nama meja sudah dipakai."] });

/**
 * Daftar meja milik toko penjual yang login, diurutkan panjang nama lalu nama, supaya "Meja 2" muncul sebelum
 * "Meja 10".
 * @param userId id penjual yang login
 * @returns `{ id, label, token, is_active }` per meja; `token` = isi kode QR meja
 * @throws 404 akun ini belum punya toko
 */
export async function listTables(userId: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, label, token, is_active FROM merchant_tables WHERE merchant_id = ? ORDER BY LENGTH(label), label",
    [await getMerchantId(userId)],
  );
  return rows.map(mapTable);
}

// Ambil satu meja milik toko; 404 bila meja tidak ada atau milik toko lain.
async function getTable(merchantId: number, tableId: number) {
  const [[row]] = await db.query<RowDataPacket[]>(
    "SELECT id, label, token, is_active FROM merchant_tables WHERE id = ? AND merchant_id = ?",
    [tableId, merchantId],
  );
  if (!row) throw new AppError(404, "NOT_FOUND", "Meja tidak ditemukan.");
  return mapTable(row);
}

/**
 * Membuat meja baru dengan token QR acak (32 karakter heksadesimal). Satu toko paling banyak {@link MAX_TABLES} meja.
 * @param userId id penjual yang login
 * @param label  nama meja, contoh "Meja 1"
 * @returns meja yang baru dibuat
 * @throws 404 akun ini belum punya toko; 409 batas jumlah meja tercapai, atau nama meja sudah dipakai (pesan di
 *   kolom `label`)
 */
export async function createTable(userId: number, label: string) {
  // 1. Cek batas jumlah meja toko ini.
  const merchantId = await getMerchantId(userId);
  const [[countRow]] = await db.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM merchant_tables WHERE merchant_id = ?",
    [merchantId],
  );
  if (Number(countRow.n) >= MAX_TABLES) throw conflict(`Maksimal ${MAX_TABLES} meja per toko.`);
  // 2. Simpan meja dengan token QR acak; nama kembar dijawab 409.
  try {
    const [result] = await db.query<ResultSetHeader>(
      "INSERT INTO merchant_tables (merchant_id, label, token) VALUES (?, ?, ?)",
      [merchantId, label, randomBytes(16).toString("hex")],
    );
    return getTable(merchantId, result.insertId);
  } catch (error) {
    if (isLabelTaken(error)) throw labelTakenError();
    throw error;
  }
}

/**
 * Mengubah nama atau status aktif meja milik toko penjual. `ganti_token: true` membuat token QR baru sehingga QR
 * lama tidak berlaku lagi (misalnya stiker QR hilang).
 * @param userId id penjual yang login
 * @param rawId  id meja dari alamat URL, belum diperiksa; bila bukan bilangan bulat ≥ 1 dijawab 404
 * @param input  perubahan yang sudah lolos skema: `label`, `is_active`, dan/atau `ganti_token`
 * @returns meja setelah diubah
 * @throws 404 meja tidak ada atau milik toko lain, 409 nama meja sudah dipakai
 */
export async function updateTable(userId: number, rawId: unknown, input: UpdateTableInput) {
  const merchantId = await getMerchantId(userId);
  // 1. Pastikan meja ada dan milik toko ini.
  const tableId = Number(rawId);
  if (!Number.isInteger(tableId) || tableId < 1) throw new AppError(404, "NOT_FOUND", "Meja tidak ditemukan.");
  await getTable(merchantId, tableId);
  // 2. Susun bagian SET hanya dari kolom yang dikirim.
  const sets: string[] = [];
  const args: unknown[] = [];
  if (input.label !== undefined) (sets.push("label = ?"), args.push(input.label));
  if (input.is_active !== undefined) (sets.push("is_active = ?"), args.push(input.is_active));
  if (input.ganti_token) (sets.push("token = ?"), args.push(randomBytes(16).toString("hex")));
  // 3. Simpan; nama kembar dijawab 409.
  try {
    await db.query(`UPDATE merchant_tables SET ${sets.join(", ")} WHERE id = ? AND merchant_id = ?`, [
      ...args,
      tableId,
      merchantId,
    ]);
  } catch (error) {
    if (isLabelTaken(error)) throw labelTakenError();
    throw error;
  }
  return getTable(merchantId, tableId);
}

// ---------- bagian publik: tamu ----------
// Cari meja dari token QR. Syaratnya: meja aktif, fitur makan di tempat (dine-in) toko menyala, dan toko boleh
// tampil (terverifikasi, akun pemilik aktif). Token yang bentuknya salah langsung 404 tanpa bertanya ke database.
async function getActiveTable(token: string) {
  // 1. Tolak token yang bentuknya salah tanpa kueri.
  if (!/^[0-9a-f]{32}$/.test(token)) throw tableNotFound();
  // 2. Cari meja beserta profil tokonya, hanya bila semua syarat di atas terpenuhi.
  const [[table]] = await db.query<RowDataPacket[]>(
    `SELECT t.id, t.label, m.id AS merchant_id, m.slug, m.business_name, m.description, m.logo_url, m.is_open, m.open_time, m.close_time
     FROM merchant_tables t JOIN merchants m ON m.id = t.merchant_id JOIN users u ON u.id = m.user_id
     WHERE t.token = ? AND t.is_active AND m.dine_in_enabled AND ${MERCHANT_VISIBLE}`,
    [token],
  );
  if (!table) throw tableNotFound();
  return table;
}

/**
 * Data halaman menu meja untuk tamu: nama meja, profil toko (termasuk sedang buka atau tutup), dan menu yang dijual.
 * Tiap menu berisi data kartu katalog ditambah deskripsi, jumlah minimal pesan, dan opsi tambahan yang aktif.
 * Menu pre-order tidak dijual lewat meja.
 * @param token token dari kode QR meja
 * @returns `{ table, merchant, menus }`
 * @throws 404 token salah, meja nonaktif, dine-in toko mati, atau toko tidak boleh tampil
 */
export async function getTableMenu(token: string) {
  const table = await getActiveTable(token);
  const nowMs = clock.now();
  // 1. Menu toko yang tampil, urut kategori lalu yang paling laku.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MENU_CARD_COLUMNS}, x.description, x.min_order_qty FROM ${MENU_FROM} ${JOIN_FAVORITE}
     WHERE ${MENU_VISIBLE} AND m.id = ? AND NOT x.is_preorder
     ORDER BY c.sort_order, c.name, x.sold_total DESC, x.id`,
    [getWibDate(new Date(nowMs)), null, table.merchant_id],
  );
  // 2. Opsi tambahan yang aktif, dikelompokkan per menu (satu kueri untuk semua menu).
  const optionsByMenu = new Map<number, { id: number; name: string; extra_price: number }[]>();
  if (rows.length) {
    const [optionRows] = await db.query<RowDataPacket[]>(
      "SELECT id, menu_id, name, extra_price FROM menu_options WHERE menu_id IN (?) AND is_active ORDER BY id",
      [rows.map((row) => row.id)],
    );
    for (const row of optionRows)
      optionsByMenu.set(row.menu_id, [
        ...(optionsByMenu.get(row.menu_id) ?? []),
        { id: row.id, name: row.name, extra_price: row.extra_price },
      ]);
  }
  // 3. Susun respons kolom demi kolom.
  return {
    table: { label: table.label },
    merchant: {
      slug: table.slug,
      business_name: table.business_name,
      description: table.description,
      logo_url: table.logo_url,
      is_open: isMerchantOpen(table, nowMs),
      open_time: formatHourMinute(table.open_time),
      close_time: formatHourMinute(table.close_time),
    },
    menus: rows.map((row) => ({
      ...mapMenuCard(row, nowMs),
      description: row.description,
      min_order_qty: row.min_order_qty,
      options: optionsByMenu.get(row.id) ?? [],
    })),
  };
}

/**
 * Membuat pesanan tamu dari QR meja: status `holding` (menunggu bayar), metode bayar `online`, tanpa akun pembeli.
 * Pemeriksaan dan penahanan stok sama dengan checkout pembeli, tetapi tanpa titik temu dan tanpa voucher; tamu lalu
 * membayar lewat Snap. Batas per meja: paling banyak {@link MAX_HOLDING_ORDERS} pesanan menunggu dan
 * MAX_TABLE_PORTIONS porsi yang ditahan. Token tamu acak dibuat di sini; database hanya menyimpan hash-nya.
 * Semua langkah berjalan dalam satu transaksi database (perubahan disimpan semua atau dibatalkan semua).
 * @param token token dari kode QR meja
 * @param data  isi pesanan tamu: menu + jumlah, catatan, nama, nomor HP (opsional)
 * @returns `guest_token` (hanya dikirim sekali ini, disimpan peramban tamu) dan status pesanan seperti
 *   {@link getGuestOrder}
 * @throws 404 meja tidak ditemukan; 400 isi pesanan tidak valid atau menu bukan dari toko ini; 409 batas pesanan
 *   atau porsi menunggu per meja tercapai, stok tidak cukup, atau toko tidak menerima pesanan/sedang tutup
 */
export async function createTableOrder(token: string, data: TableOrderInput) {
  const table = await getActiveTable(token);
  const guestToken = randomBytes(24).toString("base64url");
  // Transaksi memakai tingkat isolasi READ COMMITTED (argumen terakhir dalamTransaksi): setiap baca melihat data
  // terbaru yang sudah disimpan, dan penghitungan pesanan tidak mengunci "celah" di indeks. Alasannya dijelaskan di
  // createOrder (order.service).
  const code = await dalamTransaksi(async (conn) => {
    // 1. Kunci baris meja (FOR UPDATE = baca sambil mengunci) supaya pesanan dari meja yang sama antre satu per
    //    satu, sehingga batas pesanan menunggu tidak bisa ditembus dengan banyak permintaan sekaligus.
    await conn.query("SELECT id FROM merchant_tables WHERE id = ? FOR UPDATE", [table.id]);
    const [[countRow]] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM orders WHERE table_id = ? AND status = 'holding' AND hold_until > UTC_TIMESTAMP() FOR UPDATE",
      [table.id],
    );
    if (Number(countRow.n) >= MAX_HOLDING_ORDERS)
      throw conflict("Masih ada pesanan meja ini yang menunggu pembayaran. Selesaikan dulu.");
    // 2. Periksa keranjang seperti checkout, tanpa titik temu, waktu ambil, dan voucher.
    const nowMs = clock.now();
    const today = getWibDate(new Date(nowMs));
    const cartInput = { ...data, pickup_point_id: 0, promo_code: null, promo_codes: [], pickup_at: null };
    const cart = validateCart(await loadCart(conn, cartInput, { refresh: true, day: today, nowMs }), cartInput, nowMs, {
      skipPickupPoint: true,
    });
    if (cart.merchant.id !== table.merchant_id)
      throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { items: ["Menu bukan dari toko ini."] });
    if (cart.shortages.length) throw outOfStockError(cart.shortages);
    // 3. Tamu tidak login dan belum membayar, jadi batasi juga total porsi yang ditahan per meja, bukan hanya jumlah
    //    pesanannya. Dicek sesudah stok, supaya stok yang memang kurang tetap dijawab "stok tidak cukup".
    if ((await getHeldPortions(conn, "table_id", table.id)) + totalPortions(data.items) > MAX_TABLE_PORTIONS) {
      throw conflict(
        `Maksimal ${MAX_TABLE_PORTIONS} porsi menunggu pembayaran per meja. Selesaikan pembayaran pesanan lain dulu.`,
      );
    }
    // 4. Simpan pesanan (tanpa akun pembeli, dengan hash token tamu), tahan stok, dan catat riwayat status pertama.
    const { orderId, code } = await insertOrder(
      conn,
      today,
      `INSERT INTO orders (code, customer_id, merchant_id, pickup_point_id, table_id, guest_token_hash, status, customer_name, customer_phone,
         note, subtotal, discount, service_fee, total, payment_method, payment_status, hold_until, stock_date)
       VALUES (?, NULL, ?, NULL, ?, ?, 'holding', ?, ?, ?, ?, 0, ?, ?, 'online', 'unpaid', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?)`,
      (orderCode) => [
        orderCode,
        table.merchant_id,
        table.id,
        hash(guestToken),
        data.customer_name,
        data.customer_phone,
        data.note,
        cart.subtotal,
        cart.service_fee,
        cart.total,
        cart.merchant.hold_minutes,
        today,
      ],
    );
    await holdStockAndInsertItems(conn, orderId, cart, today);
    await conn.query(
      "INSERT INTO order_status_logs (order_id, from_status, to_status, actor_user_id) VALUES (?, NULL, 'holding', NULL)",
      [orderId],
    );
    return code;
  }, "READ COMMITTED");
  return { guest_token: guestToken, ...(await getGuestOrder(code, guestToken)) };
}

/**
 * Status pesanan tamu untuk halaman status di web: menu, total, sisa waktu tahan, dan `payment_url` (halaman bayar
 * Snap) selama pesanan masih menunggu bayar.
 * @param code       kode pesanan
 * @param guestToken token tamu dari header X-Guest-Token; dicocokkan dengan hash yang tersimpan
 * @returns status pesanan tamu
 * @throws 404 kode pesanan atau token tamu tidak cocok
 */
export async function getGuestOrder(code: string, guestToken: string) {
  // 1. Cari pesanan dengan kode + hash token tamu (token salah = 404).
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.code, o.status, o.payment_status, o.customer_name, o.note, o.subtotal, o.service_fee, o.total, o.hold_until, o.created_at,
       GREATEST(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), o.hold_until), 0) AS seconds_left, t.label, m.business_name, m.slug, ${URL_BAYAR} AS url
     FROM orders o JOIN merchants m ON m.id = o.merchant_id LEFT JOIN merchant_tables t ON t.id = o.table_id
     WHERE o.code = ? AND o.guest_token_hash = ?`,
    [code, hash(guestToken)],
  );
  if (!order) throw orderNotFound();
  // 2. Susun respons; hold_until, seconds_left, dan payment_url hanya diisi selama pesanan masih menunggu.
  const holding = order.status === "holding";
  return {
    code: order.code,
    status: order.status,
    payment_status: order.payment_status,
    table: { label: order.label },
    merchant: { slug: order.slug, business_name: order.business_name },
    customer_name: order.customer_name,
    note: order.note,
    items: (await loadOrderItems([order.id])).get(order.id) ?? [],
    subtotal: order.subtotal,
    service_fee: order.service_fee,
    total: order.total,
    hold_until: holding ? order.hold_until : null,
    seconds_left: holding ? Number(order.seconds_left) : null,
    payment_url: holding && order.payment_status !== "paid" ? order.url : null,
    created_at: order.created_at,
  };
}

/**
 * Membuka halaman bayar Snap untuk pesanan tamu, atau memakai ulang halaman yang sudah pernah dibuat. Logikanya
 * dipakai bersama pembayaran online pembeli, di bukaSnap (pembayaran-va.service).
 * @param code       kode pesanan
 * @param guestToken token tamu dari header X-Guest-Token
 * @param returnUrl  alamat web tujuan setelah bayar; harus alamat web KateringKita sendiri (CORS_ORIGIN), supaya
 *                   halaman bayar tidak bisa dipakai mengalihkan tamu ke situs lain
 * @returns `payment_url` halaman Snap
 * @throws 400 alamat kembali tidak diizinkan (pesan di kolom `kembali`), 404 kode atau token tamu tidak cocok,
 *   409 pesanan tidak sedang menunggu pembayaran, 409 batas waktu pesanan sudah habis
 */
export async function payGuestOrder(code: string, guestToken: string, returnUrl: string) {
  if (!asalSah(returnUrl))
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { kembali: ["Alamat kembali tidak diizinkan."] });
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM_SNAP} FROM orders o WHERE o.code = ? AND o.guest_token_hash = ?`,
    [code, hash(guestToken)],
  );
  if (!order) throw orderNotFound();
  return { payment_url: await bukaSnap(order, code, returnUrl) };
}
