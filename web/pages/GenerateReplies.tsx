import { useState, useEffect } from "react";
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
  Select,
} from "antd";
import { Link } from "react-router-dom";
import { http, GenerateReplyResp, PromptListItem } from "../api";

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

export function GenerateReplies() {
  const { message } = App.useApp();
  const [ids, setIds] = useState(
    () => sessionStorage.getItem("eval.ids") ?? "",
  );
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [prompts, setPrompts] = useState<PromptListItem[]>([]);
  const [promptSel, setPromptSel] = useState<string>(""); // "" = live

  useEffect(() => {
    http
      .get("/prompts", { params: { kind: "reply" } })
      .then(({ data }) => setPrompts(data.prompts))
      .catch(() => {});
  }, []);

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
        const { data } = await http.post<GenerateReplyResp>(
          `/reply/${id}`,
          promptSel ? { promptName: promptSel } : {},
        );
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
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        Générer des réponses
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        Génère une réponse avec le prompt réponse <strong>live</strong> (dernier
        validé) — ou un brouillon précis sélectionné ci-dessous, pour le tester
        avant de le valider (1 inférence / conv). Chaque réponse est comparée à
        la réponse <strong>favoritée</strong> de la conv.
      </Typography.Paragraph>

      <Input.TextArea
        rows={4}
        value={ids}
        onChange={(e) => setIds(e.target.value)}
        placeholder="conversationId séparés par virgules / espaces"
        style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}
      />
      <Space wrap>
        <Select
          value={promptSel}
          onChange={setPromptSel}
          style={{ minWidth: 280 }}
          options={[
            { value: "", label: "Prompt live (dernier validé)" },
            ...prompts.map((p) => ({
              value: p.name,
              label: `${p.name} — ${p.status === "validated" ? "validé" : "brouillon"}`,
            })),
          ]}
        />
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
