import { Typography } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import { LGM_COLORS } from "../theme";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}

// État vide standardisé : icône + titre + indice + action optionnelle, centré
// vertical. Remplace les `Typography.Text type="secondary"` ad-hoc ("Aucun…").
export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: "40px 16px",
        color: LGM_COLORS.textSecondary,
      }}
    >
      <div
        style={{
          fontSize: 36,
          color: LGM_COLORS.textTertiary,
          marginBottom: 12,
          lineHeight: 1,
        }}
      >
        {icon ?? <InboxOutlined />}
      </div>
      <Typography.Title
        level={5}
        style={{ marginTop: 0, marginBottom: 6, color: LGM_COLORS.textBase }}
      >
        {title}
      </Typography.Title>
      {hint && (
        <Typography.Paragraph
          type="secondary"
          style={{
            maxWidth: 420,
            margin: "0 auto",
            fontSize: 13,
            marginBottom: action ? 16 : 0,
          }}
        >
          {hint}
        </Typography.Paragraph>
      )}
      {action}
    </div>
  );
}
