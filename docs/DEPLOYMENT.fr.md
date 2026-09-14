# Voice Bridge — Taxi Joliette

Pont entre Twilio ConversationRelay et OpenAI. ConversationRelay assure le STT et le TTS ;
ce service ne manipule que du **texte** et délègue toute la logique métier à n8n.

```
Téléphone → Twilio → ConversationRelay (STT/TTS) → [Voice Bridge] → OpenAI (LLM texte)
                                                          ↓
                                                    n8n (métier)
```

## Ce que fait ce service

- Sert le TwiML `<ConversationRelay>` sur `POST /twiml`
- Tient le WebSocket `wss://.../relay` : sessions, contexte, interruptions
- Streame la réponse du modèle token par token pour que la voix démarre avant la fin de la génération
- Valide **strictement** les tool calls avec Zod avant tout appel à n8n
- Sérialise les actions critiques par `call_sid`

## Les deux garde-fous contre les doublons

Ils sont complémentaires, ne supprime ni l'un ni l'autre.

1. **Sérialisation par `call_sid`** (`Session.runExclusive`) — une chaîne de promesses par appel.
   Deux tool calls du même appel ne peuvent jamais partir en parallèle vers n8n.
2. **Idempotence `request_id`** (`Session.getOrCreateRequestId`) — un seul identifiant par appel,
   réutilisé tel quel sur chaque retry. n8n cherche ce `request_id` avant d'insérer et renvoie
   la course existante s'il la trouve.

La sérialisation ferme la fenêtre de course entre le `SELECT` et l'`INSERT` côté n8n.
L'idempotence couvre les retries réseau et les redémarrages.

## Validation des tool calls

`src/tools.ts` définit des schémas Zod `.strict()` : tout argument inconnu est rejeté.
`confirmation_client` est un `z.literal(true)` — le modèle ne peut pas créer une course
sans affirmer explicitement la confirmation. Les refus repartent vers le modèle sous forme
d'un message `tool` lisible, avec un champ `action` qui lui dit quoi demander au client.

La normalisation tolérante côté n8n reste une **seconde** ligne de défense.

## Développement local

```bash
npm install
cp .env.example .env      # renseigne les valeurs
npm run dev
```

Pour tester sans domaine public :

```bash
ngrok http 8080
# puis PUBLIC_HOSTNAME=<ton-sous-domaine>.ngrok.app dans .env
```

## Déploiement sur le VPS Hostinger

1. **DNS** — crée un enregistrement A `voice.tondomaine.com` vers l'IP du VPS.
   Attends la propagation avant de lancer Caddy, sinon Let's Encrypt échoue.

2. **Ports** — ouvre 80 et 443 :
   ```bash
   ufw allow 80/tcp && ufw allow 443/tcp
   ```

3. **Déploiement** :
   ```bash
   git clone <ton-repo> && cd voice-bridge
   cp .env.example .env && nano .env
   export PUBLIC_HOSTNAME=voice.tondomaine.com
   docker compose up -d --build
   ```

4. **Vérification** :
   ```bash
   curl https://voice.tondomaine.com/health   # {"status":"ok",...}
   curl https://voice.tondomaine.com/ready    # {"ready":true,"n8n":true}
   docker compose logs -f voice-bridge
   ```

`/health` est une sonde de vivacité sans dépendance externe (c'est celle du HEALTHCHECK Docker).
`/ready` teste réellement la joignabilité de n8n — utilise-la pour un monitoring externe, pas
pour le redémarrage automatique, sinon une panne n8n fait boucler le conteneur.

## Configuration Twilio

Console Twilio → Phone Numbers → ton numéro → **A call comes in** :

| Champ | Valeur |
|---|---|
| Configure with | Webhook |
| URL | `https://voice.tondomaine.com/twiml` |
| HTTP | POST |

Garde `VALIDATE_TWILIO_SIGNATURE=true` en production : sans ça, n'importe qui peut appeler
ton endpoint TwiML.

## Vérifications avant démo client

- [ ] `/health` et `/ready` répondent 200 en HTTPS
- [ ] Le workflow n8n est **activé** (les URLs `/webhook/`, pas `/webhook-test/`)
- [ ] Credential Twilio renseignée sur le nœud `Notifier le dispatcheur`
- [ ] Numéros expéditeur et dispatcheur remplis dans n8n
- [ ] Appel réel : le client interrompt en plein milieu, l'agent s'arrête net
- [ ] Appel réel : le client corrige une adresse, l'agent relit tout et redemande confirmation
- [ ] Appel réel : le client raccroche sans confirmer → aucune ligne dans `taxi_joliette_courses`,
      un événement `abandon` dans `taxi_joliette_journal`

## Points à surveiller

- **Le choix de la voix ElevenLabs n'est pas arbitraire.** `TTS_VOICE` doit être un voice ID
  ElevenLabs valide pour du français québécois. Celui du `.env.example` est un exemple :
  teste plusieurs voix avant la démo, c'est le critère sur lequel le client va juger.
- **Le prompt système est dans `src/session.ts`.** C'est lui qui porte la règle de confirmation
  obligatoire. Toute modification doit être retestée par un appel réel.
- **Pas de persistance des sessions.** Un redémarrage coupe les appels en cours. Acceptable en V1 ;
  si tu passes à plusieurs instances, il faudra du sticky routing sur le WebSocket.
