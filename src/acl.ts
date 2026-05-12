import { callFlow, McpFlowError } from "./callFlow";

const LGM_STAFF_EMAIL_REGEX = /^[a-z0-9._+-]+@lagrowthmachine\.com$/;

export interface StaffIdentity {
  email: string;
}

export const assertLgmStaff = async (apiKey: string): Promise<StaffIdentity> => {
  let member: unknown;
  try {
    member = await callFlow(apiKey, "/members");
  } catch {
    // Any /members failure (network, 401, 404, 5xx) normalizes to 503 —
    // the caller cannot meaningfully act on the underlying cause and we
    // never want to leak provenance through error responses.
    throw new McpFlowError("ACL check failed, try again shortly.", 503);
  }

  if (
    !member ||
    typeof member !== "object" ||
    !("email" in member) ||
    typeof (member as { email: unknown }).email !== "string"
  ) {
    throw new McpFlowError("ACL check returned no valid email.", 403);
  }

  const raw = (member as { email: string }).email;
  const normalized = raw.normalize("NFKC").toLowerCase().trim();

  if (!LGM_STAFF_EMAIL_REGEX.test(normalized)) {
    throw new McpFlowError(
      "explore_db is restricted to LGM staff accounts.",
      403,
    );
  }

  return { email: normalized };
};
