import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { creerCourse, journaliser, type CoursePayload } from './n8n-client.js';
import type { Session } from './session.js';
import { callLogger } from './logger.js';

/**
 * Validation stricte des arguments produits par le modèle.
 * La normalisation tolérante de n8n est une seconde ligne de défense :
 * rien de non conforme ne doit sortir d'ici.
 */

const AdresseSchema = z
  .string()
  .trim()
  .min(5, 'adresse trop courte pour etre exploitable')
  .max(200, 'adresse trop longue');

const HeureSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'heure attendue au format HH:MM');

export const CreerCourseArgs = z
  .object({
    adresse_depart: AdresseSchema,
    adresse_destination: AdresseSchema,
    confirmation_client: z.literal(true, {
      errorMap: () => ({
        message: 'confirmation_client doit valoir true : ne jamais appeler cet outil sans un accord explicite du client',
      }),
    }),
    nom_client: z.string().trim().max(120).default(''),
    moment_prise_en_charge: z.enum(['immediat', 'differe']).default('immediat'),
    heure_souhaitee: HeureSchema.optional().default(''),
    nb_passagers: z.coerce.number().int().min(1).max(8).default(1),
    notes: z.string().trim().max(500).default(''),
    resume_transcription: z.string().trim().max(500).default(''),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.moment_prise_en_charge === 'differe' && !val.heure_souhaitee) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['heure_souhaitee'],
        message: 'heure_souhaitee est obligatoire quand moment_prise_en_charge vaut differe',
      });
    }
    if (
      val.adresse_depart.toLowerCase() === val.adresse_destination.toLowerCase()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['adresse_destination'],
        message: 'depart et destination sont identiques : redemander la destination',
      });
    }
  });

export const JournaliserArgs = z
  .object({
    evenement: z.enum([
      'appel_debut',
      'adresse_extraite',
      'confirmation_demandee',
      'correction',
      'course_creee',
      'abandon',
      'erreur',
    ]),
    detail: z.string().trim().max(500).default(''),
  })
  .strict();

export const toolDefinitions: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'creer_course',
      description:
        "Enregistre une course de taxi. N'appeler cet outil QUE lorsque le client a explicitement confirmé à voix haute l'adresse de départ ET la destination que tu viens de lui relire. Ne jamais l'appeler pour vérifier ou préparer quelque chose.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['adresse_depart', 'adresse_destination', 'confirmation_client'],
        properties: {
          adresse_depart: { type: 'string', description: "Adresse de prise en charge, telle que confirmée" },
          adresse_destination: { type: 'string', description: 'Adresse de destination, telle que confirmée' },
          confirmation_client: {
            type: 'boolean',
            enum: [true],
            description: "Doit valoir true. Preuve que le client a confirmé explicitement.",
          },
          nom_client: { type: 'string', description: 'Nom du client si donné, sinon chaîne vide' },
          moment_prise_en_charge: { type: 'string', enum: ['immediat', 'differe'] },
          heure_souhaitee: { type: 'string', description: 'Format HH:MM, obligatoire si differe' },
          nb_passagers: { type: 'integer', minimum: 1, maximum: 8 },
          notes: { type: 'string', description: 'Précision utile au chauffeur' },
          resume_transcription: { type: 'string', description: "Résumé d'une phrase de l'échange" },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'journaliser_evenement',
      description:
        "Trace un événement technique de l'appel. À appeler quand le client corrige une adresse, abandonne, ou quand tu ne comprends pas après deux tentatives.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['evenement'],
        properties: {
          evenement: {
            type: 'string',
            enum: [
              'appel_debut',
              'adresse_extraite',
              'confirmation_demandee',
              'correction',
              'course_creee',
              'abandon',
              'erreur',
            ],
          },
          detail: { type: 'string' },
        },
      },
    },
  },
];

export interface ToolResult {
  /** Renvoyé au modèle dans le message role:"tool". */
  payload: Record<string, unknown>;
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join('.') || 'argument'}: ${i.message}`)
    .join(' | ');
}

/**
 * Exécute un tool call. Toute l'exécution est sérialisée par call_sid
 * en amont (voir Session.runExclusive) : deux tool calls du même appel
 * ne peuvent jamais s'exécuter en parallèle.
 */
export async function executerToolCall(
  session: Session,
  name: string,
  rawArguments: string,
): Promise<ToolResult> {
  const log = callLogger(session.callSid);
  const started = Date.now();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawArguments || '{}');
  } catch {
    log.warn({ tool: name }, 'Arguments de tool call non parsables');
    return {
      payload: {
        ok: false,
        erreur: 'arguments_invalides',
        detail: 'Les arguments ne sont pas du JSON valide. Reformule ta demande.',
      },
    };
  }

  if (name === 'journaliser_evenement') {
    const parsed = JournaliserArgs.safeParse(parsedJson);
    if (!parsed.success) {
      return {
        payload: { ok: false, erreur: 'validation', detail: formatZodError(parsed.error) },
      };
    }
    await journaliser({
      call_sid: session.callSid,
      telephone_client: session.from,
      evenement: parsed.data.evenement,
      detail: parsed.data.detail,
      latence_ms: Date.now() - started,
      erreur: '',
    });
    return { payload: { ok: true } };
  }

  if (name !== 'creer_course') {
    log.warn({ tool: name }, 'Outil inconnu demandé par le modèle');
    return { payload: { ok: false, erreur: 'outil_inconnu' } };
  }

  const parsed = CreerCourseArgs.safeParse(parsedJson);
  if (!parsed.success) {
    const detail = formatZodError(parsed.error);
    log.warn({ tool: name, detail }, 'Tool call rejeté par la validation locale');
    await journaliser({
      call_sid: session.callSid,
      telephone_client: session.from,
      evenement: 'erreur',
      detail: `validation_locale_echouee: ${detail}`,
      latence_ms: Date.now() - started,
      erreur: detail,
    });
    return {
      payload: {
        ok: false,
        erreur: 'validation',
        detail,
        action: "Demande au client l'information manquante ou incorrecte, puis rappelle l'outil.",
      },
    };
  }

  // Idempotence : un seul request_id par appel téléphonique, réutilisé sur tous les retries.
  const requestId = session.getOrCreateRequestId();

  const payload: CoursePayload = {
    request_id: requestId,
    nom_client: parsed.data.nom_client,
    telephone_client: session.from,
    adresse_depart: parsed.data.adresse_depart,
    adresse_destination: parsed.data.adresse_destination,
    moment_prise_en_charge: parsed.data.moment_prise_en_charge,
    heure_souhaitee: parsed.data.heure_souhaitee,
    nb_passagers: parsed.data.nb_passagers,
    notes: parsed.data.notes,
    langue: session.langue,
    confirmation_client: true,
    call_sid: session.callSid,
    duree_appel_s: session.dureeSecondes(),
    resume_transcription: parsed.data.resume_transcription,
  };

  try {
    const res = await creerCourse(payload);
    log.info({ requestId, ok: res.ok, doublon: res.doublon, idCourse: res.id_course }, 'Réponse n8n');

    if (res.ok && res.id_course) {
      session.markRideCreated(res.id_course);
      return {
        payload: {
          ok: true,
          id_course: res.id_course,
          deja_enregistree: Boolean(res.doublon),
          instruction:
            "Confirme au client que la course est enregistrée et donne-lui la référence si il la demande.",
        },
      };
    }

    return {
      payload: {
        ok: false,
        erreur: res.raison ?? 'refus_n8n',
        action: res.action ?? 'Redemande au client la confirmation ou l information manquante.',
      },
    };
  } catch (err) {
    log.error({ err: String(err), requestId }, 'Appel n8n définitivement échoué');
    return {
      payload: {
        ok: false,
        erreur: 'systeme_indisponible',
        action:
          "Excuse-toi, dis au client que la réservation ne peut pas être enregistrée à l'instant et qu'un répartiteur le rappelle. Ne raccroche pas brutalement.",
      },
    };
  }
}
