import {
  Button,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Switch,
  Typography,
} from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import {
  BUILTIN_HANDLERS,
  BuiltinHandler,
  EndpointInput,
  EndpointInputConfigInput,
  EndpointRow,
  EndpointType,
} from "../api";
import { LGM_COLORS, MONO_STACK } from "../theme";

// Mirror of `ENDPOINT_NAME_RE` in src/endpoints/types.ts. The two bundles
// don't share a rootDir — keep both definitions in sync.
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

// Mirror of `PATH_PLACEHOLDER_RE` in src/endpoints/types.ts.
const PATH_PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

const BUILTIN_HANDLER_OPTIONS = BUILTIN_HANDLERS.map((h) => ({
  value: h,
  label: h,
}));

interface InputRowFormValue {
  name: string;
  kind: "string" | "number" | "boolean";
  optional?: boolean;
  default?: string;
  describe: string;
  // Refinements not exposed by the form but preserved on edit so a config
  // built outside the UI survives a round-trip.
  _passthrough?: {
    enum?: string[];
    pattern?: string;
    pattern_message?: string;
    format?: "url";
    min?: number;
    max?: number;
  };
}

interface FormValues {
  name: string;
  type: EndpointType;
  // proxy-only
  method?: "GET" | "POST";
  path?: string;
  destructive_hint?: boolean;
  // builtin-only
  handler?: BuiltinHandler;
  // shared
  label?: string;
  title?: string;
  tracking_event?: string;
  description?: string;
  inputs: InputRowFormValue[];
}

export interface EndpointFormProps {
  mode: "create" | "edit";
  open: boolean;
  initial?: EndpointRow;
  saving?: boolean;
  onSave: (input: EndpointInput) => Promise<void>;
  onClose: () => void;
}

const rowToFormValues = (row?: EndpointRow): FormValues => {
  const cfg = (row?.config ?? {}) as {
    method?: "GET" | "POST";
    path?: string;
    handler?: BuiltinHandler;
    label?: string;
    title?: string;
    tracking_event?: string;
    destructive_hint?: boolean;
    inputs?: EndpointInputConfigInput[];
  };
  const type: EndpointType = row?.type === "builtin" ? "builtin" : "proxy";
  return {
    name: row?.name ?? "",
    type,
    method: cfg.method ?? "GET",
    path: cfg.path ?? "",
    destructive_hint: cfg.destructive_hint,
    handler: cfg.handler,
    label: cfg.label ?? "",
    title: cfg.title ?? "",
    tracking_event: cfg.tracking_event ?? "",
    description: row?.description ?? "",
    inputs: (cfg.inputs ?? []).map((i) => ({
      name: i.name,
      kind: i.kind,
      optional: i.optional ?? false,
      default: i.default === undefined ? "" : String(i.default),
      describe: i.describe,
      _passthrough: {
        enum: i.enum,
        pattern: i.pattern,
        pattern_message: i.pattern_message,
        format: i.format,
        min: i.min,
        max: i.max,
      },
    })),
  };
};

const formValuesToInput = (v: FormValues): EndpointInput => {
  const inputs: EndpointInputConfigInput[] = (v.inputs ?? []).map((i) => {
    const row: EndpointInputConfigInput = {
      name: i.name,
      kind: i.kind,
      describe: i.describe,
    };
    if (i.optional) row.optional = true;
    const raw = (i.default ?? "").trim();
    if (raw !== "") {
      if (i.kind === "number") {
        const n = Number(raw);
        if (Number.isFinite(n)) row.default = n;
      } else if (i.kind === "boolean") {
        if (raw === "true") row.default = true;
        else if (raw === "false") row.default = false;
      } else {
        row.default = raw;
      }
    }
    const pass = i._passthrough;
    if (pass) {
      if (pass.enum !== undefined) row.enum = pass.enum;
      if (pass.pattern !== undefined) row.pattern = pass.pattern;
      if (pass.pattern_message !== undefined)
        row.pattern_message = pass.pattern_message;
      if (pass.format !== undefined) row.format = pass.format;
      if (pass.min !== undefined) row.min = pass.min;
      if (pass.max !== undefined) row.max = pass.max;
    }
    return row;
  });

  const label = v.label?.trim() ? v.label.trim() : undefined;
  const title = v.title?.trim() ? v.title.trim() : undefined;
  const trackingEvent = v.tracking_event?.trim()
    ? v.tracking_event.trim()
    : undefined;
  const description = v.description?.trim() ? v.description.trim() : null;

  if (v.type === "builtin") {
    return {
      name: v.name,
      type: "builtin",
      description,
      config: {
        handler: v.handler as BuiltinHandler,
        label,
        title,
        tracking_event: trackingEvent,
        inputs,
      },
    };
  }

  // `destructive_hint` is only meaningful for POST (annotations.destructiveHint
  // is suppressed for GET, which is always readOnlyHint). Strip it on GET.
  const method = v.method ?? "GET";
  return {
    name: v.name,
    type: "proxy",
    description,
    config: {
      method,
      path: v.path ?? "",
      label,
      title,
      tracking_event: trackingEvent,
      destructive_hint: method === "POST" ? v.destructive_hint : undefined,
      inputs,
    },
  };
};

export function EndpointForm(props: EndpointFormProps) {
  const { mode, open, initial, saving, onSave, onClose } = props;
  const [form] = Form.useForm<FormValues>();

  const onSubmit = async () => {
    const values = await form.validateFields();
    try {
      await onSave(formValuesToInput(values));
    } catch (e: unknown) {
      // Parent re-throws so the Drawer stays open and the toast surfaces.
      // Translate 409 (name collision) to an inline form error on `name`.
      const err = e as {
        response?: { status?: number; data?: { error?: string } };
      };
      if (err?.response?.status === 409) {
        form.setFields([
          { name: "name", errors: ["Ce nom est déjà utilisé"] },
        ]);
      }
    }
  };

  return (
    <Drawer
      title={mode === "create" ? "Nouveau endpoint" : "Éditer l'endpoint"}
      open={open}
      onClose={onClose}
      width={640}
      destroyOnClose
      maskClosable={!saving}
      closable={!saving}
      extra={
        <Space>
          <Button onClick={onClose} disabled={saving}>
            Annuler
          </Button>
          <Button type="primary" onClick={onSubmit} loading={saving}>
            {mode === "create" ? "Créer" : "Enregistrer"}
          </Button>
        </Space>
      }
    >
      <Form<FormValues>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={rowToFormValues(initial)}
      >
        <Form.Item
          name="name"
          label="Nom"
          rules={[
            { required: true, message: "Nom requis" },
            {
              pattern: NAME_RE,
              message:
                "snake_case, commence par une lettre, ≤64 caractères (ex : list_campaigns)",
            },
          ]}
          extra="Identifiant unique exposé aux clients MCP. Immuable côté agent une fois utilisé."
        >
          <Input
            autoFocus={mode === "create"}
            placeholder="list_campaigns"
            style={{ fontFamily: MONO_STACK }}
          />
        </Form.Item>

        <Form.Item
          name="type"
          label="Type"
          rules={[{ required: true }]}
          extra="proxy = passe-plat vers une route LGM. builtin = handler de code (inférence Bedrock, agent loop)."
        >
          <Select
            options={[
              { value: "proxy", label: "proxy" },
              { value: "builtin", label: "builtin" },
            ]}
          />
        </Form.Item>

        <Form.Item
          noStyle
          shouldUpdate={(prev, next) => prev.type !== next.type}
        >
          {({ getFieldValue }) =>
            getFieldValue("type") === "builtin" ? (
              <Form.Item
                name="handler"
                label="Handler"
                rules={[{ required: true, message: "Handler requis" }]}
                extra="Sélectionne l'implémentation côté serveur (whitelist)."
              >
                <Select options={BUILTIN_HANDLER_OPTIONS} />
              </Form.Item>
            ) : (
              <>
                <Form.Item
                  name="method"
                  label="Méthode"
                  rules={[{ required: true, message: "Méthode requise" }]}
                  extra="GET = lecture pure (readOnlyHint). POST = écriture (destructiveHint)."
                >
                  <Select
                    options={[
                      { value: "GET", label: "GET" },
                      { value: "POST", label: "POST" },
                    ]}
                  />
                </Form.Item>

                <Form.Item
                  noStyle
                  shouldUpdate={(prev, next) => prev.method !== next.method}
                >
                  {({ getFieldValue: gf }) =>
                    gf("method") === "POST" ? (
                      <Form.Item
                        name="destructive_hint"
                        label="Destructif"
                        valuePropName="checked"
                        extra="annotations.destructiveHint. Coche pour les écritures qui suppriment/écrasent (défaut serveur : true)."
                      >
                        <Switch />
                      </Form.Item>
                    ) : null
                  }
                </Form.Item>

                <Form.Item
                  name="path"
                  label="Chemin LGM"
                  dependencies={[["inputs"]]}
                  rules={[
                    { required: true, message: "Chemin requis" },
                    {
                      validator: (_r, v) =>
                        typeof v === "string" && v.startsWith("/")
                          ? Promise.resolve()
                          : Promise.reject(
                              new Error(
                                "doit commencer par / (ex : /campaigns)",
                              ),
                            ),
                    },
                    ({ getFieldValue: gf }) => ({
                      // Best-effort client-side mirror of the server's
                      // superRefine — backend remains the source of truth.
                      validator(_r, v: unknown) {
                        if (typeof v !== "string") return Promise.resolve();
                        const inputs = (gf("inputs") ??
                          []) as InputRowFormValue[];
                        const inputNames = new Set(
                          inputs
                            .map((i) => i?.name)
                            .filter((n): n is string => !!n),
                        );
                        const matches = Array.from(
                          v.matchAll(PATH_PLACEHOLDER_RE),
                        );
                        for (const m of matches) {
                          const placeholder = m[1];
                          if (!inputNames.has(placeholder)) {
                            return Promise.reject(
                              new Error(
                                `placeholder {${placeholder}} non déclaré dans les inputs`,
                              ),
                            );
                          }
                        }
                        return Promise.resolve();
                      },
                    }),
                  ]}
                  extra="Préfixé /flow automatiquement par callFlow. Placeholders {name} substitués par les inputs matchants."
                >
                  <Input
                    placeholder="/campaigns/{campaignId}/stats"
                    style={{ fontFamily: MONO_STACK }}
                  />
                </Form.Item>
              </>
            )
          }
        </Form.Item>

        <Form.Item
          name="label"
          label="Label"
          extra="Libellé court affiché dans les UIs clients MCP (annotations.title)."
        >
          <Input placeholder="List Campaigns" />
        </Form.Item>

        <Form.Item
          name="title"
          label="Titre"
          extra="Entête markdown utilisé dans la sortie texte renvoyée à l'agent."
        >
          <Input placeholder="Campaigns" />
        </Form.Item>

        <Form.Item
          name="tracking_event"
          label="Event de tracking"
          extra="Nom envoyé à trackMcpEvent à chaque appel. Vide → défaut mcp_tool_called."
        >
          <Input
            placeholder="mcp_tool_called"
            style={{ fontFamily: MONO_STACK }}
          />
        </Form.Item>

        <Form.Item
          name="description"
          label="Description"
          extra="Description longue exposée par tools/list — c'est ce que l'agent lit pour décider d'appeler l'outil."
        >
          <Input.TextArea
            rows={3}
            placeholder="List all campaigns for the authenticated user…"
          />
        </Form.Item>

        <Typography.Title level={5} style={{ marginTop: 8, marginBottom: 8 }}>
          Inputs
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          Paramètres acceptés par l'agent. Chaque input est mappé sur un champ
          du schéma Zod du tool MCP — le <code>describe</code> est le prompt
          que l'agent voit.
        </Typography.Paragraph>

        <Form.List name="inputs">
          {(fields, { add, remove }) => (
            <Space direction="vertical" size="small" style={{ width: "100%" }}>
              {fields.map((field) => (
                <div
                  key={field.key}
                  style={{
                    border: `1px solid ${LGM_COLORS.borderSubtle}`,
                    padding: 12,
                    borderRadius: 6,
                  }}
                >
                  <Space
                    align="start"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      width: "100%",
                    }}
                  >
                    <Space wrap>
                      <Form.Item
                        {...field}
                        name={[field.name, "name"]}
                        label="Nom"
                        rules={[
                          { required: true, message: "Nom requis" },
                          {
                            pattern: NAME_RE,
                            message: "snake_case, ≤64 chars",
                          },
                        ]}
                        style={{ marginBottom: 0, minWidth: 160 }}
                      >
                        <Input
                          placeholder="campaignId"
                          style={{ fontFamily: MONO_STACK }}
                        />
                      </Form.Item>

                      <Form.Item
                        {...field}
                        name={[field.name, "kind"]}
                        label="Type"
                        rules={[{ required: true }]}
                        style={{ marginBottom: 0, minWidth: 110 }}
                      >
                        <Select
                          options={[
                            { value: "string", label: "string" },
                            { value: "number", label: "number" },
                            { value: "boolean", label: "boolean" },
                          ]}
                        />
                      </Form.Item>

                      <Form.Item
                        {...field}
                        name={[field.name, "optional"]}
                        label="Optionnel"
                        valuePropName="checked"
                        style={{ marginBottom: 0 }}
                      >
                        <Switch />
                      </Form.Item>

                      <Form.Item
                        {...field}
                        name={[field.name, "default"]}
                        label="Défaut"
                        dependencies={[["inputs", field.name, "kind"]]}
                        rules={[
                          ({ getFieldValue }) => ({
                            // `default` is typed at submit per `kind`. Without
                            // this check, `kind:number` + "abc" silently drops
                            // to NaN — error inline before submit.
                            validator(_r, v: unknown) {
                              const raw =
                                typeof v === "string" ? v.trim() : "";
                              if (raw === "") return Promise.resolve();
                              const kind = getFieldValue([
                                "inputs",
                                field.name,
                                "kind",
                              ]) as InputRowFormValue["kind"] | undefined;
                              if (kind === "number") {
                                return Number.isFinite(Number(raw))
                                  ? Promise.resolve()
                                  : Promise.reject(
                                      new Error("doit être un nombre"),
                                    );
                              }
                              if (kind === "boolean") {
                                return raw === "true" || raw === "false"
                                  ? Promise.resolve()
                                  : Promise.reject(
                                      new Error("doit être true ou false"),
                                    );
                              }
                              return Promise.resolve();
                            },
                          }),
                        ]}
                        style={{ marginBottom: 0, minWidth: 110 }}
                      >
                        <Input placeholder="25" />
                      </Form.Item>
                    </Space>

                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => remove(field.name)}
                      aria-label="Supprimer cet input"
                    />
                  </Space>

                  <Form.Item
                    {...field}
                    name={[field.name, "describe"]}
                    label="Description (prompt agent)"
                    rules={[{ required: true, message: "Description requise" }]}
                    style={{ marginTop: 12, marginBottom: 0 }}
                  >
                    <Input.TextArea
                      rows={2}
                      placeholder='Ex : "The campaign ID (24-character hex string)"'
                    />
                  </Form.Item>
                </div>
              ))}

              <Button
                type="dashed"
                onClick={() =>
                  add({
                    name: "",
                    kind: "string",
                    optional: false,
                    default: "",
                    describe: "",
                  })
                }
                icon={<PlusOutlined />}
                block
              >
                Ajouter un input
              </Button>
            </Space>
          )}
        </Form.List>
      </Form>
    </Drawer>
  );
}
