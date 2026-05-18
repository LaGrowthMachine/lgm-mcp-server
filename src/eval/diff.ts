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
