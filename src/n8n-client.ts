import { config } from './config.js';
import { logger } from './logger.js';

export interface CoursePayload {
  request_id: string;
  nom_client: string;
  telephone_client: string;
  adresse_depart: string;
  adresse_destination: string;
  moment_prise_en_charge: 'immediat' | 'differe';
  heure_souhaitee: string;
  nb_passagers: number;
  notes: string;
  langue: string;
  confirmation_client: true;
  call_sid: string;
  duree_appel_s: number;
  resume_transcription: string;
}

export interface CourseResponse {
  ok: boolean;
  doublon?: boolean;
  id_course?: string;
  raison?: string;
  action?: string;
  message?: string;
}

export interface LogPayload {
  call_sid: string;
  telephone_client: string;
  evenement:
    | 'appel_debut'
    | 'adresse_extraite'
    | 'confirmation_demandee'
    | 'correction'
    | 'course_creee'
    | 'abandon'
    | 'erreur';
  detail: string;
  latence_ms: number;
  erreur: string;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

async function postJson<T>(
  url: string,
  body: unknown,
  opts: { retries: number; timeoutMs: number; label: string },
): Promise<{ status: number; body: T | null }> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await res.text();
      let parsed: T | null = null;
      try {
        parsed = text ? (JSON.parse(text) as T) : null;
      } catch {
        parsed = null;
      }

      // 4xx métier (dont le 422 de refus) : réponse définitive, on ne retente pas.
      if (!RETRYABLE_STATUS.has(res.status)) {
        return { status: res.status, body: parsed };
      }

      lastError = new Error(`${opts.label}: HTTP ${res.status}`);
      logger.warn({ url, status: res.status, attempt }, `${opts.label} : statut réessayable`);
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      logger.warn({ url, attempt, err: String(err) }, `${opts.label} : échec réseau`);
    }

    if (attempt < opts.retries) {
      const backoff = 250 * 2 ** attempt + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${opts.label} : échec`);
}

/**
 * Crée la course. Le request_id est fourni par l'appelant et DOIT rester
 * identique sur chaque retry : c'est la clé d'idempotence côté n8n.
 */
export async function creerCourse(payload: CoursePayload): Promise<CourseResponse> {
  const { status, body } = await postJson<CourseResponse>(
    config.N8N_COURSE_WEBHOOK_URL,
    payload,
    { retries: config.N8N_MAX_RETRIES, timeoutMs: config.N8N_TIMEOUT_MS, label: 'n8n course' },
  );

  if (body) return body;

  return {
    ok: false,
    raison: `reponse_n8n_illisible_http_${status}`,
    action: 'Prevenir le client que la reservation ne peut pas etre confirmee maintenant',
  };
}

export async function journaliser(payload: LogPayload): Promise<void> {
  try {
    await postJson<{ ok: boolean }>(config.N8N_LOG_WEBHOOK_URL, payload, {
      retries: 1,
      timeoutMs: config.N8N_TIMEOUT_MS,
      label: 'n8n log',
    });
  } catch (err) {
    // Le journal ne doit jamais casser un appel en cours.
    logger.error({ err: String(err), evenement: payload.evenement }, 'Journalisation n8n échouée');
  }
}
