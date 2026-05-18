import { useCallback, useEffect, useState } from "react";
import { Typography, Table, Tag, Button, Space, Popconfirm, App } from "antd";
import { Link } from "react-router-dom";
import { http, ReplyListItem } from "../api";

export function RepliesList() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<ReplyListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const pageSize = 30;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await http.get<{
        rows: ReplyListItem[];
        total: number;
      }>("/replies", { params: { page, pageSize } });
      setRows(data.rows);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const del = async (id: string) => {
    await http.delete(`/replies/${id}`);
    message.success("Réponse supprimée");
    load();
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        Liste réponses
      </Typography.Title>
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={{
          current: page,
          pageSize,
          total,
          onChange: setPage,
          showSizeChanger: false,
        }}
        columns={[
          {
            title: "conversation",
            dataIndex: "conversation_id",
            render: (v: string) => (
              <Link to={`/conversations/${v}`}>
                <code>{v}</code>
              </Link>
            ),
          },
          { title: "prompt", dataIndex: "prompt_name", width: 90 },
          {
            title: "favorite",
            dataIndex: "is_favorite",
            width: 90,
            render: (v: boolean) =>
              v ? <Tag color="gold">favorite</Tag> : "—",
          },
          {
            title: "aperçu",
            dataIndex: "preview",
            render: (v: string) => (
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                {v}
              </Typography.Text>
            ),
          },
          {
            title: "créé",
            dataIndex: "created_at",
            width: 160,
            render: (v: string) => new Date(v).toLocaleString("fr-FR"),
          },
          {
            title: "",
            width: 80,
            render: (_: unknown, r: ReplyListItem) => (
              <Popconfirm
                title="Supprimer cette réponse ?"
                onConfirm={() => del(r.id)}
              >
                <Button size="small" danger>
                  Suppr.
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </Space>
  );
}
