// Isi file: skema zod untuk isi permintaan `PUT /me/push-token` (mendaftarkan token FCM perangkat pembeli). zod =
// pustaka yang memeriksa bentuk data masuk; data yang tidak lolos dijawab 400. Dipakai routes/notification.ts.
import { z } from "zod";

/** Isi `PUT /me/push-token`: `token` FCM (teks, dipangkas, 1–512 karakter) dan `platform` (`android` atau `web`). */
export const pushTokenSchema = z.object({
  token: z
    .string({ error: "Token notifikasi tidak valid." })
    .trim()
    .min(1, "Token notifikasi tidak valid.")
    .max(512, "Token notifikasi tidak valid."),
  platform: z.enum(["android", "web"], { error: "Platform tidak dikenal." }),
});
/** Isi pendaftaran token yang sudah lolos {@link pushTokenSchema}. */
export type PushTokenInput = z.infer<typeof pushTokenSchema>;
