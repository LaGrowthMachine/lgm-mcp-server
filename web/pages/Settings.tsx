import { useEffect, useState } from "react";
import { Button, Card, Select, Space, Typography, message } from "antd";
import { http, Model, DefaultModelResp } from "../api";

// Settings globaux. Pour l'instant uniquement le choix du modèle d'inférence
// par défaut. Stocké dans la table `settings` (k/v générique), pas en flag
// sur les modèles — permet d'ajouter d'autres réglages au même endroit.

export function Settings() {
  const [models, setModels] = useState<Model[]>([]);
  const [defaultModel, setDefaultModel] = useState<DefaultModelResp | null>(
    null,
  );
  const [draftDefaultId, setDraftDefaultId] = useState<string | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const [a, b] = await Promise.all([
        http.get<Model[]>("/models", { params: { archived: "0" } }),
        http.get<DefaultModelResp>("/settings/default-model"),
      ]);
      setModels(a.data);
      setDefaultModel(b.data);
      setDraftDefaultId(b.data.modelId ?? undefined);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const onSave = async () => {
    if (!draftDefaultId) return;
    setSaving(true);
    try {
      const { data } = await http.put<DefaultModelResp>(
        "/settings/default-model",
        { modelId: draftDefaultId },
      );
      setDefaultModel(data);
      message.success("Modèle par défaut mis à jour");
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      const msg = err?.response?.data?.error;
      message.error(msg ?? "Erreur");
    } finally {
      setSaving(false);
    }
  };

  const draftChanged = draftDefaultId !== (defaultModel?.modelId ?? undefined);

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        Settings
      </Typography.Title>

      <Card title="Modèle par défaut">
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          Modèle utilisé pour les analyses et batchs quand aucun modèle n'est
          choisi explicitement. Pré-sélectionné dans les écrans de création.
          Les modèles se gèrent dans la page <strong>Modèles</strong>.
        </Typography.Paragraph>
        <Space wrap>
          <Select
            value={draftDefaultId}
            onChange={(v) => setDraftDefaultId(v)}
            options={models.map((m) => ({ value: m.id, label: m.label }))}
            placeholder="Choisir un modèle"
            style={{ minWidth: 320 }}
            disabled={loading}
          />
          <Button
            type="primary"
            disabled={!draftDefaultId || !draftChanged}
            loading={saving}
            onClick={onSave}
          >
            Enregistrer
          </Button>
        </Space>
      </Card>
    </Space>
  );
}
