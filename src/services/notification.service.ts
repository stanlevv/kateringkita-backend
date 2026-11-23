import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import db from "../config/db";
import type { Status } from "./order-status.service";
import type { ListNotificationsQuery, MarkAsReadInput } from "../dto/notification.dto";

// F08 (C-21; D8, D12): teks notifikasi pembeli per status tujuan; status tanpa entri tidak dinotifikasi
type OrderNotificationFields = { code: string; merchantName: string; reason: string | null };
export const ORDER_NOTIFICATION_TEMPLATE: Partial<
  Record<Status, (details: OrderNotificationFields) => { title: string; body: string }>
> = {
  confirmed: (details) => ({
    title: "Pesanan dikonfirmasi",
    body: `${details.merchantName} sudah mengonfirmasi pesanan ${details.code}.`,
  }),
  cooking: (details) => ({
    title: "Pesanan sedang dimasak",
    body: `${details.merchantName} sedang memasak pesanan ${details.code}.`,
  }),
  ready: (details) => ({
    title: "Pesanan siap diambil",
    body: `Pesanan ${details.code} sudah siap. Silakan ambil di titik temu.`,
  }),
  cancelled: (details) => ({
    title: "Pesanan ditolak",
    body: `${details.merchantName} menolak pesanan ${details.code}. Alasan: ${details.reason}`,
  }),
  expired: (details) => ({
    title: "Pesanan kedaluwarsa",
    body: `Pesanan ${details.code} di ${details.merchantName} dibatalkan otomatis karena tidak dikonfirmasi tepat waktu.`,
  }),
};

// Dipanggil di dalam transaksi transisi (D10), setelah users pembeli dikunci (D11)
export async function createOrderNotification(
  conn: Pick<PoolConnection, "query">,
  order: { customer_id: number | null; merchant_id: number; code: string },
  toStatus: Status,
  reason: string | null,
): Promise<void> {
  const template = ORDER_NOTIFICATION_TEMPLATE[toStatus];
  // F21: pesanan meja tanpa akun; tamu memantau status lewat halaman pesanannya
  if (!template || !order.customer_id) return;
  const [[merchant]] = await conn.query<RowDataPacket[]>("SELECT business_name FROM merchants WHERE id = ?", [
    order.merchant_id,
  ]);
  const { title, body } = template({ code: order.code, merchantName: merchant.business_name, reason });
  await conn.query(
    "INSERT INTO notifications (user_id, type, title, body, data, created_at) VALUES (?, 'order_status', ?, ?, ?, UTC_TIMESTAMP())",
    [order.customer_id, title, body.slice(0, 255), JSON.stringify({ order_code: order.code, status: toStatus })],
  );
}

const countUnread = async (userId: number) =>
  Number(
    (
      await db.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", [
        userId,
      ])
    )[0][0].n,
  );

// D13: total mengikuti filter (unread, type); unread_count selalu seluruh yang belum dibaca, tidak terpengaruh filter/halaman
// shortcut: notifikasi tidak pernah dihapus; tambah hapus yang sudah dibaca > 90 hari ke job harian bila tabel > 1 juta baris
// shortcut: filter type tanpa indeks sendiri (cukup user_id dari idx_notif_user); tambah indeks (user_id, type, created_at)
// bila notifikasi per pengguna > 10.000
export async function listNotifications(userId: number, query: ListNotificationsQuery) {
  const where = ["user_id = ?"];
  const args: unknown[] = [userId];
  if (query.unread === "true") where.push("read_at IS NULL");
  if (query.type) {
    where.push("type = ?");
    args.push(query.type);
  }
  const whereSql = where.join(" AND ");
  const [data] = await db.query<RowDataPacket[]>(
    `SELECT id, type, title, body, data, read_at, created_at FROM notifications WHERE ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, query.limit, (query.page - 1) * query.limit],
  );
  const [[totalRow]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM notifications WHERE ${whereSql}`,
    args,
  );
  return {
    data,
    meta: { page: query.page, limit: query.limit, total: Number(totalRow.n), unread_count: await countUnread(userId) },
  };
}

// D14: id milik orang lain/tak dikenal diabaikan; read_at lama tidak tertimpa
export async function markAsRead(userId: number, body: MarkAsReadInput): Promise<{ unread_count: number }> {
  await db.query(
    `UPDATE notifications SET read_at = UTC_TIMESTAMP() WHERE user_id = ? AND read_at IS NULL${body.ids ? " AND id IN (?)" : ""}`,
    [userId, ...(body.ids ? [body.ids] : [])],
  );
  return { unread_count: await countUnread(userId) };
}
