import { useEffect, useState, useCallback } from "react";
import {
  Typography,
  Table,
  Button,
  Space,
  Switch,
  Select,
  InputNumber,
  Statistic,
  Tag,
  Popconfirm,
  App,
} from "antd";
import type { TablePaginationConfig } from "antd";
import type { SorterResult } from "antd/es/table/interface";
import { StarFilled, StarOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import { http, ConvListRow, ConvListMetrics } from "../api";

const fmtAgo = (iso: string | null): string => {
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

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString("fr-FR") : "—";

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

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        Liste conversations
      </Typography.Title>

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
        <Space size="large" wrap>
          <Statistic title="Conversations" value={metrics.count} />
          <Statistic title="Favorites" value={metrics.favorites} />
          <Statistic title="Avec canon" value={metrics.with_canon} />
          <Statistic
            title="Moy. messages"
            value={metrics.avg_messages ?? "—"}
          />
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 14 }}>
              Période
            </Typography.Text>
            <div style={{ fontSize: 16 }}>
              {fmtDate(metrics.period_from)} → {fmtDate(metrics.period_to)}
            </div>
          </div>
        </Space>
      )}

      <Table
        size="small"
        rowKey="conversation_id"
        loading={loading}
        dataSource={rows}
        onChange={onTableChange}
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
                    <StarFilled style={{ color: "#f0a500" }} />
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
            width: 160,
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
                    Suppr.
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
