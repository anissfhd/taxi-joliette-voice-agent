import { randomUUID } from 'node:crypto';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { config } from './config.js';
import { logger } from './logger.js';

export const SYSTEM_PROMPT = `Tu es le standard téléphonique de Taxi Joliette, au Québec. Tu parles au téléphone : tes réponses sont courtes, naturelles, en français québécois courant. Une à deux phrases maximum.

Ton unique mission : recueillir une adresse de départ et une adresse de destination, les faire confirmer, puis enregistrer la course.

Règles absolues :
- Ne jamais appeler l'outil creer_course avant que le client ait confirmé explicitement, à voix haute, les deux adresses que tu viens de lui relire. Un silence, un "hum", ou une reformulation ambiguë ne sont pas une confirmation.
- Relis toujours les deux adresses ensemble avant de demander la confirmation. Exemple : "Donc je vous prends au 245 rue Saint-Charles pour aller au 1500 boulevard Manseau, c'est bien ça ?"
- Si le client corrige une adresse, reprends la relecture complète et redemande une confirmation.
- Si tu n'as pas compris après deux tentatives sur la même information, appelle journaliser_evenement avec evenement "erreur", puis propose de transférer à un répartiteur.
- N'invente jamais une adresse, un délai d'attente, un prix ou un numéro de véhicule. Tu n'as pas cette information.
- Ne prononce jamais de référence technique, d'identifiant ou de terme informatique, sauf si le client demande explicitement sa référence de réservation.

Si l'outil te répond ok:false, lis le champ "action" et applique-le en parlant au client, sans jamais mentionner d'erreur technique.`;

export class Session {
  readonly callSid: string;
  readonly sessionId: string;
  readonly from: string;
  readonly to: string;
  readonly startedAt = Date.now();

  langue: string;
  messages: ChatCompletionMessageParam[];

  /** Chaîne de promesses : garantit qu'une seule action critique tourne à la fois pour ce call_sid. */
  private queue: Promise<unknown> = Promise.resolve();

  private requestId: string | null = null;
  private idCourse: string | null = null;

  /** Annule le flux OpenAI en cours quand le client interrompt. */
  abortController: AbortController | null = null;

  constructor(params: { callSid: string; sessionId: string; from: string; to: string; langue: string }) {
    this.callSid = params.callSid;
    this.sessionId = params.sessionId;
    this.from = params.from;
    this.to = params.to;
    this.langue = params.langue;
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  }

  /**
   * Sérialise les actions critiques par call_sid.
   * Les tool calls passent obligatoirement par ici : deux créations de course
   * pour le même appel ne peuvent pas partir en parallèle vers n8n.
   */
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    // La file continue même si la tâche échoue, sans propager le rejet.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Un seul request_id par appel : réutilisé tel quel sur chaque retry. */
  getOrCreateRequestId(): string {
    if (!this.requestId) {
      this.requestId = `tj-${this.callSid}-${randomUUID()}`;
    }
    return this.requestId;
  }

  markRideCreated(idCourse: string): void {
    this.idCourse = idCourse;
  }

  get courseEnregistree(): boolean {
    return this.idCourse !== null;
  }

  get referenceCourse(): string | null {
    return this.idCourse;
  }

  dureeSecondes(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }

  push(message: ChatCompletionMessageParam): void {
    this.messages.push(message);
    this.trim();
  }

  /** Conserve le prompt système et la fenêtre récente. */
  private trim(): void {
    const max = config.MAX_HISTORY_MESSAGES;
    if (this.messages.length <= max) return;

    const [system, ...rest] = this.messages;
    let cut = rest.length - (max - 1);

    // Ne jamais couper entre un assistant porteur de tool_calls et ses réponses tool.
    while (cut < rest.length && rest[cut]?.role === 'tool') cut++;

    this.messages = system ? [system, ...rest.slice(cut)] : rest.slice(cut);
  }

  /**
   * Sur interruption, l'historique doit refléter ce que le client a réellement
   * entendu, pas ce que le modèle avait prévu de dire.
   */
  truncateLastAssistant(spoken: string | undefined): void {
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    if (typeof last.content !== 'string') return;
    last.content = (spoken ?? '').trim() || '[interrompu]';
  }

  abortInFlight(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}

class SessionStore {
  private sessions = new Map<string, Session>();

  create(session: Session): void {
    this.sessions.set(session.callSid, session);
  }

  get(callSid: string): Session | undefined {
    return this.sessions.get(callSid);
  }

  delete(callSid: string): void {
    this.sessions.delete(callSid);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Filet de sécurité contre les sessions orphelines si un WS ne se ferme pas proprement. */
  sweep(): void {
    const now = Date.now();
    for (const [callSid, session] of this.sessions) {
      if (now - session.startedAt > config.SESSION_MAX_AGE_MS) {
        logger.warn({ callSid }, 'Session expirée, purge');
        session.abortInFlight();
        this.sessions.delete(callSid);
      }
    }
  }
}

export const sessions = new SessionStore();

setInterval(() => sessions.sweep(), 60_000).unref();
