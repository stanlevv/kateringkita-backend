import { z } from "zod";

// F22 AI gateway (admin). Alamat API tidak bisa diisi: hanya jenis penyedia yang dikenal (lihat JENIS di ai.service).
const PENYEDIA = "Pilih penyedia AI.";
const LABEL = "Nama 1–60 karakter.";
const MODEL = "Nama model 1–120 karakter: huruf, angka, titik, titik dua, garis miring, strip.";
const KEY = "API key 10–300 karakter tanpa spasi.";
const PRIO = "Prioritas 1–1000 (kecil dicoba lebih dulu).";
const AKTIF = "Status aktif tidak valid.";

const label = z.string({ error: LABEL }).trim().min(1, LABEL).max(60, LABEL);
const model = z.string({ error: MODEL }).trim().regex(/^[\w.:/-]{1,120}$/, MODEL);
const apiKey = z.string({ error: KEY }).trim().regex(/^\S{10,300}$/, KEY);
const prioritas = z.number({ error: PRIO }).int(PRIO).min(1, PRIO).max(1000, PRIO);
const aktif = z.boolean({ error: AKTIF });

export const aiSchema = z.object({
  provider: z.enum(["gemini", "groq", "openrouter", "nvidia"], { error: PENYEDIA }),
  label, model, api_key: apiKey,
  priority: prioritas.default(100),
  is_active: aktif.default(true),
}, { error: "Data penyedia AI tidak valid." });
export type AiInput = z.infer<typeof aiSchema>;

// tanpa default: field yang tidak dikirim tidak diubah; jenis penyedia tidak bisa diganti (buat baru)
export const ubahAiSchema = z.object({ label, model, api_key: apiKey, priority: prioritas, is_active: aktif }, { error: "Data penyedia AI tidak valid." })
  .partial().refine((o) => Object.keys(o).length > 0, "Tidak ada perubahan.");
export type UbahAiInput = z.infer<typeof ubahAiSchema>;
