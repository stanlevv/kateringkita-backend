import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { idToko } from "../merchant/menus";
import { Rentang } from "./schemas";

// F09 laporan (M-09, R-10): hanya pesanan `completed` toko sendiri (D1), tanggal = completed_at WIB (D2),
// angka dari salinan order_items (D3). Toko selalu dari token.
const SELESAI = "o.merchant_id = ? AND o.status = 'completed' AND o.completed_at >= ? AND o.completed_at < ?";
const DARI_ITEM = "FROM orders o JOIN order_items oi ON oi.order_id = o.id";

// D2: tanggal WIB inklusif → UTC [from 00:00 WIB, to+1 00:00 WIB)
export const rentangUtc = (from: string, to: string): [Date, Date] => [
  new Date(Date.parse(`${from}T00:00:00+07:00`)),
  new Date(Date.parse(`${to}T00:00:00+07:00`) + 86400e3),
];

// D3–D5: mysql2 mengembalikan SUM/DECIMAL sebagai string → Number
export async function ringkasanLaporan(userId: number, { from, to }: Rentang) {
  const merchantId = await idToko(userId);
  const [awal, akhir] = rentangUtc(from, to);
  const [[r]] = await db.query<RowDataPacket[]>(
    `SELECT COALESCE(SUM(oi.line_total), 0) AS revenue, COALESCE(SUM(oi.hpp * oi.qty), 0) AS hpp_total, COUNT(DISTINCT o.id) AS orders
     ${DARI_ITEM} WHERE ${SELESAI}`, [merchantId, awal, akhir]);
  const [[m]] = await db.query<RowDataPacket[]>("SELECT daily_revenue_target FROM merchants WHERE id = ?", [merchantId]);
  const hari = Math.round((akhir.getTime() - awal.getTime()) / 86400e3);
  const target = Number(m.daily_revenue_target) * hari; // D4: target saat ini, tanpa riwayat
  const revenue = Number(r.revenue);
  const hpp_total = Number(r.hpp_total);
  return {
    target, revenue, hpp_total, profit: revenue - hpp_total,
    achievement_pct: target > 0 ? Math.round((revenue / target) * 100) : 0,
    orders: Number(r.orders),
  };
}

// D6: satu baris per order_items; kode berulang untuk pesanan multi-menu.
// shortcut: semua baris rentang dalam satu respons, tambah page/limit bila rentang > ~10.000 baris (±100 item/hari × 92 hari)
export async function transaksiLaporan(userId: number, { from, to }: Rentang) {
  const [awal, akhir] = rentangUtc(from, to);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT o.code, o.created_at, o.completed_at, o.customer_name, o.payment_method, oi.menu_name, oi.qty,
            oi.line_total, oi.hpp * oi.qty AS hpp_total
     ${DARI_ITEM} WHERE ${SELESAI} ORDER BY o.completed_at DESC, o.id DESC, oi.id`, [await idToko(userId), awal, akhir]);
  return rows.map((t) => ({
    code: t.code, created_at: t.created_at, completed_at: t.completed_at, customer_name: t.customer_name,
    payment_method: t.payment_method, menu_name: t.menu_name, qty: t.qty, total: t.line_total, hpp_total: Number(t.hpp_total),
    status: "completed" as const,
  }));
}

// D8: hanya jam yang punya transaksi; jam = jam WIB dari completed_at (DATETIME tersimpan UTC)
export async function laporanPerJam(userId: number, { date }: { date: string }) {
  const [awal, akhir] = rentangUtc(date, date);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT HOUR(DATE_ADD(o.completed_at, INTERVAL 7 HOUR)) AS hour, COUNT(DISTINCT o.id) AS orders,
            SUM(oi.qty) AS portions, SUM(oi.line_total) AS revenue
     ${DARI_ITEM} WHERE ${SELESAI} GROUP BY 1 ORDER BY 1`, [await idToko(userId), awal, akhir]);
  return rows.map((j) => ({ hour: Number(j.hour), orders: Number(j.orders), portions: Number(j.portions), revenue: Number(j.revenue) }));
}

