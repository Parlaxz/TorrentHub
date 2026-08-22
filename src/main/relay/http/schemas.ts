import { z } from "zod";

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const idParamSchema = z.object({ id: z.string().regex(SAFE_ID_RE) });

const idempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_RE).nullish();

export const intakeCreateSchema = z.strictObject({
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("magnet"),
      value: z
        .string()
        .min(8)
        .max(4096)
        .refine((v) => /^magnet:\?/i.test(v), { message: "source.value must be a magnet URI" }),
    }),
    z.strictObject({
      kind: z.literal("url"),
      value: z
        .url()
        .max(2048)
        .refine((v) => /^https?:\/\//i.test(v), { message: "only http(s) URLs are accepted" }),
    }),
  ]),
  idempotencyKey: idempotencyKeySchema,
});

export const jobCreateSchema = z.strictObject({
  intakeId: z.string().regex(SAFE_ID_RE),
  selection: z.array(z.number().int().min(0).max(1_000_000)).max(10_000).nullish(),
  zipRequired: z.boolean().nullish(),
  idempotencyKey: idempotencyKeySchema,
  cleanup: z
    .strictObject({
      deleteTorrent: z.boolean(),
      deleteFiles: z.boolean(),
      deleteZip: z.boolean(),
    })
    .partial()
    .nullish(),
});

export const pairRequestSchema = z.strictObject({
  code: z
    .string()
    .transform((v) => v.replace(/[\s-]+/g, ""))
    .pipe(z.string().regex(/^[A-HJ-KM-NP-Z2-9]{6,10}$/i, { message: "invalid pairing code format" })),
  name: z.string().trim().min(1).max(64).optional(),
});

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export function formatIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}
