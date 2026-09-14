# Taxi Joliette — agent vocal IA

> Un client appelle un numéro, parle à une IA en français québécois, donne une adresse de départ et une destination — et une course est créée dans le système de répartition. Pas d'application, pas de menu, pas de « tapez 1 ». Le difficile n'est pas la conversation : c'est de **ne jamais créer deux fois la même course**.

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js%2022-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Twilio](https://img.shields.io/badge/Twilio%20ConversationRelay-F22F46?logo=twilio&logoColor=white)](https://www.twilio.com/docs/voice/conversationrelay)
[![OpenAI](https://img.shields.io/badge/OpenAI-412991?logo=openai&logoColor=white)](https://openai.com/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Zod](https://img.shields.io/badge/Zod-3E67B1)](https://zod.dev/)
[![Licence : MIT](https://img.shields.io/badge/Licence-MIT-yellow.svg)](LICENSE)

🇬🇧 [Read this document in English](README.md)

---

## Le flux d'appel

```
Appel téléphonique
    |
    v
Numéro Twilio  --POST /twiml-->  renvoie <ConversationRelay>
    |
    v
Twilio ConversationRelay          (STT Deepgram + TTS ElevenLabs, fr-CA)
    |  wss://.../relay             texte en entrée, texte en sortie
    v
+---------------------------+
|       Voice Bridge        |     ce service
|  sessions, streaming,     |
|  interruptions, tool calls|
+------------+--------------+
             |
        +----+----+
        |         |
        v         v
     OpenAI      n8n  -->  API Taxi Joliette  -->  course créée
   (LLM texte)  (logique métier)
```

ConversationRelay assure la reconnaissance et la synthèse vocale. **Ce service ne manipule que du texte** et délègue toute décision métier à n8n. C'est cette séparation qui le garde assez petit pour rester compréhensible.

La réponse du modèle est streamée **token par token**, pour que la voix démarre avant la fin de la génération. Au téléphone, cet écart fait la différence entre « naturel » et « cassé ».

---

## Le vrai problème : ne jamais créer deux fois une course

Un appel téléphonique est un environnement hostile à la sémantique « exactement une fois ». Le réseau coupe, le client se répète, un retry part. Deux garde-fous traitent ce cas, et **ils sont complémentaires — en retirer un rouvre la faille** :

| Garde-fou | Mécanisme | Ce qu'il couvre |
|---|---|---|
| **Sérialisation par `call_sid`** | `Session.runExclusive` chaîne une promesse par appel | Deux tool calls du même appel ne peuvent jamais atteindre n8n en parallèle — ferme la fenêtre de course entre le `SELECT` et l'`INSERT` côté n8n |
| **Idempotence par `request_id`** | `Session.getOrCreateRequestId` émet un identifiant unique par appel, réutilisé tel quel à chaque retry | Les retries réseau et les redémarrages — n8n cherche cet identifiant avant d'insérer et renvoie la course existante s'il la trouve |

La sérialisation seule perd face à un redémarrage. L'idempotence seule perd face à deux appels concurrents en vol. Ensemble, elles tiennent.

---

## Validation stricte des tool calls

Tout ce que le modèle veut faire passe par des schémas Zod `.strict()` dans [`src/tools.ts`](src/tools.ts) — tout argument inconnu est rejeté d'emblée.

La ligne porteuse est celle-ci :

```ts
confirmation_client: z.literal(true)
```

`true` est la seule valeur acceptée. **Le modèle ne peut pas créer une course sans affirmer explicitement que le client a confirmé.** Ce n'est pas une consigne de prompt dont il pourrait s'écarter : c'est une contrainte de type, appliquée avant qu'aucun appel n'atteigne n8n.

Les refus repartent vers le modèle sous forme d'un message `tool` lisible portant un champ `action` qui lui indique quoi demander ensuite au client : un échec de validation devient une question de clarification, pas une impasse.

### Outils exposés au modèle

| Outil | Rôle | Contraintes clés |
|---|---|---|
| `creer_course` | Créer la course | `confirmation_client` doit valoir littéralement `true` ; `heure_souhaitee` obligatoire si `moment_prise_en_charge` vaut `differe` ; 1 à 8 passagers |
| `journaliser_evenement` | Journaliser un événement d'appel | Types d'événements énumérés, dont `abandon` quand le client raccroche sans confirmer |

La normalisation tolérante côté n8n reste une **seconde** ligne de défense, pas la première.

---

## Endpoints

| Méthode | Route | Rôle |
|---|---|---|
| `POST` | `/twiml` | Renvoie le TwiML `<ConversationRelay>` — c'est la cible du webhook Twilio |
| `GET` | `/health` | Vivacité, sans dépendance externe. Sert au `HEALTHCHECK` Docker |
| `GET` | `/ready` | Teste réellement la joignabilité de n8n |
| `WS` | `/relay` | Le WebSocket ConversationRelay : sessions, contexte, interruptions |

Utiliser `/ready` pour du monitoring externe, **pas** pour le redémarrage automatique — sinon une panne n8n fait boucler le conteneur.

---

## Stack

| Couche | Choix | Pourquoi |
|---|---|---|
| Téléphonie | Twilio ConversationRelay | STT et TTS gérés en amont ; le pont reste purement textuel |
| STT | Deepgram `nova-3-general` | Support du fr-CA |
| TTS | ElevenLabs | La qualité de la voix est le critère sur lequel le client juge le produit |
| LLM | OpenAI, en streaming | Streaming des tokens pour que la parole démarre tôt |
| Logique métier | Webhooks n8n | Création de course et journalisation vivent hors de ce service |
| Validation | Zod `.strict()` | Rejette tout ce que le schéma n'a pas déclaré |
| Logs | pino | JSON structuré |
| Bordure | Caddy | TLS automatique ; ConversationRelay exige un `wss://` valide |
| Exécution | Node 22, Docker Compose | |

---

## Organisation du dépôt

```
.
├── src/
│   ├── index.ts            serveur HTTP, TwiML, health/ready, upgrade WS
│   ├── session.ts          état par appel, prompt système, runExclusive, request_id
│   ├── conversation.ts     historique, streaming, gestion des interruptions
│   ├── tools.ts            schémas Zod et définitions d'outils OpenAI
│   ├── n8n-client.ts       appels n8n, timeouts, retries
│   ├── relay-protocol.ts   types de messages ConversationRelay
│   ├── config.ts           lecture et validation des variables d'environnement
│   └── logger.ts
├── Dockerfile
├── docker-compose.yml      voice-bridge + Caddy
├── Caddyfile               terminaison TLS, timeouts WS à 3600 s
├── .env.example
└── docs/
    ├── SPECIFICATION.fr.md spécification fonctionnelle complète
    └── DEPLOYMENT.fr.md    déploiement VPS et configuration Twilio
```

---

## Exécution

```bash
npm install
cp .env.example .env        # renseigner les valeurs
npm run dev
```

Pour tester sans domaine public :

```bash
ngrok http 8080
# puis PUBLIC_HOSTNAME=<ton-sous-domaine>.ngrok.app dans .env
```

En production :

```bash
docker compose up -d --build
curl https://voice.tondomaine.com/health   # {"status":"ok",...}
curl https://voice.tondomaine.com/ready    # {"ready":true,"n8n":true}
```

### Configuration

| Variable | Rôle |
|---|---|
| `PUBLIC_HOSTNAME` | Domaine public — construit l'URL `wss://` **et** valide la signature Twilio |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Accès au modèle |
| `N8N_COURSE_WEBHOOK_URL` | Webhook de création de course — URL de production, `/webhook/` et non `/webhook-test/` |
| `N8N_LOG_WEBHOOK_URL` | Webhook de journalisation |
| `TWILIO_AUTH_TOKEN`, `VALIDATE_TWILIO_SIGNATURE` | **Garder la validation active en production** — sans elle, n'importe qui peut appeler ton endpoint TwiML |
| `TTS_VOICE` | Identifiant de voix ElevenLabs, valide pour le français québécois |
| `WELCOME_GREETING`, `DEFAULT_LANGUAGE` | Phrase d'accueil et locale |
| `SESSION_MAX_AGE_MS`, `MAX_HISTORY_MESSAGES` | Durée de vie des sessions et fenêtre de contexte |

> Les valeurs de `.env.example` sont des placeholders. Pointe les URLs n8n vers ta propre instance.

Console Twilio → Phone Numbers → ton numéro → *A call comes in* : Webhook, `POST`, `https://voice.tondomaine.com/twiml`.

---

## Limites connues

- **Pas de persistance des sessions.** Un redémarrage coupe les appels en cours. Acceptable en V1 ; passer à plusieurs instances imposerait du sticky routing sur le WebSocket.
- **Le prompt système est dans `src/session.ts`** et porte la règle de confirmation obligatoire. Toute modification doit être retestée par un appel réel — pas par un test unitaire.
- **Le choix de la voix est une décision produit, pas un détail de configuration.** `TTS_VOICE` doit être testé à l'oreille sur de vrais appels avant une démo.

## Licence

[MIT](LICENSE)
