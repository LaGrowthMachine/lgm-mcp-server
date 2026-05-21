import { useEffect, useState } from "react";
import { Select } from "antd";
import { http, PromptListItem, PromptKind } from "./api";

interface Props {
  value: string; // "" tant que `/prompts` n'a pas répondu (préselection live)
  onChange: (v: string) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
  kind?: PromptKind; // analysis (défaut) ou reply
}

// Source unique de vérité pour la sélection d'un prompt. Fetch le MÊME
// endpoint que la page Prompts (`/prompts?kind=...`), garde l'ordre serveur
// tel quel, format option `nom - statut[ - live]`. À l'init, on présélectionne
// automatiquement le prompt live (`is_active`) — pas d'option synthétique en
// tête. Si Prompts.tsx change son endpoint / ordre, on s'aligne ici aussi.
export function PromptSelect({
  value,
  onChange,
  disabled,
  style,
  kind = "analysis",
}: Props) {
  const [prompts, setPrompts] = useState<PromptListItem[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    http
      .get("/prompts", { params: { kind } })
      .then(({ data }) => {
        const list = data.prompts as PromptListItem[];
        setPrompts(list);
        // Préselection : si rien n'est sélectionné, on prend le live ; à
        // défaut (cas rare : aucun prompt validé live), le premier de la
        // liste pour que l'UI ne reste pas bloquée sur "—".
        if (!value && list.length) {
          const def = list.find((p) => p.is_active) ?? list[0];
          onChange(def.name);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  const options = prompts.map((p) => ({
    value: p.name,
    label:
      `${p.name} - ${p.status === "validated" ? "validé" : "brouillon"}` +
      (p.is_active ? " - live" : ""),
  }));
  return (
    <Select
      value={value || undefined}
      onChange={onChange}
      disabled={disabled || loading}
      loading={loading}
      options={options}
      placeholder="Choisir un prompt"
      style={{ minWidth: 280, ...style }}
    />
  );
}
