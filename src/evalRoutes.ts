import crypto from "node:crypto";
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

const HEX24 = /^[a-f0-9]{24}$/i;
const log = (parts: Record<string, unknown>): void => {
  console.error(
    `[eval] ${Object.entries(parts)
      .map(([k, v]) => `${k}=${typeof v === "string" && /\s/.test(v) ? `"${v}"` : v}`)
      .join(" ")}`,
  );
};

// ---------- gate d'accès (POC, D4) ----------
// EVAL_ACCESS_KEY doit être positionnée (fail closed). La clé est saisie dans
// la page et réinjectée en hidden dans chaque formulaire.
const gateConfigured = (): boolean => !!process.env.EVAL_ACCESS_KEY;
const keyOk = (provided: string): boolean => {
  const expected = process.env.EVAL_ACCESS_KEY || "";
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
textarea,input[type=number],input[type=password]{width:100%;box-sizing:border-box;font-family:ui-monospace,monospace;font-size:.85rem}
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
  k: string;
  banner?: { kind: "err" | "ok"; msg: string };
  discoverOut?: string;
  analyzeBlock?: string;
  diffBlock?: string;
}

const page = (s: PageState): string => {
  const k = esc(s.k);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Conv-Eval Harness</title><style>${PAGE_CSS}</style></head><body>
<h1>🧪 Harness d'évaluation — analyze_conversation</h1>
<p class="muted">Itère le prompt → deploy → ré-analyse → diff. Tout server-side, persistance Postgres.</p>
${
  s.banner
    ? `<p class="${s.banner.kind}">${esc(s.banner.msg)}</p>`
    : ""
}
<p><label>Clé d'accès (EVAL_ACCESS_KEY)</label>
<input form="f1" type="password" name="k" value="${k}" placeholder="clé d'accès" autocomplete="off"></p>

<section><h2>1 · Découvrir des conversationId</h2>
<form id="f1" method="post" action="eval/discover">
<input type="hidden" name="k" value="${k}">
<label>CSV (colonne <code>company_id</code>) OU userId séparés par virgules / sauts de ligne</label>
<textarea name="input" placeholder="colle ici le CSV LGM, ou des userId 24-hex">${esc(
    "",
  )}</textarea>
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
  `<form method="post" action="eval/analyze">
<input type="hidden" name="k" value="${k}">
<label>conversationId séparés par virgules</label>
<textarea name="ids" placeholder="id1, id2, id3 …"></textarea>
<button type="submit">Analyser</button>
</form>`
}
</section>

<section><h2>3 · Diff (2 dernières analyses de chaque conv)</h2>
<form method="post" action="eval/diff">
<input type="hidden" name="k" value="${k}">
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

interface Change {
  sev: 1 | 2 | 3;
  text: string;
}

// prev = plus ancienne des 2, cur = la plus récente.
const diffStable = (prev: unknown, cur: unknown): Change[] => {
  const changes: Change[] = [];
  const pa = asObj(prev);
  const ca = asObj(cur);
  if (!pa || !ca) return changes;

  const pStatus = String(pa.status ?? "?");
  const cStatus = String(ca.status ?? "?");
  if (pStatus !== cStatus) {
    changes.push({
      sev: 1,
      text: `status: ${pStatus} → ${cStatus} (transition)`,
    });
  }
  if (pa.promptVersion !== ca.promptVersion) {
    changes.push({
      sev: 3,
      text: `promptVersion: ${String(pa.promptVersion ?? "—")} → ${String(
        ca.promptVersion ?? "—",
      )}`,
    });
  }
  if (pStatus !== "ok" || cStatus !== "ok") return changes;

  const pc = asObj(pa.classification) ?? {};
  const cc = asObj(ca.classification) ?? {};

  // diff de schéma : clés top-level présentes d'un seul côté
  const keys = new Set([...Object.keys(pc), ...Object.keys(cc)]);
  for (const key of keys) {
    if (!(key in pc) || !(key in cc)) {
      changes.push({
        sev: 1,
        text: `schéma: clé "${key}" ${key in cc ? "ajoutée" : "retirée"}`,
      });
    }
  }

  const cmp = (label: string, a: unknown, b: unknown, sev: 1 | 2 | 3): void => {
    const av = a == null ? "—" : String(a);
    const bv = b == null ? "—" : String(b);
    if (av !== bv) changes.push({ sev, text: `${label}: ${av} → ${bv}` });
  };

  cmp("suggested_label", pc.suggested_label, cc.suggested_label, 2);
  cmp("suggested_sub_label", pc.suggested_sub_label, cc.suggested_sub_label, 2);
  cmp(
    "suggested_sub_label_certainty",
    pc.suggested_sub_label_certainty,
    cc.suggested_sub_label_certainty,
    3,
  );
  cmp(
    "alternative_sub_label",
    pc.alternative_sub_label,
    cc.alternative_sub_label,
    3,
  );

  const pl = asObj(pc.labels) ?? {};
  const cl = asObj(cc.labels) ?? {};
  for (const lk of LABEL_KEYS) {
    cmp(
      `labels.${lk}.certainty`,
      asObj(pl[lk])?.certainty,
      asObj(cl[lk])?.certainty,
      2,
    );
  }

  const ps = asObj(pc.signals) ?? {};
  const cs = asObj(cc.signals) ?? {};
  for (const sk of SIGNAL_KEYS) {
    cmp(`signals.${sk}`, ps[sk], cs[sk], 2);
  }

  return changes;
};

// ---------- router ----------
export const evalRouter = express.Router();
evalRouter.use(express.urlencoded({ extended: false, limit: "2mb" }));

const guard = (
  req: express.Request,
  res: express.Response,
): string | null => {
  if (!gateConfigured()) {
    res
      .status(503)
      .send(
        page({
          k: "",
          banner: {
            kind: "err",
            msg: "Harness désactivé : variable d'env EVAL_ACCESS_KEY non positionnée sur le serveur.",
          },
        }),
      );
    return null;
  }
  const k = String((req.body?.k ?? req.query?.k ?? "") as string);
  if (!keyOk(k)) {
    log({ event: "denied", path: req.path });
    res.status(401).send(
      page({
        k: "",
        banner: { kind: "err", msg: "Clé d'accès invalide ou manquante." },
      }),
    );
    return null;
  }
  return k;
};

evalRouter.get("/eval", (req: express.Request, res: express.Response) => {
  if (!gateConfigured()) {
    res.status(503).send(
      page({
        k: "",
        banner: {
          kind: "err",
          msg: "Harness désactivé : EVAL_ACCESS_KEY non positionnée sur le serveur.",
        },
      }),
    );
    return;
  }
  res.send(page({ k: "" }));
});

evalRouter.post(
  "/eval/discover",
  async (req: express.Request, res: express.Response) => {
    const k = guard(req, res);
    if (k === null) return;
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
            k,
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
          k,
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
          k,
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
    const k = guard(req, res);
    if (k === null) return;

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
          k,
          banner: {
            kind: "ok",
            msg: `Terminé — ${done}/${totalN} analysée(s). Passe à la section 3 pour le diff.`,
          },
          analyzeBlock: `<p class="muted">File vide. Relance une découverte ou colle de nouveaux ID.</p>
<form method="post" action="eval/analyze"><input type="hidden" name="k" value="${esc(
            k,
          )}"><label>conversationId séparés par virgules</label>
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
        ? `<form method="post" action="eval/analyze">
<input type="hidden" name="k" value="${esc(k)}">
<input type="hidden" name="ids" value="${esc(rest.join(","))}">
<input type="hidden" name="total" value="${totalN}">
<input type="hidden" name="done" value="${nDone}">
<button type="submit" autofocus>▶ Analyser la suivante (${rest.length} restante·s)</button>
</form>`
        : `<p class="ok">File épuisée — ${nDone}/${totalN} traitée·s. Section 3 pour le diff.</p>
<form method="post" action="eval/analyze"><input type="hidden" name="k" value="${esc(
            k,
          )}"><label>Nouvelle série</label><textarea name="ids"></textarea><button type="submit">Analyser</button></form>`;

    res.send(
      page({
        k,
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
  async (req: express.Request, res: express.Response) => {
    const k = guard(req, res);
    if (k === null) return;
    try {
      const convs = await listConversationsWithCounts();
      const eligible = convs.filter((c) => c.count >= 2);
      const skipped = convs.length - eligible.length;

      let changed = 0;
      const blocks: string[] = [];
      for (const c of eligible) {
        const rows = await getLastTwoAnalyses(c.conversationId);
        if (rows.length < 2) continue;
        // rows[0] = plus récente, rows[1] = précédente
        const curPayload = asObj(rows[0].payload);
        const prevPayload = asObj(rows[1].payload);
        const changes = diffStable(
          prevPayload?.analysis,
          curPayload?.analysis,
        );
        if (changes.length === 0) continue;
        changed++;
        const sorted = changes.sort((a, b) => a.sev - b.sev);
        blocks.push(
          `<div class="box"><strong>${esc(c.conversationId)}</strong> ` +
            `<span class="muted">(${c.count} analyses · prev ${esc(
              rows[1].createdAt,
            )} → cur ${esc(rows[0].createdAt)})</span>\n` +
            sorted
              .map(
                (ch) =>
                  `<div class="chg sev${ch.sev}">${
                    ch.sev === 1 ? "🔴" : ch.sev === 2 ? "🟠" : "🟡"
                  } ${esc(ch.text)}</div>`,
              )
              .join("") +
            `</div>`,
        );
      }

      log({
        event: "diff",
        eligible: eligible.length,
        changed,
        stable: eligible.length - changed,
        skipped,
      });
      const summary = `${eligible.length} conv comparées · <span class="sev1">${changed} avec changements</span> · ${
        eligible.length - changed
      } stables · ${skipped} ignorées (<2 analyses)`;
      res.send(
        page({
          k,
          banner: { kind: changed > 0 ? "err" : "ok", msg: "Diff terminé." },
          diffBlock: `<p>${summary}</p>${
            blocks.length ? blocks.join("\n") : '<p class="ok">Aucun changement sur les champs stables. ✅</p>'
          }`,
        }),
      );
    } catch (e) {
      res.send(
        page({
          k,
          banner: {
            kind: "err",
            msg: `Erreur diff : ${e instanceof Error ? e.message : "inconnue"}`,
          },
        }),
      );
    }
  },
);
