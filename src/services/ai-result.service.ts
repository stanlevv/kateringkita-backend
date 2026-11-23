import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import type { ListAiResultsQuery, VerifyAiResultInput } from "../dto/ai-result.dto";
import { recordAudit, withTransaction, lockRow } from "./admin-audit.service";

// Rubrik AI: setiap keluaran AI yang lolos validasi skema disimpan (tabel ai_results) lalu diverifikasi manual admin di web.
export type AiResultFeature = "asisten" | "rekomendasi";

/** Simpan keluaran AI; gagal menyimpan dicatat di log dan tidak menggagalkan jawaban ke pengguna (pola catatPakai). */
export async function saveAiResult(entry: {
  feature: AiResultFeature;
  userId: number | null;
  merchantId?: number | null;
  input: string;
  output: unknown;
}): Promise<number | null> {
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

const AI_RESULT_COLUMNS = `r.id, r.fitur, r.input_text, r.output_json, r.status, r.catatan, r.created_at, r.verified_at,
  r.user_id, u.full_name AS user_name, r.merchant_id, m.business_name, r.verified_by, v.full_name AS verifier_name`;
const AI_RESULT_FROM_SQL = `FROM ai_results r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN merchants m ON m.id = r.merchant_id
  LEFT JOIN users v ON v.id = r.verified_by`;

const mapAiResult = (row: RowDataPacket) => ({
  id: Number(row.id),
  fitur: row.fitur as AiResultFeature,
  input_text: row.input_text as string,
  // mysql2 mengurai kolom JSON; TiDB kadang mengirim string
  output: typeof row.output_json === "string" ? JSON.parse(row.output_json) : row.output_json,
  status: row.status as string,
  catatan: (row.catatan as string | null) ?? null,
  created_at: row.created_at,
  verified_at: row.verified_at,
  verified_by: row.verified_by ? { id: row.verified_by as number, name: row.verifier_name as string } : null,
  user: row.user_id ? { id: row.user_id as number, name: row.user_name as string } : null,
  merchant: row.merchant_id ? { id: row.merchant_id as number, business_name: row.business_name as string } : null,
});

export async function listAiResults(filter: ListAiResultsQuery) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status) (where.push("r.status = ?"), args.push(filter.status));
  if (filter.fitur) (where.push("r.fitur = ?"), args.push(filter.fitur));
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [[countRow]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ai_results r ${whereSql}`, args);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${AI_RESULT_COLUMNS} ${AI_RESULT_FROM_SQL} ${whereSql} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    [...args, filter.limit, (filter.page - 1) * filter.limit],
  );
  return { data: rows.map(mapAiResult), meta: { page: filter.page, limit: filter.limit, total: Number(countRow.n) } };
}

/** Setujui / tolak (alasan wajib bila ditolak). Keputusan boleh diubah; setiap perubahan dicatat di audit admin. */
export async function verifyAiResult(adminId: number, idRaw: unknown, input: VerifyAiResultInput) {
  const id = await withTransaction(async (conn) => {
    const aiResult = await lockRow(conn, "ai_results", idRaw, { notFound: "Hasil AI tidak ditemukan." });
    const note = input.catatan ?? null;
    await conn.query(
      "UPDATE ai_results SET status = ?, catatan = ?, verified_by = ?, verified_at = UTC_TIMESTAMP() WHERE id = ?",
      [input.status, note, adminId, aiResult.id],
    );
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
  const [[row]] = await db.query<RowDataPacket[]>(`SELECT ${AI_RESULT_COLUMNS} ${AI_RESULT_FROM_SQL} WHERE r.id = ?`, [
    id,
  ]);
  return mapAiResult(row);
}
