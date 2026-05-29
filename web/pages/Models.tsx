import { useEffect, useState } from "react";
import {
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  StarFilled,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { http, Model, DefaultModelResp } from "../api";
import { LGM_COLORS } from "../theme";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { fmtPriceMtok } from "../format";

// Registre CRUD des modèles d'inférence Bedrock. Le préfixe du model_id
// (eu.anthropic.*, meta.*, mistral.*…) identifie le provider — pas besoin
// d'un champ séparé. Le défaut est géré sur la page Réglages.

interface ModelFormValues {
  label: string;
  modelId: string;
  // null = champ vidé volontairement (efface le prix en DB).
  priceInputPerMtok: number | null | undefined;
  priceOutputPerMtok: number | null | undefined;
}

export function Models() {
  const [models, setModels] = useState<Model[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [defaultModel, setDefaultModel] = useState<DefaultModelResp | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Model | null>(null);
  const [form] = Form.useForm<ModelFormValues>();

  const reload = async () => {
    setLoading(true);
    try {
      const [a, b] = await Promise.all([
        http.get<Model[]>("/models", {
          params: { archived: includeArchived ? "1" : "0" },
        }),
        http.get<DefaultModelResp>("/settings/default-model"),
      ]);
      setModels(a.data);
      setDefaultModel(b.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (m: Model) => {
    setEditing(m);
    form.setFieldsValue({
      label: m.label,
      modelId: m.aws_model_id,
      priceInputPerMtok: m.price_input_per_mtok ?? undefined,
      priceOutputPerMtok: m.price_output_per_mtok ?? undefined,
    });
    setModalOpen(true);
  };

  const onSubmit = async () => {
    try {
      const values = await form.validateFields();
      // InputNumber renvoie `null` quand l'utilisateur efface la valeur — on
      // veut alors null en DB (pas undefined) pour effacer le prix.
      const priceIn = values.priceInputPerMtok ?? null;
      const priceOut = values.priceOutputPerMtok ?? null;
      if (editing) {
        // `label` + prix sont éditables. model_id immutable — créer une
        // nouvelle row pour changer le modèle technique.
        await http.put(`/models/${editing.id}`, {
          label: values.label,
          priceInputPerMtok: priceIn,
          priceOutputPerMtok: priceOut,
        });
        message.success("Modèle mis à jour");
      } else {
        await http.post("/models", {
          label: values.label,
          modelId: values.modelId,
          priceInputPerMtok: priceIn,
          priceOutputPerMtok: priceOut,
        });
        message.success("Modèle créé");
      }
      setModalOpen(false);
      reload();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      const msg = err?.response?.data?.error;
      if (msg) message.error(msg);
    }
  };

  const onArchive = async (m: Model) => {
    try {
      await http.delete(`/models/${m.id}`);
      message.success("Modèle archivé");
      reload();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      const msg = err?.response?.data?.error;
      message.error(msg ?? "Erreur");
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <PageHeader
        title="Modèles"
        description="Registre des modèles d'inférence Bedrock disponibles, avec prix au million de tokens. Le défaut se définit dans Réglages."
        actions={
          <>
            <Button onClick={() => setIncludeArchived((v) => !v)}>
              {includeArchived ? "Masquer archivés" : "Voir archivés"}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={openCreate}
            >
              Ajouter
            </Button>
          </>
        }
      />

      <Table<Model>
        dataSource={models}
        rowKey="id"
        loading={loading}
        pagination={false}
        size="middle"
        locale={{
          emptyText: (
            <EmptyState
              icon={<ThunderboltOutlined />}
              title="Aucun modèle"
              hint="Ajoute un premier modèle pour pouvoir lancer des analyses."
              action={
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={openCreate}
                >
                  Ajouter
                </Button>
              }
            />
          ),
        }}
        columns={[
            {
              title: "Label",
              dataIndex: "label",
              render: (label: string, row: Model) => (
                <Space>
                  <span>{label}</span>
                  {row.id === defaultModel?.modelId && (
                    <Tag color="gold" icon={<StarFilled />}>
                      défaut
                    </Tag>
                  )}
                  {row.is_archived && <Tag>archivé</Tag>}
                </Space>
              ),
            },
            { title: "Model ID (AWS)", dataIndex: "aws_model_id" },
            {
              title: "Prix in (USD / Mtok)",
              dataIndex: "price_input_per_mtok",
              width: 150,
              align: "right",
              render: (v: number | null) => (
                <span
                  style={{
                    color: v === null ? LGM_COLORS.textTertiary : undefined,
                  }}
                >
                  {fmtPriceMtok(v)}
                </span>
              ),
            },
            {
              title: "Prix out (USD / Mtok)",
              dataIndex: "price_output_per_mtok",
              width: 150,
              align: "right",
              render: (v: number | null) => (
                <span
                  style={{
                    color: v === null ? LGM_COLORS.textTertiary : undefined,
                  }}
                >
                  {fmtPriceMtok(v)}
                </span>
              ),
            },
            {
              title: "Actions",
              key: "actions",
              width: 160,
              render: (_: unknown, row: Model) =>
                row.is_archived ? (
                  <Typography.Text type="secondary">—</Typography.Text>
                ) : (
                  <Space>
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => openEdit(row)}
                    >
                      Éditer
                    </Button>
                    <Popconfirm
                      title="Archiver ce modèle ?"
                      description={
                        row.id === defaultModel?.modelId
                          ? "Ce modèle est le défaut — change d'abord le défaut."
                          : "Action soft : les analyses existantes gardent leur référence."
                      }
                      disabled={row.id === defaultModel?.modelId}
                      onConfirm={() => onArchive(row)}
                      okText="Archiver"
                      cancelText="Annuler"
                    >
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        disabled={row.id === defaultModel?.modelId}
                      >
                        Archiver
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
            },
          ]}
        />

      <Modal
        title={editing ? "Éditer le modèle" : "Ajouter un modèle"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={onSubmit}
        okText={editing ? "Enregistrer" : "Créer"}
        cancelText="Annuler"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="label"
            label="Label"
            rules={[{ required: true, message: "Label requis" }]}
          >
            <Input placeholder="Claude Sonnet 4.6 (Bedrock EU)" />
          </Form.Item>
          <Form.Item
            name="modelId"
            label="Model ID (AWS)"
            rules={[{ required: true, message: "Model ID requis" }]}
            extra="L'identifiant exact passé au SDK Bedrock, ex : eu.anthropic.claude-sonnet-4-6"
          >
            <Input
              disabled={!!editing}
              placeholder="eu.anthropic.claude-sonnet-4-6"
            />
          </Form.Item>
          {/* Prix optionnels : laisser vide ⇒ coût non calculé pour ce modèle
              (les tokens restent persistés et affichés). Unité = USD par
              million de tokens, comme les grilles tarifaires Bedrock. */}
          <Space size="middle" style={{ display: "flex" }}>
            <Form.Item
              name="priceInputPerMtok"
              label="Prix input (USD / Mtok)"
              style={{ flex: 1 }}
            >
              <InputNumber
                min={0}
                step={0.01}
                placeholder="ex : 3.00"
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              name="priceOutputPerMtok"
              label="Prix output (USD / Mtok)"
              style={{ flex: 1 }}
            >
              <InputNumber
                min={0}
                step={0.01}
                placeholder="ex : 15.00"
                style={{ width: "100%" }}
              />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </Space>
  );
}
