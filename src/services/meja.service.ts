import { createHash, randomBytes } from "node:crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { buatSnap } from "../utils/midtrans";
import { PesananMejaInput, UbahMejaInput } from "../dto/meja.dto";
import { dalamTransaksi } from "./admin-audit.service";
import { DARI, jam, JOIN_FAVORIT, kartu, KOLOM_KARTU, TAMPIL, tokoBuka, TOKO_TAMPIL } from "./katalog.service";
import { hariIniWib } from "./merchant-kuota.service";
import { idToko } from "./merchant-menu.service";
import { muatKeranjang, periksa } from "./pesanan-keranjang.service";
import { habis, muatItem, sisipPesanan, tahanStokDanItem } from "./pesanan.service";

// F21 pesan dari meja: QR meja → menu tanpa login → pesanan tamu → bayar lewat Snap → status lewat token tamu.
// Token tamu hanya dipegang peramban tamu; DB menyimpan SHA-256-nya.

const MAKS_MEJA = 100;
// shortcut: batas pesanan menunggu per meja menahan stok dari pesanan iseng; naikkan bila satu meja dipakai rombongan besar
const MAKS_TERTAHAN = 5;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const konflik = (pesan: string) => new AppError(409, "CONFLICT", pesan);
const mejaTidakAda = () => new AppError(404, "NOT_FOUND", "Meja tidak ditemukan atau tidak aktif.");
const pesananTidakAda = () => new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
const hhmm = (t: unknown) => String(t).slice(0, 5);

// ---------- penjual ----------
const petaMeja = (r: RowDataPacket) => ({ id: r.id, label: r.label, token: r.token, is_active: Boolean(r.is_active) });
const labelDipakai = (e: unknown) => (e as { code?: string }).code === "ER_DUP_ENTRY";
const tolakLabel = () => new AppError(409, "CONFLICT", "Nama meja sudah dipakai.", { label: ["Nama meja sudah dipakai."] });

export async function daftarMeja(userId: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, label, token, is_active FROM merchant_tables WHERE merchant_id = ? ORDER BY LENGTH(label), label", [await idToko(userId)],
  );
  return rows.map(petaMeja);
}

async function ambilMeja(tokoId: number, id: number) {
  const [[r]] = await db.query<RowDataPacket[]>("SELECT id, label, token, is_active FROM merchant_tables WHERE id = ? AND merchant_id = ?", [id, tokoId]);
  if (!r) throw new AppError(404, "NOT_FOUND", "Meja tidak ditemukan.");
  return petaMeja(r);
}

export async function buatMeja(userId: number, label: string) {
  const tokoId = await idToko(userId);
  const [[n]] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM merchant_tables WHERE merchant_id = ?", [tokoId]);
  if (Number(n.n) >= MAKS_MEJA) throw konflik(`Maksimal ${MAKS_MEJA} meja per toko.`);
  try {
    const [r] = await db.query<ResultSetHeader>(
      "INSERT INTO merchant_tables (merchant_id, label, token) VALUES (?, ?, ?)", [tokoId, label, randomBytes(16).toString("hex")],
    );
    return ambilMeja(tokoId, r.insertId);
  } catch (e) {
    if (labelDipakai(e)) throw tolakLabel();
    throw e;
  }
}

export async function ubahMeja(userId: number, idRaw: unknown, input: UbahMejaInput) {
  const tokoId = await idToko(userId);
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id < 1) throw new AppError(404, "NOT_FOUND", "Meja tidak ditemukan.");
  await ambilMeja(tokoId, id);
  const sets: string[] = [];
  const args: unknown[] = [];
  if (input.label !== undefined) sets.push("label = ?"), args.push(input.label);
  if (input.is_active !== undefined) sets.push("is_active = ?"), args.push(input.is_active);
  if (input.ganti_token) sets.push("token = ?"), args.push(randomBytes(16).toString("hex"));
  try {
    await db.query(`UPDATE merchant_tables SET ${sets.join(", ")} WHERE id = ? AND merchant_id = ?`, [...args, id, tokoId]);
  } catch (e) {
    if (labelDipakai(e)) throw tolakLabel();
    throw e;
  }
  return ambilMeja(tokoId, id);
}

// ---------- publik (tamu) ----------
// Meja aktif + dine-in toko menyala + toko tampil. Token bukan heksa 32 → 404 tanpa kueri.
async function mejaAktif(token: string) {
  if (!/^[0-9a-f]{32}$/.test(token)) throw mejaTidakAda();
  const [[t]] = await db.query<RowDataPacket[]>(
    `SELECT t.id, t.label, m.id AS merchant_id, m.slug, m.business_name, m.description, m.logo_url, m.is_open, m.open_time, m.close_time
     FROM merchant_tables t JOIN merchants m ON m.id = t.merchant_id JOIN users u ON u.id = m.user_id
     WHERE t.token = ? AND t.is_active AND m.dine_in_enabled AND ${TOKO_TAMPIL}`,
    [token],
  );
  if (!t) throw mejaTidakAda();
  return t;
}

// Menu toko untuk meja: kartu katalog + deskripsi + opsi aktif; menu pre-order tidak dijual di meja
export async function menuMeja(token: string) {
  const t = await mejaAktif(token);
  const ms = jam.sekarang();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM_KARTU}, x.description, x.min_order_qty FROM ${DARI} ${JOIN_FAVORIT}
     WHERE ${TAMPIL} AND m.id = ? AND NOT x.is_preorder
     ORDER BY c.sort_order, c.name, x.sold_total DESC, x.id`,
    [hariIniWib(new Date(ms)), null, t.merchant_id],
  );
  const opsi = new Map<number, { id: number; name: string; extra_price: number }[]>();
  if (rows.length) {
    const [o] = await db.query<RowDataPacket[]>(
      "SELECT id, menu_id, name, extra_price FROM menu_options WHERE menu_id IN (?) AND is_active ORDER BY id", [rows.map((r) => r.id)],
    );
    for (const r of o) opsi.set(r.menu_id, [...(opsi.get(r.menu_id) ?? []), { id: r.id, name: r.name, extra_price: r.extra_price }]);
  }
  return {
    table: { label: t.label },
    merchant: {
      slug: t.slug, business_name: t.business_name, description: t.description, logo_url: t.logo_url,
      is_open: tokoBuka(t, ms), open_time: hhmm(t.open_time), close_time: hhmm(t.close_time),
    },
    menus: rows.map((r) => ({ ...kartu(r, ms), description: r.description, min_order_qty: r.min_order_qty, options: opsi.get(r.id) ?? [] })),
  };
}

// Pesanan tamu: validasi & penahanan stok sama dengan checkout (F06) tanpa titik temu & promo; bayar online (Snap) menyusul.
export async function pesanMeja(token: string, data: PesananMejaInput) {
  const t = await mejaAktif(token);
  const tamu = randomBytes(24).toString("base64url");
  const code = await dalamTransaksi(async (conn) => {
    // serial per meja agar batas pesanan menunggu tidak dilampaui request paralel
    await conn.query("SELECT id FROM merchant_tables WHERE id = ? FOR UPDATE", [t.id]);
    const [[n]] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM orders WHERE table_id = ? AND status = 'holding' AND hold_until > UTC_TIMESTAMP() FOR UPDATE", [t.id],
    );
    if (Number(n.n) >= MAKS_TERTAHAN) throw konflik("Masih ada pesanan meja ini yang menunggu pembayaran. Selesaikan dulu.");
    const ms = jam.sekarang();
    const hari = hariIniWib(new Date(ms));
    const q = { ...data, pickup_point_id: 0, promo_code: null, pickup_at: null };
    const h = periksa(await muatKeranjang(conn, q, { segarkan: true, hari, ms }), q, ms, { tanpaTitikTemu: true });
    if (h.merchant.id !== t.merchant_id) throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { items: ["Menu bukan dari toko ini."] });
    if (h.kurang.length) throw habis(h.kurang);
    const { orderId, code } = await sisipPesanan(conn, hari,
      `INSERT INTO orders (code, customer_id, merchant_id, pickup_point_id, table_id, guest_token_hash, status, customer_name, customer_phone,
         note, subtotal, discount, service_fee, total, payment_method, payment_status, hold_until, stock_date)
       VALUES (?, NULL, ?, NULL, ?, ?, 'holding', ?, ?, ?, ?, 0, ?, ?, 'online', 'unpaid', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?)`,
      (kode) => [kode, t.merchant_id, t.id, hash(tamu), data.customer_name, data.customer_phone, data.note, h.subtotal, h.service_fee, h.total,
        h.merchant.hold_minutes, hari],
    );
    await tahanStokDanItem(conn, orderId, h, hari);
    await conn.query("INSERT INTO order_status_logs (order_id, from_status, to_status, actor_user_id) VALUES (?, NULL, 'holding', NULL)", [orderId]);
    return code;
  }, "READ COMMITTED");
  return { guest_token: tamu, ...(await statusMeja(code, tamu)) };
}

const URL_BAYAR = "(SELECT redirect_url FROM payments p WHERE p.order_id = o.id AND p.method = 'online' ORDER BY p.id DESC LIMIT 1)";

export async function statusMeja(code: string, tamu: string) {
  const [[o]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.code, o.status, o.payment_status, o.customer_name, o.note, o.subtotal, o.service_fee, o.total, o.hold_until, o.created_at,
       GREATEST(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), o.hold_until), 0) AS seconds_left, t.label, m.business_name, m.slug, ${URL_BAYAR} AS url
     FROM orders o JOIN merchants m ON m.id = o.merchant_id LEFT JOIN merchant_tables t ON t.id = o.table_id
     WHERE o.code = ? AND o.guest_token_hash = ?`,
    [code, hash(tamu)],
  );
  if (!o) throw pesananTidakAda();
  const holding = o.status === "holding";
  return {
    code: o.code, status: o.status, payment_status: o.payment_status, table: { label: o.label }, merchant: { slug: o.slug, business_name: o.business_name },
    customer_name: o.customer_name, note: o.note, items: (await muatItem([o.id])).get(o.id) ?? [],
    subtotal: o.subtotal, service_fee: o.service_fee, total: o.total,
    hold_until: holding ? o.hold_until : null, seconds_left: holding ? Number(o.seconds_left) : null,
    payment_url: holding && o.payment_status !== "paid" ? o.url : null, created_at: o.created_at,
  };
}

// `kembali` harus web kita sendiri (CORS_ORIGIN): mencegah halaman bayar mengalihkan tamu ke situs lain
const asalSah = (url: string) => {
  try {
    return (env.CORS_ORIGIN.length ? env.CORS_ORIGIN : ["http://localhost:3000"]).includes(new URL(url).origin);
  } catch {
    return false;
  }
};

// Snap dipanggil di luar transaksi; idempoten: halaman bayar yang sudah dibuat dikembalikan.
export async function bayarMeja(code: string, tamu: string, kembali: string) {
  if (!asalSah(kembali)) throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { kembali: ["Alamat kembali tidak diizinkan."] });
  const [[o]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.total, o.status, o.payment_status, TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), o.hold_until) AS menit, ${URL_BAYAR} AS url
     FROM orders o WHERE o.code = ? AND o.guest_token_hash = ?`,
    [code, hash(tamu)],
  );
  if (!o) throw pesananTidakAda();
  if (o.status !== "holding" || o.payment_status === "paid") throw konflik("Pesanan ini tidak menunggu pembayaran.");
  if (o.url) return { payment_url: o.url as string };
  // menit dibulatkan ke bawah: halaman bayar tutup sebelum hold habis
  const menit = Number(o.menit);
  if (menit < 1) throw konflik("Batas waktu pesanan sudah habis.");
  const { redirect_url } = await buatSnap(code, o.total, menit, kembali);
  await db.query(
    `INSERT INTO payments (order_id, method, provider, amount, status, expires_at, redirect_url)
     VALUES (?, 'online', 'midtrans', ?, 'pending', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?)`,
    [o.id, o.total, menit, redirect_url],
  );
  await db.query("UPDATE orders SET payment_status = 'pending' WHERE id = ? AND payment_status = 'unpaid'", [o.id]);
  return { payment_url: redirect_url };
}
