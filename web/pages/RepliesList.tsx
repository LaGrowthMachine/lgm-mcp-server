import { useCallback, useEffect, useState } from "react";
import { Typography, Table, Tag, Button, Space, Popconfirm, App } from "antd";
import { CommentOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import { http, ReplyListItem } from "../api";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { fmtCost, fmtDateTime, fmtTokensCompact } from "../format";
import { LGM_COLORS, MONO_STACK } from "../theme";

const channelTag = (c: ReplyListItem["channel"]) =>
  c === "LINKEDIN" ? (
    <Tag color="blue">LinkedIn</Tag>
  ) : c === "EMAIL" ? (
    <Tag color="purple">Email</Tag>
  ) : null;

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
      <PageHeader
        title="Réponses"
        description="Toutes les réponses générées par l'assistant, toutes conversations confondues. Les « retenues » servent de référence pour comparer les nouvelles générations."
      />
      <Table
        size="middle"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        locale={{
          emptyText: (
            <EmptyState
              icon={<CommentOutlined />}
              title="Aucune réponse"
              hint="Génère une réponse depuis une conversation pour voir apparaître l'historique ici."
            />
          ),
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          onChange: setPage,
          showSizeChanger: false,
        }}
        columns={[
          {
            title: "réponse",
            dataIndex: "id",
            width: 110,
            render: (v: string) => (
              <Link to={`/replies/${v}`}>
                <code style={{ fontFamily: MONO_STACK }}>#{v}</code>
              </Link>
            ),
          },
          {
            title: "profil",
            dataIndex: "identity_label",
            width: 220,
            render: (_: unknown, r: ReplyListItem) => {
              if (!r.identity_id) {
                return <Typography.Text type="secondary">—</Typography.Text>;
              }
              const dest = `/profiles/${r.identity_id}/${r.channel ?? "LINKEDIN"}`;
              return (
                <Link to={dest}>
                  <Space size={6} direction="vertical" style={{ lineHeight: 1.2 }}>
                    <Space size={6}>
                      <Typography.Text strong style={{ fontSize: 13 }}>
                        {r.identity_label ?? "(sans nom)"}
                      </Typography.Text>
                      {channelTag(r.channel)}
                    </Space>
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 11, fontFamily: MONO_STACK }}
                    >
                      {r.identity_id}
                    </Typography.Text>
                  </Space>
                </Link>
              );
            },
          },
          {
            title: "conversation",
            dataIndex: "conversation_id",
            width: 220,
            render: (v: string) => (
              <Link to={`/conversations/${v}`}>
                <code style={{ fontSize: 11 }}>{v}</code>
              </Link>
            ),
          },
          { title: "prompt", dataIndex: "prompt_name", width: 90 },
          {
            title: "modèle",
            dataIndex: "model_label",
            width: 160,
            render: (v: string | null) =>
              v ?? <Typography.Text type="secondary">—</Typography.Text>,
          },
          {
            title: "coût",
            dataIndex: "cost_usd",
            width: 140,
            render: (_: unknown, r: ReplyListItem) => {
              if (
                r.cost_usd === null &&
                r.input_tokens === null &&
                r.output_tokens === null
              ) {
                return <Typography.Text type="secondary">—</Typography.Text>;
              }
              return (
                <Space size={2} direction="vertical" style={{ lineHeight: 1.2 }}>
                  <Typography.Text strong style={{ color: LGM_COLORS.green }}>
                    {fmtCost(r.cost_usd)}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {fmtTokensCompact(r.input_tokens)} in /{" "}
                    {fmtTokensCompact(r.output_tokens)} out
                  </Typography.Text>
                </Space>
              );
            },
          },
          {
            title: "retenue",
            dataIndex: "is_favorite",
            width: 90,
            render: (v: boolean) =>
              v ? <Tag color="success">retenue</Tag> : "—",
          },
          {
            title: "créé",
            dataIndex: "created_at",
            width: 160,
            render: (v: string) => fmtDateTime(v),
          },
          {
            title: "",
            width: 110,
            render: (_: unknown, r: ReplyListItem) => (
              <Popconfirm
                title="Supprimer cette réponse ?"
                onConfirm={() => del(r.id)}
              >
                <Button size="small" danger>
                  Supprimer
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </Space>
  );
}
