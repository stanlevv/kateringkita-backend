// Isi file: notifikasi in-app, yaitu pesan pendek yang tampil di menu Notifikasi aplikasi (bukan SMS atau email),
// disimpan di tabel `notifications`. File ini membuat notifikasi perubahan status pesanan, menampilkan daftar
// notifikasi, dan menandai notifikasi sudah dibaca. Alurnya routes/notification.ts → handlers/notification.handler.ts
// → file ini → database; order-status.service memanggil createOrderNotification saat penjual atau sistem mengubah
// status pesanan, dan order-chat.service memanggil createChatNotification saat pembeli atau penjual mengirim pesan
// chat. Notifikasi untuk pembeli (status pesanan dan balasan chat) juga dikirim sebagai push setelah transaksi tersimpan.
// Tanda sudah dibaca = kolom `read_at` berisi waktu notifikasi dibaca; NULL berarti belum dibaca.
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import db from "../config/db";
import { afterCommit } from "./admin-audit.service";
import { sendPushToUser } from "./push.service";
import type { Status } from "./order-status.service";
import type { ListNotificationsQuery, MarkAsReadInput } from "../dto/notification.dto";

// Isian templat notifikasi pesanan: kode pesanan, nama toko, dan alasan penolakan (null bila tidak ada).
type OrderNotificationFields = { code: string; merchantName: string; reason: string | null };
/**
 * Templat judul dan isi notifikasi untuk pembeli, satu per status tujuan pesanan. Status yang tidak ada di sini
 * (misalnya `holding` dan `completed`) tidak dikirimi notifikasi.
 */
export const ORDER_NOTIFICATION_TEMPLATES: Partial<
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

/**
 * Menyimpan notifikasi perubahan status pesanan untuk pembelinya. Dipanggil di dalam transaksi perubahan status
 * (order-status.service), setelah baris pembeli di tabel `users` dikunci, supaya notifikasi ikut batal bila
 * perubahan status batal. Isi notifikasi dipotong menjadi paling banyak 255 karakter. Setelah transaksi tersimpan,
 * notifikasi yang sama dikirim sebagai push ke perangkat pembeli (lewat afterCommit, tidak ditunggu).
 * @param conn     koneksi di dalam transaksi pemanggil
 * @param order    pesanan yang berubah: id pembeli (null untuk pesanan meja tanpa akun), id toko, dan kode pesanan
 * @param toStatus status tujuan pesanan
 * @param reason   alasan penolakan dari penjual, atau null
 * @returns tidak ada; tidak menyimpan apa pun bila status tujuan tidak punya templat atau pesanan tidak punya pembeli
 */
export async function createOrderNotification(
  conn: Pick<PoolConnection, "query">,
  order: { customer_id: number | null; merchant_id: number; code: string },
  toStatus: Status,
  reason: string | null,
): Promise<void> {
  // 1. Pilih templat untuk status tujuan. Pesanan meja dibuat tamu tanpa akun, jadi tidak ada penerima; tamu
  //    memantau status lewat halaman pesanannya.
  const template = ORDER_NOTIFICATION_TEMPLATES[toStatus];
  if (!template || !order.customer_id) return;
  // 2. Isi templat dengan nama toko, lalu simpan notifikasi bertipe `order_status` untuk pembeli.
  const [[merchant]] = await conn.query<RowDataPacket[]>("SELECT business_name FROM merchants WHERE id = ?", [
    order.merchant_id,
  ]);
  const { title, body } = template({ code: order.code, merchantName: merchant.business_name, reason });
  await conn.query(
    "INSERT INTO notifications (user_id, type, title, body, data, created_at) VALUES (?, 'order_status', ?, ?, ?, UTC_TIMESTAMP())",
    [order.customer_id, title, body.slice(0, 255), JSON.stringify({ order_code: order.code, status: toStatus })],
  );
  // 3. Push setelah commit; nilai disalin sekarang karena `conn` sudah dilepas saat tugas jalan.
  const customerId = order.customer_id;
  const data = { type: "order_status" as const, order_code: order.code };
  afterCommit(conn, () => sendPushToUser(customerId, { title, body, data }));
}

/**
 * Memberi tahu lawan bicara bahwa ada pesan baru di chat pesanan (notifikasi bertipe `chat_message`): penjual saat
 * pembeli mengirim pesan, pembeli saat penjual membalas. Selama notifikasi chat pesanan yang sama belum dibaca
 * penerimanya, notifikasi itu dimajukan waktunya, bukan ditambah baris baru, supaya daftar notifikasi tidak penuh satu
 * entri per pesan. Untuk pembeli, notifikasi baru (bukan yang dimajukan) juga dikirim sebagai push setelah transaksi
 * tersimpan, jadi satu rentetan balasan hanya memberi satu push sampai pembeli membuka chatnya. Dipanggil sendMessage
 * di dalam transaksi pesan, setelah pesanan dikunci, sehingga pesan-pesan pesanan yang sama tidak bisa membuat dua
 * notifikasi sekaligus.
 * @param conn      koneksi di dalam transaksi pemanggil
 * @param orderId   id pesanan yang menerima pesan
 * @param recipient penerima notifikasi: `merchant` (akun pemilik toko) atau `customer` (pembeli pesanan)
 * @returns tidak ada; satu notifikasi untuk penerima tersimpan atau diperbarui (tidak ada bila pesanan tanpa pembeli)
 */
export async function createChatNotification(
  conn: Pick<PoolConnection, "query">,
  orderId: number,
  recipient: "merchant" | "customer",
): Promise<void> {
  // 1. Kode pesanan diambil dari database (bukan dari URL) supaya penggabungan selalu memakai penulisan yang sama.
  const [[order]] = await conn.query<RowDataPacket[]>(
    "SELECT o.code, o.customer_id, m.user_id FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE o.id = ?",
    [orderId],
  );
  const toCustomer = recipient === "customer";
  // Pesanan meja tidak punya akun pembeli, jadi tidak ada penerima.
  const userId: number | null = toCustomer ? order.customer_id : order.user_id;
  if (userId === null) return;
  const title = toCustomer ? "Penjual membalas pesan" : "Pesan baru dari pembeli";
  const body = toCustomer
    ? `Penjual membalas pesan di pesanan ${order.code}.`
    : `Pembeli mengirim pesan di pesanan ${order.code}.`;
  // 2. Ada notifikasi chat pesanan ini yang belum dibaca → majukan waktunya saja.
  const [updated] = await conn.query<ResultSetHeader>(
    `UPDATE notifications SET body = ?, created_at = UTC_TIMESTAMP()
     WHERE user_id = ? AND type = 'chat_message' AND read_at IS NULL
       AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.order_code')) = ?`,
    [body, userId, order.code],
  );
  if (updated.affectedRows > 0) return;
  // 3. Belum ada (atau sudah dibaca semua) → sisipkan notifikasi baru; pembeli juga dikirimi push setelah commit.
  await conn.query(
    "INSERT INTO notifications (user_id, type, title, body, data, created_at) VALUES (?, 'chat_message', ?, ?, ?, UTC_TIMESTAMP())",
    [userId, title, body, JSON.stringify({ order_code: order.code })],
  );
  const data = { type: "chat_message" as const, order_code: String(order.code) };
  if (toCustomer) afterCommit(conn, () => sendPushToUser(userId, { title, body, data }));
}

// Jumlah semua notifikasi pengguna yang belum dibaca, tanpa filter apa pun (angka penanda di aplikasi).
const countUnread = async (userId: number) =>
  Number(
    (
      await db.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", [
        userId,
      ])
    )[0][0].n,
  );

// shortcut: notifikasi tidak pernah dihapus; tambah hapus yang sudah dibaca > 90 hari ke job harian bila tabel
// > 1 juta baris
// shortcut: filter type tanpa indeks sendiri (cukup user_id dari idx_notif_user); tambah indeks
// (user_id, type, created_at) bila notifikasi per pengguna > 10.000
/**
 * Menampilkan notifikasi milik pengguna yang login, terbaru dulu, per halaman. Semua peran boleh memanggil dan hanya
 * melihat notifikasinya sendiri; pengguna yang belum pernah dikirimi notifikasi mendapat daftar kosong.
 * @param userId id pengguna yang login
 * @param query  filter `unread` ("true" = hanya yang belum dibaca), `type` (tab Pesanan/Promo/Info), `page`, `limit`
 * @returns `data` = notifikasi di halaman itu; `meta.total` = jumlah yang cocok dengan filter;
 *   `meta.unread_count` = semua yang belum dibaca, tidak terpengaruh filter maupun halaman
 */
export async function listNotifications(userId: number, query: ListNotificationsQuery) {
  // 1. Susun syarat WHERE: selalu milik pengguna ini, ditambah filter yang diisi.
  const where = ["user_id = ?"];
  const args: unknown[] = [userId];
  if (query.unread === "true") where.push("read_at IS NULL");
  if (query.type) {
    where.push("type = ?");
    args.push(query.type);
  }
  // 2. Ambil satu halaman notifikasi dan hitung totalnya dengan syarat yang sama.
  const whereSql = where.join(" AND ");
  const [data] = await db.query<RowDataPacket[]>(
    `SELECT id, type, title, body, data, read_at, created_at FROM notifications WHERE ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, query.limit, (query.page - 1) * query.limit],
  );
  const [[totalRow]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM notifications WHERE ${whereSql}`,
    args,
  );
  // 3. Tambahkan jumlah belum dibaca keseluruhan untuk angka penanda di aplikasi.
  return {
    data,
    meta: { page: query.page, limit: query.limit, total: Number(totalRow.n), unread_count: await countUnread(userId) },
  };
}

/**
 * Menandai notifikasi sudah dibaca: sebagian (`ids`) atau semuanya (`all`). Id milik orang lain atau yang tidak
 * dikenal diabaikan tanpa galat, dan waktu baca notifikasi yang sudah dibaca tidak ditimpa.
 * @param userId id pengguna yang login
 * @param body   isi permintaan yang sudah lolos markAsReadSchema: `ids` atau `all: true`
 * @returns jumlah notifikasi yang masih belum dibaca setelah ditandai
 */
export async function markAsRead(userId: number, body: MarkAsReadInput): Promise<{ unread_count: number }> {
  await db.query(
    `UPDATE notifications SET read_at = UTC_TIMESTAMP() WHERE user_id = ? AND read_at IS NULL${body.ids ? " AND id IN (?)" : ""}`,
    [userId, ...(body.ids ? [body.ids] : [])],
  );
  return { unread_count: await countUnread(userId) };
}
