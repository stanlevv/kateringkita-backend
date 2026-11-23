// Layanan fitur pesan dari meja (F21): penjual mengelola meja + QR, tamu memesan tanpa login lalu membayar lewat Snap.
// Lapisan services dari routes/table.ts dan routes/merchant.ts → handlers/table.handler.ts → di sini → database.
import { createHash, randomBytes } from "node:crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { TableOrderInput, UpdateTableInput } from "../dto/table.dto";
import { dalamTransaksi } from "./admin-audit.service";
import { asalSah, bukaSnap, KOLOM_SNAP, URL_BAYAR } from "./pembayaran-va.service";
import { DARI, jam, JOIN_FAVORIT, kartu, KOLOM_KARTU, TAMPIL, tokoBuka, TOKO_TAMPIL } from "./katalog.service";
import { hariIniWib } from "./merchant-kuota.service";
import { idToko } from "./merchant-menu.service";
import { loadCart, validateCart } from "./order-cart.service";
import {
  outOfStockError,
  MAX_TABLE_PORTIONS,
  loadOrderItems,
  getHeldPortions,
  insertOrder,
  holdStockAndInsertItems,
  totalPortions,
} from "./order.service";

// F21 pesan dari meja: QR meja → menu tanpa login → pesanan tamu → bayar lewat Snap → status lewat token tamu.
// Token tamu hanya dipegang peramban tamu; DB menyimpan SHA-256-nya.

const MAX_TABLES = 100;
// shortcut: batas pesanan menunggu per meja menahan stok dari pesanan iseng; naikkan bila satu meja dipakai rombongan besar
const MAX_HOLDING_ORDERS = 5;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const conflict = (message: string) => new AppError(409, "CONFLICT", message);
const tableNotFound = () => new AppError(404, "NOT_FOUND", "Meja tidak ditemukan atau tidak aktif.");
const orderNotFound = () => new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
const hhmm = (t: unknown) => String(t).slice(0, 5);

// ---------- penjual ----------
const mapTable = (r: RowDataPacket) => ({ id: r.id, label: r.label, token: r.token, is_active: Boolean(r.is_active) });
const isLabelTaken = (e: unknown) => (e as { code?: string }).code === "ER_DUP_ENTRY";
const labelTakenError = () =>
  new AppError(409, "CONFLICT", "Nama meja sudah dipakai.", { label: ["Nama meja sudah dipakai."] });

/**
 * Daftar meja toko milik penjual yang login, urut panjang nama lalu nama (Meja 2 sebelum Meja 10).
 *
 * @returns `{ id, label, token, is_active }` per meja; token = isi QR meja
 * @throws AppError 404 NOT_FOUND bila akun belum punya toko
 */
export async function listTables(userId: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, label, token, is_active FROM merchant_tables WHERE merchant_id = ? ORDER BY LENGTH(label), label",
    [await idToko(userId)],
  );
  return rows.map(mapTable);
}

async function getTable(merchantId: number, id: number) {
  const [[r]] = await db.query<RowDataPacket[]>(
    "SELECT id, label, token, is_active FROM merchant_tables WHERE id = ? AND merchant_id = ?",
    [id, merchantId],
  );
  if (!r) throw new AppError(404, "NOT_FOUND", "Meja tidak ditemukan.");
  return mapTable(r);
}

/**
 * Buat meja baru dengan token QR acak 32 heksa. Maks {@link MAX_TABLES} meja per toko.
 *
 * @returns meja yang baru dibuat
 * @throws AppError 409 CONFLICT bila batas meja tercapai atau nama meja sudah dipakai (galat di field `label`)
 */
export async function createTable(userId: number, label: string) {
  const merchantId = await idToko(userId);
  const [[n]] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM merchant_tables WHERE merchant_id = ?", [
    merchantId,
  ]);
  if (Number(n.n) >= MAX_TABLES) throw conflict(`Maksimal ${MAX_TABLES} meja per toko.`);
  try {
    const [r] = await db.query<ResultSetHeader>(
      "INSERT INTO merchant_tables (merchant_id, label, token) VALUES (?, ?, ?)",
      [merchantId, label, randomBytes(16).toString("hex")],
    );
    return getTable(merchantId, r.insertId);
  } catch (e) {
    if (isLabelTaken(e)) throw labelTakenError();
    throw e;
  }
}

/**
 * Ubah nama/status meja milik toko penjual; `ganti_token` membuat token QR baru sehingga QR lama tidak berlaku.
 *
 * @param idRaw id dari URL (belum divalidasi); bukan bilangan bulat ≥ 1 → 404
 * @returns meja setelah diubah
 * @throws AppError 404 NOT_FOUND bila meja bukan milik toko, 409 CONFLICT bila nama meja sudah dipakai
 */
export async function updateTable(userId: number, idRaw: unknown, input: UpdateTableInput) {
  const merchantId = await idToko(userId);
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id < 1) throw new AppError(404, "NOT_FOUND", "Meja tidak ditemukan.");
  await getTable(merchantId, id);
  const sets: string[] = [];
  const args: unknown[] = [];
  if (input.label !== undefined) (sets.push("label = ?"), args.push(input.label));
  if (input.is_active !== undefined) (sets.push("is_active = ?"), args.push(input.is_active));
  if (input.ganti_token) (sets.push("token = ?"), args.push(randomBytes(16).toString("hex")));
  try {
    await db.query(`UPDATE merchant_tables SET ${sets.join(", ")} WHERE id = ? AND merchant_id = ?`, [
      ...args,
      id,
      merchantId,
    ]);
  } catch (e) {
    if (isLabelTaken(e)) throw labelTakenError();
    throw e;
  }
  return getTable(merchantId, id);
}

// ---------- publik (tamu) ----------
// Meja aktif + dine-in toko menyala + toko tampil. Token bukan heksa 32 → 404 tanpa kueri.
async function getActiveTable(token: string) {
  if (!/^[0-9a-f]{32}$/.test(token)) throw tableNotFound();
  const [[t]] = await db.query<RowDataPacket[]>(
    `SELECT t.id, t.label, m.id AS merchant_id, m.slug, m.business_name, m.description, m.logo_url, m.is_open, m.open_time, m.close_time
     FROM merchant_tables t JOIN merchants m ON m.id = t.merchant_id JOIN users u ON u.id = m.user_id
     WHERE t.token = ? AND t.is_active AND m.dine_in_enabled AND ${TOKO_TAMPIL}`,
    [token],
  );
  if (!t) throw tableNotFound();
  return t;
}

/**
 * Data halaman menu meja untuk tamu: label meja, profil toko (termasuk buka/tutup saat ini), dan menu tampil.
 * Menu toko untuk meja: kartu katalog + deskripsi + opsi aktif; menu pre-order tidak dijual di meja.
 *
 * @param token token QR meja
 * @throws AppError 404 NOT_FOUND bila token salah, meja nonaktif, dine-in toko mati, atau toko tidak tampil
 */
export async function getTableMenu(token: string) {
  const t = await getActiveTable(token);
  const ms = jam.sekarang();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM_KARTU}, x.description, x.min_order_qty FROM ${DARI} ${JOIN_FAVORIT}
     WHERE ${TAMPIL} AND m.id = ? AND NOT x.is_preorder
     ORDER BY c.sort_order, c.name, x.sold_total DESC, x.id`,
    [hariIniWib(new Date(ms)), null, t.merchant_id],
  );
  const optionsByMenu = new Map<number, { id: number; name: string; extra_price: number }[]>();
  if (rows.length) {
    const [o] = await db.query<RowDataPacket[]>(
      "SELECT id, menu_id, name, extra_price FROM menu_options WHERE menu_id IN (?) AND is_active ORDER BY id",
      [rows.map((r) => r.id)],
    );
    for (const r of o)
      optionsByMenu.set(r.menu_id, [
        ...(optionsByMenu.get(r.menu_id) ?? []),
        { id: r.id, name: r.name, extra_price: r.extra_price },
      ]);
  }
  return {
    table: { label: t.label },
    merchant: {
      slug: t.slug,
      business_name: t.business_name,
      description: t.description,
      logo_url: t.logo_url,
      is_open: tokoBuka(t, ms),
      open_time: hhmm(t.open_time),
      close_time: hhmm(t.close_time),
    },
    menus: rows.map((r) => ({
      ...kartu(r, ms),
      description: r.description,
      min_order_qty: r.min_order_qty,
      options: optionsByMenu.get(r.id) ?? [],
    })),
  };
}

/**
 * Buat pesanan tamu dari QR meja: status `holding`, metode `online`, tanpa pembeli terdaftar.
 * Pesanan tamu: validasi & penahanan stok sama dengan checkout (F06) tanpa titik temu & promo; bayar online (Snap) menyusul.
 * Batas per meja: maks {@link MAX_HOLDING_ORDERS} pesanan menunggu dan maks MAX_TABLE_PORTIONS porsi tertahan (AUD-32).
 * Token tamu acak dibuat di sini; DB hanya menyimpan hash SHA-256-nya.
 *
 * @returns `guest_token` (hanya dikirim sekali, disimpan peramban tamu) dan status pesanan seperti {@link getGuestOrder}
 * @throws AppError 404 NOT_FOUND (meja), 400 VALIDATION_ERROR, 409 CONFLICT (batas meja), 409 OUT_OF_STOCK,
 *   409 MERCHANT_UNAVAILABLE / MERCHANT_CLOSED
 */
export async function createTableOrder(token: string, data: TableOrderInput) {
  const t = await getActiveTable(token);
  const guestToken = randomBytes(24).toString("base64url");
  const code = await dalamTransaksi(async (conn) => {
    // serial per meja agar batas pesanan menunggu tidak dilampaui request paralel
    await conn.query("SELECT id FROM merchant_tables WHERE id = ? FOR UPDATE", [t.id]);
    const [[n]] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM orders WHERE table_id = ? AND status = 'holding' AND hold_until > UTC_TIMESTAMP() FOR UPDATE",
      [t.id],
    );
    if (Number(n.n) >= MAX_HOLDING_ORDERS)
      throw conflict("Masih ada pesanan meja ini yang menunggu pembayaran. Selesaikan dulu.");
    const ms = jam.sekarang();
    const today = hariIniWib(new Date(ms));
    const q = { ...data, pickup_point_id: 0, promo_code: null, promo_codes: [], pickup_at: null };
    const h = validateCart(await loadCart(conn, q, { segarkan: true, hari: today, ms }), q, ms, {
      tanpaTitikTemu: true,
    });
    if (h.merchant.id !== t.merchant_id)
      throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { items: ["Menu bukan dari toko ini."] });
    if (h.kurang.length) throw outOfStockError(h.kurang);
    // AUD-32: tamu anonim tanpa bayar dulu; batasi porsi tertahan per meja, bukan hanya jumlah pesanannya (setelah cek stok)
    if ((await getHeldPortions(conn, "table_id", t.id)) + totalPortions(data.items) > MAX_TABLE_PORTIONS) {
      throw conflict(
        `Maksimal ${MAX_TABLE_PORTIONS} porsi menunggu pembayaran per meja. Selesaikan pembayaran pesanan lain dulu.`,
      );
    }
    const { orderId, code } = await insertOrder(
      conn,
      today,
      `INSERT INTO orders (code, customer_id, merchant_id, pickup_point_id, table_id, guest_token_hash, status, customer_name, customer_phone,
         note, subtotal, discount, service_fee, total, payment_method, payment_status, hold_until, stock_date)
       VALUES (?, NULL, ?, NULL, ?, ?, 'holding', ?, ?, ?, ?, 0, ?, ?, 'online', 'unpaid', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?)`,
      (orderCode) => [
        orderCode,
        t.merchant_id,
        t.id,
        hash(guestToken),
        data.customer_name,
        data.customer_phone,
        data.note,
        h.subtotal,
        h.service_fee,
        h.total,
        h.merchant.hold_minutes,
        today,
      ],
    );
    await holdStockAndInsertItems(conn, orderId, h, today);
    await conn.query(
      "INSERT INTO order_status_logs (order_id, from_status, to_status, actor_user_id) VALUES (?, NULL, 'holding', NULL)",
      [orderId],
    );
    return code;
  }, "READ COMMITTED");
  return { guest_token: guestToken, ...(await getGuestOrder(code, guestToken)) };
}

/**
 * Status pesanan tamu untuk halaman status di web: item, total, sisa waktu tahan, dan `payment_url` Snap selama menunggu bayar.
 *
 * @param guestToken token tamu dari header X-Guest-Token; dicocokkan lewat hash
 * @throws AppError 404 NOT_FOUND bila kode atau token tamu tidak cocok
 */
export async function getGuestOrder(code: string, guestToken: string) {
  const [[o]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.code, o.status, o.payment_status, o.customer_name, o.note, o.subtotal, o.service_fee, o.total, o.hold_until, o.created_at,
       GREATEST(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), o.hold_until), 0) AS seconds_left, t.label, m.business_name, m.slug, ${URL_BAYAR} AS url
     FROM orders o JOIN merchants m ON m.id = o.merchant_id LEFT JOIN merchant_tables t ON t.id = o.table_id
     WHERE o.code = ? AND o.guest_token_hash = ?`,
    [code, hash(guestToken)],
  );
  if (!o) throw orderNotFound();
  const holding = o.status === "holding";
  return {
    code: o.code,
    status: o.status,
    payment_status: o.payment_status,
    table: { label: o.label },
    merchant: { slug: o.slug, business_name: o.business_name },
    customer_name: o.customer_name,
    note: o.note,
    items: (await loadOrderItems([o.id])).get(o.id) ?? [],
    subtotal: o.subtotal,
    service_fee: o.service_fee,
    total: o.total,
    hold_until: holding ? o.hold_until : null,
    seconds_left: holding ? Number(o.seconds_left) : null,
    payment_url: holding && o.payment_status !== "paid" ? o.url : null,
    created_at: o.created_at,
  };
}

/**
 * Buka (atau pakai ulang) halaman bayar Snap untuk pesanan tamu.
 * Halaman bayar Snap tamu (logika bersama pre-order F26 di bukaSnap).
 *
 * @param returnUrl URL kembali setelah bayar; origin-nya harus termasuk CORS_ORIGIN
 * @returns `payment_url` halaman Snap
 * @throws AppError 400 VALIDATION_ERROR (field `kembali`) bila asal URL tidak diizinkan, 404 NOT_FOUND bila kode/token
 *   tamu tidak cocok, 409 CONFLICT bila pesanan tidak menunggu pembayaran
 */
export async function payGuestOrder(code: string, guestToken: string, returnUrl: string) {
  if (!asalSah(returnUrl))
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { kembali: ["Alamat kembali tidak diizinkan."] });
  const [[o]] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM_SNAP} FROM orders o WHERE o.code = ? AND o.guest_token_hash = ?`,
    [code, hash(guestToken)],
  );
  if (!o) throw orderNotFound();
  return { payment_url: await bukaSnap(o, code, returnUrl) };
}
