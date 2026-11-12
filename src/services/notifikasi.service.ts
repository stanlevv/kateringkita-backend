import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import db from "../config/db";
import type { Status } from "./pesanan-status.service";
import type { DaftarNotif, Tandai } from "../dto/notifikasi.dto";

// F08 (C-21; D8, D12): teks notifikasi pembeli per status tujuan; status tanpa entri tidak dinotifikasi
type Isi = { kode: string; toko: string; alasan: string | null };
export const PESAN_STATUS: Partial<Record<Status, (p: Isi) => { title: string; body: string }>> = {
  confirmed: (p) => ({ title: "Pesanan dikonfirmasi", body: `${p.toko} sudah mengonfirmasi pesanan ${p.kode}.` }),
  cooking: (p) => ({ title: "Pesanan sedang dimasak", body: `${p.toko} sedang memasak pesanan ${p.kode}.` }),
  ready: (p) => ({ title: "Pesanan siap diambil", body: `Pesanan ${p.kode} sudah siap. Silakan ambil di titik temu.` }),
  cancelled: (p) => ({ title: "Pesanan ditolak", body: `${p.toko} menolak pesanan ${p.kode}. Alasan: ${p.alasan}` }),
  expired: (p) => ({ title: "Pesanan kedaluwarsa", body: `Pesanan ${p.kode} di ${p.toko} dibatalkan otomatis karena tidak dikonfirmasi tepat waktu.` }),
};

// Dipanggil di dalam transaksi transisi (D10), setelah users pembeli dikunci (D11)
export async function buatNotifikasiPesanan(
  conn: Pick<PoolConnection, "query">, o: { customer_id: number | null; merchant_id: number; code: string }, ke: Status, alasan: string | null,
): Promise<void> {
  const pesan = PESAN_STATUS[ke];
  // F21: pesanan meja tanpa akun; tamu memantau status lewat halaman pesanannya
  if (!pesan || !o.customer_id) return;
  const [[m]] = await conn.query<RowDataPacket[]>("SELECT business_name FROM merchants WHERE id = ?", [o.merchant_id]);
  const { title, body } = pesan({ kode: o.code, toko: m.business_name, alasan });
  await conn.query(
    "INSERT INTO notifications (user_id, type, title, body, data, created_at) VALUES (?, 'order_status', ?, ?, ?, UTC_TIMESTAMP())",
    [o.customer_id, title, body.slice(0, 255), JSON.stringify({ order_code: o.code, status: ke })],
  );
}

const belum = async (userId: number) =>
  Number(((await db.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", [userId]))[0][0]).n);

// D13: total mengikuti filter (unread, type); unread_count selalu seluruh yang belum dibaca, tidak terpengaruh filter/halaman
// shortcut: notifikasi tidak pernah dihapus; tambah hapus yang sudah dibaca > 90 hari ke job harian bila tabel > 1 juta baris
// shortcut: filter type tanpa indeks sendiri (cukup user_id dari idx_notif_user); tambah indeks (user_id, type, created_at)
// bila notifikasi per pengguna > 10.000
export async function daftarNotifikasi(userId: number, f: DaftarNotif) {
  const where = ["user_id = ?"];
  const args: unknown[] = [userId];
  if (f.unread === "true") where.push("read_at IS NULL");
  if (f.type) {
    where.push("type = ?");
    args.push(f.type);
  }
  const syarat = where.join(" AND ");
  const [data] = await db.query<RowDataPacket[]>(
    `SELECT id, type, title, body, data, read_at, created_at FROM notifications WHERE ${syarat} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, f.limit, (f.page - 1) * f.limit],
  );
  const [[t]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM notifications WHERE ${syarat}`, args);
  return { data, meta: { page: f.page, limit: f.limit, total: Number(t.n), unread_count: await belum(userId) } };
}

// D14: id milik orang lain/tak dikenal diabaikan; read_at lama tidak tertimpa
export async function tandaiDibaca(userId: number, b: Tandai): Promise<{ unread_count: number }> {
  await db.query(
    `UPDATE notifications SET read_at = UTC_TIMESTAMP() WHERE user_id = ? AND read_at IS NULL${b.ids ? " AND id IN (?)" : ""}`,
    [userId, ...(b.ids ? [b.ids] : [])],
  );
  return { unread_count: await belum(userId) };
}
