// Isi file: pemeriksa isi request dengan skema zod (zod = pustaka untuk menulis aturan bentuk data). `validate` dipasang
// di routes sebelum handler: request masuk → middleware → routes (… → validate(schema)) → handlers → services → database.
// `parse` dan `fieldsFromIssues` dipakai langsung di handler/service untuk data yang diperiksa di tempat lain.
import { RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "../utils/errors";

/**
 * Mengubah daftar kesalahan zod menjadi pesan per kolom, contoh `{ "items.0.qty": ["Minimal 1."] }`.
 * @param issues  daftar kesalahan dari zod
 * @param rootKey kunci untuk kesalahan yang tidak menunjuk kolom tertentu (bawaan `""`)
 * @returns objek kolom → daftar pesan
 */
export const fieldsFromIssues = (issues: readonly z.core.$ZodIssue[], rootKey = "") => {
  const fields: Record<string, string[]> = {};
  for (const issue of issues) (fields[issue.path.join(".") || rootKey] ??= []).push(issue.message);
  return fields;
};

/**
 * Memeriksa data dengan skema zod.
 * @param schema  skema zod
 * @param body    data yang diperiksa
 * @param rootKey kunci untuk kesalahan yang tidak menunjuk kolom tertentu
 * @returns data yang sudah diperiksa dan dirapikan skema (contoh teks dipangkas, nilai bawaan diisi)
 * @throws 400 VALIDATION_ERROR berisi pesan per kolom bila data tidak sesuai skema
 */
export const parse = <Schema extends z.ZodType>(schema: Schema, body: unknown, rootKey = ""): z.output<Schema> => {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fieldsFromIssues(result.error.issues, rootKey));
  return result.data;
};

/**
 * Membuat middleware pemeriksa body request. Bila lolos, `req.body` diganti dengan data yang sudah dirapikan skema.
 * @param schema skema zod untuk body
 * @returns middleware yang meneruskan galat 400 VALIDATION_ERROR (pesan per kolom) bila body tidak sesuai
 */
export const validate =
  (schema: z.ZodType): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fieldsFromIssues(result.error.issues)));
      return;
    }
    req.body = result.data;
    next();
  };
