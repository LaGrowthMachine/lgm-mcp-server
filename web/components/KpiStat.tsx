import { Typography } from "antd";
import type { ReactNode } from "react";
import { LGM_COLORS } from "../theme";

export type KpiTone =
  | "default"
  | "success"
  | "warning"
  | "danger"
  | "muted"
  | "primary";

interface KpiStatProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: KpiTone;
}

const COLOR_BY_TONE: Record<KpiTone, string> = {
  default: LGM_COLORS.textBase,
  success: LGM_COLORS.green,
  warning: LGM_COLORS.warning,
  danger: LGM_COLORS.coral,
  muted: LGM_COLORS.textTertiary,
  primary: LGM_COLORS.green,
};

// Statistic unifié pour les KPIs en haut des pages liste/détail. Remplace
// les `<Statistic>` AntD ad-hoc avec valueStyle inline disparates.
export function KpiStat({ label, value, hint, tone = "default" }: KpiStatProps) {
  return (
    <div style={{ minWidth: 100 }}>
      <Typography.Text
        style={{
          fontSize: 12,
          color: LGM_COLORS.textSecondary,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          fontWeight: 500,
        }}
      >
        {label}
      </Typography.Text>
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          lineHeight: 1.2,
          color: COLOR_BY_TONE[tone],
          marginTop: 2,
        }}
      >
        {value}
      </div>
      {hint && (
        <div
          style={{
            fontSize: 11,
            color: LGM_COLORS.textTertiary,
            marginTop: 2,
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
