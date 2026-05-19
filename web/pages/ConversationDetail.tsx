import { useEffect, useState, useCallback, useRef } from "react";
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
  Modal,
  Input,
} from "antd";
import {
  StarFilled,
  StarOutlined,
  ArrowLeftOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { Segmented } from "antd";
import { useParams, useNavigate } from "react-router-dom";
import {
  http,
  ConvDetail,
  ReplyRowApi,
  AnalysisRow,
  TranscriptItem,
} from "../api";
import { diffLines, DiffLine } from "../lineDiff";

// "2023-05-24 14:32" (epoch ms) → libellé court fr. "" si inconnu.
const fmtWhen = (at: number): string =>
  at > 0
    ? new Date(at).toLocaleString("fr-FR", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "";

// Une bulle de conversation. LEAD (le prospect) à droite ; SENDER (nous)
// à gauche. La couleur suit le RÔLE (SENDER vert marque, LEAD gris),
// indépendamment du côté ; le « bec » de la bulle suit le côté.
function Bubble({
  right,
  role,
  text,
  meta,
}: {
  right: boolean;
  role: string;
  text: string;
  meta: string;
}) {
  const isSender = role === "SENDER";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: right ? "flex-end" : "flex-start",
      }}
    >
      <Typography.Text
        type="secondary"
        style={{ fontSize: 11, marginBottom: 3, padding: "0 4px" }}
      >
        {[role, meta].filter(Boolean).join(" · ")}
      </Typography.Text>
      <div
        style={{
          maxWidth: "78%",
          background: isSender ? "#e6f4ea" : "#f3f4f6",
          border: `1px solid ${isSender ? "#bfe3cd" : "#e5e7eb"}`,
          color: "#1f2328",
          padding: "8px 12px",
          borderRadius: 12,
          borderBottomRightRadius: right ? 3 : 12,
          borderBottomLeftRadius: right ? 12 : 3,
          whiteSpace: "pre-wrap",
          fontSize: 13,
          lineHeight: 1.5,
          wordBreak: "break-word",
        }}
      >
        {text}
      </div>
    </div>
  );
}

// Vue conversation : conteneur scrollable, auto-scrollé en bas au chargement.
// Tolérant aux anciens transcripts (éléments string non structurés).
function ChatTranscript({ items }: { items: TranscriptItem[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <div
      ref={scrollRef}
      style={{
        maxHeight: "70vh",
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "4px 2px",
      }}
    >
      {items.length === 0 && (
        <Typography.Text type="secondary">
          Aucun message lisible.
        </Typography.Text>
      )}
      {items.map((m, i) => {
        if (typeof m === "string") {
          const isSender = m.startsWith("SENDER");
          const isLead = m.startsWith("LEAD");
          const text = m.replace(/^(LEAD|SENDER):\s?/, "");
          return (
            <Bubble
              key={i}
              right={isLead}
              role={isSender ? "SENDER" : isLead ? "LEAD" : ""}
              text={text}
              meta=""
            />
          );
        }
        const meta = [
          fmtWhen(m.at),
          m.channel !== "OTHER" ? m.channel : "",
          m.subject ? `Suj : ${m.subject}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <Bubble
            key={i}
            right={m.role === "LEAD"}
            role={m.role}
            text={m.text}
            meta={meta}
          />
        );
      })}
    </div>
  );
}

// Vue brute : analyse complète (status + promptVersion + classification).
const analysisJson = (a: AnalysisRow): string =>
  JSON.stringify((a.payload as any)?.analysis ?? a.payload, null, 2);

// Classification seule = ce qu'on édite et qu'on diffe (status/promptVersion
// hors diff). Tolérant aux anciens payloads.
const analysisClassification = (a: AnalysisRow): unknown =>
  (a.payload as any)?.analysis?.classification ??
  (a.payload as any)?.analysis ??
  a.payload;

// Les `reason` / `*_reason` sont du texte LLM qui varie à chaque run même
// quand la classification est stable → exclus du diff (sinon ils noient les
// vrais changements : certainty, signals, labels, sub_labels).
const stripReasons = (v: any): any => {
  if (Array.isArray(v)) return v.map(stripReasons);
  if (v && typeof v === "object") {
    const o: Record<string, any> = {};
    for (const k of Object.keys(v)) {
      if (k === "reason" || k.endsWith("_reason")) continue;
      o[k] = stripReasons(v[k]);
    }
    return o;
  }
  return v;
};

const analysisDiffJson = (a: AnalysisRow): string =>
  JSON.stringify(stripReasons(analysisClassification(a)), null, 2);

// Rendu façon GitHub : vert = ajout, rouge = suppression, gris = inchangé.
function AnalysisDiff({
  lines,
  dim,
}: {
  lines: DiffLine[];
  dim: boolean;
}) {
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
              : dim
                ? "#8a8f98"
                : "#1f2328";
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
  const [editAid, setEditAid] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editSaving, setEditSaving] = useState(false);

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
  const openEditAnalysis = (a: AnalysisRow) => {
    setEditAid(a.id);
    setEditBody(JSON.stringify(analysisClassification(a), null, 2));
  };
  const saveAnalysisEdit = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(editBody);
    } catch {
      message.error("JSON invalide");
      return;
    }
    if (
      parsed == null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      message.error("La classification doit être un objet JSON");
      return;
    }
    setEditSaving(true);
    try {
      await http.put(`/analyses/${editAid}`, { classification: parsed });
      message.success("Analyse éditée");
      setEditAid(null);
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? "Échec édition");
    } finally {
      setEditSaving(false);
    }
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
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <Card title="Conversation" size="small">
            <ChatTranscript items={data.transcript} />
          </Card>

          {favorite && (
            <Card
              size="small"
              style={{ borderColor: "#1f9d57" }}
              title={
                <Space>
                  <Tag color="gold">RÉPONSE RETENUE</Tag>
                  <span>prompt {favorite.prompt_name}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(favorite.created_at).toLocaleString("fr-FR")}
                  </Typography.Text>
                </Space>
              }
            >
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                {favorite.reply_text}
              </div>
            </Card>
          )}
        </div>

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
            const rawCur = analysisJson(a);
            const diffCur = analysisDiffJson(a);
            let baseDiff: string | null = null;
            let refLabel = "version initiale";
            if (a.is_canon) {
              refLabel = "référence · canon";
            } else if (canonAnalysis) {
              baseDiff = analysisDiffJson(canonAnalysis);
              refLabel = "vs CANON";
            } else {
              const older = data.analyses[idx + 1];
              if (older) {
                baseDiff = analysisDiffJson(older);
                refLabel = `vs version précédente · ${new Date(
                  older.created_at,
                ).toLocaleString("fr-FR")}`;
              }
            }
            const lines: DiffLine[] =
              baseDiff == null
                ? diffCur.split("\n").map((v) => ({ t: "eq" as const, v }))
                : diffLines(baseDiff, diffCur);
            const nChanged = lines.filter((l) => l.t !== "eq").length;
            const hasClassif = !!(a.payload as any)?.analysis?.classification;
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
                    {a.status !== "ok" && (
                      <Tag color="default">{a.status}</Tag>
                    )}
                    <span>prompt {a.prompt_name ?? "—"}</span>
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12 }}
                    >
                      {new Date(a.created_at).toLocaleString("fr-FR")}
                    </Typography.Text>
                    {a.edited_at && (
                      <Tag color="purple" style={{ fontSize: 11 }}>
                        ÉDITÉ ·{" "}
                        {new Date(a.edited_at).toLocaleString("fr-FR")}
                      </Tag>
                    )}
                    {analysisView === "diff" &&
                      (baseDiff == null ? (
                        <Tag color="default" style={{ fontSize: 11 }}>
                          {refLabel}
                        </Tag>
                      ) : (
                        <Tag
                          color={nChanged ? "orange" : "green"}
                          style={{ fontSize: 11 }}
                        >
                          {nChanged
                            ? `${nChanged} diff${nChanged > 1 ? "s" : ""} · ${refLabel}`
                            : `identique · ${refLabel}`}
                        </Tag>
                      ))}
                  </Space>
                }
                extra={
                  <Space>
                    {hasClassif && (
                      <Button
                        size="small"
                        onClick={() => openEditAnalysis(a)}
                      >
                        Éditer
                      </Button>
                    )}
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
                    {rawCur}
                  </pre>
                ) : (
                  <AnalysisDiff lines={lines} dim={baseDiff != null} />
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

      <Modal
        title="Éditer la classification"
        open={editAid != null}
        onCancel={() => setEditAid(null)}
        onOk={saveAnalysisEdit}
        confirmLoading={editSaving}
        okText="Enregistrer"
        cancelText="Annuler"
        width={900}
      >
        <Input.TextArea
          value={editBody}
          onChange={(e) => setEditBody(e.target.value)}
          autoSize={{ minRows: 16, maxRows: 30 }}
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}
        />
      </Modal>
    </Space>
  );
}
