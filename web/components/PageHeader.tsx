import { Typography, Space } from "antd";
import { LGM_COLORS } from "../theme";

interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
}

// En-tête de page unifié. Une seule source de vérité pour le couple
// titre+description+actions de chaque page. Remplace les `Typography.Title
// level={3}` ad-hoc et leurs `marginTop: 0` partout.
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: PageHeaderProps) {
  return (
    <div style={{ marginBottom: 4 }}>
      {breadcrumb && (
        <div
          style={{
            fontSize: 13,
            color: LGM_COLORS.textSecondary,
            marginBottom: 6,
          }}
        >
          {breadcrumb}
        </div>
      )}
      <Space
        align="start"
        style={{
          display: "flex",
          justifyContent: "space-between",
          width: "100%",
          gap: 16,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Title
            level={3}
            style={{ marginTop: 0, marginBottom: 4, fontWeight: 600 }}
          >
            {title}
          </Typography.Title>
          {description && (
            <Typography.Paragraph
              type="secondary"
              style={{ marginBottom: 0, fontSize: 13.5 }}
            >
              {description}
            </Typography.Paragraph>
          )}
        </div>
        {actions && <Space wrap>{actions}</Space>}
      </Space>
    </div>
  );
}
