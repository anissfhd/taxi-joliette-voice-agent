# Système d’automatisation téléphonique Taxi Joliette — Spécification complète

## 1. Objectif

Je veux développer un système d’agent vocal IA pour **Taxi Joliette au Canada**.

Le fonctionnement attendu est :

**Client → Numéro Twilio → Twilio ConversationRelay → OpenAI → n8n → API Taxi Joliette → Création automatique de la course**

L’objectif est qu’un client puisse simplement appeler le numéro de Taxi Joliette, parler naturellement avec l’IA et donner son **adresse de départ** et sa **destination**.

L’IA doit récupérer et confirmer ces informations, puis déclencher automatiquement la création d’une course.

---

## 2. Réception de l’appel

Le client appelle un **numéro Twilio**.

Twilio doit recevoir l’appel et utiliser **Twilio ConversationRelay** pour connecter la conversation téléphonique au système IA.

Le client ne doit avoir besoin d’aucune application : il appelle simplement le numéro de téléphone.

---

## 3. Agent vocal OpenAI

OpenAI représente le cerveau conversationnel du système.

L’agent doit mener une conversation simple et naturelle.

Exemple :

**IA :**  
« Bonjour, Taxi Joliette. Quelle est votre adresse de départ ? »

**Client :**  
« Je suis au 120 rue X. »

Le système doit extraire et conserver :

`pickup_address = "120 rue X"`

Ensuite :

**IA :**  
« Quelle est votre destination ? »

Le client répond et le système extrait :

`destination_address = "50 rue Y"`

Le numéro de téléphone de l’appelant doit également être récupéré lorsque Twilio le fournit.

---

## 4. Confirmation obligatoire

Avant de créer une course, l’IA doit confirmer les informations avec le client.

Exemple :

**IA :**  
« Je confirme : départ au 120 rue X et destination au 50 rue Y, c’est bien cela ? »

Si le client confirme, le workflow continue.

S’il corrige une adresse, l’IA doit mettre à jour l’information puis demander une nouvelle confirmation.

Une course ne doit pas être créée avant confirmation.

---

## 5. Données structurées

Après confirmation, le système doit disposer au minimum de :

- numéro de téléphone du client ;
- adresse de départ ;
- adresse de destination ;
- date et heure de la demande.

Ces informations doivent être envoyées au workflow **n8n**.

---

## 6. Workflow n8n

n8n doit servir de couche d’automatisation entre l’agent vocal et le système Taxi Joliette.

Architecture :

**Twilio / OpenAI → n8n → destination de la course**

Le workflow doit être construit de manière à pouvoir changer facilement la destination finale sans refaire toute l’architecture.

---

## 7. Première version — sans API Taxi Joliette

L’API permettant de créer automatiquement une course dans Taxi Joliette est actuellement **en cours de développement**.

Il ne faut donc pas attendre sa disponibilité pour construire et tester le reste du système.

Pour la première version, utiliser **Google Sheets** comme destination temporaire.

Architecture V1 :

**Client**  
→ **Numéro Twilio**  
→ **Twilio ConversationRelay**  
→ **OpenAI**  
→ **n8n**  
→ **Google Sheets**

Après chaque appel correctement confirmé, n8n doit automatiquement ajouter une nouvelle ligne, par exemple :

| Téléphone | Départ | Destination | Date/heure | Statut |
|---|---|---|---|---|
| +1... | 120 rue X | 50 rue Y | ... | Nouvelle |

Cette version doit permettre une vraie démonstration :

1. appeler réellement le numéro Twilio ;
2. parler avec l’agent IA ;
3. communiquer départ et destination ;
4. confirmer les informations ;
5. terminer le processus ;
6. vérifier immédiatement que les informations apparaissent dans Google Sheets.

---

## 8. Deuxième version — intégration API Taxi Joliette

Lorsque l’API Taxi Joliette sera disponible, sa documentation me sera fournie.

À ce moment-là, remplacer la destination Google Sheets par l’appel à l’API Taxi Joliette.

Architecture finale :

**Client**  
→ **Numéro Twilio**  
→ **ConversationRelay**  
→ **OpenAI**  
→ **n8n**  
→ **API Taxi Joliette**  
→ **Course créée dans l’application Taxi Joliette**

Par exemple, si l’API expose un endpoint du type :

`POST /courses`

n8n devra lui transmettre les champs demandés par la documentation, notamment les équivalents de :

- `phone`
- `pickup_address`
- `destination_address`

Ne pas inventer l’endpoint ou le contrat de l’API avant d’avoir reçu sa documentation officielle.

---

## 9. Gestion de la course après sa création

La responsabilité de cette automatisation s’arrête initialement à la **création correcte de la course dans Taxi Joliette**.

La manière dont Taxi Joliette traite ensuite cette course dépend de leur application :

- attribution automatique à un chauffeur ;
- affichage aux chauffeurs pour acceptation ;
- attribution par un dispatcher.

Il ne faut pas supposer l’un de ces comportements tant que le fonctionnement de Taxi Joliette n’a pas été confirmé.

---

## 10. Comportement attendu en cas de problème

Le système ne doit pas créer silencieusement une course avec des données douteuses.

Si une adresse est incomprise, l’agent doit demander au client de la répéter ou de la préciser.

Si le client corrige une information, la nouvelle valeur remplace l’ancienne.

Si les informations nécessaires ne peuvent pas être obtenues ou confirmées, aucune course ne doit être créée.

Le workflow doit également avoir des logs suffisamment clairs pour comprendre les erreurs pendant le développement et les tests.

---

## 11. Architecture à respecter

### Version démonstration

**Téléphone client**  
↓  
**Twilio Number**  
↓  
**Twilio ConversationRelay**  
↓  
**Agent OpenAI**  
↓  
**Extraction + confirmation départ/destination**  
↓  
**n8n**  
↓  
**Google Sheets**  
↓  
**Course de démonstration enregistrée**

### Version finale

**Téléphone client**  
↓  
**Twilio Number**  
↓  
**Twilio ConversationRelay**  
↓  
**Agent OpenAI**  
↓  
**Extraction + confirmation départ/destination**  
↓  
**n8n**  
↓  
**API Taxi Joliette**  
↓  
**Course réelle créée dans Taxi Joliette**

---

## 12. Travail demandé

Prends en charge l’implémentation de cette solution de bout en bout.

Commence par la **V1 fonctionnelle avec Google Sheets**, mais structure le projet pour que le remplacement de Google Sheets par l’API Taxi Joliette soit simple lorsque sa documentation sera disponible.

Ne bloque pas le développement de la V1 à cause de l’absence actuelle de l’API Taxi Joliette.
