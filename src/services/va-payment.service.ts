import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import {
  VaBank,
  createMidtransQris,
  createSnapPayment,
  createMidtransVa,
  isValidNotification,
  getMidtransStatus,
} from "../utils/midtrans";
import { dalamTransaksi } from "./admin-audit.service";
import { getMyOrder } from "./order.service";
import { transitionOrder } from "./order-status.service";

// Pembayaran Midtrans: VA (F10), halaman Snap untuk pesanan meja (F21) dan pre-order (F26), notifikasi untuk semuanya.
const conflict = (message: string) => new AppError(409, "CONFLICT", message);

// `kembali` harus web kita sendiri (CORS_ORIGIN): mencegah halaman bayar mengalihkan pembeli ke situs lain
export const isAllowedOrigin = (url: string) => {
  try {
    return (env.CORS_ORIGIN.length ? env.CORS_ORIGIN : ["http://localhost:3000"]).includes(new URL(url).origin);
  } catch {
    return false;
  }
};
const returnUrlNotAllowed = () =>
  new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { kembali: ["Alamat kembali tidak diizinkan."] });

export const PAYMENT_URL_SQL =
  "(SELECT redirect_url FROM payments p WHERE p.order_id = o.id AND p.method = 'online' ORDER BY p.id DESC LIMIT 1)";
// kolom yang dibutuhkan openSnapPayment; o = orders
export const SNAP_COLUMNS = `o.id, o.total, o.status, o.payment_method, o.payment_status,
  TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), o.hold_until) AS menit, ${PAYMENT_URL_SQL} AS url`;

// Snap dipanggil di luar transaksi; idempoten: halaman bayar yang sudah dibuat dikembalikan.
export async function openSnapPayment(order: RowDataPacket, code: string, returnUrl?: string): Promise<string> {
  if (order.status !== "holding" || order.payment_status === "paid")
    throw conflict("Pesanan ini tidak menunggu pembayaran.");
  if (order.url) return order.url as string;
  // menit dibulatkan ke bawah: halaman bayar tutup sebelum hold habis
  const minutesLeft = Number(order.menit);
  if (minutesLeft < 1) throw conflict("Batas waktu pesanan sudah habis.");
  const { redirect_url } = await createSnapPayment(code, order.total, minutesLeft, returnUrl);
  await db.query(
    `INSERT INTO payments (order_id, method, provider, amount, status, expires_at, redirect_url)
     VALUES (?, 'online', 'midtrans', ?, 'pending', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?)`,
    [order.id, order.total, minutesLeft, redirect_url],
  );
  await db.query("UPDATE orders SET payment_status = 'pending' WHERE id = ? AND payment_status = 'unpaid'", [order.id]);
  return redirect_url;
}

// F26: halaman bayar online (QRIS, e-wallet, VA) untuk pre-order pembeli; `kembali` opsional (web), mobile cukup membuka payment_url
export async function payOnline(userId: number, code: string, returnUrl?: string) {
  if (returnUrl !== undefined && !isAllowedOrigin(returnUrl)) throw returnUrlNotAllowed();
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT ${SNAP_COLUMNS} FROM orders o WHERE o.code = ? AND o.customer_id = ?`,
    [code, userId],
  );
  if (!order) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  if (order.payment_method !== "online") throw conflict("Pesanan ini tidak memakai bayar online.");
  await openSnapPayment(order, code, returnUrl);
  return getMyOrder(userId, code);
}

// QRIS langsung di aplikasi untuk pesanan "online": satu QRIS per pesanan (idempoten), Midtrans dipanggil di luar transaksi.
export async function createQris(userId: number, code: string) {
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.total, o.status, o.payment_method, o.payment_status, TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), o.hold_until) AS menit,
       EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.method = 'qris') AS ada
     FROM orders o WHERE o.code = ? AND o.customer_id = ?`,
    [code, userId],
  );
  if (!order) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  if (order.payment_method !== "online") throw conflict("Pesanan ini tidak memakai bayar online.");
  if (order.status !== "holding" || order.payment_status === "paid")
    throw conflict("Pesanan ini tidak menunggu pembayaran.");
  if (!Number(order.ada)) {
    // menit dibulatkan ke bawah: QR kedaluwarsa sebelum hold habis
    const minutesLeft = Number(order.menit);
    if (minutesLeft < 1) throw conflict("Batas waktu pesanan sudah habis.");
    const qris = await createMidtransQris(code, order.total, minutesLeft);
    try {
      await db.query(
        `INSERT INTO payments (order_id, method, provider, provider_ref, qr_string, redirect_url, amount, status, expires_at)
         VALUES (?, 'qris', 'midtrans', ?, ?, ?, ?, 'pending', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))`,
        [order.id, qris.transaction_id, qris.qr_string, qris.qr_url, order.total, minutesLeft],
      );
    } catch (error) {
      // permintaan kembar yang sama-sama lolos charge → transaksi Midtrans yang sama → provider_ref duplikat
      if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
    }
    await db.query("UPDATE orders SET payment_status = 'pending' WHERE id = ? AND payment_status = 'unpaid'", [
      order.id,
    ]);
  }
  return getMyOrder(userId, code);
}

// F10: VA untuk pesanan VA milik pembeli yang masih holding. Midtrans dipanggil di luar transaksi agar kunci tidak ditahan
// selama HTTP; idempoten: VA yang sudah ada dikembalikan.
// shortcut: satu VA per pesanan (bank pertama dipakai); ganti bank butuh order_id Midtrans baru, tambahkan bila diminta
export async function createVa(userId: number, code: string, bank: VaBank) {
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.total, o.status, o.payment_method, o.payment_status, TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), o.hold_until) AS menit,
       EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.method = 'va') AS ada
     FROM orders o WHERE o.code = ? AND o.customer_id = ?`,
    [code, userId],
  );
  if (!order) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  if (order.payment_method !== "va" || order.status !== "holding" || order.payment_status === "paid") {
    throw conflict("Pesanan ini tidak menunggu pembayaran Virtual Account.");
  }
  if (!Number(order.ada)) {
    // menit dibulatkan ke bawah: VA tutup sebelum hold habis, jadi transfer tidak masuk ke pesanan yang sudah lewat waktu
    const minutesLeft = Number(order.menit);
    if (minutesLeft < 1) throw conflict("Batas waktu pesanan sudah habis.");
    const virtualAccount = await createMidtransVa(code, order.total, bank, minutesLeft);
    try {
      await db.query(
        `INSERT INTO payments (order_id, method, provider, provider_ref, bank, va_number, amount, status, expires_at)
         VALUES (?, 'va', 'midtrans', ?, ?, ?, ?, 'pending', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))`,
        [
          order.id,
          virtualAccount.transaction_id,
          virtualAccount.bank,
          virtualAccount.va_number,
          order.total,
          minutesLeft,
        ],
      );
    } catch (error) {
      // permintaan kembar: charge kedua dijawab 406 → transaksi Midtrans yang sama → provider_ref duplikat
      if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
    }
    await db.query("UPDATE orders SET payment_status = 'pending' WHERE id = ? AND payment_status = 'unpaid'", [
      order.id,
    ]);
  }
  return getMyOrder(userId, code);
}

const PAYMENT_STATUS_FROM_MIDTRANS: Record<string, "paid" | "expired" | "failed"> = {
  settlement: "paid",
  expire: "expired",
  cancel: "failed",
  deny: "failed",
  failure: "failed",
};

// F10: notifikasi HTTP Midtrans (rute publik). Sah = signature cocok dan nominal sama dengan pembayaran tersimpan.
// settlement → transisi pay oleh sistem (holding → confirmed, stok terjual, notifikasi pembeli) lalu payments lunas.
// Notifikasi berulang aman: baris yang sudah lunas atau sudah di-refund tidak disentuh (AUD-24), transisi kedua ditolak 409.
export async function handleMidtransNotification(notification: Record<string, unknown>): Promise<void> {
  if (!isValidNotification(notification)) throw new AppError(403, "FORBIDDEN", "Tanda tangan notifikasi tidak sah.");
  if (!PAYMENT_STATUS_FROM_MIDTRANS[String(notification.transaction_status)]) return; // pending: belum ada yang berubah
  const code = String(notification.order_id);
  // AUD-23: signature hanya mencakup order_id + status_code + gross_amount; transaction_status bisa diganti pada body
  // bertanda tangan yang bocor → status, nominal, dan transaction_id diambil dari Get Status Midtrans, bukan dari body.
  // Midtrans tidak terjangkau → 502 → Midtrans mengirim ulang notifikasi nanti.
  const midtransStatus = await getMidtransStatus(code);
  const newStatus = PAYMENT_STATUS_FROM_MIDTRANS[String(midtransStatus.transaction_status)];
  if (!newStatus || String(midtransStatus.order_id) !== code) return;
  await dalamTransaksi(async (conn) => {
    // VA (pembeli, F10), Snap 'online' (pesanan meja F21, pre-order F26) atau QRIS di aplikasi.
    // Pesanan online bisa punya baris Snap dan QRIS: utamakan baris yang transaction_id-nya cocok.
    const transactionId = typeof midtransStatus.transaction_id === "string" ? midtransStatus.transaction_id : null;
    const [[payment]] = await conn.query<RowDataPacket[]>(
      `SELECT p.id, p.status, p.amount FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE o.code = ? AND p.method IN ('va', 'online', 'qris') AND p.provider = 'midtrans'
       ORDER BY (p.provider_ref <=> ?) DESC, p.id LIMIT 1`,
      [code, transactionId],
    );
    if (!payment || payment.status === "paid" || payment.status === "refunded") return;
    if (Number(midtransStatus.gross_amount) !== payment.amount) {
      console.error(
        `Notifikasi Midtrans ${code}: nominal ${String(midtransStatus.gross_amount)} ≠ ${payment.amount}, diabaikan`,
      );
      return;
    }
    if (newStatus === "paid") {
      // urutan kunci sama dengan transisi lain (users → orders → menus), payments terakhir
      // lunas setelah hold habis/batal → 409 ditelan, payments tetap lunas → muncul di daftar refund admin (F26)
      await transitionOrder(conn, code, "pay", { kind: "system" }).catch((error: unknown) => {
        if (!(error instanceof AppError) || error.status !== 409) throw error;
        console.error(`VA ${code} lunas tetapi pesanan tidak bisa dikonfirmasi: ${error.message}`);
      });
    }
    // Snap baru tahu transaction_id dari notifikasi
    await conn.query(
      `UPDATE payments SET status = ?, paid_at = IF(? = 'paid', UTC_TIMESTAMP(), paid_at), raw_payload = ?, provider_ref = COALESCE(provider_ref, ?)
       WHERE id = ? AND status NOT IN ('paid', 'refunded')`,
      [newStatus, newStatus, JSON.stringify(midtransStatus), transactionId, payment.id],
    );
  });
}
