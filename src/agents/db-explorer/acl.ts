// ACL gate for the explore_db tool.
//
// POC STATE (LAGM-16436): this is a passthrough — every Bearer apiKey that
// makes it past OAuth is allowed through. The hook stays here so the
// enforcement point is already wired; flipping to a real check is then
// a one-function change.
//
// What we want eventually: restrict to `*@lagrowthmachine.com`. That requires
// either (a) an upstream endpoint that returns the caller email from an apikey
// (none exists today on the LGM external API), (b) a session-bound map
// populated at OAuth /token success, or (c) a staff apikey allowlist via env.
// Cf. deferred-work.md D2.

import { McpFlowError } from "../../callFlow";

export interface StaffIdentity {
  email: string;
}

const STAFF_EMAIL_REGEX = /^[a-z0-9._+-]+@lagrowthmachine\.com$/;

// Reserved for the real implementation. Kept so future code can lean on it
// without re-deriving the regex.
export const isLgmStaffEmail = (email: string): boolean =>
  STAFF_EMAIL_REGEX.test(email.normalize("NFKC").toLowerCase().trim());

export const assertLgmStaff = async (
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _apiKey: string,
): Promise<StaffIdentity> => {
  // POC passthrough — every authenticated caller is treated as staff.
  // Keep `async` so swapping in a real check (HTTP call, lookup, etc.)
  // does not change the call sites.
  return { email: "anonymous@poc.local" };
};

// Marker so callers can detect the stub state in logs / audits if needed.
export const ACL_MODE: "poc-passthrough" | "enforced" = "poc-passthrough";

// Kept around so the rest of the codebase imports the symbol whether or not
// it is currently used. Avoids dead-import churn when toggling the gate.
void McpFlowError;
