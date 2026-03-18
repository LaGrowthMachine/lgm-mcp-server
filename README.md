# LGM MCP Server

Serveur MCP (Model Context Protocol) pour LaGrowthMachine. Expose les fonctionnalites LGM aux agents IA externes (Claude Desktop, Claude Code, Cursor, etc.).

## Transports disponibles

| Transport                 | Usage               | Description                                               |
| ------------------------- | ------------------- | --------------------------------------------------------- |
| **HTTP** (StreamableHTTP) | Production / Remote | Serveur Express sur le port `3001`, endpoint `/mcp`       |
| **stdio**                 | Local uniquement    | Communication via stdin/stdout, pour Claude Code en local |

## Authentification

Chaque requete doit fournir une API key LGM via l'un de ces headers :

- `X-LGM-API-KEY: <api-key>` (recommande)
- `Authorization: Bearer <api-key>`

Le header optionnel `X-LGM-API-URL` permet de rediriger les appels vers une API specifique (feature branch, staging, etc.). Les URLs autorisees :

- `*.lagrowthmachine.com`
- `*.preview.lgmfeatureenv7.com`
- `localhost`
- `127.0.0.1`

---

## Demarrage rapide

### Prerequis

- Node.js >= 20
- Docker (optionnel, pour le mode HTTP)

### Installation

```bash
npm install
npm run build
```

### Mode stdio (local)

```bash
LGM_MCP_TRANSPORT=stdio LGM_API_URL=http://localhost:8081 LGM_API_KEY=<api-key> npm start
```

### Mode HTTP (Docker)

```bash
docker compose up --build
```

Par defaut, `LGM_API_URL` pointe vers `https://api.lagrowthmachine.com`.

---

## Configuration Docker

### Production (`docker-compose.yml`)

```yaml
services:
  lgm-mcp-server:
    build: .
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - LGM_API_URL=https://api.lagrowthmachine.com
```

### Dev local (`docker-compose.override.yml`)

En local, l'API LGM tourne sur la machine hote. Pour que le container Docker puisse y acceder via `localhost`, il faut activer `network_mode: host`.

Creer un fichier `docker-compose.override.yml` (git-ignore) :

```yaml
services:
  lgm-mcp-server:
    network_mode: host
```

Avec cette config, `docker compose up` merge automatiquement les deux fichiers et le container partage le reseau de la machine hote.

---

## Ajouter le MCP dans Claude Code

### Scopes disponibles

| Scope             | Stockage                       | Usage                             |
| ----------------- | ------------------------------ | --------------------------------- |
| `--scope local`   | `~/.claude.json`               | Prive, projet courant (defaut)    |
| `--scope project` | `.mcp.json` (racine du projet) | Partage avec l'equipe (versionne) |
| `--scope user`    | `~/.claude.json`               | Disponible dans tous les projets  |

### Local (API sur localhost)

```bash
# Scope projet (mcp.json a la racine du repo)
claude mcp add --transport http --scope project \
  LaGrowthMachineLocal http://localhost:3001/mcp \
  --header "X-LGM-API-KEY: <api-key>" \
  --header "X-LGM-API-URL: http://localhost:8081"

# Scope user (config globale Claude)
claude mcp add --transport http --scope user \
  LaGrowthMachineLocal http://localhost:3001/mcp \
  --header "X-LGM-API-KEY: <api-key>" \
  --header "X-LGM-API-URL: http://localhost:8081"
```

### Feature branch

```bash
# Scope projet
claude mcp add --transport http --scope project \
  LaGrowthMachineFeature http://localhost:3001/mcp \
  --header "X-LGM-API-KEY: <api-key>" \
  --header "X-LGM-API-URL: https://<branch>-api.preview.lgmfeatureenv7.com"

# Scope user
claude mcp add --transport http --scope user \
  LaGrowthMachineFeature http://localhost:3001/mcp \
  --header "X-LGM-API-KEY: <api-key>" \
  --header "X-LGM-API-URL: https://<branch>-api.preview.lgmfeatureenv7.com"
```

### Production

```bash
# Scope projet
claude mcp add --transport http --scope project \
  LaGrowthMachine https://mcp.lagrowthmachine.com/mcp \
  --header "X-LGM-API-KEY: <api-key>"

# Scope user
claude mcp add --transport http --scope user \
  LaGrowthMachine https://mcp.lagrowthmachine.com/mcp \
  --header "X-LGM-API-KEY: <api-key>"
```

### Mode stdio (sans Docker)

```bash
claude mcp add --transport stdio --scope project \
  LaGrowthMachineLocal node /chemin/vers/lgm-mcp-server/dist/index.js \
  --env LGM_MCP_TRANSPORT=stdio \
  --env LGM_API_URL=http://localhost:8081 \
  --env LGM_API_KEY=<api-key>
```

---

## Outils exposes

| Outil                       | Description                                    | Lecture/Ecriture |
| --------------------------- | ---------------------------------------------- | ---------------- |
| `list_campaigns`            | Lister les campagnes avec filtre et pagination | Lecture          |
| `get_campaign_stats`        | Statistiques detaillees d'une campagne         | Lecture          |
| `get_campaign_messages`     | Templates de messages d'une campagne           | Lecture          |
| `get_audience`              | Details d'une audience                         | Lecture          |
| `get_audience_leads`        | Leads d'une audience avec pagination           | Lecture          |
| `get_lead_logs`             | Historique d'activite d'un lead                | Lecture          |
| `get_lead_conversations`    | Conversations d'un lead (tous canaux)          | Lecture          |
| `get_conversation_messages` | Messages d'une conversation                    | Lecture          |
| `save_identity_preference`  | Sauvegarder une preference d'identite          | Ecriture         |
| `update_campaign_message`   | Modifier un template de message                | Ecriture         |

---

## Variables d'environnement

| Variable            | Defaut                            | Description                     |
| ------------------- | --------------------------------- | ------------------------------- |
| `PORT`              | `3001`                            | Port du serveur HTTP            |
| `LGM_MCP_TRANSPORT` | `http`                            | Transport : `http` ou `stdio`   |
| `LGM_API_URL`       | `https://api.lagrowthmachine.com` | URL de l'API LGM Flow           |
| `LGM_API_KEY`       | -                                 | API key (mode stdio uniquement) |
| `NODE_ENV`          | -                                 | Environnement Node.js           |

---

## Endpoints HTTP

| Methode           | Path            | Description                   |
| ----------------- | --------------- | ----------------------------- |
| `GET`             | `/health`       | Health check                  |
| `GET`             | `/health/ready` | Readiness probe               |
| `POST/GET/DELETE` | `/mcp`          | Endpoint MCP (StreamableHTTP) |
