import { useEffect, useState, useCallback } from "react";
import {
  Typography,
  Space,
  Tag,
  Button,
  Card,
  Table,
  Spin,
  Descriptions,
  Alert,
} from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { Link, useParams, useNavigate } from "react-router-dom";
import {
  http,
  IdentityChannel,
  IdentityProfileDetail,
} from "../api";
import { LGM_COLORS, MONO_STACK } from "../theme";
import { PageHeader } from "../components/PageHeader";
import { KpiStat } from "../components/KpiStat";
import { EmptyState } from "../components/EmptyState";
import { fmtDateTime } from "../format";

const channelTag = (c: IdentityChannel) =>
  c === "LINKEDIN" ? (
    <Tag color="blue">LinkedIn</Tag>
  ) : (
    <Tag color="purple">Email</Tag>
  );

const fmtNum = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : n.toFixed(digits);

const VALID_CHANNELS: IdentityChannel[] = ["LINKEDIN", "EMAIL"];

export function ProfileDetail() {
  const { identityId = "", channel: channelParam = "" } = useParams<{
    identityId: string;
    channel: string;
  }>();
  const navigate = useNavigate();
  // P16: on accepte n'importe quelle casse pour le paramètre d'URL mais on
  // rejette toute valeur hors LINKEDIN/EMAIL — sinon on requêtait l'API
  // avec un canal bidon et on tombait silencieusement en notFound.
  const channelUpper = (channelParam || "").toUpperCase();
  const channelValid = (VALID_CHANNELS as string[]).includes(channelUpper);
  const channel = (channelValid ? channelUpper : "LINKEDIN") as IdentityChannel;
  const [detail, setDetail] = useState<IdentityProfileDetail | null>(null);
  const [convs, setConvs] = useState<{ conversation_id: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // P8: erreurs hors 404 — on les surface plutôt que d'afficher une page
  // blanche silencieuse, avec un bouton de retry.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!channelValid) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    setNotFound(false);
    try {
      const { data } = await http.get<IdentityProfileDetail>(
        `/identities/profiles/${identityId}/${channel}`,
      );
      setDetail(data);
      try {
        const { data: cv } = await http.get<{
          rows: { conversation_id: string }[];
        }>(`/identities/profiles/${identityId}/${channel}/conversations`);
        setConvs(cv.rows);
      } catch {
        setConvs([]);
      }
    } catch (e) {
      const err = e as {
        response?: { status?: number; data?: { error?: string } };
        message?: string;
      };
      if (err.response?.status === 404) {
        setNotFound(true);
      } else {
        setErrorMessage(
          err.response?.data?.error ??
            err.message ??
            "Échec du chargement du profil",
        );
      }
    } finally {
      setLoading(false);
    }
  }, [identityId, channel, channelValid]);

  useEffect(() => {
    load();
  }, [load]);

  if (!channelValid)
    return (
      <Space direction="vertical">
        <PageHeader
          title="Canal invalide"
          breadcrumb={<Link to="/profiles">← Profils</Link>}
          description={
            <Typography.Text type="secondary">
              Le canal "{channelParam}" n'est pas reconnu (attendu :
              LINKEDIN ou EMAIL).
            </Typography.Text>
          }
          actions={
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => navigate("/profiles")}
            >
              Retour à la liste
            </Button>
          }
        />
      </Space>
    );
  if (loading) return <Spin />;
  if (errorMessage)
    return (
      <Space direction="vertical" style={{ width: "100%" }}>
        <PageHeader
          title="Erreur"
          breadcrumb={<Link to="/profiles">← Profils</Link>}
          actions={
            <Link to="/profiles">
              <Button icon={<ArrowLeftOutlined />}>Liste</Button>
            </Link>
          }
        />
        <Alert
          type="error"
          showIcon
          message="Échec du chargement"
          description={errorMessage}
          action={
            <Button size="small" onClick={() => load()}>
              Réessayer
            </Button>
          }
        />
      </Space>
    );
  if (notFound)
    return (
      <Space direction="vertical">
        <PageHeader
          title="Profil introuvable"
          breadcrumb={<Link to="/profiles">← Profils</Link>}
          description={
            <Typography.Text type="secondary">
              Aucun profil pour cette identité sur ce canal.
            </Typography.Text>
          }
          actions={
            <Link to="/profiles">
              <Button icon={<ArrowLeftOutlined />}>Retour à la liste</Button>
            </Link>
          }
        />
      </Space>
    );
  if (!detail) return null;

  const cur = detail.current;
  const payload = cur?.payload ?? null;
  const desc = payload?.description ?? null;
  const metrics = payload?.metrics ?? null;
  const corpus = payload?.corpus ?? null;

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <PageHeader
        breadcrumb={<Link to="/profiles">← Profils</Link>}
        title={
          <span style={{ fontFamily: MONO_STACK, fontSize: 18 }}>
            {detail.identity_id}
          </span>
        }
        description={
          <Space size="small" wrap style={{ marginTop: 4 }}>
            {channelTag(channel)}
            <Typography.Text type="secondary">
              mis à jour {fmtDateTime(detail.updated_at)}
            </Typography.Text>
          </Space>
        }
        actions={
          <Link to="/profiles">
            <Button icon={<ArrowLeftOutlined />}>Liste</Button>
          </Link>
        }
      />

      {cur && (
        <Space size="large" wrap>
          <KpiStat
            label="Messages SENDER"
            value={corpus?.msg_count_sender ?? "—"}
          />
          <KpiStat
            label="Conversations visitées"
            value={corpus?.conv_count ?? "—"}
          />
          <KpiStat
            label="Token cap"
            value={corpus?.token_cap ?? "—"}
          />
          <KpiStat
            label="Échantillonné"
            value={corpus?.sampled_at ? fmtDateTime(corpus.sampled_at) : "—"}
          />
          <KpiStat
            label="Statut"
            value={cur.status}
            tone={cur.status === "ok" ? "success" : "danger"}
          />
        </Space>
      )}

      {cur && cur.status === "error" && (
        <Card title="Erreur" size="small">
          <Typography.Text type="danger">
            {cur.error_message ?? "Erreur inconnue."}
          </Typography.Text>
        </Card>
      )}

      {desc && (
        <Card title="Description du style" size="small">
          <Descriptions
            column={1}
            size="small"
            labelStyle={{ width: 200, color: LGM_COLORS.textSecondary }}
          >
            <Descriptions.Item label="Registre">
              {desc.register || "—"}
            </Descriptions.Item>
            <Descriptions.Item label="Cadence">
              {desc.cadence || "—"}
            </Descriptions.Item>
            <Descriptions.Item label="Style de ponctuation">
              {desc.punctuation_style || "—"}
            </Descriptions.Item>
            <Descriptions.Item label="Ouvertures">
              {desc.openers.length ? (
                <Space wrap size={4}>
                  {desc.openers.map((o, i) => (
                    <Tag key={i}>{o}</Tag>
                  ))}
                </Space>
              ) : (
                "—"
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Clôtures">
              {desc.closers.length ? (
                <Space wrap size={4}>
                  {desc.closers.map((o, i) => (
                    <Tag key={i}>{o}</Tag>
                  ))}
                </Space>
              ) : (
                "—"
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Signature">
              {desc.signature || "—"}
            </Descriptions.Item>
            <Descriptions.Item label="Expressions récurrentes">
              {desc.recurring_expressions.length ? (
                <Space wrap size={4}>
                  {desc.recurring_expressions.map((o, i) => (
                    <Tag key={i}>{o}</Tag>
                  ))}
                </Space>
              ) : (
                "—"
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Synthèse">
              {desc.summary || "—"}
            </Descriptions.Item>
          </Descriptions>
        </Card>
      )}

      {metrics && (
        <Card title="Métriques (arithmétiques)" size="small">
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            <div>
              <Typography.Text strong>Longueur</Typography.Text>
              <Descriptions column={3} size="small" style={{ marginTop: 4 }}>
                <Descriptions.Item label="mots / msg">
                  {fmtNum(metrics.length.msg_words_avg, 1)}
                </Descriptions.Item>
                <Descriptions.Item label="mots / phrase">
                  {fmtNum(metrics.length.sentence_words_avg, 1)}
                </Descriptions.Item>
                <Descriptions.Item label="car. / mot">
                  {fmtNum(metrics.length.word_chars_avg, 2)}
                </Descriptions.Item>
              </Descriptions>
            </div>
            <div>
              <Typography.Text strong>Vocabulaire</Typography.Text>
              <Descriptions column={3} size="small" style={{ marginTop: 4 }}>
                <Descriptions.Item label="TTR">
                  {fmtNum(metrics.vocab.ttr, 3)}
                </Descriptions.Item>
                <Descriptions.Item label="Hapax ratio">
                  {fmtNum(metrics.vocab.hapax_ratio, 3)}
                </Descriptions.Item>
                <Descriptions.Item label="Yule K">
                  {fmtNum(metrics.vocab.yule_k, 1)}
                </Descriptions.Item>
              </Descriptions>
            </div>
            <div>
              <Typography.Text strong>Ponctuation / 100 mots</Typography.Text>
              <Descriptions column={4} size="small" style={{ marginTop: 4 }}>
                {Object.entries(metrics.punctuation_per_100w).map(([k, v]) => (
                  <Descriptions.Item key={k} label={k}>
                    {fmtNum(v, 2)}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            </div>
            <div>
              <Typography.Text strong>
                Top mots (freq. /1k tokens)
              </Typography.Text>
              <Table
                size="small"
                rowKey="word"
                pagination={false}
                dataSource={metrics.mfw_top30}
                style={{ marginTop: 4 }}
                columns={[
                  { title: "mot", dataIndex: "word" },
                  {
                    title: "freq /1k",
                    dataIndex: "freq_per_1k",
                    width: 120,
                    align: "right",
                    render: (v: number) => fmtNum(v, 2),
                  },
                ]}
              />
            </div>
          </Space>
        </Card>
      )}

      <Card title="Conversations de l'identité" size="small">
        {convs.length === 0 ? (
          <EmptyState
            title="Aucune conversation listée"
            hint="Le profil n'a pas (encore) référencé de conversation visitée."
          />
        ) : (
          <Table
            size="small"
            rowKey="conversation_id"
            pagination={{ pageSize: 20, showSizeChanger: true }}
            dataSource={convs}
            columns={[
              {
                title: "conversationId",
                dataIndex: "conversation_id",
                render: (v: string) => (
                  <Link to={`/conversations/${v}`}>
                    <code style={{ fontFamily: MONO_STACK }}>{v}</code>
                  </Link>
                ),
              },
            ]}
          />
        )}
      </Card>

      {detail.history.length > 1 && (
        <Card title="Historique" size="small">
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={detail.history}
            columns={[
              {
                title: "date",
                dataIndex: "created_at",
                width: 170,
                render: fmtDateTime,
              },
              {
                title: "statut",
                dataIndex: "status",
                width: 100,
                render: (s: "ok" | "error") =>
                  s === "ok" ? (
                    <Tag color="success">ok</Tag>
                  ) : (
                    <Tag color="error">erreur</Tag>
                  ),
              },
              {
                title: "messages SENDER",
                width: 160,
                render: (_: unknown, r) =>
                  r.payload?.corpus?.msg_count_sender ?? "—",
              },
              {
                title: "tokens in/out",
                width: 160,
                render: (_: unknown, r) =>
                  r.input_tokens === null && r.output_tokens === null
                    ? "—"
                    : `${r.input_tokens ?? 0} / ${r.output_tokens ?? 0}`,
              },
              {
                title: "courant",
                width: 100,
                render: (_: unknown, r) =>
                  r.id === detail.current_analysis_id ? (
                    <Tag color="green">CURRENT</Tag>
                  ) : (
                    ""
                  ),
              },
            ]}
          />
        </Card>
      )}
    </Space>
  );
}
