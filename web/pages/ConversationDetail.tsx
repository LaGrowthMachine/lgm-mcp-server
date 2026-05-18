import { useEffect, useState, useCallback } from "react";
import {
  Typography,
  Card,
  Tag,
  Button,
  Space,
  Spin,
  Popconfirm,
  App,
  Divider,
} from "antd";
import {
  StarFilled,
  StarOutlined,
  ArrowLeftOutlined,
} from "@ant-design/icons";
import { useParams, useNavigate } from "react-router-dom";
import { http, ConvDetail } from "../api";

export function ConversationDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [data, setData] = useState<ConvDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await http.get<ConvDetail>(`/conversations/${id}`);
      setData(r.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Spin />;
  if (!data)
    return (
      <Space direction="vertical">
        <Typography.Text type="danger">Conversation inconnue.</Typography.Text>
        <Button onClick={() => navigate("/conversations")}>Retour</Button>
      </Space>
    );

  const toggleFav = async () => {
    await http.post(`/conversations/${id}/favorite`, {
      value: !data.is_favorite,
    });
    load();
  };
  const setCanon = async (aid: string) => {
    await http.post(`/analyses/${aid}/canon`);
    message.success("Devient le canon");
    load();
  };
  const delAnalysis = async (aid: string) => {
    await http.delete(`/analyses/${aid}`);
    load();
  };
  const delConv = async () => {
    await http.delete(`/conversations/${id}`);
    message.success("Conversation supprimée");
    navigate("/conversations");
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Space>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => navigate("/conversations")}
        >
          Conversations
        </Button>
        <Button
          icon={
            data.is_favorite ? (
              <StarFilled style={{ color: "#f0a500" }} />
            ) : (
              <StarOutlined />
            )
          }
          onClick={toggleFav}
        >
          {data.is_favorite ? "Favori" : "Marquer favori"}
        </Button>
        <Popconfirm title="Supprimer cette conversation ?" onConfirm={delConv}>
          <Button danger>Supprimer la conversation</Button>
        </Popconfirm>
      </Space>

      <Typography.Title level={4} style={{ margin: 0 }}>
        <code>{data.conversation_id}</code>
      </Typography.Title>

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        <Card title="Transcript" size="small" style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              whiteSpace: "pre-wrap",
              fontFamily: "ui-monospace, monospace",
              fontSize: 12.5,
              maxHeight: "70vh",
              overflow: "auto",
            }}
          >
            {data.transcript.join("\n\n")}
          </div>
        </Card>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Title level={5}>
            Analyses ({data.analyses.length})
          </Typography.Title>
          {data.analyses.map((a) => (
            <Card
              key={a.id}
              size="small"
              style={{ marginBottom: 12 }}
              title={
                <Space>
                  {a.is_canon && <Tag color="green">CANON</Tag>}
                  <Tag color={a.status === "ok" ? "blue" : "default"}>
                    {a.status}
                  </Tag>
                  <span>prompt {a.prompt_name ?? "—"}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(a.created_at).toLocaleString("fr-FR")}
                  </Typography.Text>
                </Space>
              }
              extra={
                <Space>
                  {!a.is_canon && (
                    <Button size="small" onClick={() => setCanon(a.id)}>
                      Définir canon
                    </Button>
                  )}
                  <Popconfirm
                    title="Supprimer cette analyse ?"
                    onConfirm={() => delAnalysis(a.id)}
                  >
                    <Button size="small" danger>
                      Suppr.
                    </Button>
                  </Popconfirm>
                </Space>
              }
            >
              <pre
                style={{
                  margin: 0,
                  fontSize: 12,
                  maxHeight: 360,
                  overflow: "auto",
                }}
              >
                {JSON.stringify(
                  (a.payload as any)?.analysis ?? a.payload,
                  null,
                  2,
                )}
              </pre>
            </Card>
          ))}
          {data.analyses.length === 0 && (
            <>
              <Divider />
              <Typography.Text type="secondary">
                Aucune analyse pour cette conversation.
              </Typography.Text>
            </>
          )}
        </div>
      </div>
    </Space>
  );
}
