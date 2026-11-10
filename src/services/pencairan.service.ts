import bcrypt from "bcryptjs";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { BANK_PENCAIRAN, namaBank, PencairanInput, RefundInput, RekeningInput } from "../dto/pencairan.dto";
import { catat, dalamTransaksi } from "./admin-audit.service";

// F26 pencairan dana. Pembayaran non-tunai (VA, online) masuk akun Midtrans platform. Bagian penjual per pesanan selesai
// = subtotal − diskon promo toko, sama dengan merchant_net rekap F20: biaya layanan dan promo platform milik platform,
// biaya Midtrans ditanggung platform. Pesanan tunai dibayar langsung ke penjual, jadi tidak ikut.
const LAYAK = "o.status = 'completed' AND o.payment_method IN ('va', 'online') AND o.payment_status = 'paid' AND o.payout_id IS NULL";
const BAGIAN = "o.subtotal - CASE WHEN pr.merchant_id IS NOT NULL THEN o.discount ELSE 0 END";
const DARI = "orders o LEFT JOIN promos pr ON pr.id = o.promo_id";
const LIMIT = 20;

const konflik = (pesan: string) => new AppError(409, "CONFLICT", pesan);
const rekening = (m: RowDataPacket) => (m.payout_bank
  ? { bank: m.payout_bank, bank_name: namaBank(m.payout_bank), account_number: m.payout_account_number, account_name: m.payout_account_name, updated_at: m.payout_updated_at }
  : null);
const petaPencairan = (p: RowDataPacket) => ({
  id: p.id, merchant_id: p.merchant_id, business_name: p.business_name, amount: p.amount, orders_count: p.orders_count,
  bank: p.bank, bank_name: namaBank(p.bank), account_number: p.account_number, account_name: p.account_name,
  reference: p.reference, note: p.note, admin_name: p.admin_name ?? null, created_at: p.created_at,
});
const RIWAYAT = `SELECT p.id, p.merchant_id, m.business_name, p.amount, p.orders_count, p.bank, p.account_number, p.account_name,
    p.reference, p.note, u.full_name AS admin_name, p.created_at
  FROM payouts p JOIN merchants m ON m.id = p.merchant_id LEFT JOIN users u ON u.id = p.admin_user_id`;

// ---------- penjual ----------
export async function pencairanSaya(userId: number) {
  const [[m]] = await db.query<RowDataPacket[]>(
    "SELECT id, payout_bank, payout_account_number, payout_account_name, payout_updated_at FROM merchants WHERE user_id = ?", [userId],
  );
  if (!m) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
  const [[s]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(${BAGIAN}), 0) AS amount, MIN(o.completed_at) AS since FROM ${DARI} WHERE o.merchant_id = ? AND ${LAYAK}`,
    [m.id],
  );
  const [riwayat] = await db.query<RowDataPacket[]>(`${RIWAYAT} WHERE p.merchant_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT ?`, [m.id, LIMIT]);
  return {
    banks: Object.entries(BANK_PENCAIRAN).map(([code, name]) => ({ code, name })),
    account: rekening(m),
    balance: { amount: Number(s.amount), orders: Number(s.orders), since: s.since ?? null },
    payouts: riwayat.map(petaPencairan),
  };
}

export async function ubahRekening(userId: number, input: RekeningInput) {
  const [[u]] = await db.query<RowDataPacket[]>("SELECT password_hash FROM users WHERE id = ?", [userId]);
  // sandi diminta ulang: sesi yang dicuri saja tidak cukup untuk membelokkan pencairan ke rekening lain
  if (!u || !(await bcrypt.compare(input.password, u.password_hash))) {
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { password: ["Kata sandi salah."] });
  }
  await db.query(
    "UPDATE merchants SET payout_bank = ?, payout_account_number = ?, payout_account_name = ?, payout_updated_at = UTC_TIMESTAMP() WHERE user_id = ?",
    [input.bank, input.account_number, input.account_name, userId],
  );
  return pencairanSaya(userId);
}

// ---------- admin ----------
// Saldo per toko sampai as_of (jam DB, sama dengan completed_at); as_of dikirim balik sebagai `until` saat mencatat pencairan.
export async function daftarSaldo() {
  const [[w]] = await db.query<RowDataPacket[]>("SELECT UTC_TIMESTAMP() AS now");
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id AS merchant_id, m.business_name, m.payout_bank, m.payout_account_number, m.payout_account_name, m.payout_updated_at,
       COUNT(*) AS orders, SUM(${BAGIAN}) AS amount, MIN(o.completed_at) AS since
     FROM ${DARI} JOIN merchants m ON m.id = o.merchant_id
     WHERE ${LAYAK} AND o.completed_at <= ?
     GROUP BY m.id, m.business_name, m.payout_bank, m.payout_account_number, m.payout_account_name, m.payout_updated_at
     ORDER BY since, m.id`,
    [w.now],
  );
  return {
    as_of: w.now,
    rows: rows.map((r) => ({
      merchant_id: r.merchant_id, business_name: r.business_name, account: rekening(r),
      amount: Number(r.amount), orders: Number(r.orders), since: r.since,
    })),
  };
}

// Admin mentransfer dulu lewat banknya, lalu mencatat di sini. READ COMMITTED: kunci baris pesanan tanpa gap lock.
export async function catatPencairan(adminId: number, input: PencairanInput) {
  return dalamTransaksi(async (conn) => {
    const [[m]] = await conn.query<RowDataPacket[]>(
      "SELECT id, payout_bank, payout_account_number, payout_account_name FROM merchants WHERE id = ?", [input.merchant_id],
    );
    if (!m) throw new AppError(404, "NOT_FOUND", "Penjual tidak ditemukan.");
    if (!m.payout_bank) throw konflik("Penjual belum mengisi rekening pencairan.");
    // hanya baris orders yang dikunci (tanpa join): pencatatan kembar menunggu di sini, lalu melihat payout_id terisi → 409
    const [os] = await conn.query<RowDataPacket[]>(
      `SELECT o.id FROM orders o WHERE o.merchant_id = ? AND ${LAYAK} AND o.completed_at <= ? FOR UPDATE`, [m.id, new Date(input.until)],
    );
    const ids = os.map((o) => o.id as number);
    if (!ids.length) throw konflik("Tidak ada saldo untuk dicairkan.");
    const [[t]] = await conn.query<RowDataPacket[]>(`SELECT SUM(${BAGIAN}) AS amount FROM ${DARI} WHERE o.id IN (?)`, [ids]);
    if (Number(t.amount) !== input.amount) throw konflik("Saldo penjual berubah. Muat ulang lalu periksa lagi.");
    const [r] = await conn.query<ResultSetHeader>(
      `INSERT INTO payouts (merchant_id, amount, orders_count, bank, account_number, account_name, reference, note, admin_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [m.id, input.amount, ids.length, m.payout_bank, m.payout_account_number, m.payout_account_name, input.reference, input.note, adminId],
    );
    // updated_at tidak digeser: pesanan tidak berubah bagi pembeli/penjual (sinkron updated_since)
    await conn.query("UPDATE orders SET payout_id = ?, updated_at = updated_at WHERE id IN (?)", [r.insertId, ids]);
    await catat(conn, {
      adminId, action: "payout.create", targetType: "merchant", targetId: m.id,
      after: { payout_id: r.insertId, amount: input.amount, orders: ids.length, reference: input.reference },
    });
    const [[p]] = await conn.query<RowDataPacket[]>(`${RIWAYAT} WHERE p.id = ?`, [r.insertId]);
    return petaPencairan(p);
  }, "READ COMMITTED");
}

export async function riwayatPencairan(page: number) {
  const [rows] = await db.query<RowDataPacket[]>(`${RIWAYAT} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`, [LIMIT, (page - 1) * LIMIT]);
  const [[n]] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM payouts");
  return { data: rows.map(petaPencairan), meta: { page, limit: LIMIT, total: Number(n.n) } };
}

// Dana Midtrans yang harus dikembalikan ke pembeli: lunas tetapi pesanan batal/kedaluwarsa (ditolak penjual, atau dibayar
// setelah batas waktu habis). Pengembalian dilakukan admin di luar aplikasi (dashboard Midtrans / transfer), lalu ditandai di sini.
const REFUND = "p.provider = 'midtrans' AND p.status = 'paid' AND o.status IN ('cancelled', 'expired')";

export async function daftarRefund() {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT o.code, o.status, o.customer_name, o.customer_phone, o.cancel_reason, o.cancelled_by, o.cancelled_at, o.table_id,
       m.business_name, p.method, p.amount, p.paid_at
     FROM payments p JOIN orders o ON o.id = p.order_id JOIN merchants m ON m.id = o.merchant_id
     WHERE ${REFUND} ORDER BY p.paid_at, p.id LIMIT 100`,
  );
  return rows.map((r) => ({
    code: r.code, status: r.status, customer_name: r.customer_name, customer_phone: r.customer_phone, business_name: r.business_name,
    dine_in: r.table_id !== null, method: r.method, amount: r.amount, paid_at: r.paid_at,
    cancelled_at: r.cancelled_at, cancelled_by: r.cancelled_by, cancel_reason: r.cancel_reason,
  }));
}

export async function tandaiRefund(adminId: number, code: string, input: RefundInput) {
  return dalamTransaksi(async (conn) => {
    const [[x]] = await conn.query<RowDataPacket[]>(
      `SELECT p.id, p.order_id, p.amount FROM payments p JOIN orders o ON o.id = p.order_id WHERE ${REFUND} AND o.code = ? FOR UPDATE`, [code],
    );
    if (!x) throw new AppError(404, "NOT_FOUND", "Tidak ada dana yang perlu dikembalikan untuk pesanan ini.");
    await conn.query("UPDATE payments SET status = 'refunded', refunded_at = UTC_TIMESTAMP(), refund_ref = ? WHERE id = ?", [input.reference, x.id]);
    await conn.query("UPDATE orders SET payment_status = 'refunded' WHERE id = ?", [x.order_id]);
    await catat(conn, { adminId, action: "refund.mark", targetType: "order", targetId: code, after: { amount: x.amount, reference: input.reference } });
    return { code, amount: x.amount as number, reference: input.reference };
  });
}
