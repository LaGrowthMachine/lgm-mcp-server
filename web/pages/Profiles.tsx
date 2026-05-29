import { useState, useEffect, useCallback } from "react";
import {
  Typography,
  Input,
  Button,
  Space,
  Table,
  Tag,
  App,
  InputNumber,
  Segmented,
} from "antd";
import type { TablePaginationConfig } from "antd";
import { Link, useNavigate } from "react-router-dom";
import {
  http,
  IdentityBatchRow,
  IdentityChannel,
  IdentityProfileSummary,
  IdentityProfilesListResp,
} from "../api";
import { ModelSelect } from "../ModelSelect";
import { MONO_STACK } from "../theme";
import { PageHeader } from "../components/PageHeader";
import { parseConvIds, fmtDateTime } from "../format";

const MAX_CONCURRENCY = 2;
const DEFAULT_TOKEN_CAP = 10_000;

const statusTag = (s: IdentityProfileSummary["status"]) => {
  if (s === "ok") return <Tag color="success">ok</Tag>;
  if (s === "error") return <Tag color="error">erreur</Tag>;
  return <Tag>—</Tag>;
};

const channelTag = (c: IdentityChannel) =>
  c === "LINKEDIN" ? (
    <Tag color="blue">LinkedIn</Tag>
  ) : (
    <Tag color="purple">Email</Tag>
  );

export function Profiles() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [ids, setIds] = useState(
    () => sessionStorage.getItem("eval.identityIds") ?? "",
  );
  const [channel, setChannel] = useState<IdentityChannel>("LINKEDIN");
  const [modelSel, setModelSel] = useState<string>("");
  const [tokenCap, setTokenCap] = useState<number>(DEFAULT_TOKEN_CAP);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );

  const [rows, setRows] = useState<IdentityProfileSummary[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await http.get<IdentityProfilesListResp>(
        "/identities/profiles",
        { params: { page, pageSize } },
      );
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
    sessionStorage.setItem("eval.identityIds", ids);
  }, [ids]);

  const startBatch = async () => {
    setSubmitting(true);
    try {
      const list = parseConvIds(ids);
      if (list.length === 0) {
        message.warning("Aucun identityId valide (24-hex)");
        return;
      }
      const body: Record<string, unknown> = {
        ids: list,
        tokenCap,
      };
      if (modelSel) body.modelId = modelSel;
      const { data: batch } = await http.post<IdentityBatchRow>(
        "/identities/batches",
        body,
      );

      setProgress({ done: 0, total: list.length });

      // Worker pool — sequentiel par identité, MAX_CONCURRENCY en parallèle.
      // Pas de cancel sophistiqué : tab refermé = batch reste running côté DB,
      // peut être manuellement PATCH /batches/:id { aborted }. Trade-off pour
      // rester homogène avec le pattern Batches.tsx.
      // P9: queue partagée plutôt qu'un cursor incrémenté — la shift() est
      // atomique côté event-loop et la structure résiste aux refactorings.
      const queue = [...list];
      let completed = 0;
      let successCount = 0;
      const inputCount = list.length;
      const worker = async (): Promise<void> => {
        while (queue.length) {
          const idn = queue.shift();
          if (!idn) break;
          try {
            const { data } = await http.post<{ status: string }>(
              `/identities/analyze/${batch.id}/${idn}`,
              { channel },
            );
            if (data?.status === "ok") successCount++;
          } catch {
            // L'analyse a déjà été persistée en `error` côté serveur.
          }
          completed++;
          setProgress({ done: completed, total: inputCount });
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(MAX_CONCURRENCY, list.length) }, worker),
      );
      // P6: si aucune analyse n'a réussi sur un input non vide, on PATCH
      // aborted plutôt que done — sinon un batch 100 % erreurs apparaît
      // "terminé" dans la liste, ce qui est trompeur.
      const finalStatus =
        successCount === 0 && inputCount > 0 ? "aborted" : "done";
      try {
        await http.patch(`/identities/batches/${batch.id}`, {
          status: finalStatus,
        });
      } catch {
        // silencieux : batch reste `running` côté DB, marquage manuel possible.
      }
      const failures = completed - successCount;
      message.success(
        `Batch terminé : ${successCount} réussies, ${failures} échouées`,
      );
      setProgress(null);
      await load();
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

  const goDetail = (row: IdentityProfileSummary) => {
    navigate(`/profiles/${row.identity_id}/${row.channel}`);
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <PageHeader
        title="Profils stylométriques"
        description={
          <>
            Analyse le style d'écriture d'une <strong>identité LGM</strong>
            {" "}sur un canal (LinkedIn / Email) — un profil = description
            agrégée + métriques arithmétiques, injectable dans la génération
            de réponse pour calquer le ton.
          </>
        }
      />

      <Input.TextArea
        rows={4}
        value={ids}
        onChange={(e) => setIds(e.target.value)}
        placeholder="identityId séparés par virgules / espaces (24 hex)"
        style={{ fontFamily: MONO_STACK, fontSize: 13 }}
      />
      <Space wrap>
        <Segmented
          value={channel}
          onChange={(v) => setChannel(v as IdentityChannel)}
          options={[
            { label: "LinkedIn", value: "LINKEDIN" },
            { label: "Email", value: "EMAIL" },
          ]}
          disabled={submitting}
        />
        <ModelSelect
          value={modelSel}
          onChange={setModelSel}
          disabled={submitting}
        />
        <Space size={4}>
          <Typography.Text type="secondary">Token cap</Typography.Text>
          <InputNumber
            min={500}
            max={200_000}
            step={1000}
            value={tokenCap}
            onChange={(v) => setTokenCap(Number(v ?? DEFAULT_TOKEN_CAP))}
            disabled={submitting}
            style={{ width: 110 }}
          />
        </Space>
        <Button type="primary" loading={submitting} onClick={startBatch}>
          Lancer
        </Button>
        {progress && (
          <Typography.Text type="secondary">
            {progress.done} / {progress.total}
          </Typography.Text>
        )}
      </Space>

      <Typography.Title level={4} style={{ marginBottom: 0 }}>
        Profils existants
      </Typography.Title>
      <Table
        size="middle"
        rowKey={(r) => `${r.identity_id}|${r.channel}`}
        loading={loading}
        dataSource={rows}
        onChange={onTableChange}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
        }}
        onRow={(r) => ({ onClick: () => goDetail(r), style: { cursor: "pointer" } })}
        columns={[
          {
            title: "profil",
            dataIndex: "identity_label",
            render: (_: unknown, r: IdentityProfileSummary) => (
              <Link to={`/profiles/${r.identity_id}/${r.channel}`}>
                <Space size={2} direction="vertical" style={{ lineHeight: 1.2 }}>
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {r.identity_label ?? "(sans nom)"}
                  </Typography.Text>
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 11, fontFamily: MONO_STACK }}
                  >
                    {r.identity_id}
                  </Typography.Text>
                </Space>
              </Link>
            ),
          },
          {
            title: "canal",
            dataIndex: "channel",
            width: 110,
            render: channelTag,
          },
          {
            title: "statut",
            dataIndex: "status",
            width: 100,
            render: statusTag,
          },
          {
            title: "messages SENDER",
            dataIndex: "msg_count_sender",
            width: 160,
            render: (v: number | null) => (v ?? "—"),
          },
          {
            title: "conv. visitées",
            dataIndex: "conv_count",
            width: 140,
            render: (v: number | null) => (v ?? "—"),
          },
          {
            title: "modèle",
            dataIndex: "model_label",
            width: 180,
            render: (v: string | null) => v ?? "—",
          },
          {
            title: "mis à jour",
            dataIndex: "updated_at",
            width: 170,
            render: fmtDateTime,
          },
        ]}
      />
    </Space>
  );
}
