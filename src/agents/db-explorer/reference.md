# DB Reference

Source de vérité sur la structure et les particularités de la base MongoDB LGM (production, lue via slave readonly). Référence consommée par le skill `db-explorer` en local Claude Code et par l'agent serveur côté Heroku.

Adapté de `harness/docs/db-context.md` (2026-04-30, généré par `/db-explorer-init`). Stack source : Node.js 20 + TypeScript + Express, driver `mongodb` natif (Repo : `apps/lgm-apis`).

## Sizes

<!-- Section auto-générée par `npm run refresh-reference`. Ordres de grandeur uniquement. -->

_Dernière mise à jour : 2026-05-13_

- users : 60 078
- members : 67 456
- identities : 70 073
- audiences : 211 047
- campaigns : 267 079
- campaignstats : 287 410
- sequences : 270 553
- templates : 1 196 700
- audienceStats : 1 215 065
- emailSlotsStats : 16 356 835
- actions : 22 104 663
- inboxConversations : 13 034 131
- inboxMessages : 60 416 047
- leads : 69 919 468
- leadStats : 62 757 846
- logs : **657 108 897**

Notes :
- `logs` ≈ 657 M docs — toute query non-tenant-scopée + non-indexée explose. Cible un `identityId` précis et un `type`/`status` connu.
- `leadStats` / `audienceStats` ne sont pas 1:1 avec leur parent (multiples lignes par parent : par type / par jour).

## Conventions

- **`_id`** : `ObjectId` BSON natif. Aucun id custom (pas de uuid, pas de slug).
- **Timestamps** : `createdAt` et `modifiedAt`. **Type non uniforme** — soit `Date` BSON, soit `number` (epoch ms) selon la collection. Faire un `findOne(...).project({createdAt:1})` avant tout filtre `$gt`/`$lt`.
- **Soft-delete** : flag booléen `deleted`. Toujours filtrer `{ deleted: false }`. `users`, `members`, `actions`, `logs`, `notifications` **n'ont pas** ce flag.
- **Multi-tenancy** : `userId: ObjectId` est la racine. `identityId: ObjectId` = compte connecté (LinkedIn / email) d'un user — clé d'index préférentielle sur queue/inbox/logs. `memberId: ObjectId` = humain dans une équipe (collab inbox).
- **Naming** : collections en camelCase pluriel. Exceptions historiques : singulier (`token`, `gender`, `infra`), kebab-case (`logs-external`).
- **ObjectId explicite** : tout filtre sur `_id`, `userId`, `identityId`, `memberId`, `campaignId`, `leadId`, `audiences[]` requiert `ObjectId('…')`. Filtrer une chaîne brute renvoie 0 résultat sans erreur.

## Collections

### Hot path — toujours filtrer par tenant

- **`actions`** — file d'actions planifiées (envoi LinkedIn, email, scraping). Filtrer par `identityId` puis `type`/`available`/`scheduledAt`.
- **`leads`** — prospects. Filtrer `userId` puis `deleted`, puis `audiences` (array d'ObjectId). Atlas Search pour les recherches textuelles. Document gras — toujours projeter.
- **`logs`** — historique d'événements (envoi, ouverture, clic, reply). Préférer `identityId` ; `userId` accepté. Volume extrême (657M).
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

**Préfixe d'index** : compound `{a:1, b:1, c:1}` sert `{a}`, `{a,b}`, `{a,b,c}` mais **pas** `{b}` ou `{c}`. Ordre des champs très spécifique sur `actions`.

### Atlas Search — `leads_search_2`

Lucene, géré dans Atlas UI. **Seule voie rapide pour les recherches textuelles sur `leads`.** Accédé via `$search` (pas `$match`).

- Champs filtrables (`equals`) : `userId`, `audiences`, `deleted`.
- Champs `wildcard` : `firstnameSanitized`, `lastnameSanitized`, `jobTitleSanitized`, `industrySanitized`, `locationSanitized`, `companyNameSanitized`, `persoEmail`, `proEmail`.
- `text` sur `tags.tag`.
- `range` sur `countAudiences`, `lastMessageSentAt`.

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

Ne **jamais** remplacer par `$match: { firstname: /john/i }` → COLLSCAN sur 70M+ docs.

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
- **`$or` coûteux** : préférer `$in` quand c'est le même champ.
- **TTL trompeur** : `lknConversations` (~3h), `inboxFilters` (4h), `emailstosearch` (2j) — comptes non reproductibles minute à minute.
- **Types de timestamps non uniformes** : `createdAt` peut être `Date` ou `number` (epoch ms) selon la collection.
- **ObjectId implicite** : passer une string sur `userId`/`identityId` retourne 0 docs sans erreur.
- **Stats dénormalisées** : `audienceStats`, `campaignLeadsStats`, `campaignstats`, `leadStats`, `emailSlotsStats` peuvent dériver — recompter depuis la source si fiabilité requise.
- **`logs` partitionnée** : haut-trafic, anciens docs archivés/agrégés ailleurs (`logs-external`, `logsCampaigns`, `logsLead`, `logsIdentityDaily`).
- **`$lookup`/`$unionWith`/`$graphLookup` désactivés** côté validator — décompose en plusieurs queries séparées.
