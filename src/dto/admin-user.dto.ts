// Isi file: skema isi permintaan admin untuk mengubah akun penjual dan pembeli. Aturan kolomnya sama dengan
// PATCH /me (auth.dto), supaya nama, nomor WA, dan email diperiksa dengan cara yang sama di semua tempat.
import { z } from "zod";
import { updateMeSchema } from "./auth.dto";

/**
 * Isi `PATCH /admin/merchants/:id/owner` dan `PATCH /admin/customers/:id`: nama, nomor WA, dan/atau email (semua
 * opsional; minimal satu dicek di service). Email `""`/`null` berarti dikosongkan.
 */
export const adminAccountUpdateSchema = updateMeSchema.pick({ full_name: true, phone: true, email: true });

/** Isi yang sudah lolos {@link adminAccountUpdateSchema}. */
export type AdminAccountUpdateInput = z.infer<typeof adminAccountUpdateSchema>;
