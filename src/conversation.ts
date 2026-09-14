import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { config } from './config.js';
import { callLogger } from './logger.js';
import { toolDefinitions, executerToolCall } from './tools.js';
import type { Session } from './session.js';

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
  timeout: config.OPENAI_TIMEOUT_MS,
});

export type TokenSink = (token: string, last: boolean) => void;

const MAX_TOOL_ROUNDS = 3;

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

/**
 * Un tour de conversation : streame la réponse token par token vers
 * ConversationRelay, qui la synthétise en voix au fil de l'eau.
 */
export async function traiterTour(session: Session, sink: TokenSink): Promise<void> {
  const log = callLogger(session.callSid);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const controller = new AbortController();
    session.abortController = controller;

    let spoken = '';
    const toolCalls = new Map<number, ToolCallAccumulator>();
    let finishReason: string | null = null;

    try {
      const stream = await openai.chat.completions.create(
        {
          model: config.OPENAI_MODEL,
          messages: session.messages,
          tools: toolDefinitions,
          tool_choice: 'auto',
          parallel_tool_calls: false,
          temperature: 0.4,
          max_tokens: 300,
          stream: true,
        },
        { signal: controller.signal },
      );

      for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;

        if (delta?.content) {
          spoken += delta.content;
          sink(delta.content, false);
        }

        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const acc = toolCalls.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolCalls.set(idx, acc);
        }
      }
    } catch (err) {
      session.abortController = null;

      if (controller.signal.aborted) {
        // Interruption volontaire du client : l'historique est recalé ailleurs.
        log.debug('Flux OpenAI interrompu par le client');
        return;
      }

      log.error({ err: String(err) }, 'Échec du flux OpenAI');
      const secours =
        "Désolé, je vous ai mal entendu. Pouvez-vous répéter votre adresse de départ ?";
      sink(secours, true);
      session.push({ role: 'assistant', content: secours });
      return;
    }

    session.abortController = null;

    if (toolCalls.size === 0) {
      sink('', true);
      session.push({ role: 'assistant', content: spoken });
      return;
    }

    // Le modèle demande un outil : on clôt d'abord la parole en cours.
    if (spoken) sink('', true);

    const calls: ChatCompletionMessageToolCall[] = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) => ({
        id: acc.id || `call_${Math.random().toString(36).slice(2)}`,
        type: 'function' as const,
        function: { name: acc.name, arguments: acc.args },
      }));

    session.push({
      role: 'assistant',
      content: spoken || null,
      tool_calls: calls,
    });

    for (const call of calls) {
      // Sérialisation par call_sid : aucune exécution concurrente pour cet appel.
      const result = await session.runExclusive(() =>
        executerToolCall(session, call.function.name, call.function.arguments),
      );

      session.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result.payload),
      });
    }

    if (finishReason && finishReason !== 'tool_calls') break;
  }

  const repli =
    "Je n'arrive pas à finaliser votre réservation à l'instant. Un répartiteur va vous rappeler tout de suite.";
  sink(repli, true);
  session.push({ role: 'assistant', content: repli });
  callLogger(session.callSid).warn('Nombre maximum de tours outil atteint');
}
