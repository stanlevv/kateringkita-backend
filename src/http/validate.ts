import { RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "./errors";

// Issue zod -> { "path": [pesan] }; issue tanpa path memakai kunci `akar`.
export const fieldsDari = (issues: readonly z.core.$ZodIssue[], akar = "") => {
  const fields: Record<string, string[]> = {};
  for (const i of issues) (fields[i.path.join(".") || akar] ??= []).push(i.message);
  return fields;
};

// Parse atau lempar 400 VALIDATION_ERROR dengan fields.
export const parse = <T extends z.ZodType>(schema: T, body: unknown, akar = ""): z.output<T> => {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fieldsDari(r.error.issues, akar));
  return r.data;
};

export const validate =
  (schema: z.ZodType): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fieldsDari(result.error.issues)));
      return;
    }
    req.body = result.data;
    next();
  };
