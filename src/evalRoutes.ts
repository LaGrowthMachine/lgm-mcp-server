import express from "express";
import { ObjectId } from "mongodb";
import { getDb } from "./agents/db-explorer/mongoClient";
import { analyzeConversation } from "./agents/conversation-analyzer/analyze";
import {
  insertAnalysis,
  getLastTwoAnalyses,
  listConversationsWithCounts,
  countAnalyzedAmong,
} from "./pg";

// Harness d'évaluation itérative d'analyze_conversation. Tout server-side :
// formulaires HTML rendus par le serveur, zéro JS client. Voir spec
// _bmad-output/planning-artifacts/conv-eval-harness-spec.md (rev. 3).
// Accès libre (D4 : interne, POC-passthrough — aucune clé).

const HEX24 = /^[a-f0-9]{24}$/i;
const log = (parts: Record<string, unknown>): void => {
  console.error(
    `[eval] ${Object.entries(parts)
      .map(([k, v]) => `${k}=${typeof v === "string" && /\s/.test(v) ? `"${v}"` : v}`)
      .join(" ")}`,
  );
};

// ---------- helpers HTML ----------
const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const asObj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

const PAGE_CSS = `
:root{font-family:system-ui,sans-serif;line-height:1.4}
body{max-width:980px;margin:1.5rem auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.3rem} h2{font-size:1.05rem;margin-top:2rem;border-bottom:1px solid #ddd;padding-bottom:.3rem}
section{margin-bottom:1.5rem}
textarea,input[type=number]{width:100%;box-sizing:border-box;font-family:ui-monospace,monospace;font-size:.85rem}
textarea{min-height:5rem}
button{background:#1a5;color:#fff;border:0;padding:.5rem 1rem;border-radius:4px;cursor:pointer;font-size:.9rem;margin-top:.5rem}
.muted{color:#666;font-size:.85rem}
.err{background:#fdd;border:1px solid #c00;padding:.5rem;border-radius:4px}
.ok{background:#dfd;border:1px solid #1a5;padding:.5rem;border-radius:4px}
.box{background:#f6f6f6;border:1px solid #ddd;padding:.6rem;border-radius:4px;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.82rem;overflow:auto}
.chg{margin:.15rem 0;font-size:.85rem} .sev1{color:#c00;font-weight:600} .sev2{color:#d60} .sev3{color:#888}
label{display:block;margin:.6rem 0 .15rem;font-size:.85rem;font-weight:600}
`;

interface PageState {
  banner?: { kind: "err" | "ok"; msg: string };
  discoverOut?: string;
  analyzeBlock?: string;
  diffBlock?: string;
}

const page = (s: PageState): string => {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Conv-Eval Harness</title><style>${PAGE_CSS}</style></head><body>
<h1>🧪 Harness d'évaluation — analyze_conversation</h1>
<p class="muted">Itère le prompt → deploy → ré-analyse → diff. Tout server-side, persistance Postgres.</p>
${
  s.banner
    ? `<p class="${s.banner.kind}">${esc(s.banner.msg)}</p>`
    : ""
}
<section><h2>1 · Découvrir des conversationId</h2>
<form method="post" action="/eval/discover">
<label>CSV (colonne <code>company_id</code>) OU userId séparés par virgules / sauts de ligne</label>
<textarea name="input" placeholder="colle ici le CSV LGM, ou des userId 24-hex"></textarea>
<label>Nombre de conversations par société</label>
<input type="number" name="limit" value="50" min="1" max="200">
<label><input type="checkbox" name="repliedOnly" value="1" checked> Seulement les fils où le lead a répondu (leadReplied:true)</label>
<button type="submit">Découvrir</button>
</form>
${
  s.discoverOut !== undefined
    ? `<label>conversationId trouvés (copie-les en section 2)</label>
<textarea class="box" readonly>${esc(s.discoverOut)}</textarea>`
    : ""
}
</section>

<section><h2>2 · Analyser (1 conv par requête — contrainte routeur Heroku 30 s)</h2>
${
  s.analyzeBlock ??
  `<form method="post" action="/eval/analyze">
<label>conversationId séparés par virgules</label>
<textarea name="ids" placeholder="id1, id2, id3 …"></textarea>
<button type="submit">Analyser</button>
</form>`
}
</section>

<section><h2>3 · Diff (2 dernières analyses de chaque conv)</h2>
<form method="post" action="/eval/diff">
<button type="submit">Lancer le diff</button>
</form>
${s.diffBlock ?? ""}
</section>
</body></html>`;
};

// ---------- parsing entrée section 1 ----------
const parseUserIds = (raw: string): string[] => {
  let tokens: string[];
  if (/company_id/i.test(raw)) {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
    const col = header.indexOf("company_id");
    tokens =
      col >= 0
        ? lines
            .slice(1)
            .map((l) => (l.split(",")[col] ?? "").trim().replace(/^"|"$/g, ""))
        : [];
  } else {
    tokens = raw.split(/[\s,;]+/);
  }
  return [...new Set(tokens.map((t) => t.trim()).filter((t) => HEX24.test(t)))];
};

const parseConvIds = (raw: string): string[] =>
  [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((t) => t.trim())
        .filter((t) => HEX24.test(t)),
    ),
  ];

// ---------- diff sur champs stables ----------
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

type Sev = 1 | 2 | 3;
interface Change {
  sev: Sev;
  text: string;
}
type Verdict = "reg" | "watch" | "noise" | "stable";

const CRANK: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
  very_low: 0,
};
const crank = (v: unknown): number =>
  typeof v === "string" && v in CRANK ? CRANK[v] : -1;
const str = (v: unknown): string => (v == null ? "—" : String(v));

interface ConvDiff {
  changes: Change[];
  verdict: Verdict;
  sameVersion: boolean;
}

// Décision b+c : per-conv durci au high-certainty (le bruit d'inférence à
// temp:0 vit dans la bande low/medium et les flips de signaux). Une vraie
// régression = transition de status, changement de schéma, ou flip de
// label/sub_label alors que le modèle était high-confiance des 2 côtés.
const diffConv = (prev: unknown, cur: unknown): ConvDiff => {
  const changes: Change[] = [];
  const pa = asObj(prev);
  const ca = asObj(cur);
  if (!pa || !ca) return { changes, verdict: "stable", sameVersion: true };

  const pStatus = String(pa.status ?? "?");
  const cStatus = String(ca.status ?? "?");
  const sameVersion = pa.promptVersion === ca.promptVersion;

  if (pStatus !== cStatus) {
    changes.push({ sev: 1, text: `status: ${pStatus} → ${cStatus} (transition)` });
  }
  if (pa.promptVersion !== ca.promptVersion) {
    changes.push({
      sev: 3,
      text: `promptVersion: ${str(pa.promptVersion)} → ${str(ca.promptVersion)}`,
    });
  }

  if (pStatus === "ok" && cStatus === "ok") {
    const pc = asObj(pa.classification) ?? {};
    const cc = asObj(ca.classification) ?? {};

    // schéma : structural → toujours sev1
    for (const key of new Set([...Object.keys(pc), ...Object.keys(cc)])) {
      if (!(key in pc) || !(key in cc)) {
        changes.push({
          sev: 1,
          text: `schéma: clé "${key}" ${key in cc ? "ajoutée" : "retirée"}`,
        });
      }
    }

    const bothHigh =
      crank(pc.suggested_sub_label_certainty) === 3 &&
      crank(cc.suggested_sub_label_certainty) === 3;

    if (str(pc.suggested_label) !== str(cc.suggested_label)) {
      changes.push({
        sev: bothHigh ? 1 : 3,
        text: `suggested_label: ${str(pc.suggested_label)} → ${str(
          cc.suggested_label,
        )}${bothHigh ? " [high/high → régression]" : " [conf. faible → bruit probable]"}`,
      });
    }
    if (str(pc.suggested_sub_label) !== str(cc.suggested_sub_label)) {
      changes.push({
        sev: bothHigh ? 2 : 3,
        text: `suggested_sub_label: ${str(pc.suggested_sub_label)} → ${str(
          cc.suggested_sub_label,
        )}`,
      });
    }
    if (
      str(pc.suggested_sub_label_certainty) !==
      str(cc.suggested_sub_label_certainty)
    ) {
      changes.push({
        sev: 3,
        text: `suggested_sub_label_certainty: ${str(
          pc.suggested_sub_label_certainty,
        )} → ${str(cc.suggested_sub_label_certainty)}`,
      });
    }
    if (str(pc.alternative_sub_label) !== str(cc.alternative_sub_label)) {
      changes.push({
        sev: 3,
        text: `alternative_sub_label: ${str(pc.alternative_sub_label)} → ${str(
          cc.alternative_sub_label,
        )}`,
      });
    }

    const pl = asObj(pc.labels) ?? {};
    const cl = asObj(cc.labels) ?? {};
    for (const lk of LABEL_KEYS) {
      const a = asObj(pl[lk])?.certainty;
      const b = asObj(cl[lk])?.certainty;
      if (str(a) !== str(b)) {
        const crossesHigh = (crank(a) === 3) !== (crank(b) === 3);
        changes.push({
          sev: crossesHigh ? 2 : 3,
          text: `labels.${lk}.certainty: ${str(a)} → ${str(b)}${
            crossesHigh ? " (franchit high)" : ""
          }`,
        });
      }
    }

    const ps = asObj(pc.signals) ?? {};
    const cs = asObj(cc.signals) ?? {};
    for (const sk of SIGNAL_KEYS) {
      if (str(ps[sk]) !== str(cs[sk])) {
        changes.push({
          sev: 3,
          text: `signals.${sk}: ${str(ps[sk])} → ${str(cs[sk])}`,
        });
      }
    }
  }

  const maxSev = changes.length
    ? (Math.min(...changes.map((c) => c.sev)) as Sev)
    : 99;
  const verdict: Verdict =
    changes.length === 0
      ? "stable"
      : maxSev === 1
        ? "reg"
        : maxSev === 2
          ? "watch"
          : "noise";
  return { changes, verdict, sameVersion };
};

// Décision b : distribution agrégée sur le batch (robuste au bruit per-conv).
interface Dist {
  ok: number;
  skipped: number;
  labels: Record<string, number>;
  signals: Record<string, number>;
}
const emptyDist = (): Dist => ({
  ok: 0,
  skipped: 0,
  labels: Object.fromEntries(LABEL_KEYS.map((l) => [l, 0])),
  signals: Object.fromEntries(SIGNAL_KEYS.map((s) => [s, 0])),
});
const addToDist = (d: Dist, analysis: unknown): void => {
  const a = asObj(analysis);
  if (!a) return;
  const st = String(a.status ?? "");
  if (st === "skipped") {
    d.skipped++;
    return;
  }
  if (st !== "ok") return;
  d.ok++;
  const c = asObj(a.classification) ?? {};
  const sl = String(c.suggested_label ?? "");
  if (sl in d.labels) d.labels[sl]++;
  const sig = asObj(c.signals) ?? {};
  for (const sk of SIGNAL_KEYS) if (sig[sk] === true) d.signals[sk]++;
};
const deltaCell = (p: number, c: number): string => {
  const d = c - p;
  const col = d === 0 ? "sev3" : "sev1";
  return `${p} → ${c} <span class="${col}">(${d > 0 ? "+" : ""}${d})</span>`;
};

// ---------- router ----------
export const evalRouter = express.Router();
evalRouter.use(express.urlencoded({ extended: false, limit: "2mb" }));

evalRouter.get("/eval", (_req: express.Request, res: express.Response) => {
  res.send(page({}));
});

evalRouter.post(
  "/eval/discover",
  async (req: express.Request, res: express.Response) => {
    try {
      const input = String(req.body?.input ?? "");
      const repliedOnly = !!req.body?.repliedOnly;
      let limit = parseInt(String(req.body?.limit ?? "50"), 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 50;
      limit = Math.min(limit, 200);

      const userIds = parseUserIds(input);
      if (userIds.length === 0) {
        res.send(
          page({
            banner: {
              kind: "err",
              msg: "Aucun userId 24-hex détecté (CSV colonne company_id, ou liste d'ID).",
            },
          }),
        );
        return;
      }

      const db = await getDb();
      const found: string[] = [];
      for (const uid of userIds) {
        const filter: Record<string, unknown> = {
          userId: new ObjectId(uid),
          deleted: false,
        };
        if (repliedOnly) filter.leadReplied = true;
        const docs = await db
          .collection("inboxConversations")
          .find(filter, {
            projection: { _id: 1 },
            sort: { lastMessageAt: -1 },
            limit,
          })
          .toArray();
        for (const d of docs) found.push(String(d._id));
      }

      log({
        event: "discover",
        users: userIds.length,
        repliedOnly,
        limit,
        found: found.length,
      });
      res.send(
        page({
          banner: {
            kind: "ok",
            msg: `${found.length} conversationId pour ${userIds.length} société(s).`,
          },
          discoverOut: found.join(", "),
        }),
      );
    } catch (e) {
      log({ event: "discover_error", msg: e instanceof Error ? e.message : "?" });
      res.send(
        page({
          banner: {
            kind: "err",
            msg: `Erreur découverte : ${e instanceof Error ? e.message : "inconnue"}`,
          },
        }),
      );
    }
  },
);

evalRouter.post(
  "/eval/analyze",
  async (req: express.Request, res: express.Response) => {
    const ids = parseConvIds(String(req.body?.ids ?? ""));
    const total = parseInt(String(req.body?.total ?? ""), 10);
    const totalN = Number.isFinite(total) && total > 0 ? total : ids.length;
    const doneIn = parseInt(String(req.body?.done ?? "0"), 10);
    const done = Number.isFinite(doneIn) && doneIn >= 0 ? doneIn : 0;

    if (ids.length === 0) {
      const analyzed = await countAnalyzedAmong([]).catch(() => 0);
      void analyzed;
      res.send(
        page({
          banner: {
            kind: "ok",
            msg: `Terminé — ${done}/${totalN} analysée(s). Passe à la section 3 pour le diff.`,
          },
          analyzeBlock: `<p class="muted">File vide. Relance une découverte ou colle de nouveaux ID.</p>
<form method="post" action="/eval/analyze"><label>conversationId séparés par virgules</label>
<textarea name="ids" placeholder="id1, id2 …"></textarea><button type="submit">Analyser</button></form>`,
        }),
      );
      return;
    }

    const [head, ...rest] = ids;
    let resultMsg: string;
    let sev: "ok" | "err" = "ok";
    try {
      const result = await analyzeConversation(head);
      await insertAnalysis({
        conversationId: head,
        promptVersion:
          result.analysis.status === "ok"
            ? result.analysis.promptVersion
            : null,
        status: result.analysis.status,
        payload: result,
      });
      resultMsg = `✓ ${head} → ${result.analysis.status}`;
      log({ event: "analyze", conv: head, status: result.analysis.status });
    } catch (e) {
      sev = "err";
      resultMsg = `✗ ${head} → ${e instanceof Error ? e.message : "erreur"}`;
      log({
        event: "analyze_error",
        conv: head,
        msg: e instanceof Error ? e.message : "?",
      });
    }

    const nDone = done + 1;
    const continueForm =
      rest.length > 0
        ? `<form method="post" action="/eval/analyze">
<input type="hidden" name="ids" value="${esc(rest.join(","))}">
<input type="hidden" name="total" value="${totalN}">
<input type="hidden" name="done" value="${nDone}">
<button type="submit" autofocus>▶ Analyser la suivante (${rest.length} restante·s)</button>
</form>`
        : `<p class="ok">File épuisée — ${nDone}/${totalN} traitée·s. Section 3 pour le diff.</p>
<form method="post" action="/eval/analyze"><label>Nouvelle série</label><textarea name="ids"></textarea><button type="submit">Analyser</button></form>`;

    res.send(
      page({
        banner: {
          kind: sev,
          msg: `${resultMsg} — progression ${nDone}/${totalN}`,
        },
        analyzeBlock: `<p class="muted">Dernier : ${esc(resultMsg)}</p>${continueForm}`,
      }),
    );
  },
);

evalRouter.post(
  "/eval/diff",
  async (_req: express.Request, res: express.Response) => {
    try {
      const convs = await listConversationsWithCounts();
      const eligible = convs.filter((c) => c.count >= 2);
      const ignored = convs.length - eligible.length;

      const prevDist = emptyDist();
      const curDist = emptyDist();
      let nReg = 0;
      let nWatch = 0;
      let nNoise = 0;
      let nStable = 0;
      let nSameVer = 0;
      const regBlocks: string[] = [];
      const noiseIds: string[] = [];

      for (const c of eligible) {
        const rows = await getLastTwoAnalyses(c.conversationId);
        if (rows.length < 2) continue;
        const cur = asObj(rows[0].payload)?.analysis; // plus récente
        const prev = asObj(rows[1].payload)?.analysis; // précédente
        addToDist(prevDist, prev);
        addToDist(curDist, cur);

        const d = diffConv(prev, cur);
        if (d.sameVersion) nSameVer++;
        if (d.verdict === "reg") nReg++;
        else if (d.verdict === "watch") nWatch++;
        else if (d.verdict === "noise") nNoise++;
        else nStable++;

        if (d.verdict === "reg" || d.verdict === "watch") {
          const badge =
            d.verdict === "reg"
              ? '<span class="sev1">🔴 RÉGRESSION probable</span>'
              : '<span class="sev2">🟠 à regarder</span>';
          regBlocks.push(
            `<div class="box"><strong>${esc(c.conversationId)}</strong> ${badge} ` +
              `<span class="muted">(${c.count} analyses · ${
                d.sameVersion
                  ? "⚠️ MÊME version prompt → divergence = bruit d'inférence"
                  : "versions différentes → candidate régression"
              } · prev ${esc(rows[1].createdAt)} → cur ${esc(rows[0].createdAt)})</span>\n` +
              d.changes
                .sort((a, b) => a.sev - b.sev)
                .map(
                  (ch) =>
                    `<div class="chg sev${ch.sev}">${
                      ch.sev === 1 ? "🔴" : ch.sev === 2 ? "🟠" : "🟡"
                    } ${esc(ch.text)}</div>`,
                )
                .join("") +
              `</div>`,
          );
        } else if (d.verdict === "noise") {
          noiseIds.push(c.conversationId);
        }
      }

      log({
        event: "diff",
        eligible: eligible.length,
        reg: nReg,
        watch: nWatch,
        noise: nNoise,
        stable: nStable,
        sameVer: nSameVer,
        ignored,
      });

      const allSameVer =
        eligible.length > 0 && nSameVer === eligible.length;
      const distRow = (
        label: string,
        p: number,
        c: number,
      ): string =>
        `<div class="chg">${esc(label)} : ${deltaCell(p, c)}</div>`;
      const distBlock =
        `<div class="box"><strong>Distribution batch (robuste au bruit per-conv)</strong>\n` +
        distRow("status ok", prevDist.ok, curDist.ok) +
        distRow("status skipped", prevDist.skipped, curDist.skipped) +
        LABEL_KEYS.map((l) =>
          distRow(`suggested_label=${l}`, prevDist.labels[l], curDist.labels[l]),
        ).join("") +
        SIGNAL_KEYS.map((s) =>
          distRow(`signal ${s}`, prevDist.signals[s], curDist.signals[s]),
        ).join("") +
        `</div>`;

      const summary =
        `${eligible.length} conv comparées · ` +
        `<span class="sev1">${nReg} régression probable</span> · ` +
        `<span class="sev2">${nWatch} à regarder</span> · ` +
        `${nNoise} bruit · ${nStable} stables · ${ignored} ignorées (<2 analyses)`;

      const warn = allSameVer
        ? `<p class="err">⚠️ Toutes les paires comparées sont en <strong>même version de prompt</strong> : ce diff mesure le <strong>bruit d'inférence</strong>, pas une régression. Pour un vrai diff de régression : change le prompt, re-deploy, ré-analyse les mêmes convs, puis relance le diff.</p>`
        : "";

      res.send(
        page({
          banner: {
            kind: nReg > 0 ? "err" : "ok",
            msg: "Diff terminé.",
          },
          diffBlock:
            `<p>${summary}</p>${warn}${distBlock}` +
            (regBlocks.length
              ? `<p class="muted">Per-conv (régression / à regarder seulement ; le bruit est exclu) :</p>${regBlocks.join("\n")}`
              : '<p class="ok">Aucune régression high-confiance. ✅</p>') +
            (noiseIds.length
              ? `<p class="muted">${noiseIds.length} conv avec changements faible-confiance/bruit (non comptés) : ${esc(
                  noiseIds.join(", "),
                )}</p>`
              : ""),
        }),
      );
    } catch (e) {
      res.send(
        page({
          banner: {
            kind: "err",
            msg: `Erreur diff : ${e instanceof Error ? e.message : "inconnue"}`,
          },
        }),
      );
    }
  },
);
