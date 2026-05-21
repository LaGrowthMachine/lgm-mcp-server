import { Layout, Menu, Typography } from "antd";
import {
  SearchOutlined,
  ExperimentOutlined,
  SendOutlined,
  MessageOutlined,
  ProfileOutlined,
  FileTextOutlined,
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

const { Header, Sider, Content } = Layout;

const NAV = [
  {
    key: "/discover",
    icon: <SearchOutlined />,
    label: "Trouver des conversations",
  },
  {
    key: "/batches",
    icon: <ExperimentOutlined />,
    label: "Analyses en batch",
  },
  { key: "/generate", icon: <SendOutlined />, label: "Générer des réponses" },
  {
    key: "/conversations",
    icon: <MessageOutlined />,
    label: "Liste conversations",
  },
  { key: "/replies", icon: <ProfileOutlined />, label: "Liste réponses" },
  { key: "/prompts", icon: <FileTextOutlined />, label: "Prompts" },
];

export function Shell() {
  const navigate = useNavigate();
  const loc = useLocation();
  const selected =
    NAV.find((n) => loc.pathname.startsWith(n.key))?.key ?? "/discover";

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          background: "#0b2e20",
          paddingInline: 24,
        }}
      >
        <Typography.Title
          level={4}
          style={{ color: "#fff", margin: 0, letterSpacing: 0.3 }}
        >
          LGM · Validation de prompt
        </Typography.Title>
        <Typography.Text style={{ color: "#9fcdb8", marginLeft: 16 }}>
          analyze_conversation — bibliothèque de conversations &amp; prompts
          versionnés
        </Typography.Text>
      </Header>
      <Layout>
        {/* AntD tronque les libellés de menu par défaut ; on autorise le
            retour à la ligne (2 lignes) en plus d'un Sider plus large. */}
        <style>{`
          .ant-menu-inline .ant-menu-item {
            height: auto;
            line-height: 1.35;
            padding-top: 8px;
            padding-bottom: 8px;
          }
          .ant-menu-inline .ant-menu-item .ant-menu-title-content {
            white-space: normal;
            overflow: visible;
            text-overflow: clip;
          }
        `}</style>
        <Sider width={260} theme="light" breakpoint="lg" collapsedWidth={0}>
          <Menu
            mode="inline"
            selectedKeys={[selected]}
            style={{ height: "100%", borderRight: 0, paddingTop: 8 }}
            items={NAV}
            onClick={(e) => navigate(e.key)}
          />
        </Sider>
        <Content style={{ padding: 24, background: "#f5f6f5" }}>
          <div
            style={{
              background: "#fff",
              padding: 24,
              borderRadius: 8,
              minHeight: "100%",
              boxShadow: "0 1px 2px rgba(0,0,0,.06)",
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
            </Routes>
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
