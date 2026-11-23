// Isi file: tiket bantuan (layanan pelanggan/CS) sisi admin: daftar, detail, balas, dan tutup tiket dari pembeli.
// Alurnya routes/admin.ts → handlers/ticket.handler.ts → file ini → database. Semua tingkat admin (super, ops, support)
// boleh membaca, membalas, dan menutup tiket (lihat middleware/admin-access.ts). Sisi pembeli ada di ticket.service.ts.
// Balasan dan penutupan oleh admin dicatat di log audit dan dikabarkan ke pembeli lewat notifikasi tab Info.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { ListAdminTicketsQuery } from "../dto/ticket.dto";
import { recordAudit, Conn, withTransaction } from "./admin-audit.service";
import { likePattern } from "./order.service";
import {
  TICKET_SUMMARY_COLUMNS,
  TEAM_NAME,
  loadTicket,
  toTicketDetail,
  lockTicket,
  toTicketSummary,
  insertMessage,
  ticketClosed,
} from "./ticket.service";

/**
 * Daftar tiket untuk admin per halaman. Tab `open` diurutkan dari yang paling lama menunggu; tab lain terbaru dulu.
 * Butuh tiga query: satu halaman, total yang cocok filter, dan jumlah tiket per status.
 * @param filter `status`, `q` (kode tiket, judul, nama, atau nomor HP pembeli), `page`, `limit`
 * @returns `{ data, meta: { page, limit, total, counts } }`; `counts` = jumlah seluruh tiket per status untuk angka
 *          di tab, tidak terpengaruh filter, pencarian, maupun halaman
 */
export async function listAdminTickets(filter: ListAdminTicketsQuery) {
  // 1. Susun syarat dari status dan kata kunci.
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status) {
    where.push("t.status = ?");
    args.push(filter.status);
  }
  if (filter.q) {
    where.push(
      "(LOWER(t.code) LIKE LOWER(?) OR LOWER(t.subject) LIKE LOWER(?) OR LOWER(u.full_name) LIKE LOWER(?) OR u.phone LIKE ?)",
    );
    const pattern = likePattern(filter.q);
    args.push(pattern, pattern, pattern, pattern);
  }
  // 2. Ambil satu halaman (antrean open: paling lama menunggu di atas) beserta total yang cocok filter.
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const direction = filter.status === "open" ? "ASC" : "DESC";
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${TICKET_SUMMARY_COLUMNS}, u.id AS u_id, u.full_name AS u_name, u.phone AS u_phone
     FROM support_tickets t JOIN users u ON u.id = t.user_id LEFT JOIN orders o ON o.id = t.order_id
     ${whereSql} ORDER BY t.last_message_at ${direction}, t.id ${direction} LIMIT ? OFFSET ?`,
    [...args, filter.limit, (filter.page - 1) * filter.limit],
  );
  const [[countRow]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM support_tickets t JOIN users u ON u.id = t.user_id ${whereSql}`,
    args,
  );
  // 3. Angka di tab: seluruh tiket per status, tidak terpengaruh filter (sama seperti hitungan belum dibaca
  //    notifikasi).
  const [statusRows] = await db.query<RowDataPacket[]>(
    "SELECT status, COUNT(*) AS n FROM support_tickets GROUP BY status",
  );
  const counts = { open: 0, answered: 0, closed: 0 };
  for (const row of statusRows) counts[row.status as keyof typeof counts] = Number(row.n);
  return {
    data: rows.map((row) => ({
      ...toTicketSummary(row),
      customer: { id: row.u_id, full_name: row.u_name, phone: row.u_phone },
    })),
    meta: { page: filter.page, limit: filter.limit, total: Number(countRow.n), counts },
  };
}

/**
 * Detail tiket untuk admin. Berbeda dengan sisi pembeli, admin melihat nama asli pengirim setiap pesan (pesan admin
 * tanpa nama tampil sebagai nama tim), data kontak pembeli, dan ringkasan pesanan yang dirujuk tiket.
 * @param code kode tiket, contoh `TK-20260101-AB12`
 * @returns detail tiket beserta `customer` dan `order` (null bila tiket tidak merujuk pesanan)
 * @throws 404 tiket tidak ditemukan
 */
export async function getAdminTicket(code: string) {
  // 1. Baca tiket tanpa batasan pemilik (null = semua pembeli), beserta pesan-pesannya.
  const loaded = await loadTicket(code, null);
  const { ticket } = loaded;
  return {
    // 2. Nama pengirim = nama asli akun; pesan admin yang akunnya tidak ditemukan tampil sebagai nama tim.
    ...toTicketDetail(loaded, (message) => message.nama ?? (message.sender_role === "admin" ? TEAM_NAME : null)),
    customer: { id: ticket.u_id, full_name: ticket.u_name, phone: ticket.u_phone, email: ticket.u_email },
    order: ticket.order_code
      ? {
          code: ticket.order_code,
          status: ticket.o_status,
          total: ticket.o_total,
          merchant_name: ticket.o_merchant,
          created_at: ticket.o_created_at,
        }
      : null,
  };
}

// Notifikasi di aplikasi untuk pembeli pemilik tiket (tab Info); aplikasi membuka detail tiket dari data.ticket_code.
async function notifyCustomer(conn: Conn, ticket: RowDataPacket, title: string, body: string) {
  await conn.query(
    "INSERT INTO notifications (user_id, type, title, body, data, created_at) VALUES (?, 'info', ?, ?, ?, UTC_TIMESTAMP())",
    [ticket.user_id, title.slice(0, 120), body.slice(0, 255), JSON.stringify({ ticket_code: ticket.code })],
  );
}

/**
 * Admin membalas tiket. Status menjadi `answered` (menunggu pembeli), pembeli mendapat notifikasi, dan balasan dicatat
 * di log audit `ticket.reply` beserta id pesannya.
 * @param adminId id admin yang membalas
 * @param code    kode tiket
 * @param body    isi balasan (sudah diperiksa di handler)
 * @returns detail tiket sesudah dibalas
 * @throws 404 tiket tidak ditemukan, 409 tiket sudah ditutup
 */
export async function replyAdminTicket(adminId: number, code: string, body: string) {
  await withTransaction(async (conn) => {
    // 1. Kunci tiket; tiket yang sudah ditutup tidak bisa dibalas.
    const ticket = await lockTicket(conn, code);
    if (ticket.status === "closed") throw ticketClosed();
    // 2. Ubah status dan simpan pesannya, lalu kabari pembeli dan catat di log audit.
    await conn.query("UPDATE support_tickets SET status = 'answered', last_message_at = UTC_TIMESTAMP() WHERE id = ?", [
      ticket.id,
    ]);
    const messageId = await insertMessage(conn, ticket.id, "admin", adminId, body);
    await notifyCustomer(conn, ticket, `Balasan tiket ${ticket.code}`, `${TEAM_NAME} membalas "${ticket.subject}".`);
    await recordAudit(conn, {
      adminId,
      action: "ticket.reply",
      targetType: "ticket",
      targetId: ticket.code,
      before: { status: ticket.status },
      after: { status: "answered", message_id: messageId },
    });
  });
  return getAdminTicket(code);
}

/**
 * Admin menutup tiket. Idempoten: tiket yang sudah ditutup (oleh siapa pun) tidak berubah, tanpa notifikasi dan tanpa
 * log. Selain itu pembeli dikabari dan penutupan dicatat di log audit `ticket.close`.
 * @param adminId id admin yang menutup
 * @param code    kode tiket
 * @returns detail tiket sesudah ditutup
 * @throws 404 tiket tidak ditemukan
 */
export async function closeAdminTicket(adminId: number, code: string) {
  await withTransaction(async (conn) => {
    // 1. Kunci tiket; yang sudah ditutup dibiarkan apa adanya.
    const ticket = await lockTicket(conn, code);
    if (ticket.status === "closed") return;
    // 2. Tandai ditutup oleh admin, kabari pembeli, lalu catat di log audit.
    await conn.query(
      "UPDATE support_tickets SET status = 'closed', closed_at = UTC_TIMESTAMP(), closed_by = 'admin' WHERE id = ?",
      [ticket.id],
    );
    await notifyCustomer(
      conn,
      ticket,
      `Tiket ${ticket.code} ditutup`,
      `Tiket "${ticket.subject}" ditutup oleh ${TEAM_NAME}.`,
    );
    await recordAudit(conn, {
      adminId,
      action: "ticket.close",
      targetType: "ticket",
      targetId: ticket.code,
      before: { status: ticket.status },
      after: { status: "closed" },
    });
  });
  return getAdminTicket(code);
}
