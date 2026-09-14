import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'voice-bridge' },
  redact: {
    paths: ['req.headers.authorization', 'openaiKey', '*.apiKey'],
    remove: true,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function callLogger(callSid: string) {
  return logger.child({ callSid });
}
