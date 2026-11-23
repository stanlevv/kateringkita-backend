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

// Tiket bantuan (CS) sisi admin; semua tingkat admin boleh baca & balas (middleware/admin-access.ts). Pembeli: ticket.service.ts.

// 1 kueri halaman + 1 COUNT + 1 hitungan per status
export async function listAdminTickets(filter: ListAdminTicketsQuery) {
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
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // antrean open: yang paling lama menunggu di atas; tab lain terbaru dulu
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
  // counts = angka di tab: seluruh tiket per status, tidak terpengaruh filter/pencarian/halaman (seperti unread_count notifikasi, D13)
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

// AdminTicketDetail: nama pengirim asli (admin/pembeli), data pembeli, dan pesanan terkait
export async function getAdminTicket(code: string) {
  const loaded = await loadTicket(code, null);
  const { ticket } = loaded;
  return {
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

// Notifikasi in-app ke pembeli (tab Info); aplikasi membuka detail tiket dari data.ticket_code
async function notifyCustomer(conn: Conn, ticket: RowDataPacket, title: string, body: string) {
  await conn.query(
    "INSERT INTO notifications (user_id, type, title, body, data, created_at) VALUES (?, 'info', ?, ?, ?, UTC_TIMESTAMP())",
    [ticket.user_id, title.slice(0, 120), body.slice(0, 255), JSON.stringify({ ticket_code: ticket.code })],
  );
}

// balasan admin: tiket menunggu pembeli
export async function replyAdminTicket(adminId: number, code: string, body: string) {
  await withTransaction(async (conn) => {
    const ticket = await lockTicket(conn, code);
    if (ticket.status === "closed") throw ticketClosed();
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

// idempoten: tiket yang sudah ditutup (oleh siapa pun) tidak berubah, tanpa notifikasi dan audit
export async function closeAdminTicket(adminId: number, code: string) {
  await withTransaction(async (conn) => {
    const ticket = await lockTicket(conn, code);
    if (ticket.status === "closed") return;
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
