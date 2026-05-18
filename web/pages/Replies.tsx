import { useCallback, useEffect, useState } from "react";
import {
  Typography,
  Input,
  Button,
  Space,
  Table,
  Tag,
  Progress,
  App,
  Popconfirm,
  Tabs,
} from "antd";
import { Link } from "react-router-dom";
import { http, GenerateReplyResp, ReplyListItem } from "../api";

interface Row extends GenerateReplyResp {
  key: string;
  error?: string;
}

const HEX24 = /^[a-f0-9]{24}$/i;
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
  if (r.status === "skipped") return <Tag>ignoré</Tag>;
  if (!r.hasFavorite) return <Tag>pas de référence</Tag>;
  if (r.vsFavorite.verdict === "match")
    return <Tag color="green">= favorite ✓</Tag>;
  if (r.vsFavorite.verdict === "diff")
    return <Tag color="orange">≠ favorite ({r.vsFavorite.changes.length})</Tag>;
  return <Tag>incomparable</Tag>;
};

function BatchTab() {
  const { message } = App.useApp();
  const [ids, setIds] = useState(
    () => sessionStorage.getItem("eval.ids") ?? "",
  );
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);

  const runList = async (list: string[]) => {
    if (list.length === 0) {
      message.warning("Aucun conversationId valide");
      return;
    }
    setRunning(true);
    setRows([]);
    setDone(0);
    setTotal(list.length);
    const acc: Row[] = [];
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      try {
        const { data } = await http.post<GenerateReplyResp>(`/reply/${id}`);
        acc.push({ ...data, key: data.replyId ?? `sk-${id}` });
      } catch (e: any) {
        acc.push({
          key: `err-${id}`,
          conversationId: id,
          replyId: null,
          promptName: "",
          status: "skipped",
          replyText: null,
          hasFavorite: false,
          vsFavorite: { verdict: "incomparable", changes: [] },
          error: e?.response?.data?.error ?? "échec",
        });
      }
      setDone(i + 1);
      setRows([...acc]);
    }
    setRunning(false);
    message.success("Génération terminée");
  };

  const runFavorites = async () => {
    try {
      const { data } = await http.get<{ ids: string[] }>(
        "/reply/favorites/ids",
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

  const okIds = rows.filter((r) => r.replyId).map((r) => r.replyId as string);

  const favoriteAll = async () => {
    await http.post("/replies/favorite-batch", { ids: okIds });
    message.success(`${okIds.length} réponse(s) favoritée(s)`);
  };
  const deleteAll = async () => {
    await http.post("/replies/delete-batch", { ids: okIds });
    setRows([]);
    message.success("Réponses supprimées");
  };
  const setFav = async (id: string) => {
    await http.post(`/replies/${id}/favorite`, { value: true });
    message.success("Réponse favoritée (référence de la conv)");
  };
  const del = async (id: string, key: string) => {
    await http.delete(`/replies/${id}`);
    setRows((rs) => rs.filter((r) => r.key !== key));
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary">
        Génère une réponse avec le <strong>prompt réponse actif</strong> (1
        inférence / conv, comme l'analyse). Chaque réponse est comparée à la
        réponse <strong>favoritée</strong> de la conv (diff texte déterministe,
        temperature 0). Favorite-la pour qu'elle devienne la référence.
      </Typography.Paragraph>

      <Input.TextArea
        rows={4}
        value={ids}
        onChange={(e) => setIds(e.target.value)}
        placeholder="conversationId séparés par virgules / espaces"
        style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}
      />
      <Space wrap>
        <Button
          type="primary"
          loading={running}
          onClick={() => runList(parseIds(ids))}
        >
          Générer pour la liste
        </Button>
        <Button loading={running} onClick={runFavorites}>
          ★ Générer pour les favorites
        </Button>
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
              title="Favoriter toutes ces réponses (référence par conv) ?"
              onConfirm={favoriteAll}
            >
              <Button type="primary" disabled={!okIds.length}>
                Tout favoriter
              </Button>
            </Popconfirm>
            <Popconfirm
              title="Supprimer toutes ces réponses ?"
              onConfirm={deleteAll}
            >
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
                ) : r.status === "skipped" ? (
                  <Typography.Text type="secondary">
                    {r.reason ?? "ignoré"}
                  </Typography.Text>
                ) : (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <div
                      style={{
                        whiteSpace: "pre-wrap",
                        fontSize: 13,
                        background: "#f6f8f7",
                        padding: 12,
                        borderRadius: 6,
                      }}
                    >
                      {r.replyText}
                    </div>
                    {r.vsFavorite.changes.length > 0 && (
                      <ul style={{ margin: 0 }}>
                        {r.vsFavorite.changes.map((c, i) => (
                          <li key={i}>
                            <code>{c}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Space>
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
                title: "vs favorite",
                width: 170,
                render: (_: unknown, r: Row) => verdictTag(r),
              },
              { title: "prompt", dataIndex: "promptName", width: 90 },
              {
                title: "actions",
                width: 200,
                render: (_: unknown, r: Row) =>
                  r.replyId ? (
                    <Space>
                      <Button
                        size="small"
                        onClick={() => setFav(r.replyId as string)}
                      >
                        Favoriter
                      </Button>
                      <Button
                        size="small"
                        danger
                        onClick={() => del(r.replyId as string, r.key)}
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

function LibraryTab() {
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
  );
}

export function Replies() {
  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        Réponses
      </Typography.Title>
      <Tabs
        items={[
          {
            key: "batch",
            label: "Rejouer (batch)",
            children: <BatchTab />,
          },
          {
            key: "lib",
            label: "Bibliothèque",
            children: <LibraryTab />,
          },
        ]}
      />
    </Space>
  );
}
