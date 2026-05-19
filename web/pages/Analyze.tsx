import { useState, useEffect, useRef } from "react";
import {
  Typography,
  Input,
  Button,
  Space,
  Table,
  Tag,
  Progress,
  App,
  Tooltip,
  Popconfirm,
  Select,
} from "antd";
import { Link } from "react-router-dom";
import { http, AnalyzeResp, PromptListItem } from "../api";

interface Row extends AnalyzeResp {
  key: string;
  error?: string;
}

const HEX24 = /^[a-f0-9]{24}$/i;
// Plafond de requêtes /analyze simultanées côté navigateur (choix conservateur).
const MAX_CONCURRENCY = 3;
const parseIds = (raw: string): string[] => [
  ...new Set(
    raw
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter((t) => HEX24.test(t)),
  ),
];

const verdictTag = (r: Row) => {
  if (r.error) return <Tag color="red">erreur</Tag>;
  if (!r.hasCanon) return <Tag>pas de canon</Tag>;
  if (r.vsCanon.verdict === "match") return <Tag color="green">= canon ✓</Tag>;
  if (r.vsCanon.verdict === "diff")
    return <Tag color="orange">≠ canon ({r.vsCanon.changes.length})</Tag>;
  return <Tag>incomparable</Tag>;
};

export function Analyze() {
  const { message } = App.useApp();
  const [ids, setIds] = useState(
    () => sessionStorage.getItem("eval.ids") ?? "",
  );
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [prompts, setPrompts] = useState<PromptListItem[]>([]);
  const [promptSel, setPromptSel] = useState<string>(""); // "" = live
  // Annulation du run courant. Abort à l'unmount (quitter la page Analyse en
  // SPA) + bouton Arrêter. Volontairement PAS d'abort sur onglet masqué : un
  // gros batch doit pouvoir tourner en arrière-plan.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    http
      .get("/prompts", { params: { kind: "analysis" } })
      .then(({ data }) => setPrompts(data.prompts))
      .catch(() => {});
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = () => abortRef.current?.abort();

  const runList = async (list: string[]) => {
    if (list.length === 0) {
      message.warning("Aucun conversationId valide");
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    setRows([]);
    setDone(0);
    setTotal(list.length);
    // Pool à concurrence fixe. JS mono-thread + aucun `await` avant le tirage
    // d'index ⇒ `cursor++` / `completed++` / `results[i] =` atomiques entre
    // workers : pas de lock. `results` indexé par position préserve l'ordre
    // de saisie ; `completed`/`results` (pas d'updater fonctionnel) = source
    // de vérité, `setDone`/`setRows` ne font que la refléter.
    const results: (Row | undefined)[] = new Array(list.length);
    let cursor = 0;
    let completed = 0;
    const worker = async () => {
      for (let i = cursor++; i < list.length; i = cursor++) {
        if (ctrl.signal.aborted) return;
        const id = list[i];
        try {
          const { data } = await http.post<AnalyzeResp>(
            `/analyze/${id}`,
            promptSel ? { promptName: promptSel } : {},
            { signal: ctrl.signal },
          );
          results[i] = { ...data, key: data.analysisId };
        } catch (e: any) {
          if (ctrl.signal.aborted) return; // requête annulée : on s'arrête net
          results[i] = {
            key: `err-${id}`,
            conversationId: id,
            analysisId: "",
            promptName: "",
            status: "error",
            analysis: {},
            hasCanon: false,
            vsCanon: { verdict: "incomparable", changes: [] },
            error: e?.response?.data?.error ?? "échec",
          };
        }
        completed++;
        setDone(completed);
        setRows(results.filter((r): r is Row => !!r));
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(MAX_CONCURRENCY, list.length) }, worker),
      );
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setRunning(false);
    }
    if (ctrl.signal.aborted)
      message.info(`Analyse interrompue (${completed}/${list.length})`);
    else message.success("Analyse terminée");
  };

  const analyzeFavorites = async () => {
    try {
      const { data } = await http.get<{ ids: string[] }>(
        "/analyze/favorites/ids",
      );
      if (!data.ids.length) {
        message.info("Aucune conversation favorite");
        return;
      }
      await runList(data.ids);
    } catch {
      message.error("Impossible de charger les favorites");
    }
  };

  const okIds = rows.filter((r) => r.analysisId).map((r) => r.analysisId);

  const canonAll = async () => {
    await http.post("/analyses/canon-batch", { ids: okIds });
    message.success(`${okIds.length} analyse(s) conservée(s) comme canon`);
  };
  const deleteAll = async () => {
    await http.post("/analyses/delete-batch", { ids: okIds });
    setRows([]);
    message.success("Analyses supprimées");
  };

  const setCanon = async (id: string) => {
    await http.post(`/analyses/${id}/canon`);
    message.success("Devient le canon");
  };
  const del = async (id: string, key: string) => {
    await http.delete(`/analyses/${id}`);
    setRows((rs) => rs.filter((r) => r.key !== key));
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        Analyse de conversations
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        Analyse avec le prompt <strong>live</strong> (dernier validé) — ou un
        brouillon précis sélectionné ci-dessous, pour le tester avant de le
        valider. Chaque conv est créée / mise à jour ; chaque analyse est
        comparée au canon validé (diff déterministe, zéro inférence). Conserve
        l'analyse pour qu'elle devienne le canon, ou supprime-la.
      </Typography.Paragraph>

      <Input.TextArea
        rows={4}
        value={ids}
        onChange={(e) => setIds(e.target.value)}
        placeholder="conversationId séparés par virgules / espaces"
        style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}
      />
      <Space wrap>
        <Select
          value={promptSel}
          onChange={setPromptSel}
          style={{ minWidth: 280 }}
          options={[
            { value: "", label: "Prompt live (dernier validé)" },
            ...prompts.map((p) => ({
              value: p.name,
              label: `${p.name} — ${p.status === "validated" ? "validé" : "brouillon"}`,
            })),
          ]}
        />
        <Button
          type="primary"
          loading={running}
          onClick={() => runList(parseIds(ids))}
        >
          Analyser la liste
        </Button>
        <Button loading={running} onClick={analyzeFavorites}>
          ★ Analyser les favorites
        </Button>
        {running && (
          <Button danger onClick={stop}>
            Arrêter
          </Button>
        )}
        {total > 0 && (
          <Progress
            percent={Math.round((done / total) * 100)}
            format={() => `${done}/${total}`}
            style={{ width: 220 }}
          />
        )}
      </Space>

      {rows.length > 0 && (
        <>
          <Space>
            <Popconfirm
              title="Conserver toutes les analyses comme canon ?"
              onConfirm={canonAll}
            >
              <Button type="primary" disabled={!okIds.length}>
                Tout conserver (canon)
              </Button>
            </Popconfirm>
            <Popconfirm title="Supprimer toutes ces analyses ?" onConfirm={deleteAll}>
              <Button danger disabled={!okIds.length}>
                Tout supprimer
              </Button>
            </Popconfirm>
          </Space>

          <Table
            size="small"
            rowKey="key"
            dataSource={rows}
            pagination={false}
            expandable={{
              expandedRowRender: (r) =>
                r.error ? (
                  <Typography.Text type="danger">{r.error}</Typography.Text>
                ) : r.vsCanon.changes.length ? (
                  <ul style={{ margin: 0 }}>
                    {r.vsCanon.changes.map((c, i) => (
                      <li key={i}>
                        <code>{c}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Typography.Text type="secondary">
                    Identique au canon.
                  </Typography.Text>
                ),
            }}
            columns={[
              {
                title: "conversationId",
                dataIndex: "conversationId",
                render: (v: string) => (
                  <Link to={`/conversations/${v}`}>
                    <code>{v}</code>
                  </Link>
                ),
              },
              {
                title: "status",
                dataIndex: "status",
                width: 90,
                render: (s: string) => (
                  <Tag color={s === "ok" ? "green" : s === "error" ? "red" : "default"}>
                    {s}
                  </Tag>
                ),
              },
              {
                title: "suggested_label",
                width: 160,
                render: (_: unknown, r: Row) => {
                  const a = r.analysis as any;
                  return a?.classification?.suggested_label ?? "—";
                },
              },
              { title: "vs canon", width: 150, render: (_: unknown, r: Row) => verdictTag(r) },
              { title: "prompt", dataIndex: "promptName", width: 90 },
              {
                title: "actions",
                width: 200,
                render: (_: unknown, r: Row) =>
                  r.analysisId ? (
                    <Space>
                      <Tooltip title="Cette analyse devient le canon de la conv">
                        <Button size="small" onClick={() => setCanon(r.analysisId)}>
                          Conserver
                        </Button>
                      </Tooltip>
                      <Button
                        size="small"
                        danger
                        onClick={() => del(r.analysisId, r.key)}
                      >
                        Supprimer
                      </Button>
                    </Space>
                  ) : (
                    "—"
                  ),
              },
            ]}
          />
        </>
      )}
    </Space>
  );
}
