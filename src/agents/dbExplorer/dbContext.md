# DB Context

> Source de vérité pour l'agent `explore_db` du MCP server.
> Adapté de `harness/docs/db-context.md` (2026-04-30, généré par `/db-explorer-init`).
> Stack source : Node.js 20 + TypeScript + Express, driver `mongodb` natif — pas d'ORM (Repo : `apps/lgm-apis`).

---

## ⚡ Checklist avant CHAQUE query

- [ ] Tenant filter (`userId`/`identityId`/`memberId`) en clé top-level du filtre / 1ᵉʳ `$match`
- [ ] `deleted: false` si collection soft-deletée
- [ ] `.project({...})` sur leads / inbox*
- [ ] `.limit(N≤50)` explicite sur find (auto-injection = filet, pas excuse)
- [ ] aggregate : `$match` indexé en stage 1, `$limit` avant `$group`/`$sort` lourd
- [ ] Champ(s) filtré(s) couvert(s) par un index (cf section Indexes ci-dessous)
- [ ] Aucun `$lookup` / `$where` / regex non ancrée

Si une case n'est pas cochable → reformule ou refuse.

---

## Règles pour l'agent

- **Read-only** enforced structurellement par le validator AST côté serveur — toute tentative de mutation (`insert*`, `update*`, `delete*`, `drop*`, `bulkWrite`, `eval`, `runCommand`, etc.) est rejetée avant exécution. Pas de bypass.
- **Limites auto** : `.limit(20)` injecté si absent ; `.limit(N>50)` capé à 50 ; `.limit(N<=0)` recap à 20 ; output tronqué à 50 KB document-par-document ; `maxTimeMS` dur 10 000 ms.
- **Toujours projeter** : `.project({champ:1, _id:1})` pour les `find`. Sans projection, les fat docs (`leads`, `inboxMessages`) déclenchent la troncature avant que tu aies ce qui t'intéresse.
- **Filtre tenant obligatoire** : toute requête user-scoped inclut `userId` (racine `ObjectId`). Sur les collections de queue/inbox/logs, préférer `identityId` (index plus sélectif). Sans tenancy, tu dépasses la limite et tu pollues les résultats.
- **Pas de scan** : avant chaque requête, vérifier que les champs filtrés correspondent à un index existant (cf section *Indexes*). Sinon, reformuler ou prévenir l'utilisateur.
- **Atlas Search** : pour `leads`, c'est l'**unique chemin rapide** pour les recherches textuelles ou multi-champs. Index Lucene `leads_search_2`, accédé via `$search` (pas `$match`).
- **ObjectId** explicite : tout filtre sur `_id`, `userId`, `identityId`, `memberId`, `campaignId`, `leadId`, `audiences[]` requiert `ObjectId('…')`. Filtrer une chaîne brute renvoie systématiquement zéro résultat.
- **Soft-delete** : `{ deleted: false }` implicite sur `audiences`, `campaigns`, `identities`, `inboxConversations`, `inboxMessages`, `leads`, `templates`, `audienceStats`. L'oublier remonte des tombstones et fausse les comptes.
- **`$lookup`/`$unionWith`/`$graphLookup` désactivés** Phase 1 — décompose en plusieurs queries séparées.

## Conventions

- **`_id`** : `ObjectId` BSON natif. Aucun id custom (pas de `uuid`, pas de slug).
- **Timestamps** : `createdAt` et `modifiedAt`. Type **non uniforme** — soit `Date` BSON, soit `number` (epoch ms) selon la collection. Faire un `findOne(...).project({createdAt:1})` avant tout filtre `$gt`/`$lt`.
- **Soft-delete** : flag booléen `deleted`. Toujours filtrer `{ deleted: false }`. `users`, `members`, `actions`, `logs`, `notifications` **n'ont pas** ce flag.
- **Multi-tenancy** : `userId: ObjectId` est la racine. `identityId: ObjectId` désigne un compte connecté (LinkedIn / email) d'un user — clé d'index préférentielle sur queue/inbox/logs. `memberId: ObjectId` désigne un humain dans une équipe (collab inbox).
- **Naming** : Collections en camelCase pluriel. Exceptions historiques : singulier (`token`, `gender`, `infra`), kebab-case (`logs-external`).

## Collections

### Hot path — toujours filtrer par tenant

- **`actions`** — file d'actions planifiées (envoi LinkedIn, email, scraping). Filtrer en premier par `identityId` puis `type`/`available`/`scheduledAt`.
- **`leads`** — prospects. Filtrer `userId` puis `deleted`, puis `audiences` (array d'ObjectId). Atlas Search pour les recherches textuelles. Document gras — toujours projeter.
- **`logs`** — historique d'événements (envoi, ouverture, clic, reply). Préférer `identityId` ; `userId` accepté.
- **`inboxMessages`** — messages reçus/envoyés. Filtrer `userId + identityId` ou `conversationId`.
- **`inboxConversations`** — fils de discussion. Filtrer `userId + identityId`.

### Identité / membre

- **`users`** — comptes principaux. Indexé sur `email`, `apikey`, `externalApikey`. Pas de soft-delete.
- **`members`** — humains rattachés à un user (équipe). Indexé sur `apikey`, `userId`.
- **`identities`** — comptes connectés (LinkedIn, mail) d'un user. Filtrer `userId` ou `memberId + deleted`.

### Workspace produit

- **`audiences`** — listes de prospects. Unique sur `userId + name + deleted`.
- **`campaigns`** — séquences d'outreach. Unique sur `userId + name + deleted`. Lien immuable vers `audience` via `campaign.audienceId`.
- **`templates`** — templates de messages. `userId + deleted`.
- **`sequences`** — séquences réutilisables. `userId`, `templatesIds[]`.

### Stats / agrégats (counters dénormalisés — peuvent dériver)

- **`audienceStats`**, **`campaignLeadsStats`**, **`campaignstats`**, **`emailSlotsStats`**, **`leadStats`** — recompter depuis la source si la valeur doit être fiable.

### Email / LinkedIn / référentiels

- `emailConnections`, `emailSlots`, `emailsCache` (TTL 14j), `emailstosearch` (TTL 2j), `enrichStorage`, `bounces`.
- `lknConversations` (TTL ~3h), `lknMessages`, `linkedinCloudRequests`.
- `dataCompanies`, `dataIndustries`, `dataLeads`, `dataSchools`, `dataSkills`, `leadIndustries`, `gender`.

## Indexes — à retenir pour ne pas scanner

- **`actions`** : préfixe `identityId`. Index principal `identityId_1_available_1_channel_1_campaignId_1_priority_-1_scheduledAt_1_createdAt_1_retry_1_type_1`.
- **`leads`** : préfixe `userId_1_deleted_1` puis `audiences`. Recherche textuelle : Atlas Search `leads_search_2`.
- **`campaigns`** : `userId_1_name_1_deleted_1` (unique), `identityId_1_status_1`, `audience._id_1`, `name_text`.
- **`audiences`** : `userId_1_name_1_deleted_1` (unique).
- **`identities`** : `userId_1`, `memberId_1_deleted_1`, `deleted_1_subscription.id_1`.
- **`inboxConversations`** : `userId_1_leadId_1`, `userId_1_identityId_1_lastMessageAt_*`.
- **`inboxMessages`** : `userId_1_identityId_1_content.messageId_1` (partial unique), `userId_1_conversationId_1_deleted_1_visibleOnlyToMembers_1`.
- **`logs`** : `identityId_1_type_1_status_1_customIdentifier_1`.
- **`users`** : `email_1`, `apikey_1`, `externalApikey_1` (sparse).

### Atlas Search — `leads_search_2`

Lucene, géré dans Atlas UI. Champs filtrables (`equals`) : `userId`, `audiences`, `deleted`. Champs `wildcard` : `firstnameSanitized`, `lastnameSanitized`, `jobTitleSanitized`, `industrySanitized`, `locationSanitized`, `companyNameSanitized`, `persoEmail`, `proEmail`. `text` sur `tags.tag`. `range` sur `countAudiences`, `lastMessageSentAt`.

### Text indexes (≠ Atlas Search)

- `campaigns.name_text` → `$text: { $search: 'query' }`.
- `logs-external.text_text` → idem.

## Recipes

### 1. User par email

```js
db.users.findOne(
  { email: 'severin@lagrowthmachine.com' },
  { _id: 1, email: 1, firstname: 1, lastname: 1, apikey: 1 }
)
```

### 2. Compter les leads actifs d'une audience

```js
db.leads.countDocuments({
  userId: ObjectId('615406ed5af80714a4530a09'),
  deleted: false,
  audiences: ObjectId('66a1...AUDIENCE_ID...')
})
```

### 3. Campagnes actives d'une identité

```js
db.campaigns.find(
  {
    identityId: ObjectId('66a1...IDENTITY_ID...'),
    status: 'started',
    deleted: false
  },
  { _id: 1, name: 1, status: 1, audience: 1, createdAt: 1 }
).sort({ createdAt: -1 }).limit(20)
```

### 4. Recherche textuelle de leads (Atlas Search)

```js
db.leads.aggregate([
  { $search: {
      index: 'leads_search_2',
      compound: {
        filter: [
          { equals: { path: 'userId', value: ObjectId('615406ed5af80714a4530a09') } },
          { equals: { path: 'deleted', value: false } }
        ],
        must: [
          { wildcard: { path: 'firstnameSanitized', query: '*john*', allowAnalyzedField: true } }
        ]
      }
  }},
  { $project: { _id: 1, firstname: 1, lastname: 1, jobTitle: 1, audiences: 1 } },
  { $limit: 20 }
])
```

C'est la **seule voie rapide** pour les filtres textuels sur leads. Ne **jamais** remplacer par `$match: { firstname: /john/i }` → COLLSCAN sur 100M+ docs.

### 5. Top types d'actions en attente pour une identité

```js
db.actions.aggregate([
  { $match: {
      identityId: ObjectId('66a1...IDENTITY_ID...'),
      available: true,
      paused: false,
      done: { $ne: true }
  }},
  { $group: { _id: '$type', count: { $sum: 1 } } },
  { $sort: { count: -1 } },
  { $limit: 20 }
])
```

### 6. Distinct ObjectId

```js
db.actions.distinct('identityId', {
  userId: ObjectId('615406ed5af80714a4530a09'),
  available: true
})
```

## Landmines

- **`leads.campaignId` n'existe pas.** Pour les leads d'une campagne, lire `campaigns.audienceId` puis filtrer `leads.audiences`.
- **Atlas Search vs `$match`** : `leads_search_2` est invisible aux requêtes `find`/`$match`. Toute recherche textuelle hors `$search` produit un COLLSCAN.
- **Soft-delete oublié** : sur `audiences`, `campaigns`, `leads`, `inbox*`, `templates`, sans `deleted: false` → tombstones inclus.
- **Préfixe d'index** : compound `{a:1, b:1, c:1}` sert `{a}`, `{a,b}`, `{a,b,c}` mais **pas** `{b}` ou `{c}`. Ordre des champs très spécifique sur `actions`.
- **`$or` coûteux** : préférer `$in` quand c'est un même champ.
- **TTL trompeur** : `lknConversations` (~3h), `inboxFilters` (4h), `emailstosearch` (2j) — comptes non reproductibles minute à minute.
- **Types de timestamps non uniformes** : `createdAt` peut être `Date` ou `number` (epoch ms) selon la collection. Vérifier par `findOne().project({createdAt:1})` avant tout `$gt`/`$lt`.
- **ObjectId implicite** : passer une string sur `userId`/`identityId` retourne 0 docs sans erreur.
- **Stats dénormalisées** : `audienceStats`, `campaignLeadsStats`, `campaignstats`, `leadStats`, `emailSlotsStats` peuvent dériver — recompter depuis la source si fiabilité requise.
- **`logs` partitionnée** : haut-trafic, anciens docs archivés/agrégés ailleurs (`logs-external`, `logsCampaigns`, `logsLead`, `logsIdentityDaily`).
