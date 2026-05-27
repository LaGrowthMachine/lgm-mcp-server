import { ObjectId } from "mongodb";
import { getDb } from "../agents/db-explorer/mongoClient";

// Énumère les conversations LGM d'une identité (LinkedIn/Email) ordonnées
// par récence, jusqu'à un cap de tokens approché (chars/4 — Bedrock-friendly).
// Stratégie greedy : on accumule conv entière par conv entière jusqu'à
// déborder. Si la 1ʳᵉ conv seule dépasse, on la prend quand même (sinon
// on retournerait rien pour les identités à grosses convs).
//
// L'index Mongo utile est `userId_1_identityId_1_lastMessageAt_*`. On
// résout d'abord le `userId` via `identities` (multi-tenancy doctrine) pour
// que le find sur `inboxConversations` tape le préfixe complet.

export interface IdentityConvSlice {
  conversationId: string; // hex24
  lastMessageAt: number; // epoch ms (0 si inconnu)
}

const CHARS_PER_TOKEN = 4; // approximation usuelle Bedrock / Claude.

// P2: borne dure sur le nombre de convs chargées en mémoire. Le cap token
// (~10k par défaut) sature bien avant — 500 est large pour tout profil
// réaliste, mais évite qu'une identité avec 10k convs explose le process.
const CONV_HARD_LIMIT = 500;

const toEpochMs = (v: unknown): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
};

// Approximation de la taille en tokens d'une conv : somme(len(text)) / 4
// sur les messages SENDER ET LEAD (l'inférence verra tout le fil — sinon le
// modèle perd le contexte conversationnel). Pas de fetch Mongo ici : on le
// fait au moment de l'analyse (identityProfiler), le fetcher se contente de
// retourner les IDs.
export interface EnumerateOptions {
  tokenCap: number;
}

export const enumerateIdentityConvs = async (
  identityId: string,
  channel: "LINKEDIN" | "EMAIL",
  opts: EnumerateOptions,
): Promise<IdentityConvSlice[]> => {
  if (!/^[a-f0-9]{24}$/i.test(identityId)) {
    throw new Error("identityId invalide (24 hex attendus).");
  }
  const oid = new ObjectId(identityId);
  const db = await getDb();

  // Résolution du userId pour hit l'index compound userId+identityId+lastMessageAt.
  const ident = (await db.collection("identities").findOne(
    { _id: oid },
    { projection: { userId: 1 } },
  )) as Record<string, unknown> | null;
  if (!ident) {
    throw new Error(`identité introuvable: ${identityId}`);
  }
  const userId = ident.userId as ObjectId | undefined;
  if (!userId) {
    throw new Error(`identité ${identityId} sans userId — donnée incohérente.`);
  }

  // On récupère TOUTES les convs de l'identité sur le canal, par récence.
  // Pas de skip d'index par le filtre `deleted: false` (compound index ne
  // l'inclut pas — c'est un post-filter cheap). Projection minimale : on a
  // juste besoin d'estimer la taille de chaque conv pour le greedy cap.
  // P2: cap dur `CONV_HARD_LIMIT` pour éviter de charger toute l'inbox d'une
  // identité industrielle (10k+ convs) en mémoire avant le greedy trim.
  const convs = await db
    .collection("inboxConversations")
    .find(
      {
        userId,
        identityId: oid,
        lastMessageType: channel,
        deleted: { $ne: true },
      },
      {
        projection: { _id: 1, lastMessageAt: 1 },
      },
    )
    .sort({ lastMessageAt: -1 })
    .limit(CONV_HARD_LIMIT)
    .toArray();

  if (convs.length === 0) return [];

  // P3: collapse N+1 — au lieu de fetch les messages conv par conv, on
  // calcule la longueur (en chars) de chaque conv en UNE aggregation côté
  // Mongo. On regroupe par conversationId et on somme la longueur du champ
  // texte le plus représentatif (content texte). Pas parfait (les payloads
  // imbriqués comme nested.message ne sont pas adressés), mais suffisant
  // pour le greedy cap : on borne plutôt qu'on mesure au char près.
  const convIds = convs.map((c) => c._id as ObjectId);
  const sizeAgg = (await db
    .collection("inboxMessages")
    .aggregate([
      {
        $match: {
          userId,
          conversationId: { $in: convIds },
          deleted: { $ne: true },
        },
      },
      {
        $project: {
          conversationId: 1,
          len: {
            $cond: [
              { $eq: [{ $type: "$content" }, "string"] },
              { $strLenCP: "$content" },
              {
                $cond: [
                  { $eq: [{ $type: "$text" }, "string"] },
                  { $strLenCP: "$text" },
                  {
                    $cond: [
                      { $eq: [{ $type: "$body" }, "string"] },
                      { $strLenCP: "$body" },
                      0,
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      { $group: { _id: "$conversationId", chars: { $sum: "$len" } } },
    ])
    .toArray()) as { _id: ObjectId; chars: number }[];

  const charsByConv = new Map<string, number>();
  for (const r of sizeAgg) {
    charsByConv.set(String(r._id), Number(r.chars) || 0);
  }

  // Greedy par récence : on prend la 1ʳᵉ même si elle dépasse seule (sinon
  // certaines identités à grosses convs n'auraient aucun corpus). Pour les
  // suivantes, on stoppe si on dépasserait le cap.
  const result: IdentityConvSlice[] = [];
  let charsAccumulated = 0;
  const capChars = opts.tokenCap * CHARS_PER_TOKEN;

  for (const c of convs) {
    const cid = String(c._id);
    const convChars = charsByConv.get(cid) ?? 0;

    if (result.length === 0) {
      // Première conv : on la prend toujours (même si elle dépasse seule).
      result.push({ conversationId: cid, lastMessageAt: toEpochMs(c.lastMessageAt) });
      charsAccumulated += convChars;
      if (charsAccumulated >= capChars) break;
      continue;
    }

    if (charsAccumulated + convChars > capChars) {
      // Stop avant débordement — on ne prend pas cette conv (intégralité ou rien).
      break;
    }
    result.push({ conversationId: cid, lastMessageAt: toEpochMs(c.lastMessageAt) });
    charsAccumulated += convChars;
  }

  return result;
};
