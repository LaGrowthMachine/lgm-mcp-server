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
import { ExclamationCircleOutlined } from "@ant-design/icons";
import type { TablePaginationConfig } from "antd";
import { Link, useNavigate } from "react-router-dom";
import {
  http,
  BatchRow,
  BatchListItem,
  BatchListResp,
  deleteBatch,
} from "../api";
import { PromptSelect } from "../PromptSelect";
import { ModelSelect } from "../ModelSelect";
import { LGM_COLORS, MONO_STACK } from "../theme";
import { PageHeader } from "../components/PageHeader";
import { renderBatchDeleteContent } from "../components/BatchDeleteWarnings";
import {
  parseConvIds,
  fmtDateTime,
  fmtPct,
  fmtCost,
  fmtTokensCompact,
} from "../format";

const statusTag = (s: BatchListItem["status"]) =>
  s === "running" ? (
    <Tag color="processing">en cours</Tag>
  ) : s === "done" ? (
    <Tag color="success">terminé</Tag>
  ) : (
    <Tag>arrêté</Tag>
  );

export function Batches() {
  // `modal` via App.useApp() hérite du ConfigProvider (couleurs/locale fr_FR)
  // — Modal.confirm statique émet un warning AntD 5 et perd le theming LGM.
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [ids, setIds] = useState(
    () => sessionStorage.getItem("eval.ids") ?? "",
  );
  const [promptSel, setPromptSel] = useState<string>("");
  const [modelSel, setModelSel] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  // Id du batch en cours de suppression — empêche le double-click sur la même
  // row et affiche le loading sur ce bouton uniquement.
  const [deletingId, setDeletingId] = useState<string | null>(null);

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
        const list = parseConvIds(ids);
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

  // Modal.confirm bloquant — content conditionnel (warning canon + running)
  // partagé avec BatchDetail.tsx. Pas d'effet de bord avant onOk : si l'user
  // ferme/annule, aucune requête réseau émise.
  const confirmDelete = (row: BatchListItem) => {
    modal.confirm({
      title: "Supprimer ce batch ?",
      icon: <ExclamationCircleOutlined style={{ color: LGM_COLORS.warning }} />,
      content: renderBatchDeleteContent({
        n_total: row.n_total,
        n_canon: row.n_canon,
        status: row.status,
      }),
      okType: "danger",
      okText: "Supprimer",
      cancelText: "Annuler",
      onOk: async () => {
        setDeletingId(row.id);
        try {
          const { deletedAnalyses } = await deleteBatch(row.id);
          message.success(
            `Batch supprimé (${deletedAnalyses} analyse${
              deletedAnalyses > 1 ? "s" : ""
            })`,
          );
          await load();
        } catch (e) {
          // Mapping FR des codes d'erreur serveur — jamais d'identifiant
          // technique brut affiché à l'utilisateur.
          const err = e as { response?: { status?: number } };
          const status = err.response?.status;
          if (status === 404) message.error("Batch introuvable");
          else if (status === 400) message.error("Identifiant de batch invalide");
          else message.error("Échec de la suppression du batch");
          // Pas de rethrow : AntD ferme le modal naturellement après onOk,
          // le toast a déjà notifié.
        } finally {
          setDeletingId(null);
        }
      },
    });
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <PageHeader
        title="Batchs"
        description={
          <>
            Chaque lancement crée un <strong>batch</strong> persisté
            (partageable / revisitable). Le prompt est figé au lancement, les
            analyses sont liées au batch, et les KPIs (pass / régression) sont
            comparés au canon courant de chaque conversation.
          </>
        }
      />

      <Input.TextArea
        rows={4}
        value={ids}
        onChange={(e) => setIds(e.target.value)}
        placeholder="conversationId séparés par virgules / espaces"
        style={{ fontFamily: MONO_STACK, fontSize: 13 }}
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
        size="middle"
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
            render: (v: string, r: BatchListItem) => (
              <Link to={`/batches/${r.id}`}>{fmtDateTime(v)}</Link>
            ),
          },
          {
            title: "source",
            dataIndex: "source",
            width: 110,
            render: (v: BatchListItem["source"]) =>
              v === "favorites" ? (
                <Tag color="gold">★ favorites</Tag>
              ) : (
                <Tag>liste</Tag>
              ),
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
              n > 0 ? <Tag color="warning">{n}</Tag> : "—",
          },
          {
            title: "ignorées",
            dataIndex: "n_skipped",
            width: 90,
            render: (n: number) => (n > 0 ? <Tag>{n}</Tag> : "—"),
          },
          {
            title: "erreurs",
            dataIndex: "n_error",
            width: 90,
            render: (n: number) =>
              n > 0 ? <Tag color="error">{n}</Tag> : "—",
          },
          {
            // Cellule compacte : coût total en gras + total tokens en gris dessous.
            // NULL ⇒ "—" sur 1 ligne pour les batchs legacy ou sans tokens.
            title: "coût total",
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
                  <div
                    style={{ fontSize: 11, color: LGM_COLORS.textTertiary }}
                  >
                    {fmtTokensCompact(tot)} tok
                  </div>
                </div>
              );
            },
          },
          {
            // Coût moyen par analyse facturée — exclut les ignorées (qui n'ont
            // appelé aucune inférence et restent cost NULL). Donne un indicateur
            // stable du coût marginal d'une conv réellement classifiée.
            title: "coût moyen",
            width: 100,
            align: "right",
            render: (_: unknown, r: BatchListItem) => {
              const denom = r.n_total - r.n_skipped;
              const avg =
                r.cost_usd !== null && denom > 0 ? r.cost_usd / denom : null;
              return fmtCost(avg);
            },
          },
          {
            title: "statut",
            dataIndex: "status",
            width: 100,
            render: statusTag,
          },
          {
            title: "actions",
            width: 120,
            align: "right",
            render: (_: unknown, r: BatchListItem) => (
              <Button
                danger
                size="small"
                loading={deletingId === r.id}
                disabled={deletingId !== null && deletingId !== r.id}
                onClick={(e) => {
                  // Empêche la propagation au lien sur la row.
                  e.stopPropagation();
                  confirmDelete(r);
                }}
              >
                Supprimer
              </Button>
            ),
          },
        ]}
      />
    </Space>
  );
}
