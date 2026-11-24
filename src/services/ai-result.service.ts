// Isi file: hasil AI, yaitu arsip setiap jawaban AI yang lolos pemeriksaan bentuk (dari asisten penjual dan
// rekomendasi pembeli) supaya admin bisa memeriksanya secara manual: disetujui bila sesuai data, ditolak dengan
// alasan bila tidak. Alur admin: routes/admin.ts (GET/PATCH /admin/hasil-ai) → handlers/ai-result.handler.ts → file ini
// → database. Semua tingkat admin boleh melihat; memberi keputusan (PATCH) hanya admin ops dan super. Nilai status
// di database berbahasa Indonesia: `menunggu`, `disetujui`, `ditolak`.
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import type { ListAiResultsQuery, VerifyAiResultInput } from "../dto/ai-result.dto";
import { recordAudit, withTransaction, lockRow } from "./admin-audit.service";

/** Fitur asal hasil AI, sama dengan nilai kolom `ai_results.fitur`. */
export type AiResultFeature = "asisten" | "rekomendasi";

/**
 * Menyimpan satu jawaban AI dengan status awal `menunggu` (bawaan kolom). Gagal menyimpan hanya ditulis ke log konsol
 * dan tidak menggagalkan jawaban ke pengguna, sama seperti pencatatan pemakaian di ai.service.
 * @param entry fitur asal, id pengguna, id toko (khusus asisten), teks pertanyaan yang sudah disamarkan (disimpan
 *              paling banyak 600 karakter), dan jawaban AI yang sudah diurai
 * @returns id baris baru, atau null bila gagal disimpan
 */
export async function saveAiResult(entry: {
  feature: AiResultFeature;
  userId: number | null;
  merchantId?: number | null;
  input: string;
  output: unknown;
}): Promise<number | null> {
  // 1. Simpan; galat database ditangkap supaya jawaban AI tetap terkirim.
  try {
    const [result] = await db.query<ResultSetHeader>(
      "INSERT INTO ai_results (fitur, user_id, merchant_id, input_text, output_json) VALUES (?, ?, ?, ?, ?)",
      [entry.feature, entry.userId, entry.merchantId ?? null, entry.input.slice(0, 600), JSON.stringify(entry.output)],
    );
    return result.insertId;
  } catch (error) {
    console.error("[ai] gagal menyimpan hasil:", (error as Error).message);
    return null;
  }
}

// Kolom hasil AI beserta nama pengguna, nama toko, dan nama admin pemeriksa.
const AI_RESULT_COLUMNS = `r.id, r.fitur, r.input_text, r.output_json, r.status, r.catatan, r.created_at, r.verified_at,
  r.user_id, u.full_name AS user_name, r.merchant_id, m.business_name, r.verified_by, v.full_name AS verifier_name`;
const AI_RESULT_FROM_SQL = `FROM ai_results r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN merchants m ON m.id = r.merchant_id
  LEFT JOIN users v ON v.id = r.verified_by`;

// Baris query menjadi JSON panel admin; jawaban AI dikirim sebagai objek di kunci `output`.
const mapAiResult = (row: RowDataPacket) => ({
  id: Number(row.id),
  fitur: row.fitur as AiResultFeature,
  input_text: row.input_text as string,
  // mysql2 biasanya sudah mengurai kolom JSON, tetapi TiDB (database production) kadang mengirimnya sebagai teks.
  output: typeof row.output_json === "string" ? JSON.parse(row.output_json) : row.output_json,
  status: row.status as string,
  catatan: (row.catatan as string | null) ?? null,
  created_at: row.created_at,
  verified_at: row.verified_at,
  verified_by: row.verified_by ? { id: row.verified_by as number, name: row.verifier_name as string } : null,
  user: row.user_id ? { id: row.user_id as number, name: row.user_name as string } : null,
  merchant: row.merchant_id ? { id: row.merchant_id as number, business_name: row.business_name as string } : null,
});

/**
 * Daftar hasil AI per halaman, terbaru dulu.
 * @param filter `status` dan `fitur` opsional, `page`, `limit` (sudah diperiksa listAiResultsSchema)
 * @returns `{ data, meta: { page, limit, total } }`
 */
export async function listAiResults(filter: ListAiResultsQuery) {
  // 1. Susun syarat dari filter status dan fitur.
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status) (where.push("r.status = ?"), args.push(filter.status));
  if (filter.fitur) (where.push("r.fitur = ?"), args.push(filter.fitur));
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // 2. Hitung total, lalu ambil satu halaman.
  const [[countRow]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ai_results r ${whereSql}`, args);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${AI_RESULT_COLUMNS} ${AI_RESULT_FROM_SQL} ${whereSql} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    [...args, filter.limit, (filter.page - 1) * filter.limit],
  );
  return { data: rows.map(mapAiResult), meta: { page: filter.page, limit: filter.limit, total: Number(countRow.n) } };
}

/**
 * Memberi keputusan untuk satu hasil AI: disetujui atau ditolak (alasan wajib bila ditolak, diperiksa di skema).
 * Keputusan boleh diubah kapan saja; setiap keputusan, termasuk yang sama dengan sebelumnya, ditulis ulang beserta
 * admin dan waktunya, lalu dicatat di log audit `ai_result.verify` (status dan catatan sebelum/sesudah).
 * @param adminId id admin yang memeriksa
 * @param idRaw   id hasil AI dari URL
 * @param input   keputusan `status` dan `catatan` opsional
 * @returns hasil AI sesudah diperiksa
 * @throws 404 hasil AI tidak ditemukan
 */
export async function verifyAiResult(adminId: number, idRaw: unknown, input: VerifyAiResultInput) {
  const id = await withTransaction(async (conn) => {
    // 1. Kunci barisnya, lalu simpan keputusan, catatan, admin, dan waktunya.
    const aiResult = await lockRow(conn, "ai_results", idRaw, { notFound: "Hasil AI tidak ditemukan." });
    const note = input.catatan ?? null;
    await conn.query(
      "UPDATE ai_results SET status = ?, catatan = ?, verified_by = ?, verified_at = UTC_TIMESTAMP() WHERE id = ?",
      [input.status, note, adminId, aiResult.id],
    );
    // 2. Catat keputusan sebelum dan sesudah di log audit.
    await recordAudit(conn, {
      adminId,
      action: "ai_result.verify",
      targetType: "ai_result",
      targetId: aiResult.id,
      before: { status: aiResult.status, catatan: aiResult.catatan ?? null },
      after: { status: input.status, catatan: note },
    });
    return aiResult.id as number;
  });
  // 3. Baca ulang dalam bentuk daftar.
  const [[row]] = await db.query<RowDataPacket[]>(`SELECT ${AI_RESULT_COLUMNS} ${AI_RESULT_FROM_SQL} WHERE r.id = ?`, [
    id,
  ]);
  return mapAiResult(row);
}
