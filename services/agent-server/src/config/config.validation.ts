import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).default(3000),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  MEM_WINDOW_SIZE: z.coerce.number().int().min(1).default(15),
  HANDLE_TTL_SECONDS: z.coerce.number().int().min(0).default(7200),
  ALLOWED_CHAT_ID: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : null;
    })
    .default(null),
  OPENAI_API_KEY: z.string().optional().default(''),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
});

export type EnvSchema = z.infer<typeof envSchema>;

export const validateEnv = (config: Record<string, unknown>): EnvSchema => {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const formatted = parsed.error.flatten();
    throw new Error(
      `Config validation error: ${JSON.stringify(formatted.fieldErrors)}`,
    );
  }

  return parsed.data;
};
