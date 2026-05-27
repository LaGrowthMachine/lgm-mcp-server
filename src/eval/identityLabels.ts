import { ObjectId } from "mongodb";
import { getDb } from "../agents/db-explorer/mongoClient";

// Batch-résout les libellés humains des identités LGM (firstname + lastname
// ou fallback email). Utilisé par les listes UI pour ne pas exposer les
// 24-hex `_id` bruts à l'utilisateur. Resilient aux ids invalides/manquants
// (on filtre côté projection plutôt que d'échouer toute la liste).
export interface IdentityLabel {
  identity_id: string;
  label: string | null;
  firstname: string | null;
  lastname: string | null;
  email: string | null;
}

interface IdentityDoc {
  _id: ObjectId;
  firstname?: string;
  lastname?: string;
  linkedinData?: { email?: string };
  emailData?: { tokens?: { email?: string } };
}

const HEX24 = /^[a-f0-9]{24}$/i;

const pickLabel = (
  firstname: string | null,
  lastname: string | null,
  email: string | null,
): string | null => {
  const name = [firstname, lastname].filter(Boolean).join(" ").trim();
  return name || email || null;
};

export const fetchIdentityLabels = async (
  identityIds: string[],
): Promise<Map<string, IdentityLabel>> => {
  const out = new Map<string, IdentityLabel>();
  const valid = [...new Set(identityIds)].filter((id) => HEX24.test(id));
  if (valid.length === 0) return out;
  const db = await getDb();
  const docs = (await db
    .collection("identities")
    .find(
      { _id: { $in: valid.map((id) => new ObjectId(id)) } },
      {
        projection: {
          _id: 1,
          firstname: 1,
          lastname: 1,
          "linkedinData.email": 1,
          "emailData.tokens.email": 1,
        },
      },
    )
    .toArray()) as IdentityDoc[];
  for (const d of docs) {
    const firstname = d.firstname?.trim() || null;
    const lastname = d.lastname?.trim() || null;
    const email =
      d.linkedinData?.email?.trim() ||
      d.emailData?.tokens?.email?.trim() ||
      null;
    const id = d._id.toString();
    out.set(id, {
      identity_id: id,
      label: pickLabel(firstname, lastname, email),
      firstname,
      lastname,
      email,
    });
  }
  return out;
};
