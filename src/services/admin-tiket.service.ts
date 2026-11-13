import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { DaftarTiketAdmin } from "../dto/tiket.dto";
import { catat, Conn, dalamTransaksi } from "./admin-audit.service";
import { pola } from "./pesanan.service";
import { KOLOM_RINGKAS, NAMA_TIM, bacaTiket, detail, kunciTiket, ringkas, tambahPesan, tiketDitutup } from "./tiket.service";

// Tiket bantuan (CS) sisi admin; semua tingkat admin boleh baca & balas (middleware/admin-akses.ts). Pembeli: tiket.service.ts.

// 1 kueri halaman + 1 COUNT + 1 hitungan per status
export async function daftarTiketAdmin(f: DaftarTiketAdmin) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status) {
    where.push("t.status = ?");
    args.push(f.status);
  }
  if (f.q) {
    where.push("(LOWER(t.code) LIKE LOWER(?) OR LOWER(t.subject) LIKE LOWER(?) OR LOWER(u.full_name) LIKE LOWER(?) OR u.phone LIKE ?)");
    const p = pola(f.q);
    args.push(p, p, p, p);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // antrean open: yang paling lama menunggu di atas; tab lain terbaru dulu
  const arah = f.status === "open" ? "ASC" : "DESC";
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM_RINGKAS}, u.id AS u_id, u.full_name AS u_name, u.phone AS u_phone
     FROM support_tickets t JOIN users u ON u.id = t.user_id LEFT JOIN orders o ON o.id = t.order_id
     ${w} ORDER BY t.last_message_at ${arah}, t.id ${arah} LIMIT ? OFFSET ?`,
    [...args, f.limit, (f.page - 1) * f.limit],
  );
  const [[n]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM support_tickets t JOIN users u ON u.id = t.user_id ${w}`, args);
  // counts = angka di tab: seluruh tiket per status, tidak terpengaruh filter/pencarian/halaman (seperti unread_count notifikasi, D13)
  const [per] = await db.query<RowDataPacket[]>("SELECT status, COUNT(*) AS n FROM support_tickets GROUP BY status");
  const counts = { open: 0, answered: 0, closed: 0 };
  for (const r of per) counts[r.status as keyof typeof counts] = Number(r.n);
  return {
    data: rows.map((r) => ({ ...ringkas(r), customer: { id: r.u_id, full_name: r.u_name, phone: r.u_phone } })),
    meta: { page: f.page, limit: f.limit, total: Number(n.n), counts },
  };
}

// AdminTicketDetail: nama pengirim asli (admin/pembeli), data pembeli, dan pesanan terkait
export async function detailTiketAdmin(code: string) {
  const b = await bacaTiket(code, null);
  const { t } = b;
  return {
    ...detail(b, (m) => m.nama ?? (m.sender_role === "admin" ? NAMA_TIM : null)),
    customer: { id: t.u_id, full_name: t.u_name, phone: t.u_phone, email: t.u_email },
    order: t.order_code
      ? { code: t.order_code, status: t.o_status, total: t.o_total, merchant_name: t.o_merchant, created_at: t.o_created_at }
      : null,
  };
}

// Notifikasi in-app ke pembeli (tab Info); aplikasi membuka detail tiket dari data.ticket_code
async function kabari(conn: Conn, t: RowDataPacket, title: string, body: string) {
  await conn.query(
    "INSERT INTO notifications (user_id, type, title, body, data, created_at) VALUES (?, 'info', ?, ?, ?, UTC_TIMESTAMP())",
    [t.user_id, title.slice(0, 120), body.slice(0, 255), JSON.stringify({ ticket_code: t.code })],
  );
}

// balasan admin: tiket menunggu pembeli
export async function balasTiketAdmin(adminId: number, code: string, body: string) {
  await dalamTransaksi(async (conn) => {
    const t = await kunciTiket(conn, code);
    if (t.status === "closed") throw tiketDitutup();
    await conn.query("UPDATE support_tickets SET status = 'answered', last_message_at = UTC_TIMESTAMP() WHERE id = ?", [t.id]);
    const messageId = await tambahPesan(conn, t.id, "admin", adminId, body);
    await kabari(conn, t, `Balasan tiket ${t.code}`, `${NAMA_TIM} membalas "${t.subject}".`);
    await catat(conn, {
      adminId, action: "ticket.reply", targetType: "ticket", targetId: t.code,
      before: { status: t.status }, after: { status: "answered", message_id: messageId },
    });
  });
  return detailTiketAdmin(code);
}

// idempoten: tiket yang sudah ditutup (oleh siapa pun) tidak berubah, tanpa notifikasi dan audit
export async function tutupTiketAdmin(adminId: number, code: string) {
  await dalamTransaksi(async (conn) => {
    const t = await kunciTiket(conn, code);
    if (t.status === "closed") return;
    await conn.query("UPDATE support_tickets SET status = 'closed', closed_at = UTC_TIMESTAMP(), closed_by = 'admin' WHERE id = ?", [t.id]);
    await kabari(conn, t, `Tiket ${t.code} ditutup`, `Tiket "${t.subject}" ditutup oleh ${NAMA_TIM}.`);
    await catat(conn, {
      adminId, action: "ticket.close", targetType: "ticket", targetId: t.code, before: { status: t.status }, after: { status: "closed" },
    });
  });
  return detailTiketAdmin(code);
}
