// Mesin status pesanan: tabel aturan transisi dan satu fungsi yang menjalankannya di dalam transaksi.
// Dipakai order.service (pembeli), merchant-order.service (penjual), pembayaran-va.service (lunas), dan job kadaluarsa.
import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import { AppError } from "../utils/errors";
import { buatNotifikasiPesanan } from "./notifikasi.service";
import { releaseStock } from "./order-stock.service";

// F07 mesin status pesanan (C-15, C-16, M-04, M-08, R-03; D1–D7). Dipakai rute pembeli, rute penjual, dan job kadaluarsa F08
// (D18: `expire` dengan aktor sistem, galat 409 ditelan). F08: notifikasi in-app pembeli (C-21) dibuat di transaksi yang sama.
/** Status pesanan, sama dengan nilai kolom `orders.status`. */
export type Status = "holding" | "confirmed" | "cooking" | "ready" | "completed" | "cancelled" | "expired";
/** Aksi yang mengubah status pesanan; aturan tiap aksi ada di {@link TRANSITION_RULES}. */
export type OrderAction = "confirm" | "pay" | "cook" | "ready" | "complete" | "reject" | "cancel" | "expire";
/**
 * Pelaku transisi. Pembeli dan penjual membawa `userId` (dicatat di log status); penjual juga `merchantId`
 * untuk membatasi pesanan ke tokonya. `system` dipakai notifikasi Midtrans dan job kadaluarsa.
 */
export type Actor =
  | { jenis: "customer"; userId: number }
  | { jenis: "merchant"; userId: number; merchantId: number }
  | { jenis: "system" };

type StockOutcome = "terjual" | "kembali" | "batal";
const releaseOutcome = (fromStatus: Status): StockOutcome => (fromStatus === "holding" ? "kembali" : "batal");

/**
 * Aturan tiap aksi: `oleh` = aktor yang boleh, `dari` = status asal yang sah, `ke` = status tujuan, `kolom` = kolom
 * waktu yang diisi, `stok` = nasib porsi yang ditahan (tanpa `stok` = stok tidak disentuh).
 */
export const TRANSITION_RULES: Record<
  OrderAction,
  {
    oleh: Actor["jenis"][];
    dari: Status[];
    ke: Status;
    kolom: string;
    stok?: (fromStatus: Status) => StockOutcome | null;
  }
> = {
  confirm: { oleh: ["merchant"], dari: ["holding"], ke: "confirmed", kolom: "confirmed_at", stok: () => "terjual" },
  // F10: lunas sekaligus diterima, agar pesanan lunas tidak pernah kedaluwarsa. F26: hanya notifikasi Midtrans (sistem), QRIS manual dihapus
  pay: { oleh: ["system"], dari: ["holding"], ke: "confirmed", kolom: "confirmed_at", stok: () => "terjual" },
  cook: { oleh: ["merchant"], dari: ["confirmed"], ke: "cooking", kolom: "cooking_at" },
  ready: { oleh: ["merchant"], dari: ["cooking"], ke: "ready", kolom: "ready_at" },
  complete: { oleh: ["merchant", "customer"], dari: ["ready"], ke: "completed", kolom: "completed_at" },
  reject: {
    oleh: ["merchant"],
    dari: ["holding", "confirmed"],
    ke: "cancelled",
    kolom: "cancelled_at",
    stok: releaseOutcome,
  },
  // confirmed hanya untuk tunai (dicek di transisi)
  cancel: {
    oleh: ["customer"],
    dari: ["holding", "confirmed"],
    ke: "cancelled",
    kolom: "cancelled_at",
    stok: releaseOutcome,
  },
  expire: { oleh: ["system"], dari: ["holding"], ke: "expired", kolom: "cancelled_at", stok: releaseOutcome },
};

const conflict = (message = "Pesanan sudah berubah status.") => new AppError(409, "CONFLICT", message);

/**
 * Jalankan satu aksi pada pesanan `code`: cek aktor dan status asal, ubah status dan kolom waktunya, kembalikan kuota
 * promo bila batal/kadaluarsa (F12), perbarui porsi stok lewat releaseStock (konfirmasi/lunas: tertahan → terjual;
 * batal/tolak/kadaluarsa: dilepas, D14), tulis `order_status_logs`, dan buat notifikasi in-app pembeli bila pelakunya
 * bukan pembeli (C-21).
 *
 * Dipanggil di dalam dalamTransaksi. Urutan kunci (D5, F08 D11) untuk semua aktor: users pembeli → orders (baris, lewat code unik)
 * → menus (releaseStock, urut id), sama dengan checkout F06 (users → orders → menus) sehingga tidak ada siklus.
 *
 * Aturan tambahan: pembeli hanya boleh membatalkan pesanan `confirmed` bila tunai; holding yang lewat waktu hanya bisa
 * di-`expire` (D2); `confirm` non-tunai harus sudah lunas; `pay` hanya untuk VA/online yang belum lunas.
 *
 * @param action aksi yang diminta
 * @param actor pelaku; pesanan dicari sesuai kepemilikan (pembeli: customer_id, penjual: merchant_id, sistem: semua)
 * @param reason alasan batal/tolak; untuk `expire` diisi otomatis "Tidak dikonfirmasi tepat waktu."
 * @returns id pesanan serta status asal (`dari`) dan tujuan (`ke`)
 * @throws AppError 404 NOT_FOUND bila pesanan tidak ada/bukan milik aktor; 409 CONFLICT bila aksi tidak sah untuk status itu
 */
export async function transitionOrder(
  conn: Pick<PoolConnection, "query">,
  code: string,
  action: OrderAction,
  actor: Actor,
  reason?: string | null,
): Promise<{ id: number; dari: Status; ke: Status }> {
  const a = TRANSITION_RULES[action];
  // Pembeli: kunci baris users dulu seperti checkout. INSERT log di bawah mengambil kunci bersama FK pada users pembeli;
  // tanpa ini, checkout pembeli yang sama (users X → orders holding miliknya) dan batal ini (orders X → users S) saling menunggu.
  if (actor.jenis === "customer") await conn.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [actor.userId]);
  else {
    // F08 D11: penjual/sistem juga mengunci users pembeli dulu, karena INSERT notifikasi di bawah mengambil kunci FK pada users itu.
    // customer_id tidak pernah berubah, jadi baca tanpa kunci aman; kepemilikan dicek ulang di SELECT berkunci.
    const [[p]] = await conn.query<RowDataPacket[]>(
      `SELECT customer_id FROM orders WHERE code = ?${actor.jenis === "merchant" ? " AND merchant_id = ?" : ""}`,
      [code, ...(actor.jenis === "merchant" ? [actor.merchantId] : [])],
    );
    if (!p) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
    await conn.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [p.customer_id]);
  }
  const [[o]] = await conn.query<RowDataPacket[]>(
    `SELECT id, customer_id, merchant_id, status, payment_method, payment_status, total, promo_id, merchant_promo_id, platform_promo_id,
       hold_until <= UTC_TIMESTAMP() AS lewat FROM orders WHERE code = ?${
         actor.jenis === "customer" ? " AND customer_id = ?" : actor.jenis === "merchant" ? " AND merchant_id = ?" : ""
       } FOR UPDATE`,
    [code, ...(actor.jenis === "customer" ? [actor.userId] : actor.jenis === "merchant" ? [actor.merchantId] : [])],
  );
  if (!o) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  const fromStatus = o.status as Status;
  if (!a.oleh.includes(actor.jenis) || !a.dari.includes(fromStatus)) throw conflict();
  if (action === "cancel" && fromStatus === "confirmed" && o.payment_method !== "cod") throw conflict();
  // D2: holding lewat waktu hanya bisa di-expire (job F08)
  if (fromStatus === "holding" && Boolean(o.lewat) !== (action === "expire"))
    throw conflict(action === "expire" ? undefined : "Batas waktu pesanan sudah habis.");
  if (action === "confirm" && o.payment_method !== "cod" && o.payment_status !== "paid")
    throw conflict("Pesanan belum dibayar.");
  // VA (F10) dan Snap (meja F21, pre-order F26) dilunasi notifikasi Midtrans
  if (action === "pay" && (!["va", "online"].includes(o.payment_method) || o.payment_status === "paid"))
    throw conflict("Pesanan ini tidak menunggu pembayaran online.");
  // tolak pesanan yang sudah lunas tidak mengubah payment_status: dana Midtrans dikembalikan admin lewat daftar refund (F26)

  const isCancel = a.ke === "cancelled" || a.ke === "expired";
  const cancelReason = action === "expire" ? "Tidak dikonfirmasi tepat waktu." : reason?.trim() || null;
  await conn.query(
    `UPDATE orders SET status = ?, ${a.kolom} = UTC_TIMESTAMP()${isCancel ? ", cancelled_by = ?, cancel_reason = ?" : ""}${
      action === "complete" ? ", payment_status = IF(payment_method = 'cod', 'paid', payment_status)" : ""
    }${action === "pay" ? ", payment_status = 'paid'" : ""} WHERE id = ?`,
    [a.ke, ...(isCancel ? [actor.jenis, cancelReason] : []), o.id],
  );
  // pay: baris payments sudah ada sejak VA/halaman Snap dibuat, ditandai lunas oleh penerima notifikasi
  // F12: kuota promo kembali saat batal/kedaluwarsa; sebelum releaseStock (urutan kunci promos → menus, sama dengan checkout)
  // voucher toko + platform (pesanan baru) atau promo_id tunggal (pesanan sebelum migrasi 014); id naik = urutan kunci checkout
  const promoIds = [
    ...new Set([o.promo_id, o.merchant_promo_id, o.platform_promo_id].filter((x): x is number => x !== null)),
  ].sort((a, b) => a - b);
  if (isCancel && promoIds.length) {
    for (const id of promoIds)
      await conn.query("UPDATE promos SET used_count = used_count - 1 WHERE id = ? AND used_count > 0", [id]);
    await conn.query("DELETE FROM promo_redemptions WHERE order_id = ?", [o.id]);
  }
  const outcome = a.stok?.(fromStatus);
  if (outcome) await releaseStock(conn, o.id, outcome);
  await conn.query(
    "INSERT INTO order_status_logs (order_id, from_status, to_status, actor_user_id) VALUES (?, ?, ?, ?)",
    [o.id, fromStatus, a.ke, actor.jenis === "system" ? null : actor.userId],
  );
  if (actor.jenis !== "customer")
    await buatNotifikasiPesanan(
      conn,
      { customer_id: o.customer_id, merchant_id: o.merchant_id, code },
      a.ke,
      cancelReason,
    );
  return { id: o.id, dari: fromStatus, ke: a.ke };
}
