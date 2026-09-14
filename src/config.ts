import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  PUBLIC_HOSTNAME: z.string().min(1),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default('gpt-4.1'),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),

  N8N_COURSE_WEBHOOK_URL: z.string().url(),
  N8N_LOG_WEBHOOK_URL: z.string().url(),
  N8N_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
  N8N_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  TWILIO_AUTH_TOKEN: z.string().optional(),
  VALIDATE_TWILIO_SIGNATURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  TTS_PROVIDER: z.string().default('ElevenLabs'),
  TTS_VOICE: z.string().default('g6xIsTj2HwM6VR4iXFCw'),
  TRANSCRIPTION_PROVIDER: z.string().default('Deepgram'),
  SPEECH_MODEL: z.string().default('nova-3-general'),
  DEFAULT_LANGUAGE: z.string().default('fr-CA'),

  WELCOME_GREETING: z
    .string()
    .default("Taxi Joliette, bonjour. Je peux prendre votre réservation. D'où partez-vous ?"),

  SESSION_MAX_AGE_MS: z.coerce.number().int().positive().default(30 * 60_000),
  MAX_HISTORY_MESSAGES: z.coerce.number().int().positive().default(40),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(racine)'}: ${i.message}`)
    .join('\n');
  console.error(`Configuration invalide, démarrage annulé :\n${details}`);
  process.exit(1);
}

export const config = parsed.data;

if (config.VALIDATE_TWILIO_SIGNATURE && !config.TWILIO_AUTH_TOKEN) {
  console.error(
    'VALIDATE_TWILIO_SIGNATURE est actif mais TWILIO_AUTH_TOKEN est absent. ' +
      'Fournis le token, ou mets VALIDATE_TWILIO_SIGNATURE=false en développement uniquement.',
  );
  process.exit(1);
}

export type Config = typeof config;
