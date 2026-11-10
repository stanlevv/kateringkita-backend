import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { BankVa, buatSnap, buatVaMidtrans, notifikasiSah } from "../utils/midtrans";
import { dalamTransaksi } from "./admin-audit.service";
import { bacaPesanan } from "./pesanan.service";
import { transisi } from "./pesanan-status.service";

// Pembayaran Midtrans: VA (F10), halaman Snap untuk pesanan meja (F21) dan pre-order (F26), notifikasi untuk semuanya.
const konflik = (pesan: string) => new AppError(409, "CONFLICT", pesan);

// `kembali` harus web kita sendiri (CORS_ORIGIN): mencegah halaman bayar mengalihkan pembeli ke situs lain
export const asalSah = (url: string) => {
  try {
    return (env.CORS_ORIGIN.length ? env.CORS_ORIGIN : ["http://localhost:3000"]).includes(new URL(url).origin);
  } catch {
    return false;
  }
};
const tolakKembali = () => new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { kembali: ["Alamat kembali tidak diizinkan."] });

export const URL_BAYAR = "(SELECT redirect_url FROM payments p WHERE p.order_id = o.id AND p.method = 'online' ORDER BY p.id DESC LIMIT 1)";
// kolom yang dibutuhkan bukaSnap; o = orders
export const KOLOM_SNAP = `o.id, o.total, o.status, o.payment_method, o.payment_status,
  TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), o.hold_until) AS menit, ${URL_BAYAR} AS url`;

// Snap dipanggil di luar transaksi; idempoten: halaman bayar yang sudah dibuat dikembalikan.
export async function bukaSnap(o: RowDataPacket, code: string, kembali?: string): Promise<string> {
  if (o.status !== "holding" || o.payment_status === "paid") throw konflik("Pesanan ini tidak menunggu pembayaran.");
  if (o.url) return o.url as string;
  // menit dibulatkan ke bawah: halaman bayar tutup sebelum hold habis
  const menit = Number(o.menit);
  if (menit < 1) throw konflik("Batas waktu pesanan sudah habis.");
  const { redirect_url } = await buatSnap(code, o.total, menit, kembali);
  await db.query(
    `INSERT INTO payments (order_id, method, provider, amount, status, expires_at, redirect_url)
     VALUES (?, 'online', 'midtrans', ?, 'pending', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?)`,
    [o.id, o.total, menit, redirect_url],
  );
  await db.query("UPDATE orders SET payment_status = 'pending' WHERE id = ? AND payment_status = 'unpaid'", [o.id]);
  return redirect_url;
}

// F26: halaman bayar online (QRIS, e-wallet, VA) untuk pre-order pembeli; `kembali` opsional (web), mobile cukup membuka payment_url
export async function bayarOnline(userId: number, code: string, kembali?: string) {
  if (kembali !== undefined && !asalSah(kembali)) throw tolakKembali();
  const [[o]] = await db.query<RowDataPacket[]>(`SELECT ${KOLOM_SNAP} FROM orders o WHERE o.code = ? AND o.customer_id = ?`, [code, userId]);
  if (!o) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  if (o.payment_method !== "online") throw konflik("Pesanan ini tidak memakai bayar online.");
  await bukaSnap(o, code, kembali);
  return bacaPesanan(userId, code);
}

// F10: VA untuk pesanan VA milik pembeli yang masih holding. Midtrans dipanggil di luar transaksi agar kunci tidak ditahan
// selama HTTP; idempoten: VA yang sudah ada dikembalikan.
// shortcut: satu VA per pesanan (bank pertama dipakai); ganti bank butuh order_id Midtrans baru, tambahkan bila diminta
export async function buatVa(userId: number, code: string, bank: BankVa) {
  const [[o]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.total, o.status, o.payment_method, o.payment_status, TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), o.hold_until) AS menit,
       EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.method = 'va') AS ada
     FROM orders o WHERE o.code = ? AND o.customer_id = ?`,
    [code, userId],
  );
  if (!o) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  if (o.payment_method !== "va" || o.status !== "holding" || o.payment_status === "paid") {
    throw konflik("Pesanan ini tidak menunggu pembayaran Virtual Account.");
  }
  if (!Number(o.ada)) {
    // menit dibulatkan ke bawah: VA tutup sebelum hold habis, jadi transfer tidak masuk ke pesanan yang sudah lewat waktu
    const menit = Number(o.menit);
    if (menit < 1) throw konflik("Batas waktu pesanan sudah habis.");
    const va = await buatVaMidtrans(code, o.total, bank, menit);
    try {
      await db.query(
        `INSERT INTO payments (order_id, method, provider, provider_ref, bank, va_number, amount, status, expires_at)
         VALUES (?, 'va', 'midtrans', ?, ?, ?, ?, 'pending', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))`,
        [o.id, va.transaction_id, va.bank, va.va_number, o.total, menit],
      );
    } catch (e) {
      // permintaan kembar: charge kedua dijawab 406 → transaksi Midtrans yang sama → provider_ref duplikat
      if ((e as { code?: string }).code !== "ER_DUP_ENTRY") throw e;
    }
    await db.query("UPDATE orders SET payment_status = 'pending' WHERE id = ? AND payment_status = 'unpaid'", [o.id]);
  }
  return bacaPesanan(userId, code);
}

const STATUS: Record<string, "paid" | "expired" | "failed"> = { settlement: "paid", expire: "expired", cancel: "failed", deny: "failed", failure: "failed" };

// F10: notifikasi HTTP Midtrans (rute publik). Sah = signature cocok dan nominal sama dengan pembayaran tersimpan.
// settlement → transisi pay oleh sistem (holding → confirmed, stok terjual, notifikasi pembeli) lalu payments lunas.
// Notifikasi berulang aman: baris yang sudah lunas tidak disentuh, transisi kedua ditolak 409.
export async function terimaNotifikasiMidtrans(n: Record<string, unknown>): Promise<void> {
  if (!notifikasiSah(n)) throw new AppError(403, "FORBIDDEN", "Tanda tangan notifikasi tidak sah.");
  const baru = STATUS[String(n.transaction_status)];
  if (!baru) return; // pending: belum ada yang berubah
  const code = String(n.order_id);
  await dalamTransaksi(async (conn) => {
    // VA (pembeli, F10) atau Snap 'online' (pesanan meja F21, pre-order F26)
    const [[p]] = await conn.query<RowDataPacket[]>(
      `SELECT p.id, p.status, p.amount FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE o.code = ? AND p.method IN ('va', 'online') AND p.provider = 'midtrans' ORDER BY p.id LIMIT 1`,
      [code],
    );
    if (!p || p.status === "paid") return;
    if (Number(n.gross_amount) !== p.amount) {
      console.error(`Notifikasi Midtrans ${code}: nominal ${String(n.gross_amount)} ≠ ${p.amount}, diabaikan`);
      return;
    }
    if (baru === "paid") {
      // urutan kunci sama dengan transisi lain (users → orders → menus), payments terakhir
      // lunas setelah hold habis/batal → 409 ditelan, payments tetap lunas → muncul di daftar refund admin (F26)
      await transisi(conn, code, "pay", { jenis: "system" }).catch((e: unknown) => {
        if (!(e instanceof AppError) || e.status !== 409) throw e;
        console.error(`VA ${code} lunas tetapi pesanan tidak bisa dikonfirmasi: ${e.message}`);
      });
    }
    // Snap baru tahu transaction_id dari notifikasi
    await conn.query(
      `UPDATE payments SET status = ?, paid_at = IF(? = 'paid', UTC_TIMESTAMP(), paid_at), raw_payload = ?, provider_ref = COALESCE(provider_ref, ?)
       WHERE id = ? AND status <> 'paid'`,
      [baru, baru, JSON.stringify(n), typeof n.transaction_id === "string" ? n.transaction_id : null, p.id],
    );
  });
}
