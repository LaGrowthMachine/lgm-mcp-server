import { useEffect, useState } from "react";
import { Select } from "antd";
import { http, Model, DefaultModelResp } from "./api";

interface Props {
  value: string; // UUID du modèle sélectionné ("" tant que pas chargé)
  onChange: (id: string) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}

// Source unique de vérité pour la sélection d'un modèle d'inférence.
// Fetch les modèles non archivés + le default settings en parallèle. À
// l'init, on présélectionne le default (s'il existe), sinon le 1er modèle
// non archivé, sinon vide. Calqué sur PromptSelect.
export function ModelSelect({ value, onChange, disabled, style }: Props) {
  const [models, setModels] = useState<Model[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    Promise.all([
      http.get<Model[]>("/models", { params: { archived: "0" } }),
      http.get<DefaultModelResp>("/settings/default-model"),
    ])
      .then(([{ data: list }, { data: def }]) => {
        setModels(list);
        setDefaultId(def.modelId);
        if (!value && list.length) {
          const def0 = def.modelId
            ? list.find((m) => m.id === def.modelId)
            : null;
          onChange((def0 ?? list[0]).id);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const options = models.map((m) => ({
    value: m.id,
    label: `${m.label}${m.id === defaultId ? " - défaut" : ""}`,
  }));
  return (
    <Select
      value={value || undefined}
      onChange={onChange}
      disabled={disabled || loading}
      loading={loading}
      options={options}
      placeholder="Choisir un modèle"
      style={{ minWidth: 280, ...style }}
    />
  );
}
