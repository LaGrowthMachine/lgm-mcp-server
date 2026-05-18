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
  SendOutlined,
} from "@ant-design/icons";
import { Segmented } from "antd";
import { useParams, useNavigate } from "react-router-dom";
import { http, ConvDetail, ReplyRowApi, AnalysisRow } from "../api";
import { diffLines } from "../lineDiff";

const analysisJson = (a: AnalysisRow): string =>
  JSON.stringify(
    (a.payload as any)?.analysis ?? a.payload,
    null,
    2,
  );

// Rendu façon GitHub : vert = ajout, rouge = suppression, gris = inchangé.
function AnalysisDiff({
  base,
  next,
}: {
  base: string | null;
  next: string;
}) {
  const lines =
    base == null
      ? next.split("\n").map((v) => ({ t: "eq" as const, v }))
      : diffLines(base, next);
  return (
    <div
      style={{
        margin: 0,
        fontSize: 12,
        lineHeight: "18px",
        fontFamily: "ui-monospace, monospace",
        maxHeight: 420,
        overflow: "auto",
        borderRadius: 6,
        border: "1px solid #eee",
      }}
    >
      {lines.map((l, i) => {
        const bg =
          l.t === "add" ? "#e6ffec" : l.t === "del" ? "#ffebe9" : "transparent";
        const sign = l.t === "add" ? "+" : l.t === "del" ? "−" : " ";
        const color =
          l.t === "add"
            ? "#04260f"
            : l.t === "del"
              ? "#5c1a17"
              : base == null
                ? "#1f2328"
                : "#8a8f98";
        return (
          <div
            key={i}
            style={{
              display: "flex",
              background: bg,
              color,
              whiteSpace: "pre",
            }}
          >
            <span
              style={{
                width: 18,
                textAlign: "center",
                userSelect: "none",
                opacity: 0.6,
                flex: "0 0 auto",
              }}
            >
              {sign}
            </span>
            <span style={{ flex: 1, paddingRight: 8 }}>{l.v || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ConversationDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [data, setData] = useState<ConvDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [analysisView, setAnalysisView] = useState<"diff" | "raw">("diff");

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

  const genReply = async () => {
    setGenerating(true);
    try {
      const { data: r } = await http.post(`/reply/${id}`);
      if (r.status === "skipped") message.info(r.reason ?? "ignoré");
      else message.success(`Réponse générée (prompt ${r.promptName})`);
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? "Échec génération");
    } finally {
      setGenerating(false);
    }
  };
  const toggleReplyFav = async (rid: string, value: boolean) => {
    await http.post(`/replies/${rid}/favorite`, { value });
    load();
  };
  const delReply = async (rid: string) => {
    await http.delete(`/replies/${rid}`);
    load();
  };

  const favorite: ReplyRowApi | undefined = data.replies.find(
    (r) => r.is_favorite,
  );
  // Référence du diff : le canon (la version validée). À défaut de canon,
  // chaque version est diffée vs la précédente (plus ancienne) — la liste
  // est triée du plus récent au plus ancien.
  const canonAnalysis = data.analyses.find((a) => a.is_canon) ?? null;

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
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={generating}
          onClick={genReply}
        >
          Générer une réponse (prompt actif)
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
          {favorite && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                border: "1px dashed #1f9d57",
                borderRadius: 6,
                background: "#f2fbf5",
              }}
            >
              <Typography.Text strong style={{ color: "#1f7a45" }}>
                ↳ Réponse retenue (favorite) — prompt {favorite.prompt_name}
              </Typography.Text>
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  fontSize: 13,
                  marginTop: 6,
                }}
              >
                {favorite.reply_text}
              </div>
            </div>
          )}
        </Card>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Title level={5}>
            Réponses ({data.replies.length})
          </Typography.Title>
          {data.replies.map((r) => (
            <Card
              key={r.id}
              size="small"
              style={{
                marginBottom: 12,
                borderColor: r.is_favorite ? "#1f9d57" : undefined,
              }}
              title={
                <Space>
                  {r.is_favorite && <Tag color="gold">FAVORITE</Tag>}
                  <span>prompt {r.prompt_name}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(r.created_at).toLocaleString("fr-FR")}
                  </Typography.Text>
                </Space>
              }
              extra={
                <Space>
                  <Button
                    size="small"
                    type={r.is_favorite ? "default" : "primary"}
                    onClick={() => toggleReplyFav(r.id, !r.is_favorite)}
                  >
                    {r.is_favorite ? "Retirer favorite" : "Favoriter"}
                  </Button>
                  <Popconfirm
                    title="Supprimer cette réponse ?"
                    onConfirm={() => delReply(r.id)}
                  >
                    <Button size="small" danger>
                      Suppr.
                    </Button>
                  </Popconfirm>
                </Space>
              }
            >
              <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>
                {r.reply_text}
              </div>
            </Card>
          ))}
          {data.replies.length === 0 && (
            <Typography.Text type="secondary">
              Aucune réponse générée. « Générer une réponse » utilise le prompt
              réponse actif.
            </Typography.Text>
          )}

          <Divider />

          <Space
            style={{
              width: "100%",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <Typography.Title level={5} style={{ margin: 0 }}>
              Analyses ({data.analyses.length})
            </Typography.Title>
            {data.analyses.length > 0 && (
              <Segmented
                size="small"
                value={analysisView}
                onChange={(v) => setAnalysisView(v as "diff" | "raw")}
                options={[
                  { label: "Diff", value: "diff" },
                  { label: "JSON brut", value: "raw" },
                ]}
              />
            )}
          </Space>
          {data.analyses.map((a, idx) => {
            const cur = analysisJson(a);
            let base: string | null = null;
            let refLabel = "version initiale";
            if (a.is_canon) {
              refLabel = "référence · canon";
            } else if (canonAnalysis) {
              base = analysisJson(canonAnalysis);
              refLabel = "diff vs CANON";
            } else {
              const older = data.analyses[idx + 1];
              if (older) {
                base = analysisJson(older);
                refLabel = `diff vs version précédente · ${new Date(
                  older.created_at,
                ).toLocaleString("fr-FR")}`;
              }
            }
            return (
              <Card
                key={a.id}
                size="small"
                style={{
                  marginBottom: 12,
                  borderColor: a.is_canon ? "#1f9d57" : undefined,
                }}
                title={
                  <Space wrap size={4}>
                    {a.is_canon && <Tag color="green">CANON</Tag>}
                    <Tag color={a.status === "ok" ? "blue" : "default"}>
                      {a.status}
                    </Tag>
                    <span>prompt {a.prompt_name ?? "—"}</span>
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12 }}
                    >
                      {new Date(a.created_at).toLocaleString("fr-FR")}
                    </Typography.Text>
                    {analysisView === "diff" && (
                      <Tag
                        color={base ? "purple" : "default"}
                        style={{ fontSize: 11 }}
                      >
                        {refLabel}
                      </Tag>
                    )}
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
                {analysisView === "raw" ? (
                  <pre
                    style={{
                      margin: 0,
                      fontSize: 12,
                      maxHeight: 420,
                      overflow: "auto",
                    }}
                  >
                    {cur}
                  </pre>
                ) : (
                  <AnalysisDiff base={base} next={cur} />
                )}
              </Card>
            );
          })}
          {data.analyses.length === 0 && (
            <Typography.Text type="secondary">
              Aucune analyse pour cette conversation.
            </Typography.Text>
          )}
        </div>
      </div>
    </Space>
  );
}
