// Helpers de formatage partagés. Source unique de vérité — toutes les pages
// importent d'ici, pas de duplication inline (cf. _bmad-output/ux-harmonization.md).

export const HEX24 = /^[a-f0-9]{24}$/i;

/** Parse une liste libre (CSV / espaces / sauts de ligne) d'IDs hex 24. */
export const parseConvIds = (raw: string): string[] => [
  ...new Set(
    raw
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter((t) => HEX24.test(t)),
  ),
];

/** Coût USD compact : 4 décimales sous 1 ¢, 3 sous 1 $, 2 au-delà. NULL ⇒ "—". */
export const fmtCost = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
};

/** Tokens lisibles avec espace : "1.23 M" / "12.3 k" / "123". NULL ⇒ "—". */
export const fmtTokens = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} k`;
  return String(n);
};

/** Tokens compacts sans espace : "1.2M" / "12k" / "123". NULL ⇒ "—". */
export const fmtTokensCompact = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
};

/** Pourcentage entier FR : "87 %". NULL ⇒ "—". */
export const fmtPct = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `${Math.round(n * 100)} %`;

/** Date + heure FR localisée. NULL ⇒ "—". */
export const fmtDateTime = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString("fr-FR") : "—";

/** Date FR localisée (sans heure). NULL ⇒ "—". */
export const fmtDate = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString("fr-FR") : "—";

/** "à l'instant" / "il y a 5 min" / "il y a 3 j" / fallback date FR. */
export const fmtAgo = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "à l'instant";
  const m = s / 60;
  if (m < 60) return `il y a ${Math.floor(m)} min`;
  const h = m / 60;
  if (h < 24) return `il y a ${Math.floor(h)} h`;
  const d = h / 24;
  if (d < 30) return `il y a ${Math.floor(d)} j`;
  return new Date(iso).toLocaleDateString("fr-FR");
};

/** Prix USD/Mtok pour les modèles : "$3.00" / "$0.075". NULL ⇒ "—". */
export const fmtPriceMtok = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0";
  if (n < 0.1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
};
