// Isi file: urusan pesanan dari sisi penjual, yaitu daftar, detail, aksi status (terima, masak, siap, selesai,
// tolak), dan pesan WhatsApp ke pembeli. Alurnya routes/merchant.ts → handlers/merchant.handler.ts → file ini →
// database. Toko selalu diambil dari akun yang login; pesanan toko lain dijawab 404 seolah tidak ada.
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

// Kolom + tabel untuk pesanan versi penjual: ditambah data pembeli, meja, dan waktu tiap perubahan status. Titik temu
// dan meja memakai LEFT JOIN (tetap ikut walau kosong), karena pesanan meja tidak punya titik temu.
const MERCHANT_ORDER_SELECT = `${ORDER_COLUMNS}, o.customer_name, o.customer_phone, o.table_id, mt.label AS table_label,
  o.confirmed_at, o.cooking_at, o.ready_at, o.completed_at, o.cancelled_at
  FROM orders o LEFT JOIN pickup_points p ON p.id = o.pickup_point_id LEFT JOIN merchant_tables mt ON mt.id = o.table_id`;

/**
 * Menyusun respons pesanan versi penjual: bagian bersama dari mapOrderBase (tanpa data toko dan tanda tombol milik
 * pembeli), ditambah nama/nomor pembeli dan waktu tiap perubahan status. Pesanan meja: `pickup_point` null dan
 * `table` terisi.
 * @param order baris pesanan dari database (kolom MERCHANT_ORDER_SELECT)
 * @param items menu-menu pesanan ini
 * @returns objek pesanan untuk penjual
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
 * Daftar pesanan toko milik penjual yang login, dengan saringan status, tanggal dibuat (WIB), dan pencarian kode
 * pesanan atau nama pembeli. Bila `updated_since` diisi, saringan status diabaikan supaya semua perubahan terkirim.
 * Tanggal WIB diubah menjadi rentang waktu UTC agar database bisa memakai indeks kolom created_at (lebih cepat).
 * @param userId id penjual yang login
 * @param filter status, tanggal, kata cari, `updated_since`, halaman, dan jumlah per halaman
 * @returns `{ data, meta }` seperti paginateOrders; tiap pesanan berbentuk {@link mapMerchantOrder}
 * @throws 404 akun ini belum punya toko
 */
export async function listMerchantOrders(userId: number, filter: MerchantOrdersQuery) {
  // 1. Syarat dasar: hanya pesanan toko milik penjual ini.
  const where = ["o.merchant_id = ?"];
  const args: unknown[] = [await idToko(userId)];
  // 2. Bila updated_since diisi, saringan status diabaikan; kalau tidak, saring status yang diminta.
  if (filter.updated_since) {
    where.push("o.updated_at >= ?");
    args.push(new Date(filter.updated_since));
  } else if (filter.status.length) {
    where.push("o.status IN (?)");
    args.push(filter.status);
  }
  // 3. Tanggal WIB → rentang UTC 24 jam, dan pencarian kode pesanan atau nama pembeli.
  if (filter.date) {
    const dayStartMs = Date.parse(`${filter.date}T00:00:00+07:00`);
    where.push("o.created_at >= ? AND o.created_at < ?");
    args.push(new Date(dayStartMs), new Date(dayStartMs + 86400e3));
  }
  if (filter.q) {
    where.push("(LOWER(o.code) LIKE LOWER(?) OR LOWER(o.customer_name) LIKE LOWER(?))");
    args.push(likePattern(filter.q), likePattern(filter.q));
  }
  // 4. Ambil satu halaman.
  return paginateOrders(MERCHANT_ORDER_SELECT, where, args, filter, mapMerchantOrder);
}

/**
 * Detail satu pesanan milik toko penjual yang login. Pesanan toko lain dijawab 404.
 * @param userId id penjual yang login
 * @param code   kode pesanan
 * @returns pesanan berbentuk {@link mapMerchantOrder}
 * @throws 404 akun belum punya toko, atau pesanan tidak ditemukan di toko ini
 */
export async function getMerchantOrder(userId: number, code: string) {
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT ${MERCHANT_ORDER_SELECT} WHERE o.code = ? AND o.merchant_id = ?`,
    [code, await idToko(userId)],
  );
  if (!order) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  return mapMerchantOrder(order, (await loadOrderItems([order.id])).get(order.id) ?? []);
}

// Penjual tidak bisa menandai lunas sendiri: pembayaran non-tunai dilunasi oleh pemberitahuan dari Midtrans.
/** Aksi yang boleh dikirim penjual lewat `POST /merchant/orders/:code/:aksi`; aksi lain dijawab 404. */
export const MERCHANT_ACTIONS = ["confirm", "cook", "ready", "complete", "reject"] as const;
/** Satu aksi penjual dari {@link MERCHANT_ACTIONS}. */
export type MerchantAction = (typeof MERCHANT_ACTIONS)[number];

/**
 * Menjalankan aksi penjual pada pesanan tokonya lewat mesin status (order-status.service) di dalam transaksi
 * database (rangkaian perubahan yang disimpan semua atau dibatalkan semua), lalu mengirim detail pesanan terbaru.
 * Menolak pesanan wajib disertai alasan.
 * @param userId id penjual yang login
 * @param code   kode pesanan
 * @param action aksi penjual: terima, masak, siap, selesai, atau tolak
 * @param body   isi permintaan mentah; hanya `reason` untuk aksi tolak yang dibaca
 * @returns detail pesanan terbaru seperti {@link getMerchantOrder}
 * @throws 400 tolak tanpa alasan, 404 toko atau pesanan tidak ditemukan, 409 aksi tidak boleh untuk status pesanan
 *   saat ini
 */
export async function transitionMerchantOrder(userId: number, code: string, action: MerchantAction, body: unknown) {
  // Isi permintaan hanya berarti untuk aksi tolak; aksi lain mengabaikannya.
  const reason = action === "reject" ? parse(reasonSchema, bodyObject(body)).reason : null;
  if (action === "reject" && !reason) {
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { reason: ["Pilih alasan penolakan."] });
  }
  const merchantId = await idToko(userId);
  await dalamTransaksi((conn) => transitionOrder(conn, code, action, { kind: "merchant", userId, merchantId }, reason));
  return getMerchantOrder(userId, code);
}

/**
 * Templat pesan WhatsApp dari penjual ke pembeli, dipakai bila toko belum mengisi templat sendiri (`wa_template`).
 * Harus sama persis dengan TEMPLATE_BAWAAN di fe/lib/wa-template.ts (web); test merchant-orders-wa menjaganya.
 */
export const DEFAULT_WA_TEMPLATE = `Halo {nama}, pesanan {kode} sudah kami terima.

Menu: {menu}
Total: {total}
Cara bayar: {metode_bayar}
Ambil di: {titik_temu}
Waktu ambil: {waktu_ambil}

Terima kasih sudah memesan.`;

/**
 * Menyiapkan pesan WhatsApp dari penjual ke pembeli untuk satu pesanan tokonya, memakai templat toko (atau
 * {@link DEFAULT_WA_TEMPLATE} bila toko belum punya). Untuk pesanan meja, titik temu ditulis "Meja <nama meja>".
 * @param userId id penjual yang login
 * @param code   kode pesanan
 * @returns `wa_number` pembeli, `message` yang sudah diisi, dan `url` wa.me
 * @throws 404 toko atau pesanan tidak ditemukan; 409 pembeli (tamu meja) tidak mencantumkan nomor WhatsApp
 */
export async function getMerchantOrderWhatsapp(userId: number, code: string) {
  // 1. Ambil pesanan toko ini; titik temu pesanan meja ditulis "Meja <nama meja>".
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.code, o.customer_name, o.customer_phone, o.total, o.pickup_at, o.payment_method, o.note, m.business_name, m.wa_template,
       COALESCE(p.name, CONCAT('Meja ', mt.label)) AS titik_temu
     FROM orders o JOIN merchants m ON m.id = o.merchant_id LEFT JOIN pickup_points p ON p.id = o.pickup_point_id
       LEFT JOIN merchant_tables mt ON mt.id = o.table_id
     WHERE o.code = ? AND o.merchant_id = ?`,
    [code, await idToko(userId)],
  );
  if (!order) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  // 2. Tanpa nomor pembeli tidak ada tujuan pesan. Tamu meja boleh tidak mencantumkan nomor HP.
  if (!order.customer_phone) throw new AppError(409, "CONFLICT", "Pembeli tidak mencantumkan nomor WhatsApp.");
  // 3. Isi templat toko (atau templat bawaan) dengan data pesanan, lalu buat tautan wa.me.
  const items = (await loadOrderItems([order.id])).get(order.id) ?? [];
  const message = render(
    order.wa_template ?? DEFAULT_WA_TEMPLATE,
    buildWaValues({ ...(order as Parameters<typeof buildWaValues>[0]), items }),
  );
  return { wa_number: order.customer_phone, message, url: waLink(order.customer_phone, message) };
}
