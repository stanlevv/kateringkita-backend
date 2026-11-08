import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { Rentang } from "../dto/merchant-laporan.dto";
import { rentangUtc } from "./merchant-laporan.service";

// F20 rekap keuangan platform: pesanan completed per toko (per completed_at, tanggal WIB).
// Diskon dipisah menurut pemilik promo: promo toko ditanggung toko, promo platform ditanggung platform.
const ANGKA = ["orders", "subtotal", "discount_merchant", "discount_platform", "service_fee", "total"] as const;

const bersih = (r: Record<string, unknown>) => {
  const n = Object.fromEntries(ANGKA.map((k) => [k, Number(r[k] ?? 0)])) as Record<(typeof ANGKA)[number], number>;
  return { ...n, merchant_net: n.subtotal - n.discount_merchant, platform_net: n.service_fee - n.discount_platform };
};

export async function rekapKeuangan(r: Rentang) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id AS merchant_id, m.business_name, COUNT(*) AS orders, SUM(o.subtotal) AS subtotal,
       SUM(CASE WHEN p.merchant_id IS NOT NULL THEN o.discount ELSE 0 END) AS discount_merchant,
       SUM(CASE WHEN p.id IS NOT NULL AND p.merchant_id IS NULL THEN o.discount ELSE 0 END) AS discount_platform,
       SUM(o.service_fee) AS service_fee, SUM(o.total) AS total
     FROM orders o JOIN merchants m ON m.id = o.merchant_id LEFT JOIN promos p ON p.id = o.promo_id
     WHERE o.status = 'completed' AND o.completed_at >= ? AND o.completed_at < ?
     GROUP BY m.id, m.business_name ORDER BY total DESC, m.id`,
    rentangUtc(r),
  );
  const data = rows.map((x) => ({ merchant_id: x.merchant_id as number, business_name: x.business_name as string, ...bersih(x) }));
  const totals = bersih(Object.fromEntries(ANGKA.map((k) => [k, data.reduce((s, x) => s + x[k], 0)])));
  return { rows: data, totals };
}
