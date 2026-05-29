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
  InputNumber,
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
  GenerateReplyResp,
} from "../api";
import { diffLines, DiffLine } from "../lineDiff";
import { LGM_COLORS, MONO_STACK } from "../theme";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { ModelSelect } from "../ModelSelect";
import { fmtDateTime, fmtCost } from "../format";

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
          background: isSender ? LGM_COLORS.greenTint : LGM_COLORS.surfaceSubtle,
          border: `1px solid ${isSender ? LGM_COLORS.greenTintStrong : LGM_COLORS.border}`,
          color: LGM_COLORS.textBase,
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
        fontFamily: MONO_STACK,
        maxHeight: 420,
        overflow: "auto",
        borderRadius: 6,
        border: `1px solid ${LGM_COLORS.borderSubtle}`,
      }}
    >
      {lines.map((l, i) => {
        const bg =
          l.t === "add"
            ? LGM_COLORS.greenTintStrong
            : l.t === "del"
              ? LGM_COLORS.coralTint
              : "transparent";
        const sign = l.t === "add" ? "+" : l.t === "del" ? "−" : " ";
        const color =
          l.t === "add"
            ? LGM_COLORS.greenActive
            : l.t === "del"
              ? LGM_COLORS.coralHover
              : dim
                ? LGM_COLORS.textTertiary
                : LGM_COLORS.textBase;
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
  // Paramètres de génération de réponse (LAGM-16436). Modèle = override sur
  // settings.default_model_id ; tokenCap = budget contexte pour le grounding
  // futur (forward-compat). La validation stylométrique se consulte sur la
  // page détail de chaque réponse, pas inline ici.
  const [genModel, setGenModel] = useState<string>("");
  const [genTokenCap, setGenTokenCap] = useState<number>(10_000);

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
    if (!Number.isFinite(genTokenCap) || genTokenCap < 100) {
      message.error("Token cap invalide");
      return;
    }
    setGenerating(true);
    try {
      const body: Record<string, unknown> = { tokenCap: genTokenCap };
      if (genModel) body.modelId = genModel;
      const { data: r } = await http.post<GenerateReplyResp>(
        `/reply/${id}`,
        body,
      );
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
      <PageHeader
        breadcrumb={
          <Button
            type="link"
            size="small"
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate("/conversations")}
            style={{ padding: 0 }}
          >
            Conversations
          </Button>
        }
        title={
          <span style={{ fontFamily: MONO_STACK, fontSize: 18 }}>
            {data.conversation_id}
          </span>
        }
        actions={
          <>
            <Button
              icon={
                data.is_favorite ? (
                  <StarFilled style={{ color: LGM_COLORS.warning }} />
                ) : (
                  <StarOutlined />
                )
              }
              onClick={toggleFav}
            >
              {data.is_favorite ? "Favorite" : "Marquer favorite"}
            </Button>
            <ModelSelect
              value={genModel}
              onChange={setGenModel}
              disabled={generating}
            />
            <Space size={4}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Token cap
              </Typography.Text>
              <InputNumber
                min={500}
                max={200_000}
                step={1000}
                value={genTokenCap}
                onChange={(v) => setGenTokenCap(Number(v ?? 10_000))}
                disabled={generating}
                style={{ width: 100 }}
              />
            </Space>
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={generating}
              onClick={genReply}
            >
              Générer une réponse
            </Button>
            <Popconfirm
              title="Supprimer cette conversation ?"
              onConfirm={delConv}
            >
              <Button danger>Supprimer</Button>
            </Popconfirm>
          </>
        }
      />

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
              style={{ borderColor: LGM_COLORS.green }}
              title={
                <Space>
                  <Tag color="success">RETENUE</Tag>
                  <span>prompt {favorite.prompt_name}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {fmtDateTime(favorite.created_at)}
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
                borderColor: r.is_favorite ? LGM_COLORS.green : undefined,
              }}
              title={
                <Space>
                  {r.is_favorite && <Tag color="success">RETENUE</Tag>}
                  <span>prompt {r.prompt_name}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {fmtDateTime(r.created_at)}
                  </Typography.Text>
                </Space>
              }
              extra={
                <Space>
                  <Button
                    size="small"
                    onClick={() => navigate(`/replies/${r.id}`)}
                  >
                    Détail
                  </Button>
                  <Button
                    size="small"
                    type={r.is_favorite ? "default" : "primary"}
                    onClick={() => toggleReplyFav(r.id, !r.is_favorite)}
                  >
                    {r.is_favorite ? "Retirer (retenue)" : "Marquer retenue"}
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
            <EmptyState
              icon={<SendOutlined />}
              title="Aucune réponse"
              hint="« Générer une réponse » utilise le prompt réponse actif."
            />
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
                refLabel = `vs version précédente · ${fmtDateTime(older.created_at)}`;
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
                  borderColor: a.is_canon ? LGM_COLORS.green : undefined,
                }}
                title={
                  // 2 niveaux d'info : top = identité (prompt + statuts +
                  // verdict diff), bottom = méta secondaires (modèle, date,
                  // tokens/coût). Évite le mélange tag/texte/poids du header
                  // à plat qui partait en sucette.
                  <Space direction="vertical" size={2} style={{ width: "100%" }}>
                    <Space wrap size={6}>
                      <strong>prompt {a.prompt_name ?? "—"}</strong>
                      {a.is_canon && <Tag color="green">CANON</Tag>}
                      {a.status !== "ok" && (
                        <Tag color="default">{a.status}</Tag>
                      )}
                      {a.edited_at && (
                        <Tag color="purple" style={{ fontSize: 11 }}>
                          ÉDITÉ
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
                    <Space
                      wrap
                      size={8}
                      split={
                        <span style={{ color: LGM_COLORS.border }}>·</span>
                      }
                      style={{
                        fontSize: 12,
                        color: LGM_COLORS.textSecondary,
                        fontWeight: 400,
                      }}
                    >
                      <span>{a.model_label ?? "—"}</span>
                      <span>{fmtDateTime(a.created_at)}</span>
                      {a.edited_at && (
                        <span>édité {fmtDateTime(a.edited_at)}</span>
                      )}
                      {/* Tokens + coût USD de cette inférence. NULL ⇒ analyse
                          legacy ou status='skipped' (pas d'appel) ⇒ on
                          n'affiche rien plutôt qu'un "—" trompeur. */}
                      {(a.input_tokens !== null ||
                        a.output_tokens !== null) && (
                        <span>
                          {(a.input_tokens ?? 0).toLocaleString("fr-FR")} in /{" "}
                          {(a.output_tokens ?? 0).toLocaleString("fr-FR")} out
                          {a.cost_usd !== null && (
                            <>
                              {" — "}
                              <strong style={{ color: LGM_COLORS.green }}>
                                {fmtCost(a.cost_usd)}
                              </strong>
                            </>
                          )}
                        </span>
                      )}
                    </Space>
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
            <EmptyState
              title="Aucune analyse"
              hint="Lance un batch (ou une analyse depuis le tool MCP) pour comparer la classification au canon."
            />
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
          style={{ fontFamily: MONO_STACK, fontSize: 12.5 }}
        />
      </Modal>
    </Space>
  );
}
