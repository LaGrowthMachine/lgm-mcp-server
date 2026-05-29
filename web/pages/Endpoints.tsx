import { useEffect, useState } from "react";
import {
  Button,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import {
  ApiOutlined,
  DeleteOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import {
  EndpointInput,
  EndpointRow,
  createEndpoint,
  deleteEndpoint,
  listEndpoints,
  patchEndpointFlags,
  updateEndpoint,
} from "../api";
import { MONO_STACK } from "../theme";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { fmtDateTime } from "../format";
import { EndpointForm } from "./EndpointForm";

// Admin view of the MCP endpoints registry. Toggle `is_active` / `is_public`
// via PATCH; full CRUD through the shared `EndpointForm` Drawer. The next
// /mcp request sees the change automatically (per-request DB read, no cache).

type FlagField = "is_active" | "is_public";

type DrawerState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; row: EndpointRow };

export function Endpoints() {
  const [rows, setRows] = useState<EndpointRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>({ mode: "closed" });
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const data = await listEndpoints();
      setRows(data);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      message.error(err?.response?.data?.error ?? "Chargement échoué");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const toggle = async (
    row: EndpointRow,
    field: FlagField,
    value: boolean,
  ) => {
    setTogglingId(row.id);
    setRows((rs) =>
      rs.map((r) => (r.id === row.id ? { ...r, [field]: value } : r)),
    );
    try {
      const updated = await patchEndpointFlags(row.id, { [field]: value });
      setRows((rs) => rs.map((r) => (r.id === row.id ? updated : r)));
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      message.error(err?.response?.data?.error ?? "Échec du toggle");
      // Per-row revert: rollback only the field we just toggled — avoids
      // clobbering a concurrent toggle's success on another row.
      setRows((rs) =>
        rs.map((r) => (r.id === row.id ? { ...r, [field]: !value } : r)),
      );
    } finally {
      setTogglingId(null);
    }
  };

  const onSave = async (input: EndpointInput) => {
    setSaving(true);
    try {
      if (drawer.mode === "create") {
        const created = await createEndpoint(input);
        // Splice locally pour éviter un round-trip GET. La table re-render
        // immédiatement avec la nouvelle row (triée par name à l'arrivée).
        setRows((rs) =>
          [...rs, created].sort((a, b) => a.name.localeCompare(b.name)),
        );
        message.success("Endpoint créé");
      } else if (drawer.mode === "edit") {
        const updated = await updateEndpoint(drawer.row.id, input);
        setRows((rs) =>
          rs
            .map((r) => (r.id === updated.id ? updated : r))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        message.success("Endpoint mis à jour");
      }
      setDrawer({ mode: "closed" });
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      const msg = err?.response?.data?.error;
      message.error(msg ?? "Échec de l'enregistrement");
      // Ne pas refermer le Drawer — l'utilisateur peut corriger et retenter.
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (row: EndpointRow) => {
    try {
      await deleteEndpoint(row.id);
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      message.success("Endpoint supprimé");
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      message.error(err?.response?.data?.error ?? "Échec de la suppression");
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <PageHeader
        title="Endpoints MCP"
        description="Registre des endpoints MCP exposés par le serveur. Crée, édite, ou toggle un flag — la prochaine requête /mcp voit le changement immédiatement (sans redémarrage)."
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setDrawer({ mode: "create" })}
          >
            Nouveau
          </Button>
        }
      />

      <Table<EndpointRow>
        dataSource={rows}
        rowKey="id"
        loading={loading}
        pagination={false}
        size="middle"
        locale={{
          emptyText: (
            <EmptyState
              icon={<ApiOutlined />}
              title="Aucun endpoint"
              hint="Crée le premier via le bouton Nouveau, ou lance `npm run seed:endpoints` côté serveur."
              action={
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => setDrawer({ mode: "create" })}
                >
                  Nouveau
                </Button>
              }
            />
          ),
        }}
        columns={[
          {
            title: "Nom",
            dataIndex: "name",
            render: (name: string, row: EndpointRow) => (
              <Typography.Link
                onClick={() => setDrawer({ mode: "edit", row })}
                style={{ fontFamily: MONO_STACK }}
              >
                {name}
              </Typography.Link>
            ),
          },
          {
            title: "Type",
            dataIndex: "type",
            width: 120,
            render: (type: string) => <Tag>{type}</Tag>,
          },
          {
            title: "Description",
            dataIndex: "description",
            render: (description: string | null) => (
              <Typography.Paragraph
                ellipsis={{ rows: 1, tooltip: description ?? undefined }}
                style={{ width: 280, margin: 0 }}
                type={description ? undefined : "secondary"}
              >
                {description ?? "—"}
              </Typography.Paragraph>
            ),
          },
          {
            title: "Actif",
            dataIndex: "is_active",
            width: 90,
            align: "center",
            render: (v: boolean, row: EndpointRow) => (
              <Switch
                checked={v}
                loading={togglingId === row.id}
                onChange={(val) => toggle(row, "is_active", val)}
                aria-label={`Activer/désactiver ${row.name}`}
              />
            ),
          },
          {
            title: "Public",
            dataIndex: "is_public",
            width: 90,
            align: "center",
            render: (v: boolean, row: EndpointRow) => (
              <Switch
                checked={v}
                loading={togglingId === row.id}
                onChange={(val) => toggle(row, "is_public", val)}
                aria-label={`Rendre public/privé ${row.name}`}
              />
            ),
          },
          {
            title: "Mis à jour",
            dataIndex: "updated_at",
            width: 180,
            render: (v: string) => (
              <Typography.Text type="secondary">
                {fmtDateTime(v)}
              </Typography.Text>
            ),
          },
          {
            title: "Actions",
            key: "actions",
            width: 130,
            render: (_: unknown, row: EndpointRow) => (
              <Popconfirm
                title="Supprimer ?"
                description="Suppression définitive."
                okText="Supprimer"
                cancelText="Annuler"
                okButtonProps={{ danger: true }}
                onConfirm={() => onDelete(row)}
              >
                <Button danger icon={<DeleteOutlined />} size="small">
                  Supprimer
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />

      <EndpointForm
        mode={drawer.mode === "edit" ? "edit" : "create"}
        open={drawer.mode !== "closed"}
        initial={drawer.mode === "edit" ? drawer.row : undefined}
        saving={saving}
        onSave={onSave}
        onClose={() => setDrawer({ mode: "closed" })}
      />
    </Space>
  );
}
