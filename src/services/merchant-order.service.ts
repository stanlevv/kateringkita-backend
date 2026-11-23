// Layanan pesanan untuk penjual: daftar, detail, aksi status (terima, masak, siap, selesai, tolak), dan chat WhatsApp
// ke pembeli. Lapisan services dari routes/merchant.ts → handlers/merchant.handler.ts → di sini → database.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { dalamTransaksi } from "./admin-audit.service";
import { AppError } from "../utils/errors";
import { parse } from "../middleware/validate";
import { reasonSchema, bodyObject } from "../dto/order.dto";
import { transitionOrder } from "./order-status.service";
import {
  mapOrderBase,
  paginateOrders,
  Item,
  ORDER_COLUMNS,
  loadOrderItems,
  buildWaValues,
  likePattern,
  render,
  waLink,
} from "./order.service";
import { idToko } from "./merchant-menu.service";
import { MerchantOrdersQuery } from "../dto/merchant-order.dto";

// F07 pesanan toko (M-04, R-10, R-11). Toko selalu dari token; pesanan toko lain = 404 (D9).
// F21: pesanan meja tanpa titik temu → LEFT JOIN
const MERCHANT_ORDER_SELECT = `${ORDER_COLUMNS}, o.customer_name, o.customer_phone, o.table_id, mt.label AS table_label,
  o.confirmed_at, o.cooking_at, o.ready_at, o.completed_at, o.cancelled_at
  FROM orders o LEFT JOIN pickup_points p ON p.id = o.pickup_point_id LEFT JOIN merchant_tables mt ON mt.id = o.table_id`;

/**
 * Bentuk respons pesanan untuk penjual.
 * MerchantOrder §7 (D13): Order tanpa merchant/can_*, plus data pembeli & jejak waktu; pesanan meja: pickup_point null, table terisi.
 */
export const mapMerchantOrder = (order: RowDataPacket, items: Item[]) => ({
  ...mapOrderBase(order, items),
  pickup_point: order.pickup_point_id ? { id: order.pickup_point_id, name: order.p_name } : null,
  table: order.table_id ? { id: order.table_id, label: order.table_label } : null,
  customer_name: order.customer_name,
  customer_phone: order.customer_phone,
  confirmed_at: order.confirmed_at,
  cooking_at: order.cooking_at,
  ready_at: order.ready_at,
  completed_at: order.completed_at,
  cancelled_at: order.cancelled_at,
});

/**
 * Daftar pesanan toko milik penjual yang login, dengan filter status, tanggal dibuat (WIB), dan pencarian kode/nama pembeli.
 * D11, D12: updated_since mengabaikan status; date = tanggal WIB created_at → rentang UTC agar indeks terpakai.
 *
 * @returns `{ data, meta }` seperti paginateOrders, tiap baris berbentuk {@link mapMerchantOrder}
 * @throws AppError 404 NOT_FOUND bila akun belum punya toko
 */
export async function listMerchantOrders(userId: number, filter: MerchantOrdersQuery) {
  const where = ["o.merchant_id = ?"];
  const args: unknown[] = [await idToko(userId)];
  if (filter.updated_since) {
    where.push("o.updated_at >= ?");
    args.push(new Date(filter.updated_since));
  } else if (filter.status.length) {
    where.push("o.status IN (?)");
    args.push(filter.status);
  }
  if (filter.date) {
    const dayStartMs = Date.parse(`${filter.date}T00:00:00+07:00`);
    where.push("o.created_at >= ? AND o.created_at < ?");
    args.push(new Date(dayStartMs), new Date(dayStartMs + 86400e3));
  }
  if (filter.q) {
    where.push("(LOWER(o.code) LIKE LOWER(?) OR LOWER(o.customer_name) LIKE LOWER(?))");
    args.push(likePattern(filter.q), likePattern(filter.q));
  }
  return paginateOrders(MERCHANT_ORDER_SELECT, where, args, filter, mapMerchantOrder);
}

/**
 * Detail satu pesanan milik toko penjual (R-10: toko diambil dari token, pesanan toko lain = 404).
 *
 * @throws AppError 404 NOT_FOUND bila toko atau pesanan tidak ditemukan
 */
export async function getMerchantOrder(userId: number, code: string) {
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT ${MERCHANT_ORDER_SELECT} WHERE o.code = ? AND o.merchant_id = ?`,
    [code, await idToko(userId)],
  );
  if (!order) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  return mapMerchantOrder(order, (await loadOrderItems([order.id])).get(order.id) ?? []);
}

// F26: "pay" (verifikasi QRIS manual) dihapus; pembayaran non-tunai dilunasi notifikasi Midtrans
/** Aksi yang boleh dikirim penjual lewat `POST /merchant/orders/:code/:aksi`; aksi lain diteruskan ke 404. */
export const MERCHANT_ACTIONS = ["confirm", "cook", "ready", "complete", "reject"] as const;
/** Satu nilai dari {@link MERCHANT_ACTIONS}. */
export type MerchantAction = (typeof MERCHANT_ACTIONS)[number];

/**
 * Jalankan aksi penjual pada pesanan tokonya lewat mesin status, lalu kembalikan bentuk terkini.
 * M-04, M-08 (D1, D8): transisi dengan aktor penjual lalu bentuk terkini; tolak wajib beralasan.
 *
 * @param body body request mentah; hanya `reason` untuk aksi `reject` yang dibaca
 * @returns detail pesanan seperti {@link getMerchantOrder}
 * @throws AppError 400 VALIDATION_ERROR bila tolak tanpa alasan, 404 NOT_FOUND, 409 CONFLICT bila aksi tidak sah
 */
export async function transitionMerchantOrder(userId: number, code: string, action: MerchantAction, body: unknown) {
  // body hanya bermakna untuk tolak; aksi lain mengabaikannya
  const reason = action === "reject" ? parse(reasonSchema, bodyObject(body)).reason : null;
  if (action === "reject" && !reason) {
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { reason: ["Pilih alasan penolakan."] });
  }
  const merchantId = await idToko(userId);
  await dalamTransaksi((conn) => transitionOrder(conn, code, action, { kind: "merchant", userId, merchantId }, reason));
  return getMerchantOrder(userId, code);
}

/**
 * Templat WhatsApp penjual → pembeli bila toko belum mengisi `wa_template`.
 * D17: salinan persis fe/lib/wa-template.ts#TEMPLATE_BAWAAN (dijaga test merchant-orders-wa).
 */
export const DEFAULT_WA_TEMPLATE = `Halo {nama}, pesanan {kode} sudah kami terima.

Menu: {menu}
Total: {total}
Cara bayar: {metode_bayar}
Ambil di: {titik_temu}
Waktu ambil: {waktu_ambil}

Terima kasih sudah memesan.`;

/**
 * Pesan WhatsApp penjual ke pembeli untuk satu pesanan tokonya.
 * M-04, M-11 (D17): chat penjual → pembeli memakai templat toko (atau {@link DEFAULT_WA_TEMPLATE}).
 * Pesanan meja memakai "Meja <label>" sebagai titik temu.
 *
 * @returns `wa_number` pembeli, `message` yang sudah diisi, dan `url` wa.me
 * @throws AppError 404 NOT_FOUND; 409 CONFLICT bila pembeli (tamu meja) tidak mencantumkan nomor
 */
export async function getMerchantOrderWhatsapp(userId: number, code: string) {
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.code, o.customer_name, o.customer_phone, o.total, o.pickup_at, o.payment_method, o.note, m.business_name, m.wa_template,
       COALESCE(p.name, CONCAT('Meja ', mt.label)) AS titik_temu
     FROM orders o JOIN merchants m ON m.id = o.merchant_id LEFT JOIN pickup_points p ON p.id = o.pickup_point_id
       LEFT JOIN merchant_tables mt ON mt.id = o.table_id
     WHERE o.code = ? AND o.merchant_id = ?`,
    [code, await idToko(userId)],
  );
  if (!order) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  // F21: tamu meja boleh tidak mencantumkan nomor
  if (!order.customer_phone) throw new AppError(409, "CONFLICT", "Pembeli tidak mencantumkan nomor WhatsApp.");
  const items = (await loadOrderItems([order.id])).get(order.id) ?? [];
  const message = render(
    order.wa_template ?? DEFAULT_WA_TEMPLATE,
    buildWaValues({ ...(order as Parameters<typeof buildWaValues>[0]), items }),
  );
  return { wa_number: order.customer_phone, message, url: waLink(order.customer_phone, message) };
}
