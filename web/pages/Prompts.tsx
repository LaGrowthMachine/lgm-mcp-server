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
  Segmented,
  Tooltip,
} from "antd";
import { http, PromptListItem, PromptKind } from "../api";

export function Prompts() {
  const { message } = App.useApp();
  const [kind, setKind] = useState<PromptKind>("analysis");
  const [list, setList] = useState<PromptListItem[]>([]);
  const [nextName, setNextName] = useState("v1");
  const [loading, setLoading] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editMode, setEditMode] = useState<"create" | "edit">("create");
  const [readOnly, setReadOnly] = useState(false);
  const [formName, setFormName] = useState("");
  const [formBody, setFormBody] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await http.get("/prompts", { params: { kind } });
      setList(data.prompts);
      setNextName(data.nextName);
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditMode("create");
    setReadOnly(false);
    setFormName(nextName);
    setFormBody(
      "Colle ici le corps du prompt système.\n\n" +
        "Utilise le placeholder {{DELIMITER}} là où le délimiteur anti " +
        "prompt-injection doit apparaître (il est substitué à chaque inférence).",
    );
    setEditOpen(true);
  };

  const openEdit = async (r: PromptListItem) => {
    const { data } = await http.get(`/prompts/${r.name}`, {
      params: { kind },
    });
    setEditMode("edit");
    setReadOnly(r.status === "validated");
    setFormName(r.name);
    setFormBody(data.body);
    setEditOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      if (editMode === "create") {
        await http.post("/prompts", {
          name: formName.trim(),
          body: formBody,
          kind,
        });
        message.success(`Brouillon "${formName}" créé`);
      } else {
        await http.put(`/prompts/${formName}`, { body: formBody, kind });
        message.success(`Brouillon "${formName}" mis à jour`);
      }
      setEditOpen(false);
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? "Échec sauvegarde");
    } finally {
      setSaving(false);
    }
  };

  const validate = async (name: string) => {
    try {
      await http.post(`/prompts/${name}/validate`, { kind });
      message.success(`"${name}" validé (figé). Mets-le « live » pour l'activer.`);
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? "Échec validation");
    }
  };

  const setLive = async (name: string) => {
    try {
      await http.post(`/prompts/${name}/live`, { kind });
      message.success(`"${name}" est le prompt live`);
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? "Échec mise en live");
    }
  };

  const clone = async (name: string) => {
    try {
      const { data } = await http.post(`/prompts/${name}/clone`, { kind });
      message.success(`Cloné en brouillon "${data.name}"`);
      await load();
      openEdit({
        name: data.name,
        status: "draft",
      } as PromptListItem);
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? "Échec clonage");
    }
  };

  const del = async (name: string) => {
    try {
      await http.delete(`/prompts/${name}`, { params: { kind } });
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
          <Segmented
            value={kind}
            onChange={(v) => setKind(v as PromptKind)}
            options={[
              { label: "Analyse", value: "analysis" },
              { label: "Réponse", value: "reply" },
            ]}
            style={{ marginBottom: 8 }}
          />
        </div>
        <Button type="primary" onClick={openCreate}>
          + Nouveau brouillon ({nextName})
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
            render: (n: string, r: PromptListItem) => (
              <Space>
                <strong>{n}</strong>
                {r.status === "validated" ? (
                  <Tag color="green">VALIDÉ</Tag>
                ) : (
                  <Tag color="orange">BROUILLON</Tag>
                )}
                {r.is_active && <Tag color="blue">LIVE</Tag>}
                {r.used && <Tag>utilisé</Tag>}
              </Space>
            ),
          },
          {
            title: "validé le",
            dataIndex: "validated_at",
            width: 170,
            render: (v: string | null) =>
              v ? new Date(v).toLocaleString("fr-FR") : "—",
          },
          {
            title: "modifié",
            dataIndex: "updated_at",
            width: 170,
            render: (v: string) => new Date(v).toLocaleString("fr-FR"),
          },
          {
            title: "actions",
            width: 320,
            render: (_: unknown, r: PromptListItem) => {
              const lockReason = r.is_active
                ? "Prompt live — non supprimable"
                : r.used
                  ? "Déjà utilisé (analyses/réponses) — non supprimable"
                  : null;
              return (
                <Space wrap>
                  {r.status === "draft" ? (
                    <>
                      <Button size="small" onClick={() => openEdit(r)}>
                        Éditer
                      </Button>
                      <Popconfirm
                        title="Valider ce prompt ? Contenu FIGÉ (sens unique). Il ne devient pas live automatiquement."
                        onConfirm={() => validate(r.name)}
                      >
                        <Button size="small" type="primary">
                          Valider
                        </Button>
                      </Popconfirm>
                    </>
                  ) : (
                    <>
                      <Button size="small" onClick={() => openEdit(r)}>
                        Voir
                      </Button>
                      {!r.is_active && (
                        <Popconfirm
                          title="Mettre ce prompt en live ? Il remplacera le live actuel (défaut éval + tool MCP)."
                          onConfirm={() => setLive(r.name)}
                        >
                          <Button size="small" type="primary">
                            Mettre en live
                          </Button>
                        </Popconfirm>
                      )}
                    </>
                  )}
                  <Button size="small" onClick={() => clone(r.name)}>
                    Cloner
                  </Button>
                  {lockReason ? (
                    <Tooltip title={lockReason}>
                      <Button size="small" danger disabled>
                        Suppr.
                      </Button>
                    </Tooltip>
                  ) : (
                    <Popconfirm
                      title="Supprimer ce prompt ?"
                      onConfirm={() => del(r.name)}
                    >
                      <Button size="small" danger>
                        Suppr.
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              );
            },
          },
        ]}
      />

      <Modal
        title={
          editMode === "create"
            ? "Nouveau brouillon"
            : readOnly
              ? `Prompt "${formName}" (validé — lecture seule)`
              : `Éditer le brouillon "${formName}"`
        }
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={save}
        confirmLoading={saving}
        okText="Enregistrer"
        okButtonProps={{ style: readOnly ? { display: "none" } : undefined }}
        cancelText={readOnly ? "Fermer" : "Annuler"}
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
              readOnly={readOnly}
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
