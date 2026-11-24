// Isi file: skema zod untuk menu AI gateway admin super: tambah dan ubah penyedia AI, serta query rentang pemakaian.
// Alamat API tidak bisa diisi; admin hanya memilih jenis penyedia yang dikenal (lihat PROVIDER_TYPES di ai.service).
// Dipakai routes/admin.ts dan handlers/ai.handler.ts. Data yang tidak lolos dijawab 400 beserta pesan per kolom.
import { z } from "zod";

const PROVIDER_MSG = "Pilih penyedia AI.";
const LABEL_MSG = "Nama 1–60 karakter.";
const MODEL_MSG = "Nama model 1–120 karakter: huruf, angka, titik, titik dua, garis miring, strip.";
const API_KEY_MSG = "API key 10–300 karakter tanpa spasi.";
const PRIORITY_MSG = "Prioritas 1–1000 (kecil dicoba lebih dulu).";
const ACTIVE_MSG = "Status aktif tidak valid.";

// Aturan setiap kolom; pesan galatnya sama untuk semua pelanggaran di kolom itu.
const labelSchema = z.string({ error: LABEL_MSG }).trim().min(1, LABEL_MSG).max(60, LABEL_MSG);
const modelSchema = z
  .string({ error: MODEL_MSG })
  .trim()
  .regex(/^[\w.:/-]{1,120}$/, MODEL_MSG);
const apiKeySchema = z
  .string({ error: API_KEY_MSG })
  .trim()
  .regex(/^\S{10,300}$/, API_KEY_MSG);
const prioritySchema = z.number({ error: PRIORITY_MSG }).int(PRIORITY_MSG).min(1, PRIORITY_MSG).max(1000, PRIORITY_MSG);
const activeSchema = z.boolean({ error: ACTIVE_MSG });

/**
 * Isi menambah penyedia AI: jenis penyedia, label, nama model, API key, prioritas (bawaan 100; angka kecil dicoba
 * lebih dulu), dan status aktif (bawaan aktif).
 */
export const aiProviderSchema = z.object(
  {
    provider: z.enum(["gemini", "groq", "openrouter", "nvidia"], { error: PROVIDER_MSG }),
    label: labelSchema,
    model: modelSchema,
    api_key: apiKeySchema,
    priority: prioritySchema.default(100),
    is_active: activeSchema.default(true),
  },
  { error: "Data penyedia AI tidak valid." },
);
/** Bentuk isian penyedia AI yang sudah lolos aiProviderSchema. */
export type AiProviderInput = z.infer<typeof aiProviderSchema>;

/**
 * Isi mengubah penyedia AI: semua kolom opsional dan tanpa nilai bawaan, jadi kolom yang tidak dikirim tidak diubah.
 * Minimal satu kolom harus dikirim. Jenis penyedia tidak bisa diganti (buat penyedia baru).
 */
export const updateAiProviderSchema = z
  .object(
    {
      label: labelSchema,
      model: modelSchema,
      api_key: apiKeySchema,
      priority: prioritySchema,
      is_active: activeSchema,
    },
    { error: "Data penyedia AI tidak valid." },
  )
  .partial()
  .refine((input) => Object.keys(input).length > 0, "Tidak ada perubahan.");
/** Bentuk isian ubah penyedia AI yang sudah lolos updateAiProviderSchema. */
export type UpdateAiProviderInput = z.infer<typeof updateAiProviderSchema>;

/** Query `days` dasbor pemakaian AI: 1–90 hari; nilai yang tidak valid dianggap 7 (tidak ditolak). */
export const aiUsageSchema = z.object({ days: z.coerce.number().int().min(1).max(90).catch(7) });
