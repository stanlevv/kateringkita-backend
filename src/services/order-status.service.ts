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
  { kind: "customer"; userId: number } | { kind: "merchant"; userId: number; merchantId: number } | { kind: "system" };

type StockOutcome = "terjual" | "kembali" | "batal";
const releaseOutcome = (fromStatus: Status): StockOutcome => (fromStatus === "holding" ? "kembali" : "batal");

/**
 * Aturan tiap aksi: `oleh` = aktor yang boleh, `dari` = status asal yang sah, `ke` = status tujuan, `kolom` = kolom
 * waktu yang diisi, `stok` = nasib porsi yang ditahan (tanpa `stok` = stok tidak disentuh).
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
  // F10: lunas sekaligus diterima, agar pesanan lunas tidak pernah kedaluwarsa. F26: hanya notifikasi Midtrans (sistem), QRIS manual dihapus
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
  // confirmed hanya untuk tunai (dicek di transisi)
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
  const rule = TRANSITION_RULES[action];
  // Pembeli: kunci baris users dulu seperti checkout. INSERT log di bawah mengambil kunci bersama FK pada users pembeli;
  // tanpa ini, checkout pembeli yang sama (users X → orders holding miliknya) dan batal ini (orders X → users S) saling menunggu.
  if (actor.kind === "customer") await conn.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [actor.userId]);
  else {
    // F08 D11: penjual/sistem juga mengunci users pembeli dulu, karena INSERT notifikasi di bawah mengambil kunci FK pada users itu.
    // customer_id tidak pernah berubah, jadi baca tanpa kunci aman; kepemilikan dicek ulang di SELECT berkunci.
    const [[orderOwner]] = await conn.query<RowDataPacket[]>(
      `SELECT customer_id FROM orders WHERE code = ?${actor.kind === "merchant" ? " AND merchant_id = ?" : ""}`,
      [code, ...(actor.kind === "merchant" ? [actor.merchantId] : [])],
    );
    if (!orderOwner) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
    await conn.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [orderOwner.customer_id]);
  }
  const [[order]] = await conn.query<RowDataPacket[]>(
    `SELECT id, customer_id, merchant_id, status, payment_method, payment_status, total, promo_id, merchant_promo_id, platform_promo_id,
       hold_until <= UTC_TIMESTAMP() AS lewat FROM orders WHERE code = ?${
         actor.kind === "customer" ? " AND customer_id = ?" : actor.kind === "merchant" ? " AND merchant_id = ?" : ""
       } FOR UPDATE`,
    [code, ...(actor.kind === "customer" ? [actor.userId] : actor.kind === "merchant" ? [actor.merchantId] : [])],
  );
  if (!order) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  const fromStatus = order.status as Status;
  if (!rule.actors.includes(actor.kind) || !rule.from.includes(fromStatus)) throw conflict();
  if (action === "cancel" && fromStatus === "confirmed" && order.payment_method !== "cod") throw conflict();
  // D2: holding lewat waktu hanya bisa di-expire (job F08)
  if (fromStatus === "holding" && Boolean(order.lewat) !== (action === "expire"))
    throw conflict(action === "expire" ? undefined : "Batas waktu pesanan sudah habis.");
  if (action === "confirm" && order.payment_method !== "cod" && order.payment_status !== "paid")
    throw conflict("Pesanan belum dibayar.");
  // VA (F10) dan Snap (meja F21, pre-order F26) dilunasi notifikasi Midtrans
  if (action === "pay" && (!["va", "online"].includes(order.payment_method) || order.payment_status === "paid"))
    throw conflict("Pesanan ini tidak menunggu pembayaran online.");
  // tolak pesanan yang sudah lunas tidak mengubah payment_status: dana Midtrans dikembalikan admin lewat daftar refund (F26)

  const isCancel = rule.to === "cancelled" || rule.to === "expired";
  const cancelReason = action === "expire" ? "Tidak dikonfirmasi tepat waktu." : reason?.trim() || null;
  await conn.query(
    `UPDATE orders SET status = ?, ${rule.timestampColumn} = UTC_TIMESTAMP()${isCancel ? ", cancelled_by = ?, cancel_reason = ?" : ""}${
      action === "complete" ? ", payment_status = IF(payment_method = 'cod', 'paid', payment_status)" : ""
    }${action === "pay" ? ", payment_status = 'paid'" : ""} WHERE id = ?`,
    [rule.to, ...(isCancel ? [actor.kind, cancelReason] : []), order.id],
  );
  // pay: baris payments sudah ada sejak VA/halaman Snap dibuat, ditandai lunas oleh penerima notifikasi
  // F12: kuota promo kembali saat batal/kedaluwarsa; sebelum releaseStock (urutan kunci promos → menus, sama dengan checkout)
  // voucher toko + platform (pesanan baru) atau promo_id tunggal (pesanan sebelum migrasi 014); id naik = urutan kunci checkout
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
  const outcome = rule.stockOutcome?.(fromStatus);
  if (outcome) await releaseStock(conn, order.id, outcome);
  await conn.query(
    "INSERT INTO order_status_logs (order_id, from_status, to_status, actor_user_id) VALUES (?, ?, ?, ?)",
    [order.id, fromStatus, rule.to, actor.kind === "system" ? null : actor.userId],
  );
  if (actor.kind !== "customer")
    await buatNotifikasiPesanan(
      conn,
      { customer_id: order.customer_id, merchant_id: order.merchant_id, code },
      rule.to,
      cancelReason,
    );
  return { id: order.id, dari: fromStatus, ke: rule.to };
}
