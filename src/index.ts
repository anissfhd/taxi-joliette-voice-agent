import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import twilio from 'twilio';
import { config } from './config.js';
import { logger, callLogger } from './logger.js';
import { InboundMessage, type OutboundMessage } from './relay-protocol.js';
import { Session, sessions } from './session.js';
import { traiterTour } from './conversation.js';
import { journaliser } from './n8n-client.js';

const startedAt = Date.now();

/* ------------------------------------------------------------------ */
/* TwiML : Twilio appelle cet endpoint à la réception de l'appel       */
/* ------------------------------------------------------------------ */

function buildTwiml(): string {
  const wsUrl = `wss://${config.PUBLIC_HOSTNAME}/relay`;
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${esc(wsUrl)}"
      welcomeGreeting="${esc(config.WELCOME_GREETING)}"
      language="${esc(config.DEFAULT_LANGUAGE)}"
      ttsProvider="${esc(config.TTS_PROVIDER)}"
      voice="${esc(config.TTS_VOICE)}"
      transcriptionProvider="${esc(config.TRANSCRIPTION_PROVIDER)}"
      speechModel="${esc(config.SPEECH_MODEL)}"
      interruptible="any"
      interruptSensitivity="medium"
      reportInputDuringAgentSpeech="speech"
      dtmfDetection="true" />
  </Connect>
</Response>`;
}

function validateTwilioSignature(req: http.IncomingMessage, body: string): boolean {
  if (!config.VALIDATE_TWILIO_SIGNATURE) return true;

  const signature = req.headers['x-twilio-signature'];
  if (typeof signature !== 'string') return false;

  const url = `https://${config.PUBLIC_HOSTNAME}${req.url ?? ''}`;
  const params = Object.fromEntries(new URLSearchParams(body));

  return twilio.validateRequest(config.TWILIO_AUTH_TOKEN as string, signature, url, params);
}

/* ------------------------------------------------------------------ */
/* Serveur HTTP : TwiML + health checks                                */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Liveness : le process répond-il ? Aucune dépendance externe.
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        sessions_actives: sessions.size,
      }),
    );
    return;
  }

  // Readiness : les dépendances critiques répondent-elles ?
  if (req.method === 'GET' && url.pathname === '/ready') {
    void (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      let n8nOk = false;
      try {
        const probe = await fetch(config.N8N_LOG_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ evenement: 'inconnu', detail: 'readiness probe', latence_ms: 0 }),
          signal: controller.signal,
        });
        n8nOk = probe.ok;
      } catch {
        n8nOk = false;
      } finally {
        clearTimeout(timer);
      }

      const ready = n8nOk;
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready, n8n: n8nOk }));
    })();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/twiml') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.destroy();
    });
    req.on('end', () => {
      if (!validateTwilioSignature(req, body)) {
        logger.warn('Signature Twilio invalide sur /twiml');
        res.writeHead(403).end('Forbidden');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(buildTwiml());
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

/* ------------------------------------------------------------------ */
/* WebSocket : ConversationRelay                                       */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/relay') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function send(ws: WebSocket, message: OutboundMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

wss.on('connection', (ws: WebSocket) => {
  let session: Session | null = null;
  let alive = true;

  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 30_000);

  ws.on('pong', () => {
    alive = true;
  });

  ws.on('message', (raw) => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.toString());
    } catch {
      logger.warn('Message ConversationRelay non parsable');
      return;
    }

    const parsed = InboundMessage.safeParse(parsedJson);
    if (!parsed.success) {
      logger.debug({ issues: parsed.error.issues }, 'Message ConversationRelay ignoré');
      return;
    }

    const msg = parsed.data;

    if (msg.type === 'setup') {
      session = new Session({
        callSid: msg.callSid,
        sessionId: msg.sessionId,
        from: msg.from ?? '',
        to: msg.to ?? '',
        langue: config.DEFAULT_LANGUAGE.startsWith('en') ? 'en' : 'fr',
      });
      sessions.create(session);
      callLogger(session.callSid).info({ from: session.from }, 'Appel connecté');

      void journaliser({
        call_sid: session.callSid,
        telephone_client: session.from,
        evenement: 'appel_debut',
        detail: `session=${msg.sessionId}`,
        latence_ms: 0,
        erreur: '',
      });
      return;
    }

    if (!session) {
      logger.warn({ type: msg.type }, 'Message reçu avant le setup, ignoré');
      return;
    }

    const current = session;
    const log = callLogger(current.callSid);

    if (msg.type === 'interrupt') {
      log.debug({ spoken: msg.utteranceUntilInterrupt }, 'Client interrompt');
      current.abortInFlight();
      current.truncateLastAssistant(msg.utteranceUntilInterrupt);
      return;
    }

    if (msg.type === 'dtmf') {
      current.push({ role: 'user', content: `[touche ${msg.digit}]` });
      return;
    }

    if (msg.type === 'error') {
      log.error({ description: msg.description }, 'Erreur signalée par ConversationRelay');
      void journaliser({
        call_sid: current.callSid,
        telephone_client: current.from,
        evenement: 'erreur',
        detail: msg.description ?? 'erreur ConversationRelay',
        latence_ms: 0,
        erreur: msg.description ?? '',
      });
      return;
    }

    if (msg.type === 'prompt') {
      if (msg.last === false) return; // fragment intermédiaire, on attend la fin de l'énoncé

      const texte = msg.voicePrompt.trim();
      if (!texte) return;

      current.push({ role: 'user', content: texte });

      void traiterTour(current, (token, last) => {
        if (token || last) send(ws, { type: 'text', token, last });
      }).catch((err) => {
        log.error({ err: String(err) }, 'Tour de conversation échoué');
      });
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    if (!session) return;

    const current = session;
    current.abortInFlight();
    callLogger(current.callSid).info(
      { dureeS: current.dureeSecondes(), courseEnregistree: current.courseEnregistree },
      'Appel terminé',
    );

    if (!current.courseEnregistree) {
      void journaliser({
        call_sid: current.callSid,
        telephone_client: current.from,
        evenement: 'abandon',
        detail: `raccroche sans course, duree=${current.dureeSecondes()}s`,
        latence_ms: 0,
        erreur: '',
      });
    }

    sessions.delete(current.callSid);
  });

  ws.on('error', (err) => {
    logger.error({ err: String(err) }, 'Erreur WebSocket');
  });
});

/* ------------------------------------------------------------------ */
/* Démarrage et arrêt propre                                           */
/* ------------------------------------------------------------------ */

server.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, hostname: config.PUBLIC_HOSTNAME, model: config.OPENAI_MODEL },
    'Voice Bridge démarré',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'Arrêt en cours');
  server.close(() => process.exit(0));
  wss.clients.forEach((ws) => ws.close(1001, 'server shutting down'));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
