// Helpers CSV — RFC 4180 + défense formula injection.
// Aucune dep externe : un export CSV propre tient en < 30 lignes.

// Préférer l'échappement unicode au littéral U+FEFF (certains éditeurs /
// linters strippent silencieusement les BOM invisibles).
export const CSV_BOM = "\uFEFF";

const NEEDS_QUOTE = /[",\r\n]/;
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvEscape(v: unknown): string {
  if (v == null) return "";
  // Les nombres sont émis tels quels — sinon les négatifs (`-1`) seraient
  // préfixés `'` par la défense formula-injection et Excel les lirait comme
  // du texte (casse SUM/AVG sur des colonnes coût/tokens).
  if (typeof v === "number") {
    return Number.isFinite(v) ? String(v) : "";
  }
  let s = typeof v === "string" ? v : String(v);
  if (FORMULA_LEAD.test(s)) s = "'" + s;
  if (NEEDS_QUOTE.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsvRow(cells: ReadonlyArray<unknown>): string {
  return cells.map(csvEscape).join(",");
}
