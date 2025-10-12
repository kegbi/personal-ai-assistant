import { z } from 'zod';
import { DEFAULT_LLM_MODEL, DEFAULT_REDIS_HOST } from './config.defaults';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).default(3000),
  REDIS_HOST: z.string().default(DEFAULT_REDIS_HOST),
  REDIS_PORT: z.coerce.number().int().default(6379),
  MEM_WINDOW_SIZE: z.coerce.number().int().min(1).default(15),
  HANDLE_TTL_SECONDS: z.coerce.number().int().min(0).default(7200),
  OPENAI_API_KEY: z.string().optional().default(''),
  LLM_MODEL: z.string().default(DEFAULT_LLM_MODEL),
  MONICA_API_URL: z.string().url().default('https://app.monicahq.com/api'),
  MONICA_API_TOKEN: z.string().min(1, 'MONICA_API_TOKEN is required'),
  MONICA_WEB_URL: z.string().url().default('https://app.monicahq.com'),
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
