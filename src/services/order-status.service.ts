// Isi file: "mesin status" pesanan, yaitu tabel aturan perpindahan status (contoh: menunggu → diterima →
// dimasak → siap → selesai) dan satu fungsi yang menjalankannya. Lapisan services paling dalam: dipakai
// order.service (pembeli), merchant-order.service (penjual), va-payment.service (lunas), dan job kadaluarsa.
import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import { AppError } from "../utils/errors";
import { createOrderNotification } from "./notification.service";
import { releaseStock } from "./order-stock.service";

/** Status pesanan, sama dengan nilai kolom `orders.status`. */
export type Status = "holding" | "confirmed" | "cooking" | "ready" | "completed" | "cancelled" | "expired";
/**
 * Aksi yang mengubah status pesanan: terima (`confirm`), lunas (`pay`), masak (`cook`), siap (`ready`), selesai
 * (`complete`), tolak (`reject`), batal (`cancel`), dan kadaluarsa (`expire`). Aturan tiap aksi ada di
 * {@link TRANSITION_RULES}.
 */
export type OrderAction = "confirm" | "pay" | "cook" | "ready" | "complete" | "reject" | "cancel" | "expire";
/**
 * Pelaku perubahan status. Pembeli dan penjual membawa `userId` (dicatat di riwayat status); penjual juga membawa
 * `merchantId` supaya hanya bisa mengubah pesanan tokonya sendiri. `system` dipakai pemberitahuan pembayaran dari
 * Midtrans (penyedia pembayaran online) dan job kadaluarsa.
 */
export type Actor =
  { kind: "customer"; userId: number } | { kind: "merchant"; userId: number; merchantId: number } | { kind: "system" };

// Nasib porsi yang ditahan pesanan: "terjual" (jadi terjual), "kembali" (dilepas ke stok), "batal" (porsi yang sudah
// terjual dikembalikan ke stok).
type StockOutcome = "terjual" | "kembali" | "batal";
// Batal/tolak/kadaluarsa: pesanan yang masih menunggu melepas porsi tahanannya; pesanan yang sudah diterima toko
// mengembalikan porsi terjualnya.
const releaseOutcome = (fromStatus: Status): StockOutcome => (fromStatus === "holding" ? "kembali" : "batal");

/**
 * Aturan tiap aksi. `actors` = siapa yang boleh, `from` = status asal yang sah, `to` = status tujuan,
 * `timestampColumn` = kolom waktu yang diisi saat itu, `stockOutcome` = nasib porsi yang ditahan (bila tidak ada,
 * stok tidak disentuh).
 */
export const TRANSITION_RULES: Record<
  OrderAction,
  {
    actors: Actor["kind"][];
    from: Status[];
    to: Status;
    timestampColumn: string;
    stockOutcome?: (fromStatus: Status) => StockOutcome | null;
  }
> = {
  confirm: {
    actors: ["merchant"],
    from: ["holding"],
    to: "confirmed",
    timestampColumn: "confirmed_at",
    stockOutcome: () => "terjual",
  },
  // Lunas sekaligus dianggap diterima, supaya pesanan yang sudah dibayar tidak pernah kadaluarsa. Hanya bisa
  // dilakukan sistem saat pemberitahuan pembayaran dari Midtrans masuk.
  pay: {
    actors: ["system"],
    from: ["holding"],
    to: "confirmed",
    timestampColumn: "confirmed_at",
    stockOutcome: () => "terjual",
  },
  cook: { actors: ["merchant"], from: ["confirmed"], to: "cooking", timestampColumn: "cooking_at" },
  ready: { actors: ["merchant"], from: ["cooking"], to: "ready", timestampColumn: "ready_at" },
  complete: { actors: ["merchant", "customer"], from: ["ready"], to: "completed", timestampColumn: "completed_at" },
  reject: {
    actors: ["merchant"],
    from: ["holding", "confirmed"],
    to: "cancelled",
    timestampColumn: "cancelled_at",
    stockOutcome: releaseOutcome,
  },
  // Pembeli hanya boleh membatalkan pesanan yang sudah diterima toko bila bayar tunai (dicek di transitionOrder).
  cancel: {
    actors: ["customer"],
    from: ["holding", "confirmed"],
    to: "cancelled",
    timestampColumn: "cancelled_at",
    stockOutcome: releaseOutcome,
  },
  expire: {
    actors: ["system"],
    from: ["holding"],
    to: "expired",
    timestampColumn: "cancelled_at",
    stockOutcome: releaseOutcome,
  },
};

const conflict = (message = "Pesanan sudah berubah status.") => new AppError(409, "CONFLICT", message);

/**
 * Menjalankan satu aksi pada pesanan `code`: cek pelaku dan status asal, ubah status dan kolom waktunya, kembalikan
 * jatah voucher bila batal/kadaluarsa, perbarui stok (diterima/lunas: porsi tahanan menjadi terjual;
 * batal/tolak/kadaluarsa: porsi dilepas), catat riwayat status di `order_status_logs`, dan buat notifikasi di aplikasi
 * pembeli bila pelakunya bukan pembeli itu sendiri.
 *
 * Harus dipanggil di dalam transaksi database (rangkaian perubahan yang disimpan semua atau dibatalkan semua).
 * Baris dikunci dengan urutan yang sama seperti checkout: pembeli (users) → pesanan (orders) → menu (menus,
 * urut id).
 * Kalau dua transaksi mengunci dengan urutan berbeda, keduanya bisa saling menunggu selamanya (deadlock).
 *
 * Aturan tambahan di luar tabel: pembeli hanya boleh membatalkan pesanan yang sudah diterima bila bayar tunai;
 * pesanan menunggu yang sudah lewat batas waktu hanya bisa dikadaluarsakan; `confirm` untuk pesanan non-tunai harus
 * sudah lunas; `pay` hanya untuk pesanan Virtual Account/online yang belum lunas.
 *
 * @param conn   koneksi di dalam transaksi pemanggil
 * @param code   kode pesanan
 * @param action aksi yang diminta
 * @param actor  pelaku; pesanan dicari sesuai pemiliknya (pembeli: customer_id, penjual: merchant_id,
 *               sistem: semua pesanan)
 * @param reason alasan batal/tolak; untuk `expire` diisi otomatis "Tidak dikonfirmasi tepat waktu."
 * @returns id pesanan, status asal (`dari`), dan status tujuan (`ke`)
 * @throws 404 pesanan tidak ada atau bukan milik pelaku; 409 aksi tidak boleh untuk status pesanan saat ini
 */
export async function transitionOrder(
  conn: Pick<PoolConnection, "query">,
  code: string,
  action: OrderAction,
  actor: Actor,
  reason?: string | null,
): Promise<{ id: number; dari: Status; ke: Status }> {
  const rule = TRANSITION_RULES[action];
  // 1. Kunci baris pembeli lebih dulu (FOR UPDATE = baca sambil mengunci, transaksi lain harus menunggu). Menyimpan
  //    riwayat status dan notifikasi di bawah ikut mengunci baris pembeli karena berelasi ke tabel users; tanpa
  //    langkah ini, checkout dan pembatalan milik pembeli yang sama bisa saling menunggu.
  if (actor.kind === "customer") await conn.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [actor.userId]);
  else {
    // Penjual/sistem: cari dulu pemilik pesanan. customer_id tidak pernah berubah, jadi aman dibaca tanpa kunci;
    // kepemilikan dicek ulang di langkah 2.
    const [[orderOwner]] = await conn.query<RowDataPacket[]>(
      `SELECT customer_id FROM orders WHERE code = ?${actor.kind === "merchant" ? " AND merchant_id = ?" : ""}`,
      [code, ...(actor.kind === "merchant" ? [actor.merchantId] : [])],
    );
    if (!orderOwner) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
    await conn.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [orderOwner.customer_id]);
  }
  // 2. Ambil dan kunci pesanannya, dibatasi milik pelaku. `lewat` = batas waktu tahan sudah habis.
  const [[order]] = await conn.query<RowDataPacket[]>(
    `SELECT id, customer_id, merchant_id, status, payment_method, payment_status, total, promo_id, merchant_promo_id, platform_promo_id,
       hold_until <= UTC_TIMESTAMP() AS lewat FROM orders WHERE code = ?${
         actor.kind === "customer" ? " AND customer_id = ?" : actor.kind === "merchant" ? " AND merchant_id = ?" : ""
       } FOR UPDATE`,
    [code, ...(actor.kind === "customer" ? [actor.userId] : actor.kind === "merchant" ? [actor.merchantId] : [])],
  );
  if (!order) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  // 3. Cek aturan: tabel TRANSITION_RULES, lalu aturan tambahan.
  const fromStatus = order.status as Status;
  if (!rule.actors.includes(actor.kind) || !rule.from.includes(fromStatus)) throw conflict();
  if (action === "cancel" && fromStatus === "confirmed" && order.payment_method !== "cod") throw conflict();
  // Pesanan menunggu yang sudah lewat batas waktu hanya boleh dikadaluarsakan (oleh job kadaluarsa), dan aksi
  // kadaluarsa hanya boleh untuk pesanan yang sudah lewat batas waktu.
  if (fromStatus === "holding" && Boolean(order.lewat) !== (action === "expire"))
    throw conflict(action === "expire" ? undefined : "Batas waktu pesanan sudah habis.");
  if (action === "confirm" && order.payment_method !== "cod" && order.payment_status !== "paid")
    throw conflict("Pesanan belum dibayar.");
  // Virtual Account dan halaman bayar online (Snap) dilunasi lewat pemberitahuan dari Midtrans.
  if (action === "pay" && (!["va", "online"].includes(order.payment_method) || order.payment_status === "paid"))
    throw conflict("Pesanan ini tidak menunggu pembayaran online.");

  // 4. Ubah status, isi kolom waktunya, dan catat siapa serta mengapa bila batal. Pesanan tunai yang selesai
  //    sekalian ditandai lunas; aksi `pay` menandai lunas (baris pembayarannya ditandai oleh penerima pemberitahuan).
  //    Menolak pesanan yang sudah lunas tidak mengubah payment_status: uangnya dikembalikan admin lewat daftar
  //    refund.
  const isCancel = rule.to === "cancelled" || rule.to === "expired";
  const cancelReason = action === "expire" ? "Tidak dikonfirmasi tepat waktu." : reason?.trim() || null;
  await conn.query(
    `UPDATE orders SET status = ?, ${rule.timestampColumn} = UTC_TIMESTAMP()${isCancel ? ", cancelled_by = ?, cancel_reason = ?" : ""}${
      action === "complete" ? ", payment_status = IF(payment_method = 'cod', 'paid', payment_status)" : ""
    }${action === "pay" ? ", payment_status = 'paid'" : ""} WHERE id = ?`,
    [rule.to, ...(isCancel ? [actor.kind, cancelReason] : []), order.id],
  );
  // 5. Batal/kadaluarsa: kembalikan jatah voucher (voucher toko + platform, atau satu promo_id di pesanan lama) dan
  //    hapus catatan pemakaiannya. Dilakukan sebelum stok dan urut id, sama dengan urutan kunci saat checkout.
  const promoIds = [
    ...new Set(
      [order.promo_id, order.merchant_promo_id, order.platform_promo_id].filter(
        (promoId): promoId is number => promoId !== null,
      ),
    ),
  ].sort((left, right) => left - right);
  if (isCancel && promoIds.length) {
    for (const promoId of promoIds)
      await conn.query("UPDATE promos SET used_count = used_count - 1 WHERE id = ? AND used_count > 0", [promoId]);
    await conn.query("DELETE FROM promo_redemptions WHERE order_id = ?", [order.id]);
  }
  // 6. Perbarui stok sesuai aturan aksi.
  const outcome = rule.stockOutcome?.(fromStatus);
  if (outcome) await releaseStock(conn, order.id, outcome);
  // 7. Catat riwayat status, lalu beri tahu pembeli bila perubahan dilakukan penjual atau sistem.
  await conn.query(
    "INSERT INTO order_status_logs (order_id, from_status, to_status, actor_user_id) VALUES (?, ?, ?, ?)",
    [order.id, fromStatus, rule.to, actor.kind === "system" ? null : actor.userId],
  );
  if (actor.kind !== "customer")
    await createOrderNotification(
      conn,
      { customer_id: order.customer_id, merchant_id: order.merchant_id, code },
      rule.to,
      cancelReason,
    );
  return { id: order.id, dari: fromStatus, ke: rule.to };
}
