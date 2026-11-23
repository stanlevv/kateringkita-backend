// Isi file: rekap keuangan platform untuk admin super (GET /admin/finance?from&to). Alurnya routes/admin.ts →
// handlers/admin.handler.ts → file ini → database. Yang dihitung hanya pesanan berstatus `completed`, dikelompokkan
// per toko menurut waktu selesai (`completed_at`) dalam rentang tanggal WIB.
//
// Istilah: subtotal = jumlah harga menu; potongan voucher dibagi dua: voucher toko ditanggung toko
// (`discount_merchant`) dan voucher platform ditanggung platform (`discount_platform`); biaya layanan = pendapatan
// platform per pesanan; total = yang dibayar pembeli. Bagian bersih toko = subtotal − voucher toko; bagian bersih
// platform = biaya layanan − voucher platform.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { DateRange } from "../dto/merchant-report.dto";
import { toUtcRange } from "./merchant-report.service";

// Kolom angka hasil query yang dijumlahkan per toko dan untuk baris total.
const AMOUNT_COLUMNS = [
  "orders",
  "subtotal",
  "discount_merchant",
  "discount_platform",
  "service_fee",
  "total",
] as const;

// Mengubah kolom angka menjadi number (kosong = 0) lalu menambah bagian bersih toko dan platform.
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

/**
 * Rekap keuangan per toko untuk rentang tanggal WIB, diurutkan dari total terbesar.
 * @param range rentang tanggal WIB `{ from, to }` yang sudah diperiksa adminRangeSchema (paling panjang 92 hari)
 * @returns `{ rows, totals }`: per toko jumlah pesanan, subtotal, potongan voucher toko dan platform, biaya layanan,
 *          total, `merchant_net`, dan `platform_net`; `totals` berisi jumlah semua toko dengan rumus bersih yang sama
 */
export async function getFinanceSummary(range: DateRange) {
  // 1. Jumlahkan pesanan selesai per toko dalam rentang (waktu UTC dari tanggal WIB).
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id AS merchant_id, m.business_name, COUNT(*) AS orders, SUM(o.subtotal) AS subtotal,
       SUM(o.merchant_discount) AS discount_merchant, SUM(o.platform_discount) AS discount_platform,
       SUM(o.service_fee) AS service_fee, SUM(o.total) AS total
     FROM orders o JOIN merchants m ON m.id = o.merchant_id
     WHERE o.status = 'completed' AND o.completed_at >= ? AND o.completed_at < ?
     GROUP BY m.id, m.business_name ORDER BY total DESC, m.id`,
    toUtcRange(range),
  );
  // 2. Rapikan angka per toko dan hitung bagian bersihnya.
  const data = rows.map((row) => ({
    merchant_id: row.merchant_id as number,
    business_name: row.business_name as string,
    ...withNetAmounts(row),
  }));
  // 3. Baris total: jumlah setiap kolom dari semua toko, lalu bagian bersihnya.
  const totals = withNetAmounts(
    Object.fromEntries(AMOUNT_COLUMNS.map((key) => [key, data.reduce((sum, row) => sum + row[key], 0)])),
  );
  return { rows: data, totals };
}
