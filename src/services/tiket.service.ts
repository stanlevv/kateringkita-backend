import { randomInt } from "node:crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { Conn, dalamTransaksi } from "./admin-audit.service";
import { hariIniWib } from "./merchant-kuota.service";
import { BuatTiket, DaftarTiket } from "../dto/tiket.dto";

// Tiket bantuan (CS) dua arah pembeli ↔ tim admin (migrasi 012). Sisi admin: admin-tiket.service.ts.
// Urusan pesanan (menu, waktu ambil) tetap langsung ke penjual lewat WhatsApp.

// TK-YYYYMMDD-XXXX: tanggal WIB + 4 karakter tanpa 0/O/1/I (mudah dibacakan); `acak` diganti test untuk memaksa tabrakan
const ALFABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const kodeTiket = { acak: (): string => Array.from({ length: 4 }, () => ALFABET[randomInt(ALFABET.length)]).join("") };
// hanya duplikat pada kunci unik code yang berarti tabrakan kode (MySQL 8 "support_tickets.code", lama/TiDB "code")
const bentrokKode = (e: unknown) =>
  (e as { code?: string } | null)?.code === "ER_DUP_ENTRY" && /for key '(support_tickets\.)?code'/.test(String((e as Error).message));

const MAKS_BELUM_SELESAI = 3;
// nama pengirim balasan admin yang dilihat pembeli; nama admin asli hanya untuk dashboard admin
export const NAMA_TIM = "Tim KateringKita";

export const tiketTidakAda = () => new AppError(404, "NOT_FOUND", "Tiket tidak ditemukan.");
export const tiketDitutup = () => new AppError(409, "TICKET_CLOSED", "Tiket sudah ditutup. Buat tiket baru bila masih perlu bantuan.");

// pesan terakhir: urut waktu lalu id (AUTO_INCREMENT TiDB hanya naik per server, bukan antar-server)
const TERAKHIR = "FROM support_ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1";
// kolom TicketSummary bersama pembeli & admin; t = support_tickets, o = orders (LEFT JOIN)
export const KOLOM_RINGKAS = `t.code, t.category, t.subject, t.status, o.code AS order_code, t.created_at, t.last_message_at,
  (SELECT LEFT(m.body, 100) ${TERAKHIR}) AS last_message_preview, (SELECT m.sender_role ${TERAKHIR}) AS last_sender_role`;
// unread: ada pesan admin sesudah pembeli terakhir membuka tiket (atau belum pernah dibuka).
// shortcut: DATETIME per detik; balasan admin di detik yang sama tepat setelah pembeli membuka tiket tidak ditandai belum dibaca.
// Ganti penanda ke id pesan terakhir yang dibaca bila dikeluhkan.
const BELUM_DIBACA = `EXISTS (SELECT 1 FROM support_ticket_messages a WHERE a.ticket_id = t.id AND a.sender_role = 'admin'
  AND (t.customer_last_read_at IS NULL OR a.created_at > t.customer_last_read_at))`;

export const ringkas = (r: RowDataPacket) => ({
  code: r.code, category: r.category, subject: r.subject, status: r.status, order_code: r.order_code ?? null,
  created_at: r.created_at, last_message_at: r.last_message_at, last_message_preview: r.last_message_preview, last_sender_role: r.last_sender_role,
});

// Tiket + pesan urut kirim. userId = hanya milik pembeli itu (bukan miliknya → 404); null = admin.
// Kolom u_* (pembeli) dan o_* (pesanan) hanya dipakai detail admin.
export async function bacaTiket(code: string, userId: number | null) {
  const [[t]] = await db.query<RowDataPacket[]>(
    `SELECT t.id, t.code, t.category, t.subject, t.status, t.created_at, t.last_message_at, t.closed_at, t.closed_by,
            u.id AS u_id, u.full_name AS u_name, u.phone AS u_phone, u.email AS u_email,
            o.code AS order_code, o.status AS o_status, o.total AS o_total, o.created_at AS o_created_at, mc.business_name AS o_merchant
     FROM support_tickets t JOIN users u ON u.id = t.user_id
     LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN merchants mc ON mc.id = o.merchant_id
     WHERE t.code = ?${userId === null ? "" : " AND t.user_id = ?"}`,
    userId === null ? [code] : [code, userId],
  );
  if (!t) throw tiketTidakAda();
  const [pesan] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.sender_role, u.full_name AS nama, m.body, m.created_at
     FROM support_ticket_messages m LEFT JOIN users u ON u.id = m.sender_user_id
     WHERE m.ticket_id = ? ORDER BY m.created_at, m.id`,
    [t.id],
  );
  return { t, pesan };
}

// TicketDetail; `nama` menentukan sender_name per pesan (pembeli dan admin berbeda)
export const detail = ({ t, pesan }: Awaited<ReturnType<typeof bacaTiket>>, nama: (m: RowDataPacket) => string | null) => ({
  code: t.code, category: t.category, subject: t.subject, status: t.status, order_code: t.order_code ?? null,
  created_at: t.created_at, last_message_at: t.last_message_at, last_sender_role: pesan[pesan.length - 1]?.sender_role ?? null,
  closed_at: t.closed_at, closed_by: t.closed_by,
  messages: pesan.map((m) => ({ id: Number(m.id), sender_role: m.sender_role, sender_name: nama(m), body: m.body, created_at: m.created_at })),
});

// pembeli: balasan admin selalu atas nama tim, pesan sendiri tanpa nama
const detailPembeli = async (userId: number, code: string) =>
  detail(await bacaTiket(code, userId), (m) => (m.sender_role === "admin" ? NAMA_TIM : null));

// Kunci tiket (FOR UPDATE) agar balas/tutup pembeli & admin tidak saling timpa; userId = hanya milik pembeli itu
export async function kunciTiket(conn: Conn, code: string, userId?: number) {
  const [[t]] = await conn.query<RowDataPacket[]>(
    `SELECT id, code, user_id, subject, status FROM support_tickets WHERE code = ?${userId === undefined ? "" : " AND user_id = ?"} FOR UPDATE`,
    userId === undefined ? [code] : [code, userId],
  );
  if (!t) throw tiketTidakAda();
  return t;
}

// created_at pesan = last_message_at tiket yang baru diisi pemanggil di transaksi yang sama (satu nilai waktu):
// urutan daftar dan penanda belum dibaca konsisten. Mengembalikan id pesan.
export async function tambahPesan(conn: Conn, ticketId: number, role: "customer" | "admin", senderId: number, body: string): Promise<number> {
  const [r] = await conn.query<ResultSetHeader>(
    `INSERT INTO support_ticket_messages (ticket_id, sender_role, sender_user_id, body, created_at)
     SELECT id, ?, ?, ?, last_message_at FROM support_tickets WHERE id = ?`,
    [role, senderId, body, ticketId],
  );
  return r.insertId;
}

// galat duplikat hanya membatalkan pernyataan, bukan transaksi → coba kode baru, maks 5 kali (pola kode pesanan D7)
async function sisipTiket(conn: Conn, userId: number, orderId: number | null, b: BuatTiket) {
  const hari = hariIniWib().replace(/-/g, "");
  for (let i = 0; ; i++) {
    const code = `TK-${hari}-${kodeTiket.acak()}`;
    try {
      const [r] = await conn.query<ResultSetHeader>(
        `INSERT INTO support_tickets (code, user_id, order_id, category, subject, status, last_message_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [code, userId, orderId, b.category, b.subject],
      );
      return { id: r.insertId, code };
    } catch (e) {
      if (!bentrokKode(e)) throw e;
      if (i === 4) throw new Error("Kode tiket bentrok 5 kali.");
    }
  }
}

export async function buatTiket(userId: number, b: BuatTiket) {
  const code = await dalamTransaksi(async (conn) => {
    // Kunci baris pembeli dulu: pembuatan tiket satu pembeli jadi serial sehingga batas 3 tiket belum selesai tidak bisa
    // dilampaui request paralel. Harus sebelum INSERT: FK support_tickets → users mengambil kunci bersama (pola checkout F06).
    await conn.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [userId]);
    let orderId: number | null = null;
    if (b.order_code) {
      const [[o]] = await conn.query<RowDataPacket[]>("SELECT id FROM orders WHERE code = ? AND customer_id = ?", [b.order_code, userId]);
      if (!o) throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { order_code: ["Pesanan tidak ditemukan."] });
      orderId = o.id;
    }
    // READ COMMITTED: hitungan sesudah kunci membaca data terbaru (TiDB: baca biasa memakai snapshot awal transaksi)
    const [[n]] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = ? AND status <> 'closed'", [userId],
    );
    if (Number(n.n) >= MAKS_BELUM_SELESAI) {
      throw new AppError(409, "TOO_MANY_OPEN_TICKETS", "Masih ada 3 tiket yang belum selesai. Tunggu balasan atau tutup salah satunya.");
    }
    const t = await sisipTiket(conn, userId, orderId, b);
    await tambahPesan(conn, t.id, "customer", userId, b.message);
    return t.code;
  }, "READ COMMITTED");
  return detailPembeli(userId, code);
}

// 1 kueri halaman + 2 COUNT; unread_count = seluruh tiket yang belum dibaca, tidak terpengaruh halaman
export async function daftarTiketSaya(userId: number, h: DaftarTiket) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM_RINGKAS}, ${BELUM_DIBACA} AS unread FROM support_tickets t LEFT JOIN orders o ON o.id = t.order_id
     WHERE t.user_id = ? ORDER BY t.last_message_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    [userId, h.limit, (h.page - 1) * h.limit],
  );
  const [[n]] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM support_tickets t WHERE t.user_id = ?", [userId]);
  const [[b]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM support_tickets t WHERE t.user_id = ? AND ${BELUM_DIBACA}`, [userId]);
  return {
    data: rows.map((r) => ({ ...ringkas(r), unread: Boolean(r.unread) })),
    meta: { page: h.page, limit: h.limit, total: Number(n.n), unread_count: Number(b.n) },
  };
}

// membuka tiket = membaca semua balasan admin sampai saat ini
export async function bacaTiketSaya(userId: number, code: string) {
  await db.query("UPDATE support_tickets SET customer_last_read_at = UTC_TIMESTAMP() WHERE code = ? AND user_id = ?", [code, userId]);
  return detailPembeli(userId, code);
}

// balasan pembeli: tiket kembali menunggu admin
export async function balasTiketSaya(userId: number, code: string, body: string) {
  await dalamTransaksi(async (conn) => {
    const t = await kunciTiket(conn, code, userId);
    if (t.status === "closed") throw tiketDitutup();
    await conn.query("UPDATE support_tickets SET status = 'open', last_message_at = UTC_TIMESTAMP() WHERE id = ?", [t.id]);
    await tambahPesan(conn, t.id, "customer", userId, body);
  });
  return detailPembeli(userId, code);
}

// idempoten: tiket yang sudah ditutup (oleh siapa pun) tidak berubah
export async function tutupTiketSaya(userId: number, code: string) {
  await db.query(
    `UPDATE support_tickets SET status = 'closed', closed_at = UTC_TIMESTAMP(), closed_by = 'customer'
     WHERE code = ? AND user_id = ? AND status <> 'closed'`,
    [code, userId],
  );
  return detailPembeli(userId, code);
}
