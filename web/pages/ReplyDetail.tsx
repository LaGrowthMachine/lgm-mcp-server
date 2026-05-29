import { useEffect, useState, useCallback } from "react";
import {
  Typography,
  Space,
  Tag,
  Button,
  Card,
  Spin,
  Alert,
  Popconfirm,
  InputNumber,
  Tooltip,
  App,
} from "antd";
import {
  ArrowLeftOutlined,
  StarFilled,
  StarOutlined,
  SendOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";
import { Link, useParams, useNavigate } from "react-router-dom";
import {
  http,
  ReplyDetailApi,
  ReplyValidation,
  GenerateReplyResp,
} from "../api";
import { LGM_COLORS, MONO_STACK } from "../theme";
import { PageHeader } from "../components/PageHeader";
import { ModelSelect } from "../ModelSelect";
import { fmtCost, fmtDateTime, fmtPct, fmtTokens } from "../format";

const channelTag = (c: "LINKEDIN" | "EMAIL" | null) =>
  c === "LINKEDIN" ? (
    <Tag color="blue">LinkedIn</Tag>
  ) : c === "EMAIL" ? (
    <Tag color="purple">Email</Tag>
  ) : (
    <Tag>—</Tag>
  );

const scoreColor = (s: number | null): string => {
  if (s === null) return "default";
  if (s >= 0.66) return "success";
  if (s >= 0.34) return "warning";
  return "error";
};

const verdictTag = (v: "pass" | "fail" | "skip") =>
  v === "pass" ? (
    <Tag color="success">pass</Tag>
  ) : v === "fail" ? (
    <Tag color="error">fail</Tag>
  ) : (
    <Tag>skip</Tag>
  );

const missingReasonLabel: Record<string, string> = {
  no_identity_or_channel: "La conversation n'a pas d'identité ou de canal résolus.",
  no_profile: "Aucun profil stylométrique n'existe pour cette identité × canal.",
  profile_payload_invalid: "Le profil identité est corrompu ou incomplet.",
};

export function ReplyDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [data, setData] = useState<ReplyDetailApi | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [genModel, setGenModel] = useState<string>("");
  const [genTokenCap, setGenTokenCap] = useState<number>(10_000);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    setNotFound(false);
    try {
      const { data } = await http.get<ReplyDetailApi>(`/replies/${id}`);
      setData(data);
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: { error?: string } } };
      if (err.response?.status === 404) setNotFound(true);
      else setErrorMessage(err.response?.data?.error ?? "Échec chargement");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleFav = async () => {
    if (!data) return;
    await http.post(`/replies/${data.id}/favorite`, { value: !data.is_favorite });
    load();
  };

  const del = async () => {
    if (!data) return;
    await http.delete(`/replies/${data.id}`);
    message.success("Réponse supprimée");
    navigate(`/conversations/${data.conversation_id}`);
  };

  // Régénère la reply pour la même conv. Upsert → écrase celle-ci. Reload
  // pour récupérer le nouveau texte + validation contre profil courant.
  const regen = async () => {
    if (!data) return;
    if (!Number.isFinite(genTokenCap) || genTokenCap < 100) {
      message.error("Token cap invalide");
      return;
    }
    setGenerating(true);
    try {
      const body: Record<string, unknown> = { tokenCap: genTokenCap };
      if (genModel) body.modelId = genModel;
      const { data: r } = await http.post<GenerateReplyResp>(
        `/reply/${data.conversation_id}`,
        body,
      );
      if (r.status === "skipped") message.info(r.reason ?? "ignoré");
      else message.success(`Régénéré (prompt ${r.promptName})`);
      load();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      message.error(err.response?.data?.error ?? "Échec génération");
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
        <Spin size="large" />
      </div>
    );
  }
  if (notFound) {
    return (
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <PageHeader title="Réponse introuvable" />
        <Alert
          type="warning"
          message="Cette réponse n'existe pas ou a été supprimée."
          action={
            <Link to="/replies">
              <Button>Retour à la liste</Button>
            </Link>
          }
        />
      </Space>
    );
  }
  if (errorMessage || !data) {
    return (
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <PageHeader title="Erreur" />
        <Alert
          type="error"
          message={errorMessage ?? "Erreur inconnue"}
          action={<Button onClick={load}>Réessayer</Button>}
        />
      </Space>
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <PageHeader
        breadcrumb={
          <Button
            type="link"
            size="small"
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate(`/conversations/${data.conversation_id}`)}
            style={{ padding: 0 }}
          >
            Conversation
          </Button>
        }
        title={
          <Space size={8} align="center">
            <span>Réponse</span>
            <Typography.Text
              type="secondary"
              style={{ fontFamily: MONO_STACK, fontSize: 13 }}
            >
              #{data.id}
            </Typography.Text>
            <Tag>prompt {data.prompt_name}</Tag>
            {channelTag(data.channel)}
            {data.is_favorite && <Tag color="success">RETENUE</Tag>}
          </Space>
        }
        description={
          <Space
            size={8}
            split={<span style={{ color: LGM_COLORS.border }}>·</span>}
            style={{ fontSize: 12, color: LGM_COLORS.textSecondary }}
            wrap
          >
            <span>générée {fmtDateTime(data.created_at)}</span>
            {data.model_label && <span>{data.model_label}</span>}
            {(data.input_tokens !== null || data.output_tokens !== null) && (
              <span>
                {fmtTokens(data.input_tokens)} in /{" "}
                {fmtTokens(data.output_tokens)} out
                {data.cost_usd !== null && (
                  <>
                    {" — "}
                    <strong style={{ color: LGM_COLORS.green }}>
                      {fmtCost(data.cost_usd)}
                    </strong>
                  </>
                )}
              </span>
            )}
            {data.identity_id && (
              <Link
                to={`/profiles/${data.identity_id}/${data.channel ?? "LINKEDIN"}`}
              >
                <code style={{ fontSize: 11 }}>{data.identity_id}</code>
              </Link>
            )}
            <Link to={`/conversations/${data.conversation_id}`}>
              <code style={{ fontSize: 11 }}>{data.conversation_id}</code>
            </Link>
          </Space>
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
              {data.is_favorite ? "Retirer (retenue)" : "Marquer retenue"}
            </Button>
            <Popconfirm title="Supprimer cette réponse ?" onConfirm={del}>
              <Button danger>Supprimer</Button>
            </Popconfirm>
          </>
        }
      />

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Card title="Texte de la réponse" size="small">
            <div
              style={{
                whiteSpace: "pre-wrap",
                fontSize: 14,
                lineHeight: 1.55,
              }}
            >
              {data.reply_text}
            </div>
          </Card>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Card title="Validation stylométrique" size="small">
            {data.validation ? (
              <ValidationBlock validation={data.validation} />
            ) : (
              <Alert
                type="info"
                showIcon
                message="Score non calculable"
                description={
                  missingReasonLabel[data.profile_missing_reason ?? ""] ??
                  "Profil identité indisponible."
                }
              />
            )}
          </Card>
        </div>
      </div>

      <Card
        title={
          <Space>
            <SendOutlined />
            <span>Régénérer la réponse</span>
          </Space>
        }
        size="small"
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Paragraph
            type="secondary"
            style={{ marginBottom: 0, fontSize: 13 }}
          >
            Écrase la réponse actuelle (upsert sur conv × prompt). Le score est
            recalculé contre le profil identité courant après régénération.
          </Typography.Paragraph>
          <Space wrap>
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
                style={{ width: 110 }}
              />
            </Space>
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={generating}
              onClick={regen}
            >
              Régénérer
            </Button>
          </Space>
        </Space>
      </Card>
    </Space>
  );
}

// Métadonnées d'affichage par dimension stylométrique. `format` retourne la
// valeur arrondie + unité (ex. "23.9 mots") — null sert pour un fallback "—".
// `help` est le texte du tooltip ⓘ : explication courte, sans jargon.
type Dim = "length" | "punctuation" | "vocab";
const DIM_META: Record<
  Dim,
  { label: string; help: string; format: (v: number | null) => string }
> = {
  length: {
    label: "Longueur des messages",
    help: "Nombre moyen de mots par message. La réponse doit rester dans la fourchette type de l'identité.",
    format: (v) => (v === null ? "—" : `${v.toFixed(1)} mots/msg`),
  },
  punctuation: {
    label: "Densité de ponctuation",
    help: "Marques de ponctuation pour 100 mots (. , ! ? … : ; –). L'écart compare la *composition* des 8 marques, pas seulement le total : deux textes peuvent avoir la même densité globale mais une répartition très différente — l'écart sera élevé.",
    format: (v) => (v === null ? "—" : `${v.toFixed(2)} / 100 mots`),
  },
  vocab: {
    label: "Diversité lexicale (TTR)",
    help: "Ratio mots uniques / mots totaux. Non comparé sous 200 mots (TTR baisse mécaniquement avec la longueur — comparer une réponse courte au profil global donnerait un faux écart).",
    format: (v) => (v === null ? "—" : v.toFixed(3)),
  },
};

const SCORE_HELP =
  "Part des dimensions qui passent le seuil de tolérance (25 % d'écart relatif). Les dimensions « non comparé » sont exclues du calcul.";

function DimensionRow({
  dim,
  data,
}: {
  dim: Dim;
  data: ReplyValidation["breakdown"][Dim];
}) {
  const meta = DIM_META[dim];
  const isSkip = data.verdict === "skip";
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 6,
        border: "1px solid #f0f0f0",
        background: "#fafafa",
      }}
    >
      <Space
        style={{ width: "100%", justifyContent: "space-between" }}
        align="start"
      >
        <Space size={6}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            {meta.label}
          </Typography.Text>
          <Tooltip title={meta.help}>
            <InfoCircleOutlined style={{ color: "#999", fontSize: 12 }} />
          </Tooltip>
        </Space>
        {isSkip ? <Tag>non comparé</Tag> : verdictTag(data.verdict)}
      </Space>
      <div style={{ marginTop: 6, fontSize: 12.5, color: "#555" }}>
        {isSkip ? (
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            Réponse trop courte pour être comparée sur cette dimension.
          </Typography.Text>
        ) : (
          <Space split={<span style={{ color: "#ccc" }}>·</span>} wrap>
            <span>
              Réponse&nbsp;: <strong>{meta.format(data.reply_value)}</strong>
            </span>
            <span>
              Profil&nbsp;: <strong>{meta.format(data.profile_value)}</strong>
            </span>
            {data.delta_relative !== null && (
              <span>
                Écart&nbsp;:{" "}
                <strong>
                  {data.delta_relative >= 0 ? "+" : ""}
                  {(data.delta_relative * 100).toFixed(1)} %
                </strong>
              </span>
            )}
          </Space>
        )}
      </div>
    </div>
  );
}

function ValidationBlock({ validation }: { validation: ReplyValidation }) {
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space size={8}>
        <Typography.Text strong>Score global</Typography.Text>
        <Tag color={scoreColor(validation.score)} style={{ fontSize: 13 }}>
          {fmtPct(validation.score)}
        </Tag>
        <Tooltip title={SCORE_HELP}>
          <InfoCircleOutlined style={{ color: "#999", fontSize: 12 }} />
        </Tooltip>
      </Space>
      <DimensionRow dim="length" data={validation.breakdown.length} />
      <DimensionRow dim="punctuation" data={validation.breakdown.punctuation} />
      <DimensionRow dim="vocab" data={validation.breakdown.vocab} />
    </Space>
  );
}
