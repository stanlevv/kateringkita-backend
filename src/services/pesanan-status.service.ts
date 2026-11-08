import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import { AppError } from "../utils/errors";
import { buatNotifikasiPesanan } from "./notifikasi.service";
import { lepasStok } from "./pesanan-stok.service";

// F07 mesin status pesanan (C-15, C-16, M-04, M-08, R-03; D1–D7). Dipakai rute pembeli, rute penjual, dan job kadaluarsa F08
// (D18: `expire` dengan aktor sistem, galat 409 ditelan). F08: notifikasi in-app pembeli (C-21) dibuat di transaksi yang sama.
export type Status = "holding" | "confirmed" | "cooking" | "ready" | "completed" | "cancelled" | "expired";
export type Aksi = "confirm" | "pay" | "cook" | "ready" | "complete" | "reject" | "cancel" | "expire";
export type Aktor = { jenis: "customer"; userId: number } | { jenis: "merchant"; userId: number; merchantId: number } | { jenis: "system" };

type Jadi = "terjual" | "kembali" | "batal";
const lepas = (dari: Status): Jadi => (dari === "holding" ? "kembali" : "batal");

export const ATURAN: Record<Aksi, { oleh: Aktor["jenis"][]; dari: Status[]; ke: Status; kolom: string; stok?: (dari: Status) => Jadi | null }> = {
  confirm: { oleh: ["merchant"], dari: ["holding"], ke: "confirmed", kolom: "confirmed_at", stok: () => "terjual" },
  // F10: penjual memverifikasi QRIS sekaligus menerima, agar pesanan lunas tidak pernah kedaluwarsa
  pay: { oleh: ["merchant"], dari: ["holding"], ke: "confirmed", kolom: "confirmed_at", stok: () => "terjual" },
  cook: { oleh: ["merchant"], dari: ["confirmed"], ke: "cooking", kolom: "cooking_at" },
  ready: { oleh: ["merchant"], dari: ["cooking"], ke: "ready", kolom: "ready_at" },
  complete: { oleh: ["merchant", "customer"], dari: ["ready"], ke: "completed", kolom: "completed_at" },
  reject: { oleh: ["merchant"], dari: ["holding", "confirmed"], ke: "cancelled", kolom: "cancelled_at", stok: lepas },
  // confirmed hanya untuk tunai (dicek di transisi)
  cancel: { oleh: ["customer"], dari: ["holding", "confirmed"], ke: "cancelled", kolom: "cancelled_at", stok: lepas },
  expire: { oleh: ["system"], dari: ["holding"], ke: "expired", kolom: "cancelled_at", stok: lepas },
};

const konflik = (pesan = "Pesanan sudah berubah status.") => new AppError(409, "CONFLICT", pesan);

// Dipanggil di dalam dalamTransaksi. Urutan kunci (D5, F08 D11) untuk semua aktor: users pembeli → orders (baris, lewat code unik)
// → menus (lepasStok, urut id), sama dengan checkout F06 (users → orders → menus) sehingga tidak ada siklus.
export async function transisi(
  conn: Pick<PoolConnection, "query">, code: string, aksi: Aksi, aktor: Aktor, reason?: string | null,
): Promise<{ id: number; dari: Status; ke: Status }> {
  const a = ATURAN[aksi];
  // Pembeli: kunci baris users dulu seperti checkout. INSERT log di bawah mengambil kunci bersama FK pada users pembeli;
  // tanpa ini, checkout pembeli yang sama (users X → orders holding miliknya) dan batal ini (orders X → users S) saling menunggu.
  if (aktor.jenis === "customer") await conn.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [aktor.userId]);
  else {
    // F08 D11: penjual/sistem juga mengunci users pembeli dulu, karena INSERT notifikasi di bawah mengambil kunci FK pada users itu.
    // customer_id tidak pernah berubah, jadi baca tanpa kunci aman; kepemilikan dicek ulang di SELECT berkunci.
    const [[p]] = await conn.query<RowDataPacket[]>(
      `SELECT customer_id FROM orders WHERE code = ?${aktor.jenis === "merchant" ? " AND merchant_id = ?" : ""}`,
      [code, ...(aktor.jenis === "merchant" ? [aktor.merchantId] : [])],
    );
    if (!p) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
    await conn.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [p.customer_id]);
  }
  const [[o]] = await conn.query<RowDataPacket[]>(
    `SELECT id, customer_id, merchant_id, status, payment_method, payment_status, total, hold_until <= UTC_TIMESTAMP() AS lewat FROM orders WHERE code = ?${
      aktor.jenis === "customer" ? " AND customer_id = ?" : aktor.jenis === "merchant" ? " AND merchant_id = ?" : ""} FOR UPDATE`,
    [code, ...(aktor.jenis === "customer" ? [aktor.userId] : aktor.jenis === "merchant" ? [aktor.merchantId] : [])],
  );
  if (!o) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  const dari = o.status as Status;
  if (!a.oleh.includes(aktor.jenis) || !a.dari.includes(dari)) throw konflik();
  if (aksi === "cancel" && dari === "confirmed" && o.payment_method !== "cod") throw konflik();
  // D2: holding lewat waktu hanya bisa di-expire (job F08)
  if (dari === "holding" && Boolean(o.lewat) !== (aksi === "expire")) throw konflik(aksi === "expire" ? undefined : "Batas waktu pesanan sudah habis.");
  if (aksi === "confirm" && o.payment_method !== "cod" && o.payment_status !== "paid") throw konflik("Pesanan belum dibayar.");
  if (aksi === "pay" && (o.payment_method !== "qris" || o.payment_status === "paid")) throw konflik("Pesanan ini tidak menunggu pembayaran QRIS.");
  // shortcut: tolak pesanan QRIS lunas tidak mengubah payment_status (dana dikembalikan manual); upgrade saat gateway dipasang

  const batal = a.ke === "cancelled" || a.ke === "expired";
  const alasan = aksi === "expire" ? "Tidak dikonfirmasi tepat waktu." : reason?.trim() || null;
  await conn.query(
    `UPDATE orders SET status = ?, ${a.kolom} = UTC_TIMESTAMP()${batal ? ", cancelled_by = ?, cancel_reason = ?" : ""}${
      aksi === "complete" ? ", payment_status = IF(payment_method = 'cod', 'paid', payment_status)" : ""}${
      aksi === "pay" ? ", payment_status = 'paid'" : ""} WHERE id = ?`,
    [a.ke, ...(batal ? [aktor.jenis, alasan] : []), o.id],
  );
  if (aksi === "pay") {
    await conn.query("INSERT INTO payments (order_id, method, provider, amount, status, paid_at) VALUES (?, 'qris', 'manual', ?, 'paid', UTC_TIMESTAMP())",
      [o.id, o.total]);
  }
  const jadi = a.stok?.(dari);
  if (jadi) await lepasStok(conn, o.id, jadi);
  await conn.query("INSERT INTO order_status_logs (order_id, from_status, to_status, actor_user_id) VALUES (?, ?, ?, ?)",
    [o.id, dari, a.ke, aktor.jenis === "system" ? null : aktor.userId]);
  if (aktor.jenis !== "customer") await buatNotifikasiPesanan(conn, { customer_id: o.customer_id, merchant_id: o.merchant_id, code }, a.ke, alasan);
  return { id: o.id, dari, ke: a.ke };
}
