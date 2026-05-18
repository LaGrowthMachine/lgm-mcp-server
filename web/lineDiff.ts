// Diff ligne-à-ligne (LCS) pour l'affichage — vert = ajout, rouge = suppr.
// Les payloads d'analyse JSON pretty-printés font quelques dizaines de
// lignes : LCS O(n·m) est largement suffisant.

export type DiffLine = { t: "eq" | "add" | "del"; v: string };

export const diffLines = (oldText: string, newText: string): DiffLine[] => {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: "eq", v: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ t: "del", v: a[i] });
      i++;
    } else {
      out.push({ t: "add", v: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ t: "del", v: a[i++] });
  while (j < m) out.push({ t: "add", v: b[j++] });
  return out;
};
