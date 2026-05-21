import { useEffect, useState } from "react";
import { Button, Card, Space, Typography, App } from "antd";
import { http, DefaultModelResp } from "../api";
import { PageHeader } from "../components/PageHeader";
import { ModelSelect } from "../ModelSelect";

// Réglages globaux. Pour l'instant uniquement le choix du modèle d'inférence
// par défaut. Stocké dans la table `settings` (k/v générique), pas en flag
// sur les modèles — permet d'ajouter d'autres réglages au même endroit.

export function Settings() {
  const { message } = App.useApp();
  const [defaultModel, setDefaultModel] = useState<DefaultModelResp | null>(
    null,
  );
  const [draftDefaultId, setDraftDefaultId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const { data } = await http.get<DefaultModelResp>(
        "/settings/default-model",
      );
      setDefaultModel(data);
      setDraftDefaultId(data.modelId ?? "");
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

  const draftChanged = draftDefaultId !== (defaultModel?.modelId ?? "");

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <PageHeader
        title="Réglages"
        description="Configuration globale de l'environnement. Affecte les batchs et analyses lancés sans modèle explicite."
      />

      <Card title="Modèle par défaut">
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          Modèle utilisé pour les analyses et batchs quand aucun modèle n'est
          choisi explicitement. Pré-sélectionné dans les écrans de création.
          Les modèles se gèrent dans la page <strong>Modèles</strong>.
        </Typography.Paragraph>
        <Space wrap>
          <ModelSelect
            value={draftDefaultId}
            onChange={setDraftDefaultId}
            disabled={loading}
            style={{ minWidth: 320 }}
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
