import { useEffect, useState, useCallback } from "react";
import {
  Typography,
  Table,
  Tag,
  Button,
  Space,
  Modal,
  Input,
  Popconfirm,
  App,
} from "antd";
import { http, PromptListItem } from "../api";

export function Prompts() {
  const { message } = App.useApp();
  const [list, setList] = useState<PromptListItem[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [nextName, setNextName] = useState("1");
  const [loading, setLoading] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editMode, setEditMode] = useState<"create" | "edit">("create");
  const [formName, setFormName] = useState("");
  const [formBody, setFormBody] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await http.get("/prompts");
      setList(data.prompts);
      setActive(data.active);
      setNextName(data.nextName);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditMode("create");
    setFormName(nextName);
    setFormBody(
      "Colle ici le corps du prompt système.\n\n" +
        "Utilise le placeholder {{DELIMITER}} là où le délimiteur anti " +
        "prompt-injection doit apparaître (il est substitué à chaque inférence).",
    );
    setEditOpen(true);
  };

  const openEdit = async (name: string) => {
    const { data } = await http.get(`/prompts/${name}`);
    setEditMode("edit");
    setFormName(name);
    setFormBody(data.body);
    setEditOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      if (editMode === "create") {
        await http.post("/prompts", { name: formName.trim(), body: formBody });
        message.success(`Prompt "${formName}" créé`);
      } else {
        await http.put(`/prompts/${formName}`, { body: formBody });
        message.success(`Prompt "${formName}" mis à jour`);
      }
      setEditOpen(false);
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? "Échec sauvegarde");
    } finally {
      setSaving(false);
    }
  };

  const activate = async (name: string) => {
    await http.post(`/prompts/${name}/activate`);
    message.success(`"${name}" est le prompt actif`);
    load();
  };

  const del = async (name: string) => {
    try {
      await http.delete(`/prompts/${name}`);
      message.success("Prompt supprimé");
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? "Échec suppression");
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Space
        style={{ width: "100%", justifyContent: "space-between" }}
        align="start"
      >
        <div>
          <Typography.Title level={3} style={{ marginTop: 0 }}>
            Prompts
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ maxWidth: 640 }}>
            Le prompt actif est utilisé par la page Analyse. La clé est le{" "}
            <strong>nom = version</strong> (prérempli au max+1). Le schéma de
            sortie reste figé en code (contrat déterministe) — ici on n'itère
            que le texte d'instructions.
          </Typography.Paragraph>
        </div>
        <Button type="primary" onClick={openCreate}>
          + Nouveau prompt ({nextName})
        </Button>
      </Space>

      <Table
        size="small"
        rowKey="name"
        loading={loading}
        dataSource={list}
        pagination={false}
        columns={[
          {
            title: "nom / version",
            dataIndex: "name",
            render: (n: string) => (
              <Space>
                <strong>{n}</strong>
                {n === active && <Tag color="green">ACTIF</Tag>}
              </Space>
            ),
          },
          {
            title: "créé",
            dataIndex: "created_at",
            width: 180,
            render: (v: string) => new Date(v).toLocaleString("fr-FR"),
          },
          {
            title: "modifié",
            dataIndex: "updated_at",
            width: 180,
            render: (v: string) => new Date(v).toLocaleString("fr-FR"),
          },
          {
            title: "actions",
            width: 280,
            render: (_: unknown, r: PromptListItem) => (
              <Space>
                <Button
                  size="small"
                  type="primary"
                  disabled={r.name === active}
                  onClick={() => activate(r.name)}
                >
                  Activer
                </Button>
                <Button size="small" onClick={() => openEdit(r.name)}>
                  Éditer
                </Button>
                <Popconfirm
                  title={
                    r.name === active
                      ? "C'est le prompt ACTIF — supprimer quand même ?"
                      : "Supprimer ce prompt ?"
                  }
                  onConfirm={() => del(r.name)}
                >
                  <Button size="small" danger>
                    Suppr.
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={
          editMode === "create"
            ? "Nouveau prompt"
            : `Éditer le prompt "${formName}"`
        }
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={save}
        confirmLoading={saving}
        okText="Enregistrer"
        width={900}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <div>
            <Typography.Text strong>Nom (version) — clé</Typography.Text>
            <Input
              value={formName}
              disabled={editMode === "edit"}
              onChange={(e) => setFormName(e.target.value)}
              style={{ marginTop: 4 }}
            />
          </div>
          <div>
            <Typography.Text strong>Corps du prompt système</Typography.Text>
            <Input.TextArea
              value={formBody}
              onChange={(e) => setFormBody(e.target.value)}
              autoSize={{ minRows: 16, maxRows: 30 }}
              style={{
                marginTop: 4,
                fontFamily: "ui-monospace, monospace",
                fontSize: 12.5,
              }}
            />
          </div>
        </Space>
      </Modal>
    </Space>
  );
}
