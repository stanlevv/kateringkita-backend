// Isi file: tiket bantuan sisi pembeli (buat, daftar, buka, balas, tutup) dan potongan yang dipakai bersama sisi admin
// (admin-ticket.service). Alurnya routes/ticket.ts → handlers/ticket.handler.ts → file ini → database.
// Tiket bantuan = percakapan dua arah antara pembeli dan tim admin (customer service) untuk masalah akun, pembayaran,
// atau aplikasi. Urusan isi pesanan (menu, waktu ambil) tetap langsung ke penjual lewat WhatsApp.
import { randomInt } from "node:crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { Conn, withTransaction } from "./admin-audit.service";
import { getWibDate } from "./merchant-quota.service";
import { CreateTicketInput, ListTicketsQuery } from "../dto/ticket.dto";

// Kode tiket berbentuk TK-YYYYMMDD-XXXX: tanggal WIB lalu 4 karakter acak tanpa 0/O/1/I supaya mudah dibacakan.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
/**
 * Pembuat 4 karakter acak untuk kode tiket. Ditaruh di dalam objek supaya test bisa mengganti `random` dan sengaja
 * membuat kode kembar.
 */
export const ticketCodeGenerator = {
  random: (): string => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""),
};
// Hanya galat duplikat pada kunci unik `code` yang berarti kode tiket kembar (MySQL 8 menyebutnya
// "support_tickets.code", versi lama dan TiDB menyebut "code").
const isCodeCollision = (error: unknown) =>
  (error as { code?: string } | null)?.code === "ER_DUP_ENTRY" &&
  /for key '(support_tickets\.)?code'/.test(String((error as Error).message));

// Batas tiket yang belum ditutup per pembeli.
const MAX_OPEN_TICKETS = 3;
/** Nama pengirim balasan admin yang dilihat pembeli. Nama admin yang asli hanya tampil di dashboard admin. */
export const TEAM_NAME = "Tim KateringKita";

/**
 * Galat 404 tiket tidak ditemukan (juga dipakai bila tiket milik pembeli lain).
 * @returns AppError 404 NOT_FOUND
 */
export const ticketNotFound = () => new AppError(404, "NOT_FOUND", "Tiket tidak ditemukan.");
/**
 * Galat 409 untuk tiket yang sudah ditutup dan tidak bisa dibalas lagi.
 * @returns AppError 409 TICKET_CLOSED
 */
export const ticketClosed = () =>
  new AppError(409, "TICKET_CLOSED", "Tiket sudah ditutup. Buat tiket baru bila masih perlu bantuan.");

// Pesan terakhir sebuah tiket: urut waktu lalu id. Urutan id saja tidak cukup karena di TiDB AUTO_INCREMENT hanya
// naik di dalam satu server, bukan antar-server.
const LAST_MESSAGE_SQL =
  "FROM support_ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1";
/**
 * Kolom ringkasan tiket untuk daftar, dipakai sisi pembeli dan admin. Kueri pemakainya harus memberi alias `t` untuk
 * support_tickets dan `o` untuk orders (LEFT JOIN).
 */
export const TICKET_SUMMARY_COLUMNS = `t.code, t.category, t.subject, t.status, o.code AS order_code, t.created_at, t.last_message_at,
  (SELECT LEFT(m.body, 100) ${LAST_MESSAGE_SQL}) AS last_message_preview, (SELECT m.sender_role ${LAST_MESSAGE_SQL}) AS last_sender_role`;
// Belum dibaca: ada pesan admin sesudah pembeli terakhir membuka tiket, atau tiket belum pernah dibuka.
// shortcut: DATETIME per detik; balasan admin di detik yang sama tepat setelah pembeli membuka tiket tidak ditandai
// belum dibaca. Ganti penanda ke id pesan terakhir yang dibaca bila dikeluhkan.
const UNREAD_SQL = `EXISTS (SELECT 1 FROM support_ticket_messages a WHERE a.ticket_id = t.id AND a.sender_role = 'admin'
  AND (t.customer_last_read_at IS NULL OR a.created_at > t.customer_last_read_at))`;

/**
 * Mengubah baris hasil kueri {@link TICKET_SUMMARY_COLUMNS} menjadi ringkasan tiket untuk JSON.
 * @param row baris hasil kueri
 * @returns `{ code, category, subject, status, order_code, created_at, last_message_at, last_message_preview,
 *          last_sender_role }`
 */
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

/**
 * Membaca satu tiket beserta semua pesannya (urut waktu kirim). Kolom `u_*` (data pembeli) dan `o_*` (data pesanan)
 * hanya dipakai detail di sisi admin.
 * @param code   kode tiket
 * @param userId id pembeli bila hanya boleh membaca tiket miliknya sendiri, atau null untuk admin (semua tiket)
 * @returns `{ ticket, messages }`: baris tiket dan daftar baris pesan
 * @throws 404 tiket tidak ada, atau bukan milik pembeli itu
 */
export async function loadTicket(code: string, userId: number | null) {
  // 1. Baca tiket beserta pembeli dan pesanan yang dirujuk (bila ada).
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
  // 2. Baca semua pesannya; `nama` = nama asli pengirim.
  const [messages] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.sender_role, u.full_name AS nama, m.body, m.created_at
     FROM support_ticket_messages m LEFT JOIN users u ON u.id = m.sender_user_id
     WHERE m.ticket_id = ? ORDER BY m.created_at, m.id`,
    [ticket.id],
  );
  return { ticket, messages };
}

/**
 * Menyusun detail tiket untuk JSON. Nama pengirim tiap pesan ditentukan pemanggil, karena pembeli dan admin melihat
 * nama yang berbeda.
 * @param loaded        hasil {@link loadTicket}: `{ ticket, messages }`
 * @param getSenderName fungsi yang memberi nama pengirim untuk satu pesan, atau null bila tanpa nama
 * @returns detail tiket berisi data tiket, `last_sender_role`, dan `messages`
 */
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

// Detail untuk pembeli: balasan admin selalu atas nama tim, pesan pembeli sendiri tanpa nama.
const getCustomerTicketDetail = async (userId: number, code: string) =>
  toTicketDetail(await loadTicket(code, userId), (message) => (message.sender_role === "admin" ? TEAM_NAME : null));

/**
 * Mengunci satu tiket (FOR UPDATE: baris dikunci sampai transaksi selesai) supaya balasan dan penutupan dari pembeli
 * dan admin tidak saling timpa.
 * @param conn   koneksi di dalam transaksi pemanggil
 * @param code   kode tiket
 * @param userId id pembeli bila hanya boleh tiket miliknya sendiri; kosong untuk admin
 * @returns baris tiket `{ id, code, user_id, subject, status }`
 * @throws 404 tiket tidak ada, atau bukan milik pembeli itu
 */
export async function lockTicket(conn: Conn, code: string, userId?: number) {
  const [[ticket]] = await conn.query<RowDataPacket[]>(
    `SELECT id, code, user_id, subject, status FROM support_tickets WHERE code = ?${userId === undefined ? "" : " AND user_id = ?"} FOR UPDATE`,
    userId === undefined ? [code] : [code, userId],
  );
  if (!ticket) throw ticketNotFound();
  return ticket;
}

/**
 * Menambah satu pesan ke tiket. Waktu kirim pesan disalin dari `last_message_at` tiket yang baru saja diisi pemanggil
 * di transaksi yang sama, sehingga keduanya satu nilai waktu dan urutan daftar serta tanda belum dibaca tetap cocok.
 * @param conn     koneksi di dalam transaksi pemanggil
 * @param ticketId id tiket
 * @param role     pengirim: `customer` (pembeli) atau `admin`
 * @param senderId id pengguna pengirim
 * @param body     isi pesan
 * @returns id pesan yang baru
 */
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

// Menyimpan baris tiket baru dengan kode acak. Galat duplikat hanya membatalkan satu perintah itu, bukan seluruh
// transaksi, jadi bila kode kebetulan kembar dicoba kode baru, paling banyak 5 kali (sama dengan kode pesanan).
async function insertTicket(conn: Conn, userId: number, orderId: number | null, input: CreateTicketInput) {
  const datePart = getWibDate().replace(/-/g, "");
  for (let i = 0; ; i++) {
    // 1. Buat kode baru lalu coba simpan.
    const code = `TK-${datePart}-${ticketCodeGenerator.random()}`;
    try {
      const [result] = await conn.query<ResultSetHeader>(
        `INSERT INTO support_tickets (code, user_id, order_id, category, subject, status, last_message_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [code, userId, orderId, input.category, input.subject],
      );
      return { id: result.insertId, code };
    } catch (error) {
      // 2. Galat selain kode kembar dilempar; kode kembar dicoba lagi sampai percobaan kelima.
      if (!isCodeCollision(error)) throw error;
      if (i === 4) throw new Error("Kode tiket bentrok 5 kali.");
    }
  }
}

/**
 * Membuat tiket baru beserta pesan pertamanya. Pembeli boleh mengaitkan tiket dengan salah satu pesanannya, dan
 * paling banyak punya 3 tiket yang belum ditutup.
 * @param userId id pembeli yang login
 * @param input  isi yang sudah lolos createTicketSchema: `category`, `subject`, `message`, `order_code` (opsional)
 * @returns detail tiket yang baru (sudut pandang pembeli)
 * @throws 400 pesanan tidak ditemukan atau bukan milik pembeli, 409 masih ada 3 tiket yang belum selesai
 */
export async function createTicket(userId: number, input: CreateTicketInput) {
  const code = await withTransaction(async (conn) => {
    // 1. Kunci baris pembeli dulu supaya pembuatan tiket satu pembeli berjalan satu per satu, sehingga batas 3 tiket
    //    tidak bisa dilampaui permintaan yang datang bersamaan. Harus sebelum INSERT, karena INSERT ke support_tickets
    //    ikut mengambil kunci bersama pada baris users (lewat foreign key), sama seperti di checkout.
    await conn.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [userId]);
    // 2. Pesanan yang dirujuk harus milik pembeli ini; pesanan orang lain dijawab dengan pesan yang sama.
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
    // 3. Hitung tiket yang belum ditutup. Transaksi READ COMMITTED membuat hitungan sesudah kunci membaca data
    //    terbaru (di TiDB, pembacaan biasa memakai potret data dari awal transaksi).
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
    // 4. Simpan tiket dan pesan pertamanya.
    const ticket = await insertTicket(conn, userId, orderId, input);
    await insertMessage(conn, ticket.id, "customer", userId, input.message);
    return ticket.code;
  }, "READ COMMITTED");
  return getCustomerTicketDetail(userId, code);
}

/**
 * Daftar tiket milik pembeli per halaman, yang paling baru ada pesannya di atas. `unread_count` menghitung semua
 * tiket yang belum dibaca, tidak hanya di halaman ini.
 * @param userId id pembeli yang login
 * @param query  `page` dan `limit` yang sudah lolos listTicketsSchema
 * @returns `{ data: [ringkasan + unread], meta: { page, limit, total, unread_count } }`
 */
export async function listMyTickets(userId: number, query: ListTicketsQuery) {
  // 1. Ambil satu halaman tiket beserta tanda belum dibaca.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${TICKET_SUMMARY_COLUMNS}, ${UNREAD_SQL} AS unread FROM support_tickets t LEFT JOIN orders o ON o.id = t.order_id
     WHERE t.user_id = ? ORDER BY t.last_message_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    [userId, query.limit, (query.page - 1) * query.limit],
  );
  // 2. Hitung jumlah semua tiket dan jumlah yang belum dibaca.
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

/**
 * Membuka satu tiket milik pembeli. Membuka tiket berarti semua balasan admin sampai saat ini dianggap sudah dibaca.
 * @param userId id pembeli yang login
 * @param code   kode tiket
 * @returns detail tiket (sudut pandang pembeli)
 * @throws 404 tiket tidak ada atau milik pembeli lain
 */
export async function getMyTicket(userId: number, code: string) {
  await db.query("UPDATE support_tickets SET customer_last_read_at = UTC_TIMESTAMP() WHERE code = ? AND user_id = ?", [
    code,
    userId,
  ]);
  return getCustomerTicketDetail(userId, code);
}

/**
 * Pembeli membalas tiketnya. Status tiket kembali `open` (menunggu admin).
 * @param userId id pembeli yang login
 * @param code   kode tiket
 * @param body   isi balasan (sudah lolos replyTicketSchema)
 * @returns detail tiket terbaru (sudut pandang pembeli)
 * @throws 404 tiket tidak ada atau milik pembeli lain, 409 tiket sudah ditutup
 */
export async function replyMyTicket(userId: number, code: string, body: string) {
  await withTransaction(async (conn) => {
    const ticket = await lockTicket(conn, code, userId);
    if (ticket.status === "closed") throw ticketClosed();
    await conn.query("UPDATE support_tickets SET status = 'open', last_message_at = UTC_TIMESTAMP() WHERE id = ?", [
      ticket.id,
    ]);
    await insertMessage(conn, ticket.id, "customer", userId, body);
  });
  return getCustomerTicketDetail(userId, code);
}

/**
 * Pembeli menutup tiketnya. Idempoten: tiket yang sudah ditutup (oleh siapa pun) tidak diubah lagi.
 * @param userId id pembeli yang login
 * @param code   kode tiket
 * @returns detail tiket terbaru (sudut pandang pembeli)
 * @throws 404 tiket tidak ada atau milik pembeli lain
 */
export async function closeMyTicket(userId: number, code: string) {
  await db.query(
    `UPDATE support_tickets SET status = 'closed', closed_at = UTC_TIMESTAMP(), closed_by = 'customer'
     WHERE code = ? AND user_id = ? AND status <> 'closed'`,
    [code, userId],
  );
  return getCustomerTicketDetail(userId, code);
}
