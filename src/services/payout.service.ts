import bcrypt from "bcryptjs";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { PAYOUT_BANKS, getBankName, PayoutInput, RefundInput, BankAccountInput } from "../dto/payout.dto";
import { catat, dalamTransaksi } from "./admin-audit.service";

// F26 pencairan dana. Pembayaran non-tunai (VA, online) masuk akun Midtrans platform. Bagian penjual per pesanan selesai
// = subtotal − potongan voucher toko (merchant_discount, migrasi 014), sama dengan merchant_net rekap F20: biaya layanan dan
// voucher platform milik platform, biaya Midtrans ditanggung platform. Pesanan tunai dibayar langsung ke penjual, jadi tidak ikut.
const ELIGIBLE_ORDERS_SQL =
  "o.status = 'completed' AND o.payment_method IN ('va', 'online') AND o.payment_status = 'paid' AND o.payout_id IS NULL";
const MERCHANT_SHARE_SQL = "o.subtotal - o.merchant_discount";
const ORDERS_FROM_SQL = "orders o";
const LIMIT = 20;

const conflict = (message: string) => new AppError(409, "CONFLICT", message);
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
export async function getMyPayouts(userId: number) {
  const [[merchant]] = await db.query<RowDataPacket[]>(
    "SELECT id, payout_bank, payout_account_number, payout_account_name, payout_updated_at FROM merchants WHERE user_id = ?",
    [userId],
  );
  if (!merchant) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
  const [[balance]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(${MERCHANT_SHARE_SQL}), 0) AS amount, MIN(o.completed_at) AS since FROM ${ORDERS_FROM_SQL} WHERE o.merchant_id = ? AND ${ELIGIBLE_ORDERS_SQL}`,
    [merchant.id],
  );
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

export async function updateBankAccount(userId: number, input: BankAccountInput) {
  const [[user]] = await db.query<RowDataPacket[]>("SELECT password_hash FROM users WHERE id = ?", [userId]);
  // sandi diminta ulang: sesi yang dicuri saja tidak cukup untuk membelokkan pencairan ke rekening lain
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
// Saldo per toko sampai as_of (jam DB, sama dengan completed_at); as_of dikirim balik sebagai `until` saat mencatat pencairan.
export async function listBalances() {
  const [[dbClock]] = await db.query<RowDataPacket[]>("SELECT UTC_TIMESTAMP() AS now");
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
      // AUD-25: batas voucher platform per akun bisa dipanen penjual lewat akun palsu; porsi besar = periksa dulu sebelum transfer
      amount: Number(row.amount),
      orders: Number(row.orders),
      platform_discount: Number(row.platform_discount),
      since: row.since,
    })),
  };
}

// Admin mentransfer dulu lewat banknya, lalu mencatat di sini. READ COMMITTED: kunci baris pesanan tanpa gap lock.
export async function recordPayout(adminId: number, input: PayoutInput) {
  return dalamTransaksi(async (conn) => {
    const [[merchant]] = await conn.query<RowDataPacket[]>(
      // FOR UPDATE (AUD-34): rekening tidak bisa diganti penjual di tengah pencatatan
      "SELECT id, payout_bank, payout_account_number, payout_account_name, payout_updated_at FROM merchants WHERE id = ? FOR UPDATE",
      [input.merchant_id],
    );
    if (!merchant) throw new AppError(404, "NOT_FOUND", "Penjual tidak ditemukan.");
    if (!merchant.payout_bank) throw conflict("Penjual belum mengisi rekening pencairan.");
    // AUD-34: pencatatan terikat ke rekening yang dilihat admin saat mentransfer, bukan rekening yang berlaku sekarang
    const accountVersion = input.account_updated_at ? new Date(input.account_updated_at).getTime() : NaN;
    if (!(merchant.payout_updated_at instanceof Date) || accountVersion !== merchant.payout_updated_at.getTime()) {
      throw conflict("Rekening penjual berubah. Muat ulang lalu periksa lagi.");
    }
    // hanya baris orders yang dikunci (tanpa join): pencatatan kembar menunggu di sini, lalu melihat payout_id terisi → 409
    const [orderRows] = await conn.query<RowDataPacket[]>(
      `SELECT o.id FROM orders o WHERE o.merchant_id = ? AND ${ELIGIBLE_ORDERS_SQL} AND o.completed_at <= ? FOR UPDATE`,
      [merchant.id, new Date(input.until)],
    );
    const ids = orderRows.map((order) => order.id as number);
    if (!ids.length) throw conflict("Tidak ada saldo untuk dicairkan.");
    const [[total]] = await conn.query<RowDataPacket[]>(
      `SELECT SUM(${MERCHANT_SHARE_SQL}) AS amount FROM ${ORDERS_FROM_SQL} WHERE o.id IN (?)`,
      [ids],
    );
    if (Number(total.amount) !== input.amount) throw conflict("Saldo penjual berubah. Muat ulang lalu periksa lagi.");
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
    // updated_at tidak digeser: pesanan tidak berubah bagi pembeli/penjual (sinkron updated_since)
    await conn.query("UPDATE orders SET payout_id = ?, updated_at = updated_at WHERE id IN (?)", [
      insertResult.insertId,
      ids,
    ]);
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

export async function listPayoutHistory(page: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    `${PAYOUT_HISTORY_SQL} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    [LIMIT, (page - 1) * LIMIT],
  );
  const [[countRow]] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM payouts");
  return { data: rows.map(mapPayout), meta: { page, limit: LIMIT, total: Number(countRow.n) } };
}

// Dana Midtrans yang harus dikembalikan ke pembeli: lunas tetapi pesanan batal/kedaluwarsa (ditolak penjual, atau dibayar
// setelah batas waktu habis). Pengembalian dilakukan admin di luar aplikasi (dashboard Midtrans / transfer), lalu ditandai di sini.
// refunded_at IS NULL (AUD-24): pembayaran yang pernah ditandai refund tidak masuk antrian lagi walau statusnya berubah
const REFUND_DUE_SQL =
  "p.provider = 'midtrans' AND p.status = 'paid' AND p.refunded_at IS NULL AND o.status IN ('cancelled', 'expired')";

export async function listRefunds() {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT o.code, o.status, o.customer_name, o.customer_phone, o.cancel_reason, o.cancelled_by, o.cancelled_at, o.table_id,
       m.business_name, p.method, p.amount, p.paid_at
     FROM payments p JOIN orders o ON o.id = p.order_id JOIN merchants m ON m.id = o.merchant_id
     WHERE ${REFUND_DUE_SQL} ORDER BY p.paid_at, p.id LIMIT 100`,
  );
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

export async function markRefunded(adminId: number, code: string, input: RefundInput) {
  return dalamTransaksi(async (conn) => {
    const [[payment]] = await conn.query<RowDataPacket[]>(
      `SELECT p.id, p.order_id, p.amount FROM payments p JOIN orders o ON o.id = p.order_id WHERE ${REFUND_DUE_SQL} AND o.code = ? FOR UPDATE`,
      [code],
    );
    if (!payment) throw new AppError(404, "NOT_FOUND", "Tidak ada dana yang perlu dikembalikan untuk pesanan ini.");
    await conn.query(
      "UPDATE payments SET status = 'refunded', refunded_at = UTC_TIMESTAMP(), refund_ref = ? WHERE id = ?",
      [input.reference, payment.id],
    );
    await conn.query("UPDATE orders SET payment_status = 'refunded' WHERE id = ?", [payment.order_id]);
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
