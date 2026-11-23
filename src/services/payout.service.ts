// Isi file: pencairan dana ke penjual dan pengembalian dana (refund) ke pembeli. Sisi penjual: lihat saldo, riwayat
// pencairan, dan ubah rekening. Sisi admin: daftar saldo semua toko, catat pencairan, riwayat, dan antrean refund.
// Alurnya routes/merchant.ts atau routes/admin.ts → handlers/payout.handler.ts → file ini → database.
import bcrypt from "bcryptjs";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { PAYOUT_BANKS, getBankName, PayoutInput, RefundInput, BankAccountInput } from "../dto/payout.dto";
import { catat, dalamTransaksi } from "./admin-audit.service";

// Cara uang mengalir: pembayaran non-tunai (VA dan online) masuk ke akun Midtrans milik platform, lalu admin
// mentransfer bagian penjual secara manual (pencairan). Bagian penjual per pesanan selesai = subtotal (harga menu)
// − potongan voucher toko (`merchant_discount`); sama dengan `merchant_net` di rekap keuangan admin. Biaya layanan dan
// potongan voucher platform menjadi urusan platform, dan biaya Midtrans ditanggung platform. Pesanan tunai (COD)
// dibayar langsung ke penjual, jadi tidak pernah masuk saldo.
// Pesanan yang masuk saldo: selesai, dibayar non-tunai, lunas, dan belum pernah dicairkan (`payout_id` kosong).
const ELIGIBLE_ORDERS_SQL =
  "o.status = 'completed' AND o.payment_method IN ('va', 'online') AND o.payment_status = 'paid' AND o.payout_id IS NULL";
const MERCHANT_SHARE_SQL = "o.subtotal - o.merchant_discount";
const ORDERS_FROM_SQL = "orders o";
// Jumlah baris per halaman riwayat pencairan.
const LIMIT = 20;

const conflict = (message: string) => new AppError(409, "CONFLICT", message);
// Rekening pencairan toko dalam bentuk JSON, atau null bila penjual belum mengisinya. `updated_at` dipakai sebagai
// "versi rekening" saat admin mencatat pencairan.
const toBankAccount = (merchant: RowDataPacket) =>
  merchant.payout_bank
    ? {
        bank: merchant.payout_bank,
        bank_name: getBankName(merchant.payout_bank),
        account_number: merchant.payout_account_number,
        account_name: merchant.payout_account_name,
        updated_at: merchant.payout_updated_at,
      }
    : null;
// Satu baris riwayat pencairan dalam bentuk JSON. Rekening di sini adalah salinan saat pencairan dicatat.
const mapPayout = (payout: RowDataPacket) => ({
  id: payout.id,
  merchant_id: payout.merchant_id,
  business_name: payout.business_name,
  amount: payout.amount,
  orders_count: payout.orders_count,
  bank: payout.bank,
  bank_name: getBankName(payout.bank),
  account_number: payout.account_number,
  account_name: payout.account_name,
  reference: payout.reference,
  note: payout.note,
  admin_name: payout.admin_name ?? null,
  created_at: payout.created_at,
});
const PAYOUT_HISTORY_SQL = `SELECT p.id, p.merchant_id, m.business_name, p.amount, p.orders_count, p.bank, p.account_number, p.account_name,
    p.reference, p.note, u.full_name AS admin_name, p.created_at
  FROM payouts p JOIN merchants m ON m.id = p.merchant_id LEFT JOIN users u ON u.id = p.admin_user_id`;

// ---------- penjual ----------
/**
 * Halaman pencairan penjual: daftar bank yang bisa dipilih, rekening tersimpan, saldo yang belum dicairkan, dan 20
 * pencairan terakhir.
 * @param userId id pengguna penjual dari token login
 * @returns `{ banks, account, balance: { amount, orders, since }, payouts }`; `since` = waktu selesai pesanan tertua
 *          yang belum dicairkan, atau null
 * @throws 404 bila pengguna ini tidak punya toko
 */
export async function getMyPayouts(userId: number) {
  // 1. Ambil toko dan rekening pencairannya.
  const [[merchant]] = await db.query<RowDataPacket[]>(
    "SELECT id, payout_bank, payout_account_number, payout_account_name, payout_updated_at FROM merchants WHERE user_id = ?",
    [userId],
  );
  if (!merchant) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
  // 2. Saldo = jumlah bagian penjual dari semua pesanan yang masuk saldo.
  const [[balance]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(${MERCHANT_SHARE_SQL}), 0) AS amount, MIN(o.completed_at) AS since FROM ${ORDERS_FROM_SQL} WHERE o.merchant_id = ? AND ${ELIGIBLE_ORDERS_SQL}`,
    [merchant.id],
  );
  // 3. Riwayat pencairan terbaru.
  const [payoutHistory] = await db.query<RowDataPacket[]>(
    `${PAYOUT_HISTORY_SQL} WHERE p.merchant_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
    [merchant.id, LIMIT],
  );
  return {
    banks: Object.entries(PAYOUT_BANKS).map(([code, name]) => ({ code, name })),
    account: toBankAccount(merchant),
    balance: { amount: Number(balance.amount), orders: Number(balance.orders), since: balance.since ?? null },
    payouts: payoutHistory.map(mapPayout),
  };
}

/**
 * Menyimpan atau mengganti rekening pencairan toko. Kata sandi akun diminta ulang, supaya sesi login yang dicuri saja
 * tidak cukup untuk membelokkan pencairan ke rekening lain. Waktu ubah rekening ikut diperbarui.
 * @param userId id pengguna penjual dari token login
 * @param input  rekening yang sudah lolos bankAccountSchema: `bank`, `account_number`, `account_name`, `password`
 * @returns data halaman pencairan terbaru (sama dengan {@link getMyPayouts})
 * @throws 400 kata sandi salah, 404 pengguna tidak punya toko
 */
export async function updateBankAccount(userId: number, input: BankAccountInput) {
  const [[user]] = await db.query<RowDataPacket[]>("SELECT password_hash FROM users WHERE id = ?", [userId]);
  if (!user || !(await bcrypt.compare(input.password, user.password_hash))) {
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { password: ["Kata sandi salah."] });
  }
  await db.query(
    "UPDATE merchants SET payout_bank = ?, payout_account_number = ?, payout_account_name = ?, payout_updated_at = UTC_TIMESTAMP() WHERE user_id = ?",
    [input.bank, input.account_number, input.account_name, userId],
  );
  return getMyPayouts(userId);
}

// ---------- admin ----------
/**
 * Saldo semua toko yang punya pesanan siap dicairkan, dihitung sampai `as_of` (jam database sekarang, satu jam dengan
 * completed_at). Admin mengirim balik `as_of` sebagai `until` saat mencatat pencairan, supaya pesanan yang selesai
 * sesudah admin melihat daftar ini tidak ikut terhitung.
 * @returns `{ as_of, rows }`; tiap baris berisi toko, rekening, `amount` (saldo), `orders`, `platform_discount`, dan
 *          `since` (pesanan tertua), urut dari saldo yang paling lama menunggu
 */
export async function listBalances() {
  // 1. Tetapkan batas waktu dari jam database.
  const [[dbClock]] = await db.query<RowDataPacket[]>("SELECT UTC_TIMESTAMP() AS now");
  // 2. Jumlahkan saldo per toko sampai batas itu.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id AS merchant_id, m.business_name, m.payout_bank, m.payout_account_number, m.payout_account_name, m.payout_updated_at,
       COUNT(*) AS orders, SUM(${MERCHANT_SHARE_SQL}) AS amount, SUM(o.platform_discount) AS platform_discount, MIN(o.completed_at) AS since
     FROM ${ORDERS_FROM_SQL} JOIN merchants m ON m.id = o.merchant_id
     WHERE ${ELIGIBLE_ORDERS_SQL} AND o.completed_at <= ?
     GROUP BY m.id, m.business_name, m.payout_bank, m.payout_account_number, m.payout_account_name, m.payout_updated_at
     ORDER BY since, m.id`,
    [dbClock.now],
  );
  return {
    as_of: dbClock.now,
    rows: rows.map((row) => ({
      merchant_id: row.merchant_id,
      business_name: row.business_name,
      account: toBankAccount(row),
      // `platform_discount` ditampilkan supaya admin bisa memeriksa dulu sebelum transfer: batas voucher platform per
      // akun bisa dipanen penjual lewat akun pembeli palsu, jadi potongan platform yang besar perlu dicek.
      amount: Number(row.amount),
      orders: Number(row.orders),
      platform_discount: Number(row.platform_discount),
      since: row.since,
    })),
  };
}

/**
 * Mencatat pencairan yang sudah ditransfer admin lewat banknya. Semua pesanan toko yang masuk saldo sampai `until`
 * ditandai sudah dicairkan, dan pencairan menyimpan salinan rekening tujuan. Transaksi memakai tingkat isolasi READ
 * COMMITTED: setiap pembacaan melihat data terbaru yang sudah disimpan, dan baris pesanan dikunci tanpa ikut mengunci
 * celah di antaranya (gap lock).
 * @param adminId id admin yang mencatat
 * @param input   isi yang sudah lolos payoutSchema: `merchant_id`, `amount`, `until`, `reference`, `note`, dan
 *                `account_updated_at` (versi rekening yang dilihat admin saat mentransfer)
 * @returns baris riwayat pencairan yang baru
 * @throws 404 toko tidak ada; 409 toko belum mengisi rekening, rekening berubah sejak dilihat admin, tidak ada saldo
 *         (termasuk bila pencatatan yang sama sudah lebih dulu tersimpan), atau jumlah saldo berbeda dari `amount`
 */
export async function recordPayout(adminId: number, input: PayoutInput) {
  return dalamTransaksi(async (conn) => {
    // 1. Kunci baris toko (FOR UPDATE), supaya penjual tidak bisa mengganti rekening di tengah pencatatan.
    const [[merchant]] = await conn.query<RowDataPacket[]>(
      "SELECT id, payout_bank, payout_account_number, payout_account_name, payout_updated_at FROM merchants WHERE id = ? FOR UPDATE",
      [input.merchant_id],
    );
    if (!merchant) throw new AppError(404, "NOT_FOUND", "Penjual tidak ditemukan.");
    if (!merchant.payout_bank) throw conflict("Penjual belum mengisi rekening pencairan.");
    // 2. Pencatatan terikat ke rekening yang dilihat admin saat mentransfer, bukan rekening yang berlaku sekarang:
    //    versi (waktu ubah rekening) harus sama persis.
    const accountVersion = input.account_updated_at ? new Date(input.account_updated_at).getTime() : NaN;
    if (!(merchant.payout_updated_at instanceof Date) || accountVersion !== merchant.payout_updated_at.getTime()) {
      throw conflict("Rekening penjual berubah. Muat ulang lalu periksa lagi.");
    }
    // 3. Kunci pesanan yang masuk saldo sampai `until`. Hanya baris orders yang dikunci (tanpa join): pencatatan
    //    kembar menunggu di sini, lalu melihat payout_id sudah terisi sehingga tidak ada saldo → 409.
    const [orderRows] = await conn.query<RowDataPacket[]>(
      `SELECT o.id FROM orders o WHERE o.merchant_id = ? AND ${ELIGIBLE_ORDERS_SQL} AND o.completed_at <= ? FOR UPDATE`,
      [merchant.id, new Date(input.until)],
    );
    const ids = orderRows.map((order) => order.id as number);
    if (!ids.length) throw conflict("Tidak ada saldo untuk dicairkan.");
    // 4. Jumlah bagian penjual dari pesanan itu harus sama persis dengan nominal yang ditransfer admin.
    const [[total]] = await conn.query<RowDataPacket[]>(
      `SELECT SUM(${MERCHANT_SHARE_SQL}) AS amount FROM ${ORDERS_FROM_SQL} WHERE o.id IN (?)`,
      [ids],
    );
    if (Number(total.amount) !== input.amount) throw conflict("Saldo penjual berubah. Muat ulang lalu periksa lagi.");
    // 5. Simpan pencairan beserta salinan rekening tujuan.
    const [insertResult] = await conn.query<ResultSetHeader>(
      `INSERT INTO payouts (merchant_id, amount, orders_count, bank, account_number, account_name, reference, note, admin_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        merchant.id,
        input.amount,
        ids.length,
        merchant.payout_bank,
        merchant.payout_account_number,
        merchant.payout_account_name,
        input.reference,
        input.note,
        adminId,
      ],
    );
    // 6. Tandai pesanan sudah dicairkan. updated_at tidak digeser karena bagi pembeli dan penjual pesanannya tidak
    //    berubah (aplikasi menyinkronkan pesanan lewat updated_since).
    await conn.query("UPDATE orders SET payout_id = ?, updated_at = updated_at WHERE id IN (?)", [
      insertResult.insertId,
      ids,
    ]);
    // 7. Catat di log audit admin, lalu kembalikan baris riwayatnya.
    await catat(conn, {
      adminId,
      action: "payout.create",
      targetType: "merchant",
      targetId: merchant.id,
      after: { payout_id: insertResult.insertId, amount: input.amount, orders: ids.length, reference: input.reference },
    });
    const [[payout]] = await conn.query<RowDataPacket[]>(`${PAYOUT_HISTORY_SQL} WHERE p.id = ?`, [
      insertResult.insertId,
    ]);
    return mapPayout(payout);
  }, "READ COMMITTED");
}

/**
 * Riwayat pencairan semua toko untuk admin, 20 per halaman, yang terbaru di atas.
 * @param page nomor halaman mulai 1
 * @returns `{ data, meta: { page, limit, total } }`
 */
export async function listPayoutHistory(page: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    `${PAYOUT_HISTORY_SQL} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    [LIMIT, (page - 1) * LIMIT],
  );
  const [[countRow]] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM payouts");
  return { data: rows.map(mapPayout), meta: { page, limit: LIMIT, total: Number(countRow.n) } };
}

// Refund = dana Midtrans yang harus dikembalikan ke pembeli: pembayarannya lunas tetapi pesanannya batal atau
// kedaluwarsa (ditolak penjual, atau dibayar setelah batas waktu bayar habis). Pengembalian dilakukan admin di luar
// aplikasi (dashboard Midtrans atau transfer), lalu ditandai di sini. Syarat `refunded_at IS NULL` membuat pembayaran
// yang pernah ditandai refund tidak masuk antrean lagi walau statusnya berubah lagi.
const REFUND_DUE_SQL =
  "p.provider = 'midtrans' AND p.status = 'paid' AND p.refunded_at IS NULL AND o.status IN ('cancelled', 'expired')";

/**
 * Antrean refund untuk admin: paling banyak 100 pembayaran yang perlu dikembalikan, yang paling lama dibayar di atas.
 * @returns daftar `{ code, status, customer_name, customer_phone, business_name, dine_in, method, amount, paid_at,
 *          cancelled_at, cancelled_by, cancel_reason }`
 */
export async function listRefunds() {
  // 1. Ambil pembayaran yang memenuhi syarat refund beserta data pesanan dan tokonya.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT o.code, o.status, o.customer_name, o.customer_phone, o.cancel_reason, o.cancelled_by, o.cancelled_at, o.table_id,
       m.business_name, p.method, p.amount, p.paid_at
     FROM payments p JOIN orders o ON o.id = p.order_id JOIN merchants m ON m.id = o.merchant_id
     WHERE ${REFUND_DUE_SQL} ORDER BY p.paid_at, p.id LIMIT 100`,
  );
  // 2. `dine_in` = pesanan dari meja QR (punya table_id).
  return rows.map((row) => ({
    code: row.code,
    status: row.status,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    business_name: row.business_name,
    dine_in: row.table_id !== null,
    method: row.method,
    amount: row.amount,
    paid_at: row.paid_at,
    cancelled_at: row.cancelled_at,
    cancelled_by: row.cancelled_by,
    cancel_reason: row.cancel_reason,
  }));
}

/**
 * Menandai bahwa dana pesanan sudah dikembalikan admin ke pembeli: baris pembayaran menjadi `refunded` (dengan waktu
 * dan nomor referensi transfer), status bayar pesanan menjadi `refunded`, dan tindakan dicatat di log audit.
 * @param adminId id admin yang menandai
 * @param code    kode pesanan
 * @param input   isi yang sudah lolos refundSchema: `reference` (nomor referensi transfer)
 * @returns `{ code, amount, reference }`
 * @throws 404 pesanan ini tidak ada di antrean refund
 */
export async function markRefunded(adminId: number, code: string, input: RefundInput) {
  return dalamTransaksi(async (conn) => {
    // 1. Kunci pembayaran pesanan ini, hanya bila memang ada di antrean refund.
    const [[payment]] = await conn.query<RowDataPacket[]>(
      `SELECT p.id, p.order_id, p.amount FROM payments p JOIN orders o ON o.id = p.order_id WHERE ${REFUND_DUE_SQL} AND o.code = ? FOR UPDATE`,
      [code],
    );
    if (!payment) throw new AppError(404, "NOT_FOUND", "Tidak ada dana yang perlu dikembalikan untuk pesanan ini.");
    // 2. Ubah status pembayaran dan pesanan menjadi refunded.
    await conn.query(
      "UPDATE payments SET status = 'refunded', refunded_at = UTC_TIMESTAMP(), refund_ref = ? WHERE id = ?",
      [input.reference, payment.id],
    );
    await conn.query("UPDATE orders SET payment_status = 'refunded' WHERE id = ?", [payment.order_id]);
    // 3. Catat di log audit admin.
    await catat(conn, {
      adminId,
      action: "refund.mark",
      targetType: "order",
      targetId: code,
      after: { amount: payment.amount, reference: input.reference },
    });
    return { code, amount: payment.amount as number, reference: input.reference };
  });
}
