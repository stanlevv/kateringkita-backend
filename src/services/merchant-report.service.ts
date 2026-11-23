// Isi file: laporan penjualan toko untuk penjual (rekap penjualan, per jam, dan daftar transaksi). Alurnya
// routes/merchant.ts → handlers/merchant.handler.ts → file ini → database. Rekap toko juga dipakai asisten AI penjual
// (assistant.service), dan pengubah rentang tanggal dipakai rekap keuangan admin (admin-finance.service).
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { countDays, DateRange } from "../dto/merchant-report.dto";
import { getMerchantId } from "./merchant-menu.service";

// Laporan hanya menghitung pesanan berstatus completed (selesai), dan tanggalnya diambil dari completed_at (waktu
// selesai), bukan waktu pesan. Database menyimpan waktu dalam UTC, sedangkan penjual memilih tanggal menurut WIB
// (UTC+7), jadi tanggal WIB diubah dulu menjadi rentang waktu UTC.
// shortcut: diskon promo tidak mengurangi omzet laporan toko; upgrade bila penjual minta laba bersih
// (rincian diskon ada di rekap keuangan admin)
const wibDayStart = (date: string) => new Date(Date.parse(`${date}T00:00:00+07:00`));
/**
 * Mengubah rentang tanggal WIB menjadi rentang waktu UTC `[awal, akhir)`: awal = pukul 00.00 WIB tanggal `from`,
 * akhir = pukul 00.00 WIB sehari setelah tanggal `to` (batas akhir tidak ikut). Jadi tanggal `to` ikut penuh sampai
 * 23.59.59 WIB.
 * @param range rentang tanggal `{ from, to }` berformat `YYYY-MM-DD` menurut WIB
 * @returns pasangan `[awal, akhir]` sebagai objek Date, siap dipakai di klausa `>= ? AND < ?`
 */
export const toUtcRange = ({ from: startDate, to: endDate }: DateRange) => [
  wibDayStart(startDate),
  new Date(wibDayStart(endDate).getTime() + 86400e3),
];

// Potongan SQL bersama: baris menu (order_items) dari pesanan selesai milik satu toko dalam rentang completed_at.
// Isian `?` berurutan: id toko, awal rentang, akhir rentang.
const COMPLETED_ORDERS_SQL = `FROM orders o JOIN order_items i ON i.order_id = o.id
  WHERE o.merchant_id = ? AND o.status = 'completed' AND o.completed_at >= ? AND o.completed_at < ?`;

/**
 * Rekap penjualan satu toko dalam rentang tanggal: omzet, HPP, laba kotor, target, dan capaian target.
 * Omzet (`revenue`) = jumlah `line_total` semua baris menu pesanan selesai, yaitu harga sebelum potongan voucher.
 * HPP (harga pokok penjualan, yaitu modal per porsi) dijumlah dari `hpp × qty` yang tersimpan di baris pesanan.
 * Dipakai juga oleh asisten AI penjual untuk angka penjualan 30 hari.
 * @param merchantId id toko
 * @param range      rentang tanggal WIB `{ from, to }`
 * @returns `target` (target omzet harian toko × jumlah hari rentang), `revenue`, `hpp_total`, `profit` (omzet − HPP),
 *          `achievement_pct` (omzet ÷ target × 100, dibulatkan; 0 bila target 0), dan `orders` (jumlah pesanan)
 */
export async function getMerchantSummary(merchantId: number, range: DateRange) {
  // 1. Jumlahkan pesanan, omzet, dan HPP dari pesanan selesai dalam rentang.
  const [[totals]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(i.line_total), 0) AS revenue, COALESCE(SUM(i.hpp * i.qty), 0) AS hpp_total ${COMPLETED_ORDERS_SQL}`,
    [merchantId, ...toUtcRange(range)],
  );
  // 2. Target rentang = target omzet harian toko × jumlah hari dalam rentang.
  const [[merchant]] = await db.query<RowDataPacket[]>("SELECT daily_revenue_target FROM merchants WHERE id = ?", [
    merchantId,
  ]);
  const target = Number(merchant.daily_revenue_target) * countDays(range.from, range.to);
  const revenue = Number(totals.revenue);
  const costTotal = Number(totals.hpp_total);
  // 3. Laba kotor dan persen capaian dihitung dari angka di atas.
  return {
    target,
    revenue,
    hpp_total: costTotal,
    profit: revenue - costTotal,
    achievement_pct: target > 0 ? Math.round((revenue * 100) / target) : 0,
    orders: Number(totals.orders),
  };
}

/**
 * Rekap penjualan toko milik penjual yang login (lihat {@link getMerchantSummary}).
 * @param userId id pengguna penjual dari token login
 * @param range  rentang tanggal WIB `{ from, to }` yang sudah lolos reportRangeSchema
 * @returns rekap penjualan toko
 * @throws 404 bila pengguna ini tidak punya toko
 */
export async function getReportSummary(userId: number, range: DateRange) {
  return getMerchantSummary(await getMerchantId(userId), range);
}

/**
 * Penjualan per jam WIB dalam satu hari. Hanya jam yang punya pesanan selesai yang muncul, urut dari jam terkecil.
 * @param userId id pengguna penjual dari token login
 * @param date   tanggal WIB `YYYY-MM-DD`
 * @returns daftar `{ hour (0–23, WIB), orders, portions (jumlah porsi), revenue }`
 * @throws 404 bila pengguna ini tidak punya toko
 */
export async function getHourlyReport(userId: number, date: string) {
  // 1. Kelompokkan per jam. completed_at disimpan UTC, jadi ditambah 7 jam dulu supaya jamnya menjadi jam WIB.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT HOUR(o.completed_at + INTERVAL 7 HOUR) AS hour, COUNT(DISTINCT o.id) AS orders, SUM(i.qty) AS portions, SUM(i.line_total) AS revenue
     ${COMPLETED_ORDERS_SQL} GROUP BY hour ORDER BY hour`,
    [await getMerchantId(userId), ...toUtcRange({ from: date, to: date })],
  );
  // 2. Hasil SUM dari MySQL bisa berupa teks, jadi diubah ke angka.
  return rows.map((row) => ({
    hour: Number(row.hour),
    orders: Number(row.orders),
    portions: Number(row.portions),
    revenue: Number(row.revenue),
  }));
}

// shortcut: tanpa paginasi (fe memotong 20 per halaman, rentang maks 92 hari); upgrade bila satu toko > ribuan
// baris per rentang
/**
 * Daftar transaksi: satu baris per menu dalam setiap pesanan selesai, urut dari yang paling baru selesai. Web memakai
 * daftar ini juga untuk membuat unduhan CSV (berkas tabel berisi teks yang bisa dibuka di Excel).
 * @param userId id pengguna penjual dari token login
 * @param range  rentang tanggal WIB `{ from, to }`
 * @returns baris `{ code, created_at, completed_at, customer_name, payment_method, menu_name, qty, total, hpp_total,
 *          status }`; `total` = harga baris menu itu (sebelum potongan voucher), `hpp_total` = HPP × qty
 * @throws 404 bila pengguna ini tidak punya toko
 */
export async function getTransactionReport(userId: number, range: DateRange) {
  // 1. Ambil baris menu pesanan selesai dalam rentang, yang paling baru selesai di atas.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT o.code, o.created_at, o.completed_at, o.customer_name, o.payment_method, o.status,
       i.menu_name, i.qty, i.line_total, i.hpp * i.qty AS hpp_total
     ${COMPLETED_ORDERS_SQL} ORDER BY o.completed_at DESC, i.id`,
    [await getMerchantId(userId), ...toUtcRange(range)],
  );
  // 2. Bentuk baris jawaban; angka dari database diubah ke number.
  return rows.map((row) => ({
    code: row.code,
    created_at: row.created_at,
    completed_at: row.completed_at,
    customer_name: row.customer_name,
    payment_method: row.payment_method,
    menu_name: row.menu_name,
    qty: Number(row.qty),
    total: Number(row.line_total),
    hpp_total: Number(row.hpp_total),
    status: row.status,
  }));
}
