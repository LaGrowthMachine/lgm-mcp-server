---
title: "Harness d'évaluation itérative de l'analyse de conversation"
project: lgm-mcp-server
author: Paige (Technical Writer)
date: 2026-05-18
revision: 3 — formulaires HTML server-rendered (zéro JS client) + chunk analyse
status: validé — décisions D1–D7 actées 2026-05-18, prêt à implémenter
jira: LAGM-16436
audience: Stol (build), Alexandre (PM / opérateur du harness)
---

# Harness d'évaluation itérative — `analyze_conversation`

## Objectif

Permettre à Alex de **lancer des analyses de conversations par batch** via
une **mini-interface web** hébergée par le serveur, à nous de **faire
évoluer le prompt/process** d'analyse selon ses retours, et de **détecter
toute régression** en comparant chaque nouvelle analyse à la précédente —
schéma JSON déterministe, mise en exergue des diffs.

Boucle cible : `analyse → retour Alex → modif prompt/process → deploy Heroku
→ ré-analyse → diff`.

## Contraintes (fixées par Stol)

- **Seul appel IA = l'inférence d'analyse** (server-side, existant). Découverte
  = requête Mongo **déterministe** ; diff = calcul pur.
- **Tout server-side.** Aucun code client écrit/déployé : **routes qui
  rendent du HTML**, appelées par des `<form method="POST">` (soumission
  navigateur native, zéro JS applicatif). Alex ouvre une **URL**, rien à
  installer. Toute la logique tourne sur le serveur.
- **Coût d'inférence : hors scope.**

## Faits DB validés (production réelle, 2026-05-18)

Vérifiés via `bin/lgm-mongosh` (même validator+interpreter que Heroku),
tenant test `646b2ef1398f0a733fbb19c2` (DSD SYSTEM) :

| Question | Réponse vérifiée |
|---|---|
| L'id du CSV / saisi = ? | **`users._id` = `userId`** (racine tenant ; `company_id` du CSV) |
| Collection des fils | **`inboxConversations`** ; `_id` = `conversationId` |
| Linkage conv → messages | `inboxMessages.conversationId == inboxConversations._id` (champ utilisé par `messageFetcher.ts`) |
| « N plus récentes » | `.sort({ lastMessageAt: -1 }).limit(N)` |
| Type de `lastMessageAt` | ⚠️ **number epoch-ms**, pas `Date` BSON |
| Soft-delete | flag `deleted` présent → toujours `deleted: false` |
| Volume / tenant | DSD = 2462 fils → échantillonnage trivial |
| Signal `leadReplied` | bool sur le fil (≈40 % `false` sur l'échantillon) |

**Requête de découverte embarquée (déterministe, pas de LLM) :**

```js
db.inboxConversations.find(
  { userId: ObjectId('<userId>'), deleted: false, leadReplied: true },
  { _id: 1, leadReplied: 1, lastMessageAt: 1, lastMessageType: 1 }
).sort({ lastMessageAt: -1 }).limit(<n>)
```

> `leadReplied: true` (décision D2) : on n'échantillonne que les fils où le
> lead a répondu. ⚠️ `analyze_conversation` peut **encore** skipper
> (`messageCount==0`, aucune ligne lead lisible après formatage) : skips
> **réduits, pas éliminés** — le diff gère toujours `skip↔ok`.
>
> Nuance index : filtre `userId` + tri `lastMessageAt`. Index dispo :
> `userId_1_leadId_1` (filtre) et `userId_1_identityId_1_lastMessageAt_*`
> (pas un préfixe propre sans `identityId`). Sur un tenant borné le tri en
> mémoire est négligeable. À `.explain()` au build pour le plus gros tenant.

## Le défaut critique #1 : déterminisme de l'inférence

`inference.ts` n'impose **aucune `temperature`** → sampling par défaut. Le
`tool_choice` fige *la forme* (schéma stable) mais **pas les valeurs**. Sans
correctif, « diff des 2 dernières analyses » = bruit de sampling, pas
régression.

**Correctif (décision D1, 1 ligne, deploy Heroku) :** `temperature: 0` en
dur dans `inferStructured`. Impacte tous les appelants de
`analyze_conversation` (classif plus stable — souhaité).

> 🔴 **VALIDATION PROD 2026-05-18 — `temperature: 0` est INSUFFISANT.**
> Test sur Heroku v32 : même conversation, même prompt, 2 runs consécutifs
> à `temperature:0` → divergences sur champs **stables** :
> - conv `67dd75cf…` : `suggested_label: curious → open`, sub_label changé,
>   2 signaux flippés, alternative changée.
> - conv `646e0d7b…` : `labels.curious.certainty: low → medium`.
>
> L'inférence Claude n'est **pas bit-déterministe** même à temp:0 (routing
> MoE / batching infra). Le classifieur fait de la « certitude calibrée »
> sur des réponses B2B ambiguës → beaucoup de convs proches d'une frontière
> de décision → l'argmax flippe entre runs. **Le diff per-conv brut compare
> donc du bruit d'inférence autant qu'une vraie régression de prompt.**
>
> Le harness fonctionne (il a *correctement détecté et affiché* la
> divergence — c'est son job). C'est le modèle d'interprétation « temp:0 ⇒
> déterministe » qui est faux. Mitigations à trancher (cf. fin de doc) :
> a) **N échantillons/conv/version** + consensus (mode par champ), un champ
>    instable *intra-version* est exclu du signal de régression ;
> b) **diff de distribution** sur un batch (shift de distribution des
>    `suggested_label` entre versions) plutôt que per-conv ;
> c) **signal restreint au `certainty: high`** des deux côtés (les sorties
>    high-certainty sont nettement plus stables) ; low/medium = contexte ;
> d) combinaison b+c.

### Taxonomie des champs (verrouillée sur `CLASSIFIER_TOOL_SCHEMA`)

Le diff ne traite **que** les champs stables ; les champs libres = contexte,
jamais signal de régression.

**Champs stables (signal) :** `analysis.status` · `analysis.promptVersion` ·
`classification.labels.{negative,open,curious,interest,confirmed_need}.certainty`
(`high|medium|low|very_low`) · `classification.suggested_label` (5) ·
`classification.suggested_sub_label` (25) + `suggested_sub_label_certainty` ·
`classification.alternative_sub_label` (string|null) ·
`classification.signals.{8 booléens}`.

**Champs libres (contexte) :** `classification.labels.*.reason` ·
`classification.sub_label_reason` · texte `reason` d'un skip.

## Le défaut critique #2 : FS Heroku éphémère

Le disque du dyno est **effacé à chaque deploy/restart**. La boucle impose un
deploy *entre* deux analyses → stocker l'historique sur le FS du dyno ferait
**disparaître l'analyse N-1 pile au moment du diff**. `gitignore` n'y change
rien.

**Correctif (décision D6) :** historique en **Heroku Postgres (mini)**,
durable hors dyno. Add-on 1-clic, env `DATABASE_URL` (fournie par Heroku),
1 dépendance npm bornée (`pg`).

## Le défaut critique #3 : routeur Heroku 30 s

Le routeur Heroku **coupe toute requête HTTP à 30 s**. La section 2 analyse
N conversations = N inférences (~qq s chacune) ; un POST unique pour un gros
batch dépasse 30 s → timeout garanti (cf. saga H27/proxy déjà connue).

**Correctif (décision D7) :** **1 conversation par requête**. Chaque
soumission de formulaire traite 1 conv (1 inférence, large sous 30 s), le
serveur ré-affiche la page avec l'avancement (`X/N`, lu depuis Postgres) et
un bouton/redirect vers la suivante. Reprenable si l'onglet est fermé
(l'état vit en Postgres, pas dans la page).

## Architecture cible

```
  Navigateur d'Alex                Serveur Heroku (Express existant + module eval)
  ┌──────────────────┐  <form>     ┌───────────────────────────────────────────────┐
  │ pages HTML        │  POST       │ GET  /eval            → HTML (3 sections)      │
  │ rendues par le    │ ──────────▶ │ POST /eval/discover   → Mongo déterministe     │
  │ serveur (0 JS)    │             │ POST /eval/analyze    → 1 conv, inférence(t:0) │
  │ gate clé API LGM  │ ◀────────── │ POST /eval/diff       → calcul pur             │
  └──────────────────┘  HTML rendu  │        │ persist {conv,analysis}                │
                                   │        ▼                                        │
                                   │   Heroku Postgres (mini)  ── durable ──────────┐│
                                   │   table conv_eval_analyses (append-only)       ││
                                   └───────────────────────────────────────────────┘│
   Mongo LGM (readonly slave) ◀───── /eval/discover & inférence (lecture) ───────────┘
```

- Routes appelées par **soumission `<form>` native** (zéro JS client). Chaque
  POST **renvoie une page HTML**, pas du JSON. UI servie par l'Express
  existant. Pas de framework, pas de build. Endpoints MCP / OAuth / health
  **intacts**.
- Auth : UI + endpoints derrière le **gate clé API LGM** (décision D4,
  interne / POC-passthrough). Une URL publique avec champ de saisie sans gate
  = surface d'attaque — non négociable.

## Modèle de données (Postgres)

Une seule table, append-only, créée idempotemment au boot
(`CREATE TABLE IF NOT EXISTS`, pas de framework de migration) :

```sql
CREATE TABLE IF NOT EXISTS conv_eval_analyses (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt_version  TEXT,                       -- analysis.promptVersion (null si skip)
  status          TEXT        NOT NULL,       -- ok | skipped | error
  payload         JSONB       NOT NULL        -- { conversation, analysis } complet
);
CREATE INDEX IF NOT EXISTS conv_eval_conv_ts
  ON conv_eval_analyses (conversation_id, created_at DESC);
```

- La conversation voyage **dans** `payload` (contrat `{conversation,
  analysis}`) — pas de table séparée, pas d'écrasement (lignes immuables).
- Diff = `SELECT payload FROM conv_eval_analyses WHERE conversation_id=$1
  ORDER BY created_at DESC LIMIT 2`.
- La découverte n'est **pas** persistée (sortie affichée → copiée par
  l'utilisateur dans la section 2).

## L'interface — 1 page, 3 sections

### Section 1 — Découvrir des conversationId

- Entrée : **upload CSV** (col `company_id`) **OU** `userId` séparés par
  virgules.
- Options : nombre/société (`limit`), tri (`lastMessageAt` desc déf.),
  filtre `leadReplied:true` (déf., D2).
- `POST /eval/discover` → requête Mongo déterministe → **sortie : conv IDs
  séparés par virgules** (copiables tels quels en section 2).

### Section 2 — Analyser

- Entrée : conversationId séparés par virgules (champ texte).
- `POST /eval/analyze` traite **1 conv par requête** (D7, contrainte
  routeur 30 s) → inférence server-side existante → **INSERT** d'une ligne
  `conv_eval_analyses` (`{conversation, analysis}` + ts + promptVersion +
  status).
- Le serveur **renvoie la page HTML** : avancement `X/N` (compté depuis
  Postgres), dernier statut, bouton/redirect « analyser la suivante ».
  Reprenable (état en Postgres).
- **Seul appel IA.**

### Section 3 — Diff

- `POST /eval/diff` (aucune entrée, ou filtre optionnel) : pour chaque conv
  à **≥ 2 analyses**, diff des **2 dernières** sur les **champs stables**.
- Rapport rendu **dans la page** : groupé par sévérité — flips de label,
  glissements de certainty (`high→low`), bascules de signaux, transitions
  `skip↔ok`, **diffs de schéma** (clé ajoutée/retirée). Champs libres en
  contexte replié. Δ global en tête.

## Changements serveur requis (deploy Heroku)

1. `inference.ts` : `temperature: 0` dans `inferStructured` (D1).
2. Add-on **Heroku Postgres mini** + dépendance `pg` ; module
   `src/pg.ts` (Pool lazy singleton, SSL Heroku, `CREATE TABLE IF NOT
   EXISTS` au boot).
3. Module `src/evalRoutes.ts` (Express) :
   - `GET /eval` + `POST /eval/discover|analyze|diff` — **chaque route
     renvoie du HTML** (template string, pas de moteur de template, pas de
     JS client).
   - `POST /eval/analyze` = **1 conv/requête** (D7).
   - `withRequestContext`, gate clé API, logs `[eval]` key=value, jamais de
     secret loggé.
4. Endpoints MCP / OAuth / health : **intacts**.

> ⚠️ **ACL** (D4) : `/eval/*` est **cross-tenant admin** (`discover`
> interroge des `userId` arbitraires). Même classe de risque qu'`explore_db`.
> Acté : interne Alex/Stol, **ACL POC-passthrough conservée**, documentée
> comme dette ; staff-gate (`isLgmStaffEmail`/`assertLgmStaff`) **obligatoire
> avant toute exposition orientée client**.

## Décisions actées (2026-05-18)

| # | Décision | Choix retenu |
|---|---|---|
| D1 | Déterminisme | **`temperature: 0` global** dans `inferStructured`, deploy Heroku. |
| D2 | Échantillonnage | **Filtrer `leadReplied:true`** dans `discover`. Skips réduits, pas nuls. |
| D3 | Surface | **Mini-UI server-side** (1 page / 3 sections) + 3 endpoints JSON, servie par l'Express existant. |
| D4 | ACL | **Interne, POC-passthrough conservée** (dette documentée) ; staff-gate avant exposition client. |
| D5 | Emplacement livrable | **Dans le serveur** (`src/evalRoutes.ts` + UI + `src/pg.ts`). Plus de dossier client. |
| D6 | Persistance | **Heroku Postgres (mini)**, table `conv_eval_analyses` append-only. |
| D7 | UI / invocation | **Formulaires HTML server-rendered** : routes appelées par `<form method=POST>` natif, renvoient du HTML. **Zéro JS client.** Analyse = **1 conv/requête** (routeur Heroku 30 s). |

## Hors scope

- Suivi du coût d'inférence.
- Scripts / outillage côté client (abandonné — tout server-side).
- Persistance sur FS dyno (impossible — Postgres à la place).
- Boucle LLM `explore_db` dans le pipeline (remplacée par requête fixe).

## Key Takeaways

- Découverte `userId → conversationId` **résolue et déterministe**
  (`inboxConversations` filtré `userId, deleted:false, leadReplied:true`,
  trié `lastMessageAt` desc).
- **Trois gotchas Heroku/IA, tous corrigés** : (1) inférence non
  déterministe → `temperature: 0` ; (2) FS dyno éphémère → **Heroku
  Postgres** ; (3) routeur 30 s → **1 conv/requête**.
- Le diff sépare **champs stables** (signal) et **libres** (contexte).
- Livrable = **formulaires HTML server-rendered + 1 table Postgres** : zéro
  install **et zéro JS client** pour Alex, une URL. « Tout server-side » =
  aucun code client écrit ; le navigateur ne fait que soumettre des `<form>`.
- 7 décisions (D1–D7) **actées le 2026-05-18** — spec prête à implémenter.
