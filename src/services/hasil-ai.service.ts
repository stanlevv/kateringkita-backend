import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import type { DaftarHasilAi, VerifikasiAi } from "../dto/hasil-ai.dto";
import { catat, dalamTransaksi, kunci } from "./admin-audit.service";

// Rubrik AI: setiap keluaran AI yang lolos validasi skema disimpan (tabel ai_results) lalu diverifikasi manual admin di web.
export type FiturHasil = "asisten" | "rekomendasi";

/** Simpan keluaran AI; gagal menyimpan dicatat di log dan tidak menggagalkan jawaban ke pengguna (pola catatPakai). */
export async function simpanHasil(h: {
  fitur: FiturHasil;
  userId: number | null;
  merchantId?: number | null;
  input: string;
  output: unknown;
}): Promise<number | null> {
  try {
    const [r] = await db.query<ResultSetHeader>(
      "INSERT INTO ai_results (fitur, user_id, merchant_id, input_text, output_json) VALUES (?, ?, ?, ?, ?)",
      [h.fitur, h.userId, h.merchantId ?? null, h.input.slice(0, 600), JSON.stringify(h.output)],
    );
    return r.insertId;
  } catch (e) {
    console.error("[ai] gagal menyimpan hasil:", (e as Error).message);
    return null;
  }
}

const KOLOM = `r.id, r.fitur, r.input_text, r.output_json, r.status, r.catatan, r.created_at, r.verified_at,
  r.user_id, u.full_name AS user_name, r.merchant_id, m.business_name, r.verified_by, v.full_name AS verifier_name`;
const DARI = `FROM ai_results r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN merchants m ON m.id = r.merchant_id
  LEFT JOIN users v ON v.id = r.verified_by`;

const peta = (r: RowDataPacket) => ({
  id: Number(r.id),
  fitur: r.fitur as FiturHasil,
  input_text: r.input_text as string,
  // mysql2 mengurai kolom JSON; TiDB kadang mengirim string
  output: typeof r.output_json === "string" ? JSON.parse(r.output_json) : r.output_json,
  status: r.status as string,
  catatan: (r.catatan as string | null) ?? null,
  created_at: r.created_at,
  verified_at: r.verified_at,
  verified_by: r.verified_by ? { id: r.verified_by as number, name: r.verifier_name as string } : null,
  user: r.user_id ? { id: r.user_id as number, name: r.user_name as string } : null,
  merchant: r.merchant_id ? { id: r.merchant_id as number, business_name: r.business_name as string } : null,
});

export async function daftarHasilAi(f: DaftarHasilAi) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status) (where.push("r.status = ?"), args.push(f.status));
  if (f.fitur) (where.push("r.fitur = ?"), args.push(f.fitur));
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [[n]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ai_results r ${w}`, args);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM} ${DARI} ${w} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    [...args, f.limit, (f.page - 1) * f.limit],
  );
  return { data: rows.map(peta), meta: { page: f.page, limit: f.limit, total: Number(n.n) } };
}

/** Setujui / tolak (alasan wajib bila ditolak). Keputusan boleh diubah; setiap perubahan dicatat di audit admin. */
export async function verifikasiHasilAi(adminId: number, idRaw: unknown, input: VerifikasiAi) {
  const id = await dalamTransaksi(async (conn) => {
    const r = await kunci(conn, "ai_results", idRaw, { notFound: "Hasil AI tidak ditemukan." });
    const catatan = input.catatan ?? null;
    await conn.query(
      "UPDATE ai_results SET status = ?, catatan = ?, verified_by = ?, verified_at = UTC_TIMESTAMP() WHERE id = ?",
      [input.status, catatan, adminId, r.id],
    );
    await catat(conn, {
      adminId,
      action: "ai_result.verify",
      targetType: "ai_result",
      targetId: r.id,
      before: { status: r.status, catatan: r.catatan ?? null },
      after: { status: input.status, catatan },
    });
    return r.id as number;
  });
  const [[r]] = await db.query<RowDataPacket[]>(`SELECT ${KOLOM} ${DARI} WHERE r.id = ?`, [id]);
  return peta(r);
}
