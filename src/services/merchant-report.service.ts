import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { countDays, DateRange } from "../dto/merchant-report.dto";
import { getMerchantId } from "./merchant-menu.service";

// F09 laporan toko (LP-N1..N4): hanya pesanan completed, dihitung per completed_at; tanggal WIB → rentang UTC [from, to).
// shortcut: diskon promo tidak mengurangi omzet laporan toko; upgrade bila penjual minta laba bersih (rincian diskon di F20)
const wibDayStart = (date: string) => new Date(Date.parse(`${date}T00:00:00+07:00`));
export const toUtcRange = ({ from: startDate, to: endDate }: DateRange) => [
  wibDayStart(startDate),
  new Date(wibDayStart(endDate).getTime() + 86400e3),
];

const COMPLETED_ORDERS_SQL = `FROM orders o JOIN order_items i ON i.order_id = o.id
  WHERE o.merchant_id = ? AND o.status = 'completed' AND o.completed_at >= ? AND o.completed_at < ?`;

/** Angka laporan untuk toko `merchantId` (dipakai ulang asisten F17). */
export async function getMerchantSummary(merchantId: number, range: DateRange) {
  const [[totals]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(i.line_total), 0) AS revenue, COALESCE(SUM(i.hpp * i.qty), 0) AS hpp_total ${COMPLETED_ORDERS_SQL}`,
    [merchantId, ...toUtcRange(range)],
  );
  const [[merchant]] = await db.query<RowDataPacket[]>("SELECT daily_revenue_target FROM merchants WHERE id = ?", [
    merchantId,
  ]);
  const target = Number(merchant.daily_revenue_target) * countDays(range.from, range.to);
  const revenue = Number(totals.revenue);
  const costTotal = Number(totals.hpp_total);
  return {
    target,
    revenue,
    hpp_total: costTotal,
    profit: revenue - costTotal,
    achievement_pct: target > 0 ? Math.round((revenue * 100) / target) : 0,
    orders: Number(totals.orders),
  };
}

export async function getReportSummary(userId: number, range: DateRange) {
  return getMerchantSummary(await getMerchantId(userId), range);
}

// LP-N2: jam WIB yang ada transaksinya saja, urut jam (sama dengan fe/lib/laporan.ts#perJam)
export async function getHourlyReport(userId: number, date: string) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT HOUR(o.completed_at + INTERVAL 7 HOUR) AS hour, COUNT(DISTINCT o.id) AS orders, SUM(i.qty) AS portions, SUM(i.line_total) AS revenue
     ${COMPLETED_ORDERS_SQL} GROUP BY hour ORDER BY hour`,
    [await getMerchantId(userId), ...toUtcRange({ from: date, to: date })],
  );
  return rows.map((row) => ({
    hour: Number(row.hour),
    orders: Number(row.orders),
    portions: Number(row.portions),
    revenue: Number(row.revenue),
  }));
}

// LP-N3: satu baris per menu dalam pesanan.
// shortcut: tanpa paginasi (fe memotong 20 per halaman, rentang maks 92 hari); upgrade bila satu toko > ribuan baris per rentang
export async function getTransactionReport(userId: number, range: DateRange) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT o.code, o.created_at, o.completed_at, o.customer_name, o.payment_method, o.status,
       i.menu_name, i.qty, i.line_total, i.hpp * i.qty AS hpp_total
     ${COMPLETED_ORDERS_SQL} ORDER BY o.completed_at DESC, i.id`,
    [await getMerchantId(userId), ...toUtcRange(range)],
  );
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
