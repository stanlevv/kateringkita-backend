import { RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "../utils/errors";

// Issue zod -> { "path": [pesan] }; issue tanpa path memakai kunci `akar`.
export const fieldsFromIssues = (issues: readonly z.core.$ZodIssue[], rootKey = "") => {
  const fields: Record<string, string[]> = {};
  for (const issue of issues) (fields[issue.path.join(".") || rootKey] ??= []).push(issue.message);
  return fields;
};

// Parse atau lempar 400 VALIDATION_ERROR dengan fields.
export const parse = <T extends z.ZodType>(schema: T, body: unknown, rootKey = ""): z.output<T> => {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fieldsFromIssues(result.error.issues, rootKey));
  return result.data;
};

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
