// Isi file: chat pembeli ↔ penjual untuk satu pesanan, dipakai untuk koordinasi titik temu dan pengambilan makanan.
// Alurnya routes/order.ts dan routes/merchant.ts → handlers/order-chat.handler.ts → file ini → database (tabel
// order_messages, order_chat_reads, order_chat_reports). Setiap fungsi chat menerima `party`, yaitu pihak yang meminta
// (pembeli atau penjual), dan hanya melayani pesanan milik pihak itu. Chat hanya bisa dikirimi pesan dan foto saat
// pesanan sudah diterima toko dan belum selesai (status confirmed, cooking, ready); di luar itu riwayatnya tetap bisa
// dibaca. Admin hanya bisa membaca chat yang dilaporkan, lewat laporannya (listChatReports, getChatReport).
import { z } from "zod";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { Conn, withTransaction } from "./admin-audit.service";
import { createUpload, validateImageUrl } from "./upload.service";
import { ListChatReportsQuery, SendMessageInput } from "../dto/order-chat.dto";
import { uploadSchema } from "../dto/upload.dto";

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
// Folder unggah foto chat satu pesanan; dipakai saat membuat alamat unggah dan saat memeriksa URL foto pesan.
const chatPhotoFolder = (orderId: number) => `orders/${orderId}/chat/`;
// Menolak penulisan ke chat yang tertutup (kirim pesan, minta alamat unggah foto) dengan galat sesuai alasannya.
const assertChatOpen = (order: ChatOrder) => {
  const closedReason = getClosedReason(order.status, order.customerId);
  if (closedReason) throw CLOSED_ERRORS[closedReason]();
};

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
 * Kolom SQL `chat_unread`: jumlah pesan pihak lawan yang belum dibaca satu pihak, dipakai bersama alias tabel orders
 * `o`. Peran ditulis langsung ke SQL; nilainya selalu salah satu dari dua peran tetap, bukan masukan pengguna.
 * @param role peran pihak yang membaca
 * @returns potongan SQL satu kolom, untuk diletakkan di daftar kolom SELECT
 */
export const chatUnreadColumn = (role: ChatRole) =>
  `(SELECT COUNT(*) FROM order_messages cm WHERE cm.order_id = o.id AND cm.sender_role = '${otherRole(role)}'
      AND cm.id > COALESCE((SELECT cr.last_read_message_id FROM order_chat_reads cr
        WHERE cr.order_id = o.id AND cr.reader_role = '${role}'), 0)) AS chat_unread`;

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
  return `${chatUnreadColumn(role)},
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
  // 1. Pastikan pesanan milik pihak ini, lalu ambil pesan sesudah `afterId`.
  const order = await loadChatOrder(party, code);
  const messages = await loadMessages(order.orderId, afterId);
  // 2. Sertakan keadaan chat terbaru (terbuka/tertutup, belum dibaca, tanda dibaca pihak lawan).
  return { messages, chat: await getChatState(party, order) };
}

// Pesan satu pesanan dengan id lebih besar dari `afterId`, urut id, supaya cek berkala tidak mendapat pesan dobel atau
// terlewat. Dipakai pembeli, penjual, dan admin (lewat laporan); hak akses diperiksa pemanggil.
// shortcut: tanpa after_id seluruh riwayat dikirim sekaligus (chat satu pesanan biasanya puluhan pesan); beri paginasi bila chat mencapai ratusan pesan
async function loadMessages(orderId: number, afterId = 0): Promise<ChatMessage[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MESSAGE_COLUMNS} FROM order_messages WHERE order_id = ? AND id > ? ORDER BY id`,
    [orderId, afterId],
  );
  return rows.map(toChatMessage);
}

/**
 * Mengirim pesan teks dan/atau foto ke chat pesanan. Baris pesanan dikunci selama pesan disimpan, sehingga pesan tidak
 * bisa lolos tepat saat pesanan diselesaikan atau dibatalkan.
 * @param party pihak pengirim
 * @param code  kode pesanan
 * @param input isi pesan (sudah lolos sendMessageSchema)
 * @returns pesan yang baru disimpan
 * @throws 404 pesanan tidak ada atau bukan milik pihak itu; 409 CHAT_NOT_OPEN (toko belum menerima pesanan),
 *         CHAT_CLOSED (pesanan selesai, batal, atau kadaluarsa), atau CHAT_UNAVAILABLE (pesanan tamu QR meja);
 *         400 VALIDATION_ERROR di `image_url` bila foto bukan unggahan ke folder chat pesanan ini
 */
export async function sendMessage(party: ChatParty, code: string, input: SendMessageInput): Promise<ChatMessage> {
  return withTransaction(async (conn) => {
    // 1. Kunci pesanan lalu pastikan chat sedang terbuka.
    const order = await lockChatOrder(conn, party, code);
    assertChatOpen(order);
    // 2. Foto hanya boleh dari folder chat pesanan ini, bukan dari pesanan lain atau domain lain.
    validateImageUrl(input.image_url, null, chatPhotoFolder(order.orderId), "image_url");
    // 3. Simpan pesan, lalu baca lagi supaya waktu kirimnya sama persis dengan yang tersimpan.
    const [result] = await conn.query<ResultSetHeader>(
      "INSERT INTO order_messages (order_id, sender_role, sender_user_id, body, image_url) VALUES (?, ?, ?, ?, ?)",
      [order.orderId, party.role, party.userId, input.body ?? null, input.image_url ?? null],
    );
    const [[row]] = await conn.query<RowDataPacket[]>(`SELECT ${MESSAGE_COLUMNS} FROM order_messages WHERE id = ?`, [
      result.insertId,
    ]);
    return toChatMessage(row);
  });
}

// Mengunci pesanan di dalam transaksi sebelum chat ditulisi (kirim pesan, laporan). Baris pembeli dikunci dulu, baru
// pesanan: urutan sama dengan transitionOrder, supaya penulisan chat dan perubahan status yang bersamaan tidak saling
// menunggu (deadlock). Penjual: customer_id tidak pernah berubah, jadi aman dibaca tanpa kunci; pesanan tamu tidak
// punya pembeli untuk dikunci. Pesanan pihak lain dijawab 404 oleh loadChatOrder.
async function lockChatOrder(conn: Conn, party: ChatParty, code: string): Promise<ChatOrder> {
  // 1. Tentukan pembeli pesanan: pembeli = akun yang meminta; penjual = customer_id pesanan tokonya (null bila tamu).
  let customerId: number | null = party.userId;
  if (party.role === "merchant") {
    const [[owner]] = await conn.query<RowDataPacket[]>(
      "SELECT customer_id FROM orders WHERE code = ? AND merchant_id = ?",
      [code, party.merchantId],
    );
    customerId = owner?.customer_id ?? null;
  }
  // 2. Kunci baris pembeli lebih dulu.
  if (customerId !== null) await conn.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [customerId]);
  // 3. Baru kunci dan baca pesanannya (404 bila bukan milik pihak ini).
  return loadChatOrder(party, code, conn);
}

/**
 * Menandai pesan chat pesanan sudah dibaca oleh pihak yang meminta. Penanda tidak pernah mundur, jadi permintaan lama
 * yang datang terlambat tidak membuat pesan kembali "belum dibaca". Boleh juga setelah chat ditutup.
 * @param party  pihak yang membaca
 * @param code   kode pesanan
 * @param lastId id pesan terakhir yang tampil di layar. Bila diisi, penanda = yang lebih kecil antara `lastId` dan id
 *               pesan terakhir pihak lawan, supaya pesan lawan yang masuk sesudahnya tidak ikut "Dibaca". Bila tidak
 *               diisi, penanda = id pesan terakhir pihak lawan (semua pesannya dianggap sudah dibaca)
 * @returns selesai setelah penanda disimpan (tidak ada yang disimpan bila pihak lawan belum mengirim pesan)
 * @throws 404 pesanan tidak ada atau bukan milik pihak itu
 */
export async function markRead(party: ChatParty, code: string, lastId?: number): Promise<void> {
  // 1. Cari pesan terakhir pihak lawan, lalu tentukan penandanya.
  const order = await loadChatOrder(party, code);
  const [[latestRow]] = await db.query<RowDataPacket[]>(
    "SELECT MAX(id) AS id FROM order_messages WHERE order_id = ? AND sender_role = ?",
    [order.orderId, otherRole(party.role)],
  );
  if (latestRow.id === null) return;
  const latest = Number(latestRow.id);
  const readId = Math.min(lastId ?? latest, latest);
  // 2. Simpan sebagai penanda baca pihak ini; bila sudah ada, ambil yang lebih besar.
  await db.query(
    `INSERT INTO order_chat_reads (order_id, reader_role, last_read_message_id, updated_at)
     VALUES (?, ?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE last_read_message_id = GREATEST(last_read_message_id, ?), updated_at = UTC_TIMESTAMP()`,
    [order.orderId, party.role, readId, readId],
  );
}

/**
 * Pesanan yang punya pesan pihak lawan belum dibaca, untuk badge chat dan daftar chat masuk. `total` = jumlah semua
 * pesan belum dibaca (bukan jumlah chat), sama dengan total `unread_count` semua pesanan.
 * @param party pihak yang membaca
 * @returns `{ total, orders }`; tiap pesanan berisi `code`, `unread_count`, dan `last_message_at` (waktu pesan belum
 *          dibaca yang terakhir), urut dari yang terbaru
 */
export async function listUnreadChats(party: ChatParty) {
  // shortcut: jumlah pesanan tidak dibatasi dan biaya kueri ikut membesar bersama riwayat pesan toko/pembeli, padahal
  // fungsi ini dipanggil tiap sinkron 5 detik dan tiap pindah halaman; biasanya hanya pesanan aktif yang punya pesan
  // belum dibaca. Batasi ke pesanan aktif atau beri LIMIT bila riwayatnya membesar dan kueri mulai lambat.
  // 1. Hitung pesan pihak lawan sesudah penanda baca pihak ini, per pesanan.
  const [condition, ownerId] = ownerCondition(party);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT o.code, COUNT(*) AS unread_count, MAX(cm.created_at) AS last_message_at
     FROM order_messages cm JOIN orders o ON o.id = cm.order_id
     LEFT JOIN order_chat_reads cr ON cr.order_id = o.id AND cr.reader_role = ?
     WHERE ${condition} AND cm.sender_role = ? AND cm.id > COALESCE(cr.last_read_message_id, 0)
     GROUP BY o.id, o.code ORDER BY last_message_at DESC, o.id DESC`,
    [party.role, ownerId, otherRole(party.role)],
  );
  // 2. Susun daftar dan jumlahkan.
  const orders = rows.map((row) => ({
    code: row.code as string,
    unread_count: Number(row.unread_count),
    last_message_at: row.last_message_at as Date,
  }));
  return { total: orders.reduce((sum, order) => sum + order.unread_count, 0), orders };
}

/**
 * Pesanan toko yang chatnya belum dibalas: chat masih terbuka (status confirmed, cooking, ready) dan pesan terakhirnya
 * dari pembeli. Pesanan tetap di daftar walau penjual sudah membaca pesannya; baru keluar setelah penjual membalas.
 * @param merchantId id toko penjual
 * @returns `{ total, orders }`; `total` = jumlah pesanan, tiap pesanan berisi `code`, `status`, `last_message_at`
 *          (waktu pesan pembeli yang belum dibalas), dan `unread_count` (pesan pembeli yang belum dibaca), urut dari
 *          yang paling lama menunggu
 */
export async function listUnrepliedChats(merchantId: number) {
  // 1. Cari id pesan terakhir tiap pesanan toko yang chatnya terbuka, lalu ambil yang pengirimnya pembeli.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT o.code, o.status, lm.created_at AS last_message_at, ${chatUnreadColumn("merchant")}
     FROM orders o
     JOIN (SELECT m.order_id, MAX(m.id) AS last_id
           FROM order_messages m JOIN orders oo ON oo.id = m.order_id
           WHERE oo.merchant_id = ? AND oo.status IN (?)
           GROUP BY m.order_id) latest ON latest.order_id = o.id
     JOIN order_messages lm ON lm.id = latest.last_id
     WHERE lm.sender_role = 'customer'
     ORDER BY lm.id ASC`,
    [merchantId, OPEN_STATUSES],
  );
  // 2. Susun daftarnya; total = jumlah pesanan yang menunggu balasan.
  const orders = rows.map((row) => ({
    code: row.code as string,
    status: row.status as string,
    last_message_at: row.last_message_at as Date,
    unread_count: Number(row.chat_unread),
  }));
  return { total: orders.length, orders };
}

/**
 * Membuat alamat unggah foto chat di folder `orders/<id pesanan>/chat/`. Hanya boleh selama chat terbuka.
 * @param party pihak yang mengunggah
 * @param code  kode pesanan
 * @param input tipe dan ukuran foto (sudah lolos uploadSchema)
 * @returns hasil createUpload: `upload_url`, `public_url`, dan `expires_at`
 * @throws 404 pesanan tidak ada atau bukan milik pihak itu; 409 CHAT_NOT_OPEN, CHAT_CLOSED, atau CHAT_UNAVAILABLE;
 *         503 pengaturan R2 belum diisi
 */
export async function requestChatUpload(party: ChatParty, code: string, input: z.infer<typeof uploadSchema>) {
  const order = await loadChatOrder(party, code);
  assertChatOpen(order);
  return createUpload(chatPhotoFolder(order.orderId), input);
}

/**
 * Melaporkan chat pesanan ke admin. Setiap pihak hanya bisa melapor sekali per pesanan; laporan tetap boleh setelah
 * chat ditutup.
 * @param party  pihak pelapor
 * @param code   kode pesanan
 * @param reason alasan laporan (sudah lolos reportChatSchema)
 * @returns laporan yang baru disimpan: `id`, `reporter_role`, `reason`, dan `created_at`
 * @throws 404 pesanan tidak ada atau bukan milik pihak itu; 409 CHAT_UNAVAILABLE (pesanan tamu QR meja) atau
 *         ALREADY_REPORTED (pihak ini sudah melaporkan chat ini)
 */
export async function reportChat(party: ChatParty, code: string, reason: string) {
  return withTransaction(async (conn) => {
    // 1. Kunci pesanan; pesanan tamu QR meja tidak punya chat untuk dilaporkan.
    const order = await lockChatOrder(conn, party, code);
    if (order.customerId === null) throw CLOSED_ERRORS.unavailable();
    // 2. Simpan laporan. Indeks unik (pesanan, pihak) menolak laporan kedua dari pihak yang sama.
    let reportId: number;
    try {
      const [result] = await conn.query<ResultSetHeader>(
        "INSERT INTO order_chat_reports (order_id, reporter_role, reporter_user_id, reason) VALUES (?, ?, ?, ?)",
        [order.orderId, party.role, party.userId, reason],
      );
      reportId = result.insertId;
    } catch (error) {
      if ((error as { code?: string })?.code === "ER_DUP_ENTRY")
        throw new AppError(409, "ALREADY_REPORTED", "Chat ini sudah kamu laporkan.");
      throw error;
    }
    // 3. Baca lagi supaya waktu laporan sama persis dengan yang tersimpan.
    const [[row]] = await conn.query<RowDataPacket[]>(
      "SELECT id, reporter_role, reason, created_at FROM order_chat_reports WHERE id = ?",
      [reportId],
    );
    return { id: row.id, reporter_role: row.reporter_role as ChatRole, reason: row.reason, created_at: row.created_at };
  });
}

// Kolom laporan untuk admin (alias rp = order_chat_reports, o = orders, u = akun pelapor).
const REPORT_SELECT = `SELECT rp.id, rp.order_id, o.code AS order_code, rp.reporter_role, u.full_name AS reporter_name,
    rp.reason, rp.created_at
  FROM order_chat_reports rp JOIN orders o ON o.id = rp.order_id LEFT JOIN users u ON u.id = rp.reporter_user_id`;
// Baris REPORT_SELECT → bentuk JSON laporan.
const toChatReport = (row: RowDataPacket) => ({
  id: row.id as number,
  order_code: row.order_code as string,
  reporter_role: row.reporter_role as ChatRole,
  reporter_name: (row.reporter_name ?? null) as string | null,
  reason: row.reason as string,
  created_at: row.created_at as Date,
});

/**
 * Daftar laporan chat untuk admin, terbaru dulu.
 * @param filter halaman dan jumlah per halaman
 * @returns `{ data, meta: { page, limit, total } }`; tiap laporan berisi `id`, `order_code`, `reporter_role`,
 *          `reporter_name` (null bila akun pelapor dihapus), `reason`, dan `created_at`
 */
export async function listChatReports(filter: ListChatReportsQuery) {
  const [rows] = await db.query<RowDataPacket[]>(
    `${REPORT_SELECT} ORDER BY rp.created_at DESC, rp.id DESC LIMIT ? OFFSET ?`,
    [filter.limit, (filter.page - 1) * filter.limit],
  );
  const [[countRow]] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM order_chat_reports");
  return { data: rows.map(toChatReport), meta: { page: filter.page, limit: filter.limit, total: Number(countRow.n) } };
}

/**
 * Satu laporan chat beserta seluruh pesan pesanan itu, urut id. Ini satu-satunya jalan admin membaca isi chat, jadi
 * chat yang tidak dilaporkan tidak bisa dibaca admin.
 * @param reportId id laporan dari path (NaN bila path bukan angka desimal)
 * @returns laporan seperti di {@link listChatReports}, ditambah `messages`
 * @throws 404 id tidak valid atau laporan tidak ada
 */
export async function getChatReport(reportId: number) {
  // 1. Cari laporannya; id yang bukan bilangan bulat positif pasti tidak ada.
  const notFound = () => new AppError(404, "NOT_FOUND", "Laporan tidak ditemukan.");
  if (!Number.isSafeInteger(reportId) || reportId < 1) throw notFound();
  const [[row]] = await db.query<RowDataPacket[]>(`${REPORT_SELECT} WHERE rp.id = ?`, [reportId]);
  if (!row) throw notFound();
  // 2. Sertakan seluruh riwayat chat pesanan itu.
  return { ...toChatReport(row), messages: await loadMessages(row.order_id) };
}
