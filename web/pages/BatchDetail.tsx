import { useState, useEffect, useRef, useCallback } from "react";
import {
  Typography,
  Space,
  Tag,
  Table,
  Button,
  Progress,
  Statistic,
  Popconfirm,
  Tooltip,
  App,
} from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";
import { Link, useParams, useNavigate, useLocation } from "react-router-dom";
import {
  http,
  BatchDetailResp,
  BatchRow,
  BatchAnalysisItem,
  BatchVerdict,
} from "../api";

const MAX_CONCURRENCY = 3;
const POLL_MS = 3000;

const fmtDateTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString("fr-FR") : "—";

const fmtPct = (n: number | null): string =>
  n === null ? "—" : `${Math.round(n * 100)} %`;

// 1234567 → "1.23 M", 12345 → "12.3 k", 123 → "123". NULL ⇒ "—".
const fmtTokens = (n: number | null): string => {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} k`;
  return String(n);
};

// Coût USD : 4 décimales sous 1 ¢, 3 sous 1 $, 2 au-delà. NULL ⇒ "—".
const fmtCost = (n: number | null): string => {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
};

const baseVerdictTag = (v: BatchVerdict) => {
  if (v === "pass") return <Tag color="green">pass ✓</Tag>;
  if (v === "regression") return <Tag color="orange">regression</Tag>;
  if (v === "error") return <Tag color="red">erreur</Tag>;
  if (v === "skipped") return <Tag color="default">skipped</Tag>;
  return <Tag>pas de canon</Tag>;
};

// Verdict + tooltip survol affichant la raison quand on en a une (cas
// skipped/error). L'icône info à côté du tag signale visuellement qu'un
// tooltip est dispo (sinon le hover est invisible et l'info se perd).
const verdictTag = (v: BatchVerdict, reason: string | null) => {
  const tag = baseVerdictTag(v);
  if (!reason) return tag;
  return (
    <Tooltip title={reason}>
      <span style={{ cursor: "help" }}>
        {tag}
        <InfoCircleOutlined
          style={{ marginLeft: 2, color: "#8c8c8c", fontSize: 12 }}
        />
      </span>
    </Tooltip>
  );
};

const statusTag = (s: BatchRow["status"]) =>
  s === "running" ? (
    <Tag color="processing">en cours</Tag>
  ) : s === "done" ? (
    <Tag color="green">terminé</Tag>
  ) : (
    <Tag>arrêté</Tag>
  );

// Couleurs de ligne tableau analyses : reflet visuel du verdict (vert pâle =
// pass, orange = regression, rouge = error, gris pâle = skipped). Légères
// pour rester lisibles.
const ROW_BG: Record<BatchVerdict, string> = {
  pass: "#f6ffed",
  regression: "#fff7e6",
  error: "#fff1f0",
  skipped: "#fafafa",
  no_canon: "transparent",
};

const labelOrDash = (s: string | null): string => s ?? "—";

export function BatchDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = App.useApp();

  const [detail, setDetail] = useState<BatchDetailResp | null>(null);
  const [notFound, setNotFound] = useState(false);
  // `running` = ce tab a un worker pool actif (pas juste "batch en cours en
  // DB"). Sert à afficher Stop vs Marquer arrêté, et à empêcher un 2e lancer.
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // Capté à l'instant T0 : ne réagit pas aux re-renders, et on l'efface
  // dès qu'on lance le worker pour éviter un double-démarrage.
  const shouldRunRef = useRef<boolean>(
    (location.state as { run?: boolean } | null)?.run === true,
  );

  const fetchDetail =
    useCallback(async (): Promise<BatchDetailResp | null> => {
      if (!id) return null;
      try {
        const { data } = await http.get<BatchDetailResp>(`/batches/${id}`);
        setDetail(data);
        return data;
      } catch (e) {
        const err = e as { response?: { status?: number } };
        if (err.response?.status === 404) setNotFound(true);
        return null;
      }
    }, [id]);

  // Le pool de workers du batch : 3 en parallèle, AbortController pour Stop.
  // Cf. ex-Analyze.tsx — même logique (cursor partagé, pas d'await avant
  // tirage d'index ⇒ atomique côté JS mono-thread). Sortie : PATCH status
  // done|aborted + refresh détail.
  const runWorkers = useCallback(
    async (batch: BatchRow): Promise<void> => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setRunning(true);
      setDone(0);

      const list = batch.source_ids;
      let cursor = 0;
      let completed = 0;

      const worker = async (): Promise<void> => {
        for (let i = cursor++; i < list.length; i = cursor++) {
          if (ctrl.signal.aborted) return;
          const cid = list[i];
          try {
            await http.post(
              `/analyze/${cid}`,
              {
                batchId: batch.id,
                ...(batch.prompt_name
                  ? { promptName: batch.prompt_name }
                  : {}),
                ...(batch.model_id ? { modelId: batch.model_id } : {}),
              },
              { signal: ctrl.signal },
            );
          } catch {
            if (ctrl.signal.aborted) return;
            // l'échec côté serveur n'insère pas d'analyse pour cette conv ;
            // le batch terminera avec n_total < input_count (visible en UI).
          }
          completed++;
          setDone(completed);
        }
      };

      try {
        await Promise.all(
          Array.from(
            { length: Math.min(MAX_CONCURRENCY, list.length) },
            worker,
          ),
        );
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
        setRunning(false);
      }

      const finalStatus: "done" | "aborted" = ctrl.signal.aborted
        ? "aborted"
        : "done";
      try {
        await http.patch(`/batches/${batch.id}`, { status: finalStatus });
      } catch {
        // silencieux : si le PATCH foire, le batch reste "running" en DB,
        // l'utilisateur peut le marquer arrêté manuellement plus tard.
      }
      await fetchDetail();

      if (ctrl.signal.aborted)
        message.info(`Batch interrompu (${completed}/${list.length})`);
      else message.success("Batch terminé");
    },
    [fetchDetail, message],
  );

  // Chargement initial : on lit la détail, et si cet onglet est le lanceur
  // (location.state.run === true) ET que le batch est encore running, on
  // attaque les workers. On efface state.run du history pour qu'un refresh
  // ultérieur ne relance pas par accident.
  useEffect(() => {
    if (!id) return;
    let mounted = true;
    void fetchDetail().then((d) => {
      if (!mounted || !d) return;
      if (shouldRunRef.current && d.batch.status === "running") {
        shouldRunRef.current = false;
        navigate(`/batches/${id}`, { replace: true, state: null });
        void runWorkers(d.batch);
      }
    });
    return () => {
      mounted = false;
      abortRef.current?.abort();
    };
    // id seul : on ne veut pas re-fetcher à chaque change de fetchDetail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Polling : tant que le batch est `running` (que cet onglet soit lanceur
  // ou non), on rafraîchit la vue toutes les POLL_MS. Clear dès que le batch
  // n'est plus running, ou au démontage.
  useEffect(() => {
    if (!detail || detail.batch.status !== "running") return;
    const t = setInterval(() => {
      void fetchDetail();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [detail?.batch.status, fetchDetail]);

  const stop = (): void => abortRef.current?.abort();

  const markAborted = async (): Promise<void> => {
    if (!id) return;
    await http.patch(`/batches/${id}`, { status: "aborted" });
    await fetchDetail();
  };

  if (notFound)
    return (
      <Space direction="vertical">
        <Typography.Title level={3}>Batch introuvable</Typography.Title>
        <Link to="/batches">← Retour à la liste</Link>
      </Space>
    );
  if (!detail)
    return <Typography.Text type="secondary">Chargement…</Typography.Text>;

  const { batch, rows, metrics } = detail;
  const isRunning = batch.status === "running";
  const progress = isRunning && running ? done : metrics.n_total;
  const progressPct =
    batch.input_count > 0
      ? Math.round((progress / batch.input_count) * 100)
      : 0;

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <div>
          <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>
            Batch — {fmtDateTime(batch.created_at)}
          </Typography.Title>
          <Space size="small" wrap>
            {statusTag(batch.status)}
            <Tag>
              {batch.source === "favorites" ? "★ favorites" : "liste"}
            </Tag>
            <Tag color={batch.prompt_name ? "default" : "blue"}>
              prompt : {batch.prompt_name ?? "live"}
            </Tag>
            <Tag color={batch.model_label ? "purple" : "default"}>
              modèle : {batch.model_label ?? "—"}
            </Tag>
            <Typography.Text type="secondary">
              {batch.input_count} conversation(s) ciblée(s)
            </Typography.Text>
          </Space>
        </div>
        <Space>
          {isRunning && running && (
            <Button danger onClick={stop}>
              Arrêter
            </Button>
          )}
          {isRunning && !running && (
            <Popconfirm
              title="Marquer ce batch comme arrêté ?"
              onConfirm={markAborted}
            >
              <Button danger>Marquer arrêté</Button>
            </Popconfirm>
          )}
          <Link to="/batches">
            <Button>← Liste</Button>
          </Link>
        </Space>
      </Space>

      {isRunning && (
        <Progress
          percent={progressPct}
          format={() => `${progress} / ${batch.input_count}`}
        />
      )}

      {/* Partition exclusive en 3 buckets (somme = 100 % du comparable). OK/KO
          encodé par la couleur des termes "Label" / "Sub-label" — pas de
          texte OK/KO :
            row 1 : Label(vert) + Sub-label(vert) → full match
            row 2 : Label(vert) + Sub-label(rouge) → label OK, sub divergent
            row 3 : Label(rouge) seul → label faux (sub non comparé)
          Dénominateur = analyses comparables (verdict pass ou regression). */}
      {(() => {
        const cmp = rows.filter(
          (r) => r.verdict === "pass" || r.verdict === "regression",
        );
        const denom = cmp.length;
        const eq = (a: string | null, b: string | null) =>
          (a ?? null) === (b ?? null);
        const labelOk = (r: BatchAnalysisItem) => eq(r.new_label, r.canon_label);
        const subOk = (r: BatchAnalysisItem) =>
          eq(r.new_sub_label, r.canon_sub_label);
        const n_full = cmp.filter((r) => labelOk(r) && subOk(r)).length;
        const n_partial = cmp.filter((r) => labelOk(r) && !subOk(r)).length;
        const n_wrong = cmp.filter((r) => !labelOk(r)).length;
        const OK = "#3f8600";
        const KO = "#cf1322";
        type Bucket = {
          key: string;
          parts: { name: string; color: string }[];
          n: number;
          rate: number | null;
          rowColor: string;
        };
        const buckets: Bucket[] = [
          {
            key: "full",
            parts: [
              { name: "Label", color: OK },
              { name: "Sub-label", color: OK },
            ],
            n: n_full,
            rate: denom > 0 ? n_full / denom : null,
            rowColor: OK,
          },
          {
            key: "partial",
            parts: [
              { name: "Label", color: OK },
              { name: "Sub-label", color: KO },
            ],
            n: n_partial,
            rate: denom > 0 ? n_partial / denom : null,
            // Couleur "intermédiaire" du bucket sur les chiffres (orange) —
            // les couleurs OK/KO restent réservées au statut par terme.
            rowColor: "#d48806",
          },
          {
            key: "wrong",
            parts: [{ name: "Label", color: KO }],
            n: n_wrong,
            rate: denom > 0 ? n_wrong / denom : null,
            rowColor: KO,
          },
        ];
        return (
          <Space size="large" align="start" wrap>
            <Table<Bucket>
              size="small"
              pagination={false}
              showHeader
              rowKey="key"
              dataSource={buckets}
              style={{ minWidth: 340 }}
              columns={[
                {
                  title: "",
                  dataIndex: "parts",
                  render: (_: unknown, row) => (
                    <span>
                      {row.parts.map((p, i) => (
                        <span key={p.name}>
                          {i > 0 && (
                            <span style={{ color: "#999", margin: "0 6px" }}>
                              +
                            </span>
                          )}
                          <strong style={{ color: p.color }}>{p.name}</strong>
                        </span>
                      ))}
                    </span>
                  ),
                },
                {
                  title: "#",
                  dataIndex: "n",
                  width: 70,
                  align: "right",
                  render: (n: number, row) => (
                    <span style={{ color: row.rowColor, fontWeight: 600 }}>
                      {n}
                    </span>
                  ),
                },
                {
                  title: "%",
                  dataIndex: "rate",
                  width: 80,
                  align: "right",
                  render: (r: number | null, row) => (
                    <span style={{ color: row.rowColor }}>{fmtPct(r)}</span>
                  ),
                },
              ]}
            />
            <Space size="large" wrap>
              <Statistic
                title="Pas de canon"
                value={metrics.n_no_canon}
                valueStyle={{ color: "#999" }}
              />
              <Statistic
                title="Skipped"
                value={metrics.n_skipped}
                valueStyle={{ color: "#999" }}
              />
              <Statistic
                title="Erreurs"
                value={metrics.n_error}
                valueStyle={{
                  color: metrics.n_error > 0 ? "#cf1322" : undefined,
                }}
              />
              <Statistic
                title="Analyses"
                value={`${metrics.n_total} / ${batch.input_count}`}
              />
              {/* Tokens — input/output, "in" et "out" en suffixe pour signifier
                  qu'on n'additionne pas (les prix diffèrent). cache_read en
                  tooltip seulement si > 0 (info de debug, pas un KPI). */}
              <Tooltip
                title={
                  metrics.n_cache_read_tokens
                    ? `cache read : ${fmtTokens(metrics.n_cache_read_tokens)}`
                    : ""
                }
              >
                <Statistic
                  title="Tokens"
                  value={
                    metrics.n_input_tokens === null &&
                    metrics.n_output_tokens === null
                      ? "—"
                      : `${fmtTokens(metrics.n_input_tokens)} in · ${fmtTokens(
                          metrics.n_output_tokens,
                        )} out`
                  }
                  valueStyle={{ color: "#666", fontSize: 16 }}
                />
              </Tooltip>
              <Statistic
                title="Coût"
                value={fmtCost(metrics.cost_usd)}
                valueStyle={{
                  color: metrics.cost_usd === null ? "#999" : "#1d39c4",
                }}
              />
            </Space>
          </Space>
        );
      })()}

      <div>
        <Typography.Title level={4} style={{ marginBottom: 4 }}>
          Analyses ({rows.length})
        </Typography.Title>
        <Table<BatchAnalysisItem>
          size="small"
          rowKey="analysis_id"
          dataSource={rows}
          pagination={{ pageSize: 50, showSizeChanger: true }}
          onRow={(r) => ({
            style: { background: ROW_BG[r.verdict] },
          })}
          columns={[
            {
              title: "conversationId",
              dataIndex: "conversation_id",
              render: (v: string) => (
                <Link to={`/conversations/${v}`}>
                  <code>{v}</code>
                </Link>
              ),
            },
            {
              title: "label (analyse → canon)",
              width: 260,
              render: (_: unknown, r: BatchAnalysisItem) =>
                r.has_canon ? (
                  <span>
                    <code>{labelOrDash(r.new_label)}</code> →{" "}
                    <code>{labelOrDash(r.canon_label)}</code>
                  </span>
                ) : (
                  <code>{labelOrDash(r.new_label)}</code>
                ),
            },
            {
              title: "sub_label (analyse → canon)",
              width: 280,
              render: (_: unknown, r: BatchAnalysisItem) =>
                r.has_canon ? (
                  <span>
                    <code>{labelOrDash(r.new_sub_label)}</code> →{" "}
                    <code>{labelOrDash(r.canon_sub_label)}</code>
                  </span>
                ) : (
                  <code>{labelOrDash(r.new_sub_label)}</code>
                ),
            },
            {
              title: "verdict",
              dataIndex: "verdict",
              width: 130,
              render: (_: unknown, r: BatchAnalysisItem) =>
                verdictTag(r.verdict, r.reason),
            },
          ]}
        />
      </div>
    </Space>
  );
}
