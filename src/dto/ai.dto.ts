import { z } from "zod";

// F22 AI gateway (admin). Alamat API tidak bisa diisi: hanya jenis penyedia yang dikenal (lihat JENIS di ai.service).
const PROVIDER_MSG = "Pilih penyedia AI.";
const LABEL_MSG = "Nama 1–60 karakter.";
const MODEL_MSG = "Nama model 1–120 karakter: huruf, angka, titik, titik dua, garis miring, strip.";
const API_KEY_MSG = "API key 10–300 karakter tanpa spasi.";
const PRIORITY_MSG = "Prioritas 1–1000 (kecil dicoba lebih dulu).";
const ACTIVE_MSG = "Status aktif tidak valid.";

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
export type AiProviderInput = z.infer<typeof aiProviderSchema>;

// tanpa default: field yang tidak dikirim tidak diubah; jenis penyedia tidak bisa diganti (buat baru)
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
export type UpdateAiProviderInput = z.infer<typeof updateAiProviderSchema>;

// F25: rentang dasbor pemakaian; nilai aneh → 7 hari (seperti halaman/limit)
export const aiUsageSchema = z.object({ days: z.coerce.number().int().min(1).max(90).catch(7) });
