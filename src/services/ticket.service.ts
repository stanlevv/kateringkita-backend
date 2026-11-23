import { randomInt } from "node:crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { Conn, dalamTransaksi } from "./admin-audit.service";
import { getWibDate } from "./merchant-quota.service";
import { CreateTicketInput, ListTicketsQuery } from "../dto/ticket.dto";

// Tiket bantuan (CS) dua arah pembeli ↔ tim admin (migrasi 012). Sisi admin: admin-tiket.service.ts.
// Urusan pesanan (menu, waktu ambil) tetap langsung ke penjual lewat WhatsApp.

// TK-YYYYMMDD-XXXX: tanggal WIB + 4 karakter tanpa 0/O/1/I (mudah dibacakan); `random` diganti test untuk memaksa tabrakan
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const ticketCodeGenerator = {
  random: (): string => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""),
};
// hanya duplikat pada kunci unik code yang berarti tabrakan kode (MySQL 8 "support_tickets.code", lama/TiDB "code")
const isCodeCollision = (error: unknown) =>
  (error as { code?: string } | null)?.code === "ER_DUP_ENTRY" &&
  /for key '(support_tickets\.)?code'/.test(String((error as Error).message));

const MAX_OPEN_TICKETS = 3;
// nama pengirim balasan admin yang dilihat pembeli; nama admin asli hanya untuk dashboard admin
export const TEAM_NAME = "Tim KateringKita";

export const ticketNotFound = () => new AppError(404, "NOT_FOUND", "Tiket tidak ditemukan.");
export const ticketClosed = () =>
  new AppError(409, "TICKET_CLOSED", "Tiket sudah ditutup. Buat tiket baru bila masih perlu bantuan.");

// pesan terakhir: urut waktu lalu id (AUTO_INCREMENT TiDB hanya naik per server, bukan antar-server)
const LAST_MESSAGE_SQL =
  "FROM support_ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1";
// kolom TicketSummary bersama pembeli & admin; t = support_tickets, o = orders (LEFT JOIN)
export const TICKET_SUMMARY_COLUMNS = `t.code, t.category, t.subject, t.status, o.code AS order_code, t.created_at, t.last_message_at,
  (SELECT LEFT(m.body, 100) ${LAST_MESSAGE_SQL}) AS last_message_preview, (SELECT m.sender_role ${LAST_MESSAGE_SQL}) AS last_sender_role`;
// unread: ada pesan admin sesudah pembeli terakhir membuka tiket (atau belum pernah dibuka).
// shortcut: DATETIME per detik; balasan admin di detik yang sama tepat setelah pembeli membuka tiket tidak ditandai belum dibaca.
// Ganti penanda ke id pesan terakhir yang dibaca bila dikeluhkan.
const UNREAD_SQL = `EXISTS (SELECT 1 FROM support_ticket_messages a WHERE a.ticket_id = t.id AND a.sender_role = 'admin'
  AND (t.customer_last_read_at IS NULL OR a.created_at > t.customer_last_read_at))`;

export const toTicketSummary = (row: RowDataPacket) => ({
  code: row.code,
  category: row.category,
  subject: row.subject,
  status: row.status,
  order_code: row.order_code ?? null,
  created_at: row.created_at,
  last_message_at: row.last_message_at,
  last_message_preview: row.last_message_preview,
  last_sender_role: row.last_sender_role,
});

// Tiket + pesan urut kirim. userId = hanya milik pembeli itu (bukan miliknya → 404); null = admin.
// Kolom u_* (pembeli) dan o_* (pesanan) hanya dipakai detail admin.
export async function loadTicket(code: string, userId: number | null) {
  const [[ticket]] = await db.query<RowDataPacket[]>(
    `SELECT t.id, t.code, t.category, t.subject, t.status, t.created_at, t.last_message_at, t.closed_at, t.closed_by,
            u.id AS u_id, u.full_name AS u_name, u.phone AS u_phone, u.email AS u_email,
            o.code AS order_code, o.status AS o_status, o.total AS o_total, o.created_at AS o_created_at, mc.business_name AS o_merchant
     FROM support_tickets t JOIN users u ON u.id = t.user_id
     LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN merchants mc ON mc.id = o.merchant_id
     WHERE t.code = ?${userId === null ? "" : " AND t.user_id = ?"}`,
    userId === null ? [code] : [code, userId],
  );
  if (!ticket) throw ticketNotFound();
  const [messages] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.sender_role, u.full_name AS nama, m.body, m.created_at
     FROM support_ticket_messages m LEFT JOIN users u ON u.id = m.sender_user_id
     WHERE m.ticket_id = ? ORDER BY m.created_at, m.id`,
    [ticket.id],
  );
  return { ticket, messages };
}

// TicketDetail; `nama` menentukan sender_name per pesan (pembeli dan admin berbeda)
export const toTicketDetail = (
  { ticket, messages }: Awaited<ReturnType<typeof loadTicket>>,
  getSenderName: (message: RowDataPacket) => string | null,
) => ({
  code: ticket.code,
  category: ticket.category,
  subject: ticket.subject,
  status: ticket.status,
  order_code: ticket.order_code ?? null,
  created_at: ticket.created_at,
  last_message_at: ticket.last_message_at,
  last_sender_role: messages[messages.length - 1]?.sender_role ?? null,
  closed_at: ticket.closed_at,
  closed_by: ticket.closed_by,
  messages: messages.map((message) => ({
    id: Number(message.id),
    sender_role: message.sender_role,
    sender_name: getSenderName(message),
    body: message.body,
    created_at: message.created_at,
  })),
});

// pembeli: balasan admin selalu atas nama tim, pesan sendiri tanpa nama
const getCustomerTicketDetail = async (userId: number, code: string) =>
  toTicketDetail(await loadTicket(code, userId), (message) => (message.sender_role === "admin" ? TEAM_NAME : null));

// Kunci tiket (FOR UPDATE) agar balas/tutup pembeli & admin tidak saling timpa; userId = hanya milik pembeli itu
export async function lockTicket(conn: Conn, code: string, userId?: number) {
  const [[ticket]] = await conn.query<RowDataPacket[]>(
    `SELECT id, code, user_id, subject, status FROM support_tickets WHERE code = ?${userId === undefined ? "" : " AND user_id = ?"} FOR UPDATE`,
    userId === undefined ? [code] : [code, userId],
  );
  if (!ticket) throw ticketNotFound();
  return ticket;
}

// created_at pesan = last_message_at tiket yang baru diisi pemanggil di transaksi yang sama (satu nilai waktu):
// urutan daftar dan penanda belum dibaca konsisten. Mengembalikan id pesan.
export async function insertMessage(
  conn: Conn,
  ticketId: number,
  role: "customer" | "admin",
  senderId: number,
  body: string,
): Promise<number> {
  const [result] = await conn.query<ResultSetHeader>(
    `INSERT INTO support_ticket_messages (ticket_id, sender_role, sender_user_id, body, created_at)
     SELECT id, ?, ?, ?, last_message_at FROM support_tickets WHERE id = ?`,
    [role, senderId, body, ticketId],
  );
  return result.insertId;
}

// galat duplikat hanya membatalkan pernyataan, bukan transaksi → coba kode baru, maks 5 kali (pola kode pesanan D7)
async function insertTicket(conn: Conn, userId: number, orderId: number | null, input: CreateTicketInput) {
  const datePart = getWibDate().replace(/-/g, "");
  for (let i = 0; ; i++) {
    const code = `TK-${datePart}-${ticketCodeGenerator.random()}`;
    try {
      const [result] = await conn.query<ResultSetHeader>(
        `INSERT INTO support_tickets (code, user_id, order_id, category, subject, status, last_message_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [code, userId, orderId, input.category, input.subject],
      );
      return { id: result.insertId, code };
    } catch (error) {
      if (!isCodeCollision(error)) throw error;
      if (i === 4) throw new Error("Kode tiket bentrok 5 kali.");
    }
  }
}

export async function createTicket(userId: number, input: CreateTicketInput) {
  const code = await dalamTransaksi(async (conn) => {
    // Kunci baris pembeli dulu: pembuatan tiket satu pembeli jadi serial sehingga batas 3 tiket belum selesai tidak bisa
    // dilampaui request paralel. Harus sebelum INSERT: FK support_tickets → users mengambil kunci bersama (pola checkout F06).
    await conn.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [userId]);
    let orderId: number | null = null;
    if (input.order_code) {
      const [[order]] = await conn.query<RowDataPacket[]>("SELECT id FROM orders WHERE code = ? AND customer_id = ?", [
        input.order_code,
        userId,
      ]);
      if (!order)
        throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { order_code: ["Pesanan tidak ditemukan."] });
      orderId = order.id;
    }
    // READ COMMITTED: hitungan sesudah kunci membaca data terbaru (TiDB: baca biasa memakai snapshot awal transaksi)
    const [[openCount]] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = ? AND status <> 'closed'",
      [userId],
    );
    if (Number(openCount.n) >= MAX_OPEN_TICKETS) {
      throw new AppError(
        409,
        "TOO_MANY_OPEN_TICKETS",
        "Masih ada 3 tiket yang belum selesai. Tunggu balasan atau tutup salah satunya.",
      );
    }
    const ticket = await insertTicket(conn, userId, orderId, input);
    await insertMessage(conn, ticket.id, "customer", userId, input.message);
    return ticket.code;
  }, "READ COMMITTED");
  return getCustomerTicketDetail(userId, code);
}

// 1 kueri halaman + 2 COUNT; unread_count = seluruh tiket yang belum dibaca, tidak terpengaruh halaman
export async function listMyTickets(userId: number, query: ListTicketsQuery) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${TICKET_SUMMARY_COLUMNS}, ${UNREAD_SQL} AS unread FROM support_tickets t LEFT JOIN orders o ON o.id = t.order_id
     WHERE t.user_id = ? ORDER BY t.last_message_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    [userId, query.limit, (query.page - 1) * query.limit],
  );
  const [[totalRow]] = await db.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM support_tickets t WHERE t.user_id = ?",
    [userId],
  );
  const [[unreadRow]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM support_tickets t WHERE t.user_id = ? AND ${UNREAD_SQL}`,
    [userId],
  );
  return {
    data: rows.map((row) => ({ ...toTicketSummary(row), unread: Boolean(row.unread) })),
    meta: { page: query.page, limit: query.limit, total: Number(totalRow.n), unread_count: Number(unreadRow.n) },
  };
}

// membuka tiket = membaca semua balasan admin sampai saat ini
export async function getMyTicket(userId: number, code: string) {
  await db.query("UPDATE support_tickets SET customer_last_read_at = UTC_TIMESTAMP() WHERE code = ? AND user_id = ?", [
    code,
    userId,
  ]);
  return getCustomerTicketDetail(userId, code);
}

// balasan pembeli: tiket kembali menunggu admin
export async function replyMyTicket(userId: number, code: string, body: string) {
  await dalamTransaksi(async (conn) => {
    const ticket = await lockTicket(conn, code, userId);
    if (ticket.status === "closed") throw ticketClosed();
    await conn.query("UPDATE support_tickets SET status = 'open', last_message_at = UTC_TIMESTAMP() WHERE id = ?", [
      ticket.id,
    ]);
    await insertMessage(conn, ticket.id, "customer", userId, body);
  });
  return getCustomerTicketDetail(userId, code);
}

// idempoten: tiket yang sudah ditutup (oleh siapa pun) tidak berubah
export async function closeMyTicket(userId: number, code: string) {
  await db.query(
    `UPDATE support_tickets SET status = 'closed', closed_at = UTC_TIMESTAMP(), closed_by = 'customer'
     WHERE code = ? AND user_id = ? AND status <> 'closed'`,
    [code, userId],
  );
  return getCustomerTicketDetail(userId, code);
}
