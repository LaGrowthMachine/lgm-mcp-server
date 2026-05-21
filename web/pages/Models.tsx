import { useEffect, useState } from "react";
import {
  Button,
  Card,
  Form,
  Input,
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
} from "@ant-design/icons";
import { http, Model, DefaultModelResp } from "../api";

// Registre CRUD des modèles d'inférence Bedrock. Le préfixe du model_id
// (eu.anthropic.*, meta.*, mistral.*…) identifie le provider — pas besoin
// d'un champ séparé. Le défaut est géré sur la page Settings.

interface ModelFormValues {
  label: string;
  modelId: string;
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
    form.setFieldsValue({ label: m.label, modelId: m.aws_model_id });
    setModalOpen(true);
  };

  const onSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editing) {
        // Seul `label` est éditable. model_id immutable — créer une nouvelle
        // row pour changer le modèle technique.
        await http.put(`/models/${editing.id}`, { label: values.label });
        message.success("Modèle mis à jour");
      } else {
        await http.post("/models", {
          label: values.label,
          modelId: values.modelId,
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
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        Modèles
      </Typography.Title>

      <Card
        title="Registre des modèles d'inférence"
        extra={
          <Space>
            <Button size="small" onClick={() => setIncludeArchived((v) => !v)}>
              {includeArchived ? "Masquer archivés" : "Voir archivés"}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={openCreate}
            >
              Ajouter
            </Button>
          </Space>
        }
      >
        <Table<Model>
          dataSource={models}
          rowKey="id"
          loading={loading}
          pagination={false}
          size="small"
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
      </Card>

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
        </Form>
      </Modal>
    </Space>
  );
}
