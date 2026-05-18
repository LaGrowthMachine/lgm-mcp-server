import { useEffect, useState, useCallback } from "react";
import {
  Typography,
  Table,
  Tag,
  Button,
  Space,
  Switch,
  Popconfirm,
  App,
} from "antd";
import { StarFilled, StarOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import { http, ConvListRow } from "../api";

export function Conversations() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<ConvListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await http.get("/conversations", {
        params: { page, pageSize, favorite: favoriteOnly ? 1 : 0 },
      });
      setRows(data.rows);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, favoriteOnly]);

  useEffect(() => {
    load();
  }, [load]);

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

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        Conversations analysées
      </Typography.Title>
      <Space>
        <span>Favorites seulement</span>
        <Switch
          checked={favoriteOnly}
          onChange={(v) => {
            setPage(1);
            setFavoriteOnly(v);
          }}
        />
      </Space>
      <Table
        size="small"
        rowKey="conversation_id"
        loading={loading}
        dataSource={rows}
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
            title: "analyses",
            dataIndex: "analyses_count",
            width: 100,
          },
          {
            title: "canon",
            dataIndex: "has_canon",
            width: 90,
            render: (v: boolean) =>
              v ? <Tag color="green">oui</Tag> : <Tag>non</Tag>,
          },
          {
            title: "dernière analyse",
            dataIndex: "latest_at",
            width: 200,
            render: (v: string | null) =>
              v ? new Date(v).toLocaleString("fr-FR") : "—",
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
