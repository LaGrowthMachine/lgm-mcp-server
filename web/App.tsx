import { Layout, Menu, Typography } from "antd";
import {
  SearchOutlined,
  ExperimentOutlined,
  MessageOutlined,
  FileTextOutlined,
  SendOutlined,
} from "@ant-design/icons";
import {
  Routes,
  Route,
  useNavigate,
  useLocation,
  Navigate,
} from "react-router-dom";
import { Discover } from "./pages/Discover";
import { Analyze } from "./pages/Analyze";
import { Replies } from "./pages/Replies";
import { Conversations } from "./pages/Conversations";
import { ConversationDetail } from "./pages/ConversationDetail";
import { Prompts } from "./pages/Prompts";

const { Header, Sider, Content } = Layout;

const NAV = [
  { key: "/discover", icon: <SearchOutlined />, label: "Découverte" },
  { key: "/analyze", icon: <ExperimentOutlined />, label: "Analyse" },
  { key: "/replies", icon: <SendOutlined />, label: "Réponses" },
  { key: "/conversations", icon: <MessageOutlined />, label: "Conversations" },
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
        <Sider width={210} theme="light" breakpoint="lg" collapsedWidth={0}>
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
              <Route path="/analyze" element={<Analyze />} />
              <Route path="/replies" element={<Replies />} />
              <Route path="/conversations" element={<Conversations />} />
              <Route
                path="/conversations/:id"
                element={<ConversationDetail />}
              />
              <Route path="/prompts" element={<Prompts />} />
            </Routes>
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
