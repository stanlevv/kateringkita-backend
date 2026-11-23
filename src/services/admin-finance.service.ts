import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { DateRange } from "../dto/merchant-report.dto";
import { toUtcRange } from "./merchant-report.service";

// F20 rekap keuangan platform: pesanan completed per toko (per completed_at, tanggal WIB).
// Diskon dipisah per slot voucher (migrasi 014): voucher toko ditanggung toko, voucher platform ditanggung platform.
const AMOUNT_COLUMNS = [
  "orders",
  "subtotal",
  "discount_merchant",
  "discount_platform",
  "service_fee",
  "total",
] as const;

const withNetAmounts = (row: Record<string, unknown>) => {
  const amounts = Object.fromEntries(AMOUNT_COLUMNS.map((key) => [key, Number(row[key] ?? 0)])) as Record<
    (typeof AMOUNT_COLUMNS)[number],
    number
  >;
  return {
    ...amounts,
    merchant_net: amounts.subtotal - amounts.discount_merchant,
    platform_net: amounts.service_fee - amounts.discount_platform,
  };
};

export async function getFinanceSummary(range: DateRange) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id AS merchant_id, m.business_name, COUNT(*) AS orders, SUM(o.subtotal) AS subtotal,
       SUM(o.merchant_discount) AS discount_merchant, SUM(o.platform_discount) AS discount_platform,
       SUM(o.service_fee) AS service_fee, SUM(o.total) AS total
     FROM orders o JOIN merchants m ON m.id = o.merchant_id
     WHERE o.status = 'completed' AND o.completed_at >= ? AND o.completed_at < ?
     GROUP BY m.id, m.business_name ORDER BY total DESC, m.id`,
    toUtcRange(range),
  );
  const data = rows.map((row) => ({
    merchant_id: row.merchant_id as number,
    business_name: row.business_name as string,
    ...withNetAmounts(row),
  }));
  const totals = withNetAmounts(
    Object.fromEntries(AMOUNT_COLUMNS.map((key) => [key, data.reduce((sum, row) => sum + row[key], 0)])),
  );
  return { rows: data, totals };
}
