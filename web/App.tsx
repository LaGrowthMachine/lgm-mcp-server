import { Layout, Menu, Typography, theme } from "antd";
import {
  SearchOutlined,
  ExperimentOutlined,
  SendOutlined,
  MessageOutlined,
  CommentOutlined,
  FileTextOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  ApiOutlined,
} from "@ant-design/icons";
import {
  Routes,
  Route,
  useNavigate,
  useLocation,
  Navigate,
} from "react-router-dom";
import { Discover } from "./pages/Discover";
import { Batches } from "./pages/Batches";
import { BatchDetail } from "./pages/BatchDetail";
import { GenerateReplies } from "./pages/GenerateReplies";
import { Conversations } from "./pages/Conversations";
import { RepliesList } from "./pages/RepliesList";
import { ConversationDetail } from "./pages/ConversationDetail";
import { Prompts } from "./pages/Prompts";
import { Models } from "./pages/Models";
import { Endpoints } from "./pages/Endpoints";
import { Settings } from "./pages/Settings";
import { LGM_COLORS } from "./theme";

const { Header, Sider, Content } = Layout;

const NAV = [
  { key: "/discover", icon: <SearchOutlined />, label: "Trouver" },
  { key: "/batches", icon: <ExperimentOutlined />, label: "Batchs" },
  { key: "/generate", icon: <SendOutlined />, label: "Générer" },
  { key: "/conversations", icon: <MessageOutlined />, label: "Conversations" },
  { key: "/replies", icon: <CommentOutlined />, label: "Réponses" },
  { key: "/prompts", icon: <FileTextOutlined />, label: "Prompts" },
  { key: "/models", icon: <ThunderboltOutlined />, label: "Modèles" },
  { key: "/endpoints", icon: <ApiOutlined />, label: "Endpoints MCP" },
  { key: "/settings", icon: <SettingOutlined />, label: "Réglages" },
];

// Overrides ciblés pour le menu dark sidebar : barre verticale verte sur
// l'item actif (signature LGM) + wrap libellé sur 2 lignes si besoin.
const MENU_CSS = `
  .lgm-sider .ant-menu-dark .ant-menu-item {
    height: auto;
    line-height: 1.35;
    padding-top: 8px;
    padding-bottom: 8px;
    position: relative;
  }
  .lgm-sider .ant-menu-dark .ant-menu-item .ant-menu-title-content {
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
  }
  .lgm-sider .ant-menu-dark .ant-menu-item-selected::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 3px;
    background: ${LGM_COLORS.green};
    border-radius: 0 3px 3px 0;
  }
  body, html, #root {
    font-feature-settings: "cv11", "ss01", "ss03";
  }
`;

export function Shell() {
  const navigate = useNavigate();
  const loc = useLocation();
  const { token } = theme.useToken();
  const selected =
    NAV.find((n) => loc.pathname.startsWith(n.key))?.key ?? "/discover";

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <style>{MENU_CSS}</style>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          borderBottom: `1px solid ${LGM_COLORS.charcoalDeep}`,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background: LGM_COLORS.green,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            color: LGM_COLORS.charcoal,
            fontSize: 13,
            letterSpacing: -0.3,
          }}
        >
          L
        </div>
        <Typography.Title
          level={5}
          style={{
            color: "#fff",
            margin: 0,
            fontWeight: 600,
            letterSpacing: -0.1,
          }}
        >
          LGM OS
        </Typography.Title>
        <Typography.Text
          style={{
            color: "rgba(255,255,255,.55)",
            fontSize: 13,
            marginLeft: 4,
          }}
        >
          MCP · IA · agents · modèles
        </Typography.Text>
      </Header>
      <Layout>
        <Sider
          width={236}
          theme="dark"
          breakpoint="lg"
          collapsedWidth={0}
          className="lgm-sider"
        >
          <Menu
            mode="inline"
            theme="dark"
            selectedKeys={[selected]}
            style={{
              height: "100%",
              borderRight: 0,
              paddingTop: 12,
              background: "transparent",
            }}
            items={NAV}
            onClick={(e) => navigate(e.key)}
          />
        </Sider>
        <Content style={{ padding: 24 }}>
          <div
            style={{
              background: token.colorBgBase,
              padding: 24,
              borderRadius: token.borderRadiusLG,
              minHeight: "100%",
              boxShadow: token.boxShadowTertiary,
              border: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <Routes>
              <Route path="/" element={<Navigate to="/discover" replace />} />
              <Route path="/discover" element={<Discover />} />
              <Route path="/batches" element={<Batches />} />
              <Route path="/batches/:id" element={<BatchDetail />} />
              <Route path="/generate" element={<GenerateReplies />} />
              <Route path="/conversations" element={<Conversations />} />
              <Route
                path="/conversations/:id"
                element={<ConversationDetail />}
              />
              <Route path="/replies" element={<RepliesList />} />
              <Route path="/prompts" element={<Prompts />} />
              <Route path="/models" element={<Models />} />
              <Route path="/endpoints" element={<Endpoints />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
