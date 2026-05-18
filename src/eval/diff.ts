// Diff 100% déterministe (script, zéro inférence) entre deux résultats
// d'analyse — typiquement une nouvelle analyse vs le canon validé.
// Sert à revalider une conv quand le prompt change.

const SIGNAL_KEYS = [
  "explicit_opt_out",
  "asks_question",
  "mentions_competitor",
  "shares_pain",
  "contains_referral",
  "contains_timing_signal",
  "pricing_signal",
  "next_step_signal",
];
const LABEL_KEYS = ["negative", "open", "curious", "interest", "confirmed_need"];

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown): string => (v == null ? "—" : String(v));

export type DiffVerdict = "match" | "diff" | "incomparable";

export interface DiffResult {
  verdict: DiffVerdict;
  changes: string[];
}

// `a` = canon (référence), `b` = nouvelle analyse.
export const diffAnalyses = (a: unknown, b: unknown): DiffResult => {
  const aa = asObj(a);
  const bb = asObj(b);
  const aAnalysis = asObj(aa.analysis);
  const bAnalysis = asObj(bb.analysis);
  if (!aAnalysis.status || !bAnalysis.status) {
    return { verdict: "incomparable", changes: ["analyse(s) absente(s)"] };
  }

  const changes: string[] = [];
  const aStatus = str(aAnalysis.status);
  const bStatus = str(bAnalysis.status);
  if (aStatus !== bStatus) {
    changes.push(`status : ${aStatus} → ${bStatus}`);
  }

  if (aStatus === "ok" && bStatus === "ok") {
    const ac = asObj(aAnalysis.classification);
    const bc = asObj(bAnalysis.classification);

    for (const key of new Set([...Object.keys(ac), ...Object.keys(bc)])) {
      if (!(key in ac) || !(key in bc)) {
        changes.push(
          `schéma : clé "${key}" ${key in bc ? "ajoutée" : "retirée"}`,
        );
      }
    }

    if (str(ac.suggested_label) !== str(bc.suggested_label)) {
      changes.push(
        `suggested_label : ${str(ac.suggested_label)} → ${str(
          bc.suggested_label,
        )}`,
      );
    }
    if (str(ac.suggested_sub_label) !== str(bc.suggested_sub_label)) {
      changes.push(
        `suggested_sub_label : ${str(ac.suggested_sub_label)} → ${str(
          bc.suggested_sub_label,
        )}`,
      );
    }
    if (
      str(ac.suggested_sub_label_certainty) !==
      str(bc.suggested_sub_label_certainty)
    ) {
      changes.push(
        `sub_label_certainty : ${str(
          ac.suggested_sub_label_certainty,
        )} → ${str(bc.suggested_sub_label_certainty)}`,
      );
    }

    const al = asObj(ac.labels);
    const bl = asObj(bc.labels);
    for (const lk of LABEL_KEYS) {
      const x = asObj(al[lk]).certainty;
      const y = asObj(bl[lk]).certainty;
      if (str(x) !== str(y)) {
        changes.push(`labels.${lk}.certainty : ${str(x)} → ${str(y)}`);
      }
    }

    const asig = asObj(ac.signals);
    const bsig = asObj(bc.signals);
    for (const sk of SIGNAL_KEYS) {
      if (str(asig[sk]) !== str(bsig[sk])) {
        changes.push(`signals.${sk} : ${str(asig[sk])} → ${str(bsig[sk])}`);
      }
    }
  }

  return { verdict: changes.length === 0 ? "match" : "diff", changes };
};

// ---------- diff réponse (texte libre) ----------
// À temperature:0 le texte est reproductible : l'égalité normalisée
// (whitespace tolérant, casse significative) suffit comme détection de
// régression quand on rejoue une nouvelle version de prompt. Sinon on
// renvoie un diff mot-à-mot (LCS) pour verdict humain.

const normalizeReply = (t: string): string =>
  t
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim().replace(/[ \t]+/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const wordDiff = (a: string, b: string): string[] => {
  const A = a.split(/\s+/).filter(Boolean);
  const B = b.split(/\s+/).filter(Boolean);
  const n = A.length;
  const m = B.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        A[i] === B[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const changes: string[] = [];
  let i = 0;
  let j = 0;
  let rem: string[] = [];
  let add: string[] = [];
  const flush = () => {
    if (rem.length) changes.push(`− ${rem.join(" ")}`);
    if (add.length) changes.push(`+ ${add.join(" ")}`);
    rem = [];
    add = [];
  };
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      flush();
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rem.push(A[i++]);
    } else {
      add.push(B[j++]);
    }
  }
  while (i < n) rem.push(A[i++]);
  while (j < m) add.push(B[j++]);
  flush();
  return changes.slice(0, 40);
};

// `canonText` = réponse favoritée (référence), `newText` = nouvelle réponse.
export const diffReplies = (
  canonText: string | null | undefined,
  newText: string | null | undefined,
): DiffResult => {
  if (canonText == null || newText == null) {
    return { verdict: "incomparable", changes: ["pas encore de référence"] };
  }
  const a = normalizeReply(canonText);
  const b = normalizeReply(newText);
  if (a === b) return { verdict: "match", changes: [] };
  return { verdict: "diff", changes: wordDiff(a, b) };
};
