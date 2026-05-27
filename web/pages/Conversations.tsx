import { useEffect, useState, useCallback } from "react";
import {
  Typography,
  Table,
  Button,
  Space,
  Switch,
  Select,
  InputNumber,
  Tag,
  Popconfirm,
  App,
} from "antd";
import type { TablePaginationConfig } from "antd";
import type { SorterResult } from "antd/es/table/interface";
import {
  StarFilled,
  StarOutlined,
  MessageOutlined,
  DownloadOutlined,
} from "@ant-design/icons";
import { Link } from "react-router-dom";
import { http, ConvListRow, ConvListMetrics } from "../api";
import { LGM_COLORS } from "../theme";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { KpiStat } from "../components/KpiStat";
import { fmtAgo, fmtDate } from "../format";

export function Conversations() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<ConvListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [metrics, setMetrics] = useState<ConvListMetrics | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);

  // Filtres (server-side, params /conversations)
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [canonOnly, setCanonOnly] = useState(false);
  const [minMessages, setMinMessages] = useState<number | null>(null);
  const [lastRole, setLastRole] = useState<string>("");
  const [channel, setChannel] = useState<string>("");
  const [sort, setSort] = useState("last_at");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await http.get("/conversations", {
        params: {
          page,
          pageSize,
          favorite: favoriteOnly ? 1 : 0,
          ...(canonOnly ? { hasCanon: 1 } : {}),
          ...(minMessages ? { minMessages } : {}),
          ...(lastRole ? { lastRole } : {}),
          ...(channel ? { channel } : {}),
          sort,
          dir,
        },
      });
      setRows(data.rows);
      setTotal(data.total);
      setMetrics(data.metrics);
    } finally {
      setLoading(false);
    }
  }, [
    page,
    pageSize,
    favoriteOnly,
    canonOnly,
    minMessages,
    lastRole,
    channel,
    sort,
    dir,
  ]);

  useEffect(() => {
    load();
  }, [load]);

  // Tout changement de filtre repart en page 1.
  const onFilter = (fn: () => void) => {
    setPage(1);
    fn();
  };

  const toggleFav = async (r: ConvListRow) => {
    await http.post(`/conversations/${r.conversation_id}/favorite`, {
      value: !r.is_favorite,
    });
    load();
  };

  const del = async (id: string) => {
    await http.delete(`/conversations/${id}`);
    message.success("Conversation supprimée");
    load();
  };

  const onTableChange = (
    _pag: TablePaginationConfig,
    _flt: unknown,
    sorter: SorterResult<ConvListRow> | SorterResult<ConvListRow>[],
  ) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    if (s && s.field && s.order) {
      setSort(String(s.field));
      setDir(s.order === "ascend" ? "asc" : "desc");
    }
  };

  // Construit le query string d'export depuis l'état filtres courant.
  // Mêmes params que l'appel JSON, sans page/pageSize (l'export ignore la
  // pagination). Param `favorite` n'est inclus que si vrai (`0` est l'état
  // par défaut, pas un filtre actif côté serveur).
  const buildExportUrl = (): string => {
    const qs = new URLSearchParams();
    if (favoriteOnly) qs.set("favorite", "1");
    if (canonOnly) qs.set("hasCanon", "1");
    if (minMessages) qs.set("minMessages", String(minMessages));
    if (lastRole) qs.set("lastRole", lastRole);
    if (channel) qs.set("channel", channel);
    if (sort) qs.set("sort", sort);
    if (dir) qs.set("dir", dir);
    const s = qs.toString();
    return s
      ? `/api/eval/conversations/export.csv?${s}`
      : "/api/eval/conversations/export.csv";
  };

  // Télécharge le CSV via fetch+blob plutôt que `window.location.href` : ça
  // permet d'intercepter un 413 (cap dépassé) et d'afficher un toast plutôt
  // que de remplacer la SPA par la page d'erreur plaintext. Le cookie de
  // session OAuth est porté nativement (même origine).
  const exportCsv = async () => {
    setExporting(true);
    try {
      const resp = await fetch(buildExportUrl(), { credentials: "include" });
      if (resp.status === 413) {
        const text = await resp.text();
        message.error(text || "Export trop volumineux : filtre davantage.");
        return;
      }
      if (!resp.ok) {
        message.error(`Export impossible (HTTP ${resp.status}).`);
        return;
      }
      const blob = await resp.blob();
      const disposition = resp.headers.get("Content-Disposition") ?? "";
      const filename =
        disposition.match(/filename="([^"]+)"/)?.[1] ??
        `conversations-${new Date().toISOString().slice(0, 10)}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : "Export impossible (réseau).",
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <PageHeader
        title="Conversations"
        description="Bibliothèque des conversations analysées. Marque-en une en favorite pour la retrouver vite, et définis-lui un canon (analyse de référence) pour qu'elle soit comparée dans les batchs."
        actions={
          <Button
            icon={<DownloadOutlined />}
            loading={exporting}
            onClick={exportCsv}
          >
            Exporter CSV
          </Button>
        }
      />

      <Space wrap size="middle">
        <Space>
          <span>Favorites</span>
          <Switch
            checked={favoriteOnly}
            onChange={(v) => onFilter(() => setFavoriteOnly(v))}
          />
        </Space>
        <Space>
          <span>Avec canon</span>
          <Switch
            checked={canonOnly}
            onChange={(v) => onFilter(() => setCanonOnly(v))}
          />
        </Space>
        <Space>
          <span>Messages ≥</span>
          <InputNumber
            min={1}
            style={{ width: 80 }}
            value={minMessages}
            onChange={(v) => onFilter(() => setMinMessages(v))}
          />
        </Space>
        <Select
          style={{ width: 170 }}
          value={lastRole}
          onChange={(v) => onFilter(() => setLastRole(v))}
          options={[
            { value: "", label: "Dernier émetteur : tous" },
            { value: "LEAD", label: "Finit sur LEAD" },
            { value: "SENDER", label: "Finit sur SENDER" },
          ]}
        />
        <Select
          style={{ width: 150 }}
          value={channel}
          onChange={(v) => onFilter(() => setChannel(v))}
          options={[
            { value: "", label: "Canal : tous" },
            { value: "LINKEDIN", label: "LinkedIn" },
            { value: "EMAIL", label: "Email" },
          ]}
        />
      </Space>

      {metrics && (
        <Space size="large" wrap align="start">
          <KpiStat label="Conversations" value={metrics.count} />
          <KpiStat label="Favorites" value={metrics.favorites} />
          <KpiStat label="Avec canon" value={metrics.with_canon} />
          <KpiStat label="Moy. messages" value={metrics.avg_messages ?? "—"} />
          <KpiStat
            label="Période"
            value={
              <span style={{ fontSize: 14, fontWeight: 500 }}>
                {fmtDate(metrics.period_from)} → {fmtDate(metrics.period_to)}
              </span>
            }
          />
        </Space>
      )}

      <Table
        size="middle"
        rowKey="conversation_id"
        loading={loading}
        dataSource={rows}
        onChange={onTableChange}
        locale={{
          emptyText: (
            <EmptyState
              icon={<MessageOutlined />}
              title="Aucune conversation"
              hint="Lance un Trouver pour découvrir des conversations à analyser."
            />
          ),
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
        columns={[
          {
            title: "",
            width: 44,
            render: (_: unknown, r: ConvListRow) => (
              <Button
                type="text"
                icon={
                  r.is_favorite ? (
                    <StarFilled style={{ color: LGM_COLORS.warning }} />
                  ) : (
                    <StarOutlined />
                  )
                }
                onClick={() => toggleFav(r)}
              />
            ),
          },
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
            title: "msg",
            dataIndex: "msg_count",
            width: 70,
            sorter: true,
            render: (v: number | null) => v ?? "—",
          },
          {
            title: "début",
            dataIndex: "first_at",
            width: 110,
            sorter: true,
            render: (v: string | null) => fmtDate(v),
          },
          {
            title: "dernière activité",
            dataIndex: "last_at",
            width: 140,
            sorter: true,
            defaultSortOrder: "descend",
            render: (v: string | null) => fmtAgo(v),
          },
          {
            title: "dernier",
            dataIndex: "last_role",
            width: 90,
            render: (v: string | null) =>
              v ? (
                <Tag color={v === "LEAD" ? "blue" : "default"}>{v}</Tag>
              ) : (
                "—"
              ),
          },
          {
            title: "canal",
            dataIndex: "channels",
            width: 120,
            render: (v: string[] | null) =>
              v && v.length ? v.join(", ") : "—",
          },
          {
            title: "canon",
            dataIndex: "has_canon",
            width: 70,
            render: (v: boolean) =>
              v ? <Tag color="green">oui</Tag> : <Tag>non</Tag>,
          },
          {
            title: "analyses",
            dataIndex: "analyses_count",
            width: 80,
          },
          {
            title: "actions",
            width: 180,
            render: (_: unknown, r: ConvListRow) => (
              <Space>
                <Link to={`/conversations/${r.conversation_id}`}>
                  <Button size="small">Ouvrir</Button>
                </Link>
                <Popconfirm
                  title="Supprimer la conversation et ses analyses ?"
                  onConfirm={() => del(r.conversation_id)}
                >
                  <Button size="small" danger>
                    Supprimer
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}
