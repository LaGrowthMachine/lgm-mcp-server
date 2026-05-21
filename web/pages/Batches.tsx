import { useState, useEffect, useCallback } from "react";
import {
  Typography,
  Input,
  Button,
  Space,
  Table,
  Tag,
  App,
} from "antd";
import type { TablePaginationConfig } from "antd";
import { Link, useNavigate } from "react-router-dom";
import { http, BatchRow, BatchListItem, BatchListResp } from "../api";
import { PromptSelect } from "../PromptSelect";
import { ModelSelect } from "../ModelSelect";

const HEX24 = /^[a-f0-9]{24}$/i;
const parseIds = (raw: string): string[] => [
  ...new Set(
    raw
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter((t) => HEX24.test(t)),
  ),
];

const fmtDateTime = (iso: string): string =>
  new Date(iso).toLocaleString("fr-FR");

const fmtPct = (n: number | null): string =>
  n === null ? "—" : `${Math.round(n * 100)} %`;

const fmtCost = (n: number | null): string => {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
};

const fmtTokensCompact = (n: number | null): string => {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
};

const statusTag = (s: BatchListItem["status"]) =>
  s === "running" ? (
    <Tag color="processing">en cours</Tag>
  ) : s === "done" ? (
    <Tag color="green">terminé</Tag>
  ) : (
    <Tag>arrêté</Tag>
  );

export function Batches() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [ids, setIds] = useState(
    () => sessionStorage.getItem("eval.ids") ?? "",
  );
  const [promptSel, setPromptSel] = useState<string>("");
  const [modelSel, setModelSel] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  const [rows, setRows] = useState<BatchListItem[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await http.get<BatchListResp>("/batches", {
        params: { page, pageSize },
      });
      setRows(data.rows);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    sessionStorage.setItem("eval.ids", ids);
  }, [ids]);

  // Création : on demande au serveur de résoudre/figer les IDs (favorites OU
  // liste cliente filtrée), puis on navigue vers la page détail qui prend la
  // main sur l'exécution. La page détail démarre le worker pool si
  // location.state.run === true (= cet onglet est le lanceur).
  const startBatch = async (source: "ids" | "favorites") => {
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { source };
      if (promptSel) body.promptName = promptSel;
      if (modelSel) body.modelId = modelSel;
      if (source === "ids") {
        const list = parseIds(ids);
        if (list.length === 0) {
          message.warning("Aucun conversationId valide");
          return;
        }
        body.ids = list;
      }
      const { data } = await http.post<BatchRow>("/batches", body);
      navigate(`/batches/${data.id}`, { state: { run: true } });
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } };
      message.error(err.response?.data?.error ?? "Échec création du batch");
    } finally {
      setSubmitting(false);
    }
  };

  const onTableChange = (pag: TablePaginationConfig) => {
    setPage(pag.current ?? 1);
    setPageSize(pag.pageSize ?? 20);
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        Analyses en batch
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        Chaque lancement crée un <strong>batch</strong> persisté
        (partageable / revisitable). Le prompt est figé au lancement, les
        analyses sont liées au batch, et les KPIs (pass / régression) sont
        comparés au canon courant de chaque conversation.
      </Typography.Paragraph>

      <Input.TextArea
        rows={4}
        value={ids}
        onChange={(e) => setIds(e.target.value)}
        placeholder="conversationId séparés par virgules / espaces"
        style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}
      />
      <Space wrap>
        <PromptSelect
          value={promptSel}
          onChange={setPromptSel}
          disabled={submitting}
        />
        <ModelSelect
          value={modelSel}
          onChange={setModelSel}
          disabled={submitting}
        />
        <Button
          type="primary"
          loading={submitting}
          onClick={() => startBatch("ids")}
        >
          Lancer la liste
        </Button>
        <Button loading={submitting} onClick={() => startBatch("favorites")}>
          ★ Lancer les favorites
        </Button>
      </Space>

      <Typography.Title level={4} style={{ marginBottom: 0 }}>
        Historique
      </Typography.Title>
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        onChange={onTableChange}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
        }}
        columns={[
          {
            title: "date",
            dataIndex: "created_at",
            width: 170,
            render: (v: string) => fmtDateTime(v),
          },
          {
            title: "source",
            dataIndex: "source",
            width: 110,
            render: (v: BatchListItem["source"]) =>
              v === "favorites" ? <Tag color="gold">★ favorites</Tag> : <Tag>liste</Tag>,
          },
          {
            title: "prompt",
            dataIndex: "prompt_name",
            width: 140,
            render: (v: string | null) =>
              v ? <code>{v}</code> : <Tag color="blue">live</Tag>,
          },
          {
            title: "modèle",
            dataIndex: "model_label",
            width: 160,
            render: (v: string | null) => v ?? "—",
          },
          {
            title: "#conv",
            width: 90,
            render: (_: unknown, r: BatchListItem) =>
              `${r.n_total} / ${r.input_count}`,
          },
          {
            title: "pass",
            width: 80,
            render: (_: unknown, r: BatchListItem) => {
              const denom = r.n_pass + r.n_regression;
              return fmtPct(denom > 0 ? r.n_pass / denom : null);
            },
          },
          {
            title: "régressions",
            dataIndex: "n_regression",
            width: 110,
            render: (n: number) =>
              n > 0 ? <Tag color="orange">{n}</Tag> : "—",
          },
          {
            title: "skipped",
            dataIndex: "n_skipped",
            width: 90,
            render: (n: number) => (n > 0 ? <Tag>{n}</Tag> : "—"),
          },
          {
            title: "erreurs",
            dataIndex: "n_error",
            width: 90,
            render: (n: number) => (n > 0 ? <Tag color="red">{n}</Tag> : "—"),
          },
          {
            // Cellule compacte : coût en gras + total tokens en gris dessous.
            // NULL ⇒ "—" sur 1 ligne pour les batchs legacy ou sans tokens.
            title: "coût",
            width: 110,
            align: "right",
            render: (_: unknown, r: BatchListItem) => {
              const tot =
                r.n_input_tokens === null && r.n_output_tokens === null
                  ? null
                  : (r.n_input_tokens ?? 0) + (r.n_output_tokens ?? 0);
              return (
                <div style={{ lineHeight: 1.15 }}>
                  <div style={{ fontWeight: 600 }}>{fmtCost(r.cost_usd)}</div>
                  <div style={{ fontSize: 11, color: "#999" }}>
                    {fmtTokensCompact(tot)} tok
                  </div>
                </div>
              );
            },
          },
          {
            title: "statut",
            dataIndex: "status",
            width: 100,
            render: statusTag,
          },
          {
            title: "",
            width: 90,
            render: (_: unknown, r: BatchListItem) => (
              <Link to={`/batches/${r.id}`}>
                <Button size="small">Ouvrir</Button>
              </Link>
            ),
          },
        ]}
      />
    </Space>
  );
}
