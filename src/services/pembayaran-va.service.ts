import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { BankVa, buatVaMidtrans, notifikasiSah } from "../utils/midtrans";
import { dalamTransaksi } from "./admin-audit.service";
import { bacaPesanan } from "./pesanan.service";
import { transisi } from "./pesanan-status.service";

const konflik = (pesan: string) => new AppError(409, "CONFLICT", pesan);

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
    const [[p]] = await conn.query<RowDataPacket[]>(
      `SELECT p.id, p.status, p.amount FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE o.code = ? AND p.method = 'va' AND p.provider = 'midtrans'`,
      [code],
    );
    if (!p || p.status === "paid") return;
    if (Number(n.gross_amount) !== p.amount) {
      console.error(`Notifikasi Midtrans ${code}: nominal ${String(n.gross_amount)} ≠ ${p.amount}, diabaikan`);
      return;
    }
    if (baru === "paid") {
      // urutan kunci sama dengan transisi lain (users → orders → menus), payments terakhir
      // shortcut: lunas setelah hold habis/batal → 409 ditelan, payments tetap lunas; dana dikembalikan manual (lihat log ini)
      await transisi(conn, code, "pay", { jenis: "system" }).catch((e: unknown) => {
        if (!(e instanceof AppError) || e.status !== 409) throw e;
        console.error(`VA ${code} lunas tetapi pesanan tidak bisa dikonfirmasi: ${e.message}`);
      });
    }
    await conn.query(
      "UPDATE payments SET status = ?, paid_at = IF(? = 'paid', UTC_TIMESTAMP(), paid_at), raw_payload = ? WHERE id = ? AND status <> 'paid'",
      [baru, baru, JSON.stringify(n), p.id],
    );
  });
}
