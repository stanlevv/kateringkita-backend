import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { jumlahHari, Rentang } from "../dto/merchant-laporan.dto";
import { idToko } from "./merchant-menu.service";

// F09 laporan toko (LP-N1..N4): hanya pesanan completed, dihitung per completed_at; tanggal WIB → rentang UTC [from, to).
// shortcut: diskon promo tidak mengurangi omzet laporan toko; upgrade bila penjual minta laba bersih (rincian diskon di F20)
const awalWib = (d: string) => new Date(Date.parse(`${d}T00:00:00+07:00`));
const rentangUtc = ({ from, to }: Rentang) => [awalWib(from), new Date(awalWib(to).getTime() + 86400e3)];

const SELESAI = `FROM orders o JOIN order_items i ON i.order_id = o.id
  WHERE o.merchant_id = ? AND o.status = 'completed' AND o.completed_at >= ? AND o.completed_at < ?`;

/** Angka laporan untuk toko `merchantId` (dipakai ulang asisten F17). */
export async function ringkasanToko(merchantId: number, r: Rentang) {
  const [[a]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(i.line_total), 0) AS revenue, COALESCE(SUM(i.hpp * i.qty), 0) AS hpp_total ${SELESAI}`,
    [merchantId, ...rentangUtc(r)],
  );
  const [[m]] = await db.query<RowDataPacket[]>("SELECT daily_revenue_target FROM merchants WHERE id = ?", [merchantId]);
  const target = Number(m.daily_revenue_target) * jumlahHari(r.from, r.to);
  const revenue = Number(a.revenue);
  const hpp_total = Number(a.hpp_total);
  return {
    target, revenue, hpp_total, profit: revenue - hpp_total,
    achievement_pct: target > 0 ? Math.round((revenue * 100) / target) : 0, orders: Number(a.orders),
  };
}

export async function ringkasanLaporan(userId: number, r: Rentang) {
  return ringkasanToko(await idToko(userId), r);
}

// LP-N2: jam WIB yang ada transaksinya saja, urut jam (sama dengan fe/lib/laporan.ts#perJam)
export async function laporanPerJam(userId: number, date: string) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT HOUR(o.completed_at + INTERVAL 7 HOUR) AS hour, COUNT(DISTINCT o.id) AS orders, SUM(i.qty) AS portions, SUM(i.line_total) AS revenue
     ${SELESAI} GROUP BY hour ORDER BY hour`,
    [await idToko(userId), ...rentangUtc({ from: date, to: date })],
  );
  return rows.map((x) => ({ hour: Number(x.hour), orders: Number(x.orders), portions: Number(x.portions), revenue: Number(x.revenue) }));
}

// LP-N3: satu baris per menu dalam pesanan.
// shortcut: tanpa paginasi (fe memotong 20 per halaman, rentang maks 92 hari); upgrade bila satu toko > ribuan baris per rentang
export async function laporanTransaksi(userId: number, r: Rentang) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT o.code, o.created_at, o.completed_at, o.customer_name, o.payment_method, o.status,
       i.menu_name, i.qty, i.line_total, i.hpp * i.qty AS hpp_total
     ${SELESAI} ORDER BY o.completed_at DESC, i.id`,
    [await idToko(userId), ...rentangUtc(r)],
  );
  return rows.map((x) => ({
    code: x.code, created_at: x.created_at, completed_at: x.completed_at, customer_name: x.customer_name,
    payment_method: x.payment_method, menu_name: x.menu_name, qty: Number(x.qty), total: Number(x.line_total),
    hpp_total: Number(x.hpp_total), status: x.status,
  }));
}
