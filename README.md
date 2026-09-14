# Taxi Joliette — AI voice agent

> A customer calls a phone number, talks to an AI in Québécois French, gives a pickup and a destination — and a ride is created in the dispatch system. No app, no menu, no "press 1". The hard part isn't the conversation: it's **never creating the same ride twice**.

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js%2022-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Twilio](https://img.shields.io/badge/Twilio%20ConversationRelay-F22F46?logo=twilio&logoColor=white)](https://www.twilio.com/docs/voice/conversationrelay)
[![OpenAI](https://img.shields.io/badge/OpenAI-412991?logo=openai&logoColor=white)](https://openai.com/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Zod](https://img.shields.io/badge/Zod-3E67B1)](https://zod.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

🇫🇷 [Lire ce document en français](README.fr.md)

---

## The call flow

```
Phone call
    |
    v
Twilio number  --POST /twiml-->  returns <ConversationRelay>
    |
    v
Twilio ConversationRelay          (Deepgram STT + ElevenLabs TTS, fr-CA)
    |  wss://.../relay             text in, text out
    v
+---------------------------+
|       Voice Bridge        |     this service
|  sessions, streaming,     |
|  interruptions, tool calls|
+------------+--------------+
             |
        +----+----+
        |         |
        v         v
     OpenAI      n8n  -->  Taxi Joliette API  -->  ride created
   (text LLM)  (business logic)
```

ConversationRelay handles speech-to-text and text-to-speech. **This service only ever touches text** and delegates every business decision to n8n. That separation is what keeps it small enough to reason about.

The model's reply is streamed **token by token**, so the voice starts speaking before generation finishes. On a phone call, that difference is the gap between "natural" and "broken".

---

## The real problem: never create a ride twice

A phone call is a hostile environment for exactly-once semantics. The network drops, the caller repeats themselves, a retry fires. Two guards handle this, and **they are complementary — removing either one reopens the hole**:

| Guard | Mechanism | What it covers |
|---|---|---|
| **Serialization by `call_sid`** | `Session.runExclusive` chains a promise per call | Two tool calls from the same call can never reach n8n in parallel — closes the race window between n8n's `SELECT` and `INSERT` |
| **Idempotency by `request_id`** | `Session.getOrCreateRequestId` issues one id per call, reused verbatim on every retry | Network retries and restarts — n8n looks the id up before inserting and returns the existing ride if found |

Serialization alone loses to a restart. Idempotency alone loses to a concurrent in-flight pair. Together they hold.

---

## Strict tool validation

Everything the model wants to do goes through Zod `.strict()` schemas in [`src/tools.ts`](src/tools.ts) — any unknown argument is rejected outright.

The load-bearing line is this one:

```ts
confirmation_client: z.literal(true)
```

`true` is the only accepted value. **The model cannot create a ride without explicitly asserting that the customer confirmed.** This is not a prompt instruction the model might drift away from — it is a type constraint enforced before any call reaches n8n.

Rejections are sent back to the model as a readable `tool` message carrying an `action` field that tells it what to ask the customer next, so a validation failure turns into a clarifying question rather than a dead end.

### Tools exposed to the model

| Tool | Purpose | Key constraints |
|---|---|---|
| `creer_course` | Create the ride | `confirmation_client` must be literal `true`; `heure_souhaitee` required when `moment_prise_en_charge` is `differe`; 1–8 passengers |
| `journaliser_evenement` | Log a call event | Enumerated event types, including `abandon` when the caller hangs up before confirming |

Permissive normalization on the n8n side remains a **second** line of defence, not the first.

---

## Endpoints

| Method | Route | Role |
|---|---|---|
| `POST` | `/twiml` | Returns the `<ConversationRelay>` TwiML — this is Twilio's webhook target |
| `GET` | `/health` | Liveness, no external dependency. Backs the Docker `HEALTHCHECK` |
| `GET` | `/ready` | Actually probes n8n reachability |
| `WS` | `/relay` | The ConversationRelay WebSocket: sessions, context, interruptions |

Use `/ready` for external monitoring, **not** for automatic restarts — an n8n outage would otherwise put the container in a restart loop.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Telephony | Twilio ConversationRelay | STT and TTS handled upstream; the bridge stays text-only |
| STT | Deepgram `nova-3-general` | fr-CA support |
| TTS | ElevenLabs | Voice quality is what the client judges the product on |
| LLM | OpenAI, streamed | Token streaming so speech starts early |
| Business logic | n8n webhooks | Ride creation and journaling live outside this service |
| Validation | Zod `.strict()` | Rejects anything the schema did not declare |
| Logging | pino | Structured JSON |
| Edge | Caddy | Automatic TLS; ConversationRelay requires a valid `wss://` |
| Runtime | Node 22, Docker Compose | |

---

## Repository layout

```
.
├── src/
│   ├── index.ts            HTTP server, TwiML, health/ready, WS upgrade
│   ├── session.ts          per-call state, system prompt, runExclusive, request_id
│   ├── conversation.ts     history, streaming, interruption handling
│   ├── tools.ts            Zod schemas and OpenAI tool definitions
│   ├── n8n-client.ts       n8n calls, timeouts, retries
│   ├── relay-protocol.ts   ConversationRelay message types
│   ├── config.ts           env parsing and validation
│   └── logger.ts
├── Dockerfile
├── docker-compose.yml      voice-bridge + Caddy
├── Caddyfile               TLS termination, 3600s WS timeouts
├── .env.example
└── docs/
    ├── SPECIFICATION.fr.md full functional specification
    └── DEPLOYMENT.fr.md    VPS deployment and Twilio setup
```

---

## Running it

```bash
npm install
cp .env.example .env        # fill in the values
npm run dev
```

To test without a public domain:

```bash
ngrok http 8080
# then set PUBLIC_HOSTNAME=<your-subdomain>.ngrok.app in .env
```

Production:

```bash
docker compose up -d --build
curl https://voice.yourdomain.com/health   # {"status":"ok",...}
curl https://voice.yourdomain.com/ready    # {"ready":true,"n8n":true}
```

### Configuration

| Variable | Role |
|---|---|
| `PUBLIC_HOSTNAME` | Public domain — builds the `wss://` URL **and** validates the Twilio signature |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Model access |
| `N8N_COURSE_WEBHOOK_URL` | Ride creation webhook — production URL, `/webhook/` not `/webhook-test/` |
| `N8N_LOG_WEBHOOK_URL` | Event journaling webhook |
| `TWILIO_AUTH_TOKEN`, `VALIDATE_TWILIO_SIGNATURE` | **Keep validation on in production** — without it anyone can hit your TwiML endpoint |
| `TTS_VOICE` | ElevenLabs voice id, must be valid for Québécois French |
| `WELCOME_GREETING`, `DEFAULT_LANGUAGE` | Opening line and locale |
| `SESSION_MAX_AGE_MS`, `MAX_HISTORY_MESSAGES` | Session lifetime and context window |

> The values in `.env.example` are placeholders. Point the n8n URLs at your own instance.

Twilio console → Phone Numbers → your number → *A call comes in*: Webhook, `POST`, `https://voice.yourdomain.com/twiml`.

---

## Known limitations

- **No session persistence.** A restart drops calls in progress. Acceptable for V1; running several instances would require sticky routing on the WebSocket.
- **The system prompt lives in `src/session.ts`** and carries the mandatory-confirmation rule. Any change to it must be re-tested with a real phone call — not a unit test.
- **Voice selection is a product decision, not a config detail.** `TTS_VOICE` has to be tested by ear on real calls before a demo.

## License

[MIT](LICENSE)
