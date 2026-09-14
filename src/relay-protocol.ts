import { z } from 'zod';

/**
 * Messages entrants envoyés par Twilio ConversationRelay sur le WebSocket.
 * ConversationRelay assure le STT et le TTS : on ne reçoit et n'envoie que du texte.
 */

export const SetupMessage = z.object({
  type: z.literal('setup'),
  sessionId: z.string(),
  callSid: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  direction: z.string().optional(),
  callStatus: z.string().optional(),
  customParameters: z.record(z.string()).optional(),
});

export const PromptMessage = z.object({
  type: z.literal('prompt'),
  voicePrompt: z.string(),
  lang: z.string().optional(),
  last: z.boolean().optional(),
});

export const InterruptMessage = z.object({
  type: z.literal('interrupt'),
  utteranceUntilInterrupt: z.string().optional(),
  durationUntilInterruptMs: z.number().optional(),
});

export const DtmfMessage = z.object({
  type: z.literal('dtmf'),
  digit: z.string(),
});

export const ErrorMessage = z.object({
  type: z.literal('error'),
  description: z.string().optional(),
});

export const InboundMessage = z.discriminatedUnion('type', [
  SetupMessage,
  PromptMessage,
  InterruptMessage,
  DtmfMessage,
  ErrorMessage,
]);

export type InboundMessage = z.infer<typeof InboundMessage>;
export type SetupMessage = z.infer<typeof SetupMessage>;

/** Messages sortants vers ConversationRelay. */
export type OutboundMessage =
  | { type: 'text'; token: string; last: boolean; interruptible?: boolean; preemptible?: boolean }
  | { type: 'play'; source: string; loop?: number; preemptible?: boolean }
  | { type: 'sendDigits'; digits: string }
  | { type: 'language'; ttsLanguage?: string; transcriptionLanguage?: string }
  | { type: 'end'; handoffData?: string };
