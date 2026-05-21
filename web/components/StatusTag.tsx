import { Tag } from "antd";
import type { ReactNode } from "react";

export type StatusKind =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral"
  | "processing"
  | "highlight";

interface StatusTagProps {
  kind: StatusKind;
  label: ReactNode;
  icon?: ReactNode;
}

// Mapping unique vers les couleurs AntD (qui sont déjà dérivées du thème
// LGM via main.tsx → ConfigProvider). Cinq couleurs sémantiques + une
// "highlight" (gold) pour les marqueurs spéciaux type "défaut/favori".
const COLOR_BY_KIND: Record<StatusKind, string> = {
  success: "success",
  warning: "warning",
  danger: "error",
  info: "blue",
  neutral: "default",
  processing: "processing",
  highlight: "gold",
};

// Tag de statut unifié. Toutes les pages doivent passer par ici pour les
// statuts (batch, prompt, verdict, favori, etc.). Cf. glossaire UI.
export function StatusTag({ kind, label, icon }: StatusTagProps) {
  return (
    <Tag color={COLOR_BY_KIND[kind]} icon={icon}>
      {label}
    </Tag>
  );
}
