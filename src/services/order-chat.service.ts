// Isi file: chat pembeli ↔ penjual untuk satu pesanan, dipakai untuk koordinasi titik temu dan pengambilan makanan.
// Alurnya routes/order.ts → handlers/order-chat.handler.ts → file ini → database (tabel order_messages,
// order_chat_reads, order_chat_reports). Setiap fungsi menerima `party`, yaitu pihak yang meminta (pembeli atau
// penjual), dan hanya melayani pesanan milik pihak itu. Chat hanya bisa dikirimi pesan saat pesanan sudah diterima
// toko dan belum selesai (status confirmed, cooking, ready); di luar itu riwayatnya tetap bisa dibaca.
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { Conn, withTransaction } from "./admin-audit.service";
import { SendMessageInput } from "../dto/order-chat.dto";

/** Peran pihak di dalam chat: pembeli (`customer`) atau penjual (`merchant`). */
export type ChatRole = "customer" | "merchant";
/**
 * Pihak yang meminta. Pembeli dikenali dari id akunnya; penjual dari id tokonya, ditambah id akun untuk dicatat
 * sebagai pengirim pesan.
 */
export type ChatParty = { role: "customer"; userId: number } | { role: "merchant"; merchantId: number; userId: number };
/** Pesanan yang chatnya sedang dibuka: id, status, dan pembelinya (null untuk pesanan tamu QR meja). */
export type ChatOrder = { orderId: number; status: string; customerId: number | null };
/** Satu pesan chat seperti yang dikirim ke aplikasi. */
export type ChatMessage = {
  id: number;
  sender_role: ChatRole;
  body: string | null;
  image_url: string | null;
  created_at: Date;
};
/** Keadaan chat dilihat dari pihak yang meminta. */
export type ChatState = {
  available: boolean;
  is_open: boolean;
  closed_reason: "not_started" | "finished" | "unavailable" | null;
  unread_count: number;
  other_party_last_read_id: number | null;
  reported_by_me: boolean;
};

// Status pesanan saat chat terbuka: sudah diterima toko dan belum selesai atau batal.
const OPEN_STATUSES = ["confirmed", "cooking", "ready"];
// Galat untuk setiap alasan chat tertutup, dipakai saat pesan dikirim.
const CLOSED_ERRORS: Record<NonNullable<ChatState["closed_reason"]>, () => AppError> = {
  not_started: () => new AppError(409, "CHAT_NOT_OPEN", "Chat terbuka setelah penjual menerima pesanan."),
  finished: () => new AppError(409, "CHAT_CLOSED", "Chat sudah ditutup karena pesanan selesai atau dibatalkan."),
  unavailable: () => new AppError(409, "CHAT_UNAVAILABLE", "Chat tidak tersedia untuk pesanan meja."),
};

const otherRole = (role: ChatRole): ChatRole => (role === "customer" ? "merchant" : "customer");
// Syarat SQL kepemilikan pesanan (alias tabel orders `o`): pembeli lewat customer_id, penjual lewat merchant_id.
const ownerCondition = (party: ChatParty): [string, number] =>
  party.role === "customer" ? ["o.customer_id = ?", party.userId] : ["o.merchant_id = ?", party.merchantId];

/**
 * Menentukan kenapa chat tertutup. Pesanan tamu QR meja tidak punya akun pembeli, jadi chatnya tidak tersedia.
 * Status `holding` berarti toko belum menerima pesanan; status akhir (`completed`, `cancelled`, `expired`) berarti
 * chat sudah ditutup.
 * @param status     status pesanan
 * @param customerId id pembeli, atau null untuk pesanan tamu QR meja
 * @returns alasan tertutup, atau null bila chat terbuka
 */
export const getClosedReason = (status: string, customerId: number | null): ChatState["closed_reason"] => {
  if (customerId === null) return "unavailable";
  if (OPEN_STATUSES.includes(status)) return null;
  return status === "holding" ? "not_started" : "finished";
};

/**
 * Kolom SQL untuk keadaan chat satu pesanan dilihat dari satu pihak, dipakai bersama alias tabel orders `o`:
 * `chat_unread` (pesan pihak lawan yang belum dibaca), `chat_other_read_id` (pesan terakhir yang sudah dibaca pihak
 * lawan), dan `chat_reported` (pihak ini sudah melaporkan chat). Peran ditulis langsung ke SQL; nilainya selalu salah
 * satu dari dua peran tetap, bukan masukan pengguna.
 * @param role peran pihak yang melihat
 * @returns potongan SQL berisi tiga kolom, untuk diletakkan di daftar kolom SELECT
 */
export const chatStateColumns = (role: ChatRole) => {
  const other = otherRole(role);
  return `(SELECT COUNT(*) FROM order_messages cm WHERE cm.order_id = o.id AND cm.sender_role = '${other}'
      AND cm.id > COALESCE((SELECT cr.last_read_message_id FROM order_chat_reads cr
        WHERE cr.order_id = o.id AND cr.reader_role = '${role}'), 0)) AS chat_unread,
    (SELECT cr.last_read_message_id FROM order_chat_reads cr
      WHERE cr.order_id = o.id AND cr.reader_role = '${other}') AS chat_other_read_id,
    EXISTS (SELECT 1 FROM order_chat_reports rp
      WHERE rp.order_id = o.id AND rp.reporter_role = '${role}') AS chat_reported`;
};

/**
 * Menyusun {@link ChatState} dari satu baris database.
 * @param row baris yang memuat `status`, `customer_id`, dan kolom {@link chatStateColumns}
 * @returns keadaan chat untuk dikirim ke aplikasi
 */
export const toChatState = (row: RowDataPacket): ChatState => {
  const closedReason = getClosedReason(row.status, row.customer_id ?? null);
  return {
    available: closedReason !== "unavailable",
    is_open: closedReason === null,
    closed_reason: closedReason,
    unread_count: Number(row.chat_unread),
    other_party_last_read_id: row.chat_other_read_id === null ? null : Number(row.chat_other_read_id),
    reported_by_me: Boolean(row.chat_reported),
  };
};

// Baris order_messages → bentuk JSON pesan.
const toChatMessage = (row: RowDataPacket): ChatMessage => ({
  id: Number(row.id),
  sender_role: row.sender_role,
  body: row.body,
  image_url: row.image_url,
  created_at: row.created_at,
});
const MESSAGE_COLUMNS = "id, sender_role, body, image_url, created_at";

/**
 * Mencari pesanan milik pihak yang meminta. Pesanan pihak lain dijawab 404, seolah tidak ada, supaya kode pesanan
 * orang lain tidak bisa diintip.
 * @param party    pihak yang meminta
 * @param code     kode pesanan
 * @param lockConn koneksi transaksi; bila diisi, baris pesanan dikunci (FOR UPDATE) sampai transaksi selesai,
 *                 supaya statusnya tidak berubah di tengah jalan
 * @returns id, status, dan id pembeli pesanan
 * @throws 404 pesanan tidak ada atau bukan milik pihak itu
 */
export async function loadChatOrder(party: ChatParty, code: string, lockConn?: Conn): Promise<ChatOrder> {
  const [condition, ownerId] = ownerCondition(party);
  const [[order]] = await (lockConn ?? db).query<RowDataPacket[]>(
    `SELECT o.id, o.status, o.customer_id FROM orders o
     WHERE o.code = ? AND ${condition}${lockConn ? " FOR UPDATE" : ""}`,
    [code, ownerId],
  );
  if (!order) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  return { orderId: order.id, status: order.status, customerId: order.customer_id };
}

/**
 * Keadaan chat satu pesanan dilihat dari pihak yang meminta.
 * @param party pihak yang meminta
 * @param order pesanan hasil {@link loadChatOrder}
 * @returns keadaan chat
 */
export async function getChatState(party: ChatParty, order: ChatOrder): Promise<ChatState> {
  const [[row]] = await db.query<RowDataPacket[]>(
    `SELECT ${chatStateColumns(party.role)} FROM orders o WHERE o.id = ?`,
    [order.orderId],
  );
  return toChatState({ ...row, status: order.status, customer_id: order.customerId } as RowDataPacket);
}

/**
 * Daftar pesan satu pesanan, urut id dari yang terlama, beserta keadaan chatnya. Riwayat tetap bisa dibaca setelah
 * chat ditutup.
 * @param party   pihak yang meminta
 * @param code    kode pesanan
 * @param afterId bila diisi, hanya pesan dengan id lebih besar (untuk cek berkala)
 * @returns `{ messages, chat }`
 * @throws 404 pesanan tidak ada atau bukan milik pihak itu
 */
export async function listMessages(
  party: ChatParty,
  code: string,
  afterId = 0,
): Promise<{ messages: ChatMessage[]; chat: ChatState }> {
  // 1. Pastikan pesanan milik pihak ini.
  const order = await loadChatOrder(party, code);
  // 2. Ambil pesan sesudah `afterId`, urut id, supaya cek berkala tidak mendapat pesan dobel atau terlewat.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MESSAGE_COLUMNS} FROM order_messages WHERE order_id = ? AND id > ? ORDER BY id`,
    [order.orderId, afterId],
  );
  // 3. Sertakan keadaan chat terbaru (terbuka/tertutup, belum dibaca, tanda dibaca pihak lawan).
  return { messages: rows.map(toChatMessage), chat: await getChatState(party, order) };
}

/**
 * Mengirim pesan ke chat pesanan. Baris pesanan dikunci selama pesan disimpan, sehingga pesan tidak bisa lolos tepat
 * saat pesanan diselesaikan atau dibatalkan.
 * @param party pihak pengirim
 * @param code  kode pesanan
 * @param input isi pesan (sudah lolos sendMessageSchema)
 * @returns pesan yang baru disimpan
 * @throws 404 pesanan tidak ada atau bukan milik pihak itu; 409 CHAT_NOT_OPEN (toko belum menerima pesanan),
 *         CHAT_CLOSED (pesanan selesai, batal, atau kadaluarsa), atau CHAT_UNAVAILABLE (pesanan tamu QR meja)
 */
export async function sendMessage(party: ChatParty, code: string, input: SendMessageInput): Promise<ChatMessage> {
  return withTransaction(async (conn) => {
    // 1. Kunci baris pembeli dulu, baru pesanan: urutan sama dengan transitionOrder, supaya kirim pesan dan perubahan
    //    status yang bersamaan tidak saling menunggu (deadlock). Penjual: customer_id tidak pernah berubah, jadi aman
    //    dibaca tanpa kunci; pesanan tamu tidak punya pembeli untuk dikunci.
    let customerId: number | null = party.userId;
    if (party.role === "merchant") {
      const [[owner]] = await conn.query<RowDataPacket[]>(
        "SELECT customer_id FROM orders WHERE code = ? AND merchant_id = ?",
        [code, party.merchantId],
      );
      customerId = owner?.customer_id ?? null;
    }
    if (customerId !== null) await conn.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [customerId]);
    // 2. Kunci pesanan lalu pastikan chat sedang terbuka.
    const order = await loadChatOrder(party, code, conn);
    const closedReason = getClosedReason(order.status, order.customerId);
    if (closedReason) throw CLOSED_ERRORS[closedReason]();
    // 3. Simpan pesan, lalu baca lagi supaya waktu kirimnya sama persis dengan yang tersimpan.
    const [result] = await conn.query<ResultSetHeader>(
      "INSERT INTO order_messages (order_id, sender_role, sender_user_id, body) VALUES (?, ?, ?, ?)",
      [order.orderId, party.role, party.userId, input.body],
    );
    const [[row]] = await conn.query<RowDataPacket[]>(`SELECT ${MESSAGE_COLUMNS} FROM order_messages WHERE id = ?`, [
      result.insertId,
    ]);
    return toChatMessage(row);
  });
}

/**
 * Menandai semua pesan chat pesanan sudah dibaca oleh pihak yang meminta. Penanda tidak pernah mundur, jadi
 * permintaan lama yang datang terlambat tidak membuat pesan kembali "belum dibaca". Boleh juga setelah chat ditutup.
 * @param party pihak yang membaca
 * @param code  kode pesanan
 * @returns selesai setelah penanda disimpan (tidak ada yang disimpan bila chat masih kosong)
 * @throws 404 pesanan tidak ada atau bukan milik pihak itu
 */
export async function markRead(party: ChatParty, code: string): Promise<void> {
  // 1. Cari pesan terakhir di chat ini.
  const order = await loadChatOrder(party, code);
  const [[latest]] = await db.query<RowDataPacket[]>("SELECT MAX(id) AS id FROM order_messages WHERE order_id = ?", [
    order.orderId,
  ]);
  if (latest.id === null) return;
  // 2. Simpan sebagai penanda baca pihak ini; bila sudah ada, ambil yang lebih besar.
  await db.query(
    `INSERT INTO order_chat_reads (order_id, reader_role, last_read_message_id, updated_at)
     VALUES (?, ?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE last_read_message_id = GREATEST(last_read_message_id, ?), updated_at = UTC_TIMESTAMP()`,
    [order.orderId, party.role, latest.id, latest.id],
  );
}

/**
 * Jumlah pesan penjual yang belum dibaca pembeli di semua pesanannya, untuk badge chat di aplikasi.
 * @param userId id pembeli yang login
 * @returns jumlah pesan belum dibaca
 */
export async function countCustomerUnread(userId: number): Promise<number> {
  const [[row]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM order_messages cm JOIN orders o ON o.id = cm.order_id
     LEFT JOIN order_chat_reads cr ON cr.order_id = o.id AND cr.reader_role = 'customer'
     WHERE o.customer_id = ? AND cm.sender_role = 'merchant' AND cm.id > COALESCE(cr.last_read_message_id, 0)`,
    [userId],
  );
  return Number(row.total);
}
