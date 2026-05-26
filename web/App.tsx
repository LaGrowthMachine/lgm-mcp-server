import { useEffect, useState } from "react";
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
  UserOutlined,
  LogoutOutlined,
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

// Source de vérité auth pour tout le SPA. Hook partagé entre RequireAuth
// (qui bloque le rendu) et UserBadge (affichage). Une seule requête /me.
type AuthState =
  | { kind: "loading" }
  | { kind: "logged_in"; email: string; name: string }
  | { kind: "logged_out"; loginUrl: string }
  | { kind: "disabled" };

function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/eval/auth/me", {
          credentials: "same-origin",
        });
        if (cancelled) return;
        if (r.ok) {
          const u = (await r.json()) as { email: string; name: string };
          setState({ kind: "logged_in", ...u });
          return;
        }
        if (r.status === 401) {
          const body = (await r.json().catch(() => ({}))) as {
            error?: string;
            loginUrl?: string;
          };
          if (body.error === "auth_disabled") {
            setState({ kind: "disabled" });
          } else {
            const here = window.location.pathname + window.location.search;
            const loginUrl = `${body.loginUrl ?? "/eval/auth/login"}?returnTo=${encodeURIComponent(here)}`;
            setState({ kind: "logged_out", loginUrl });
          }
          return;
        }
      } catch {
        // Erreur réseau (backend down, DNS, CORS) : on ne sait PAS si l'auth
        // est désactivée ou si la session est valide. Plus conservateur de
        // traiter comme non-loggué pour que RequireAuth bounce vers le login
        // au lieu d'exposer la SPA transitoirement.
        if (!cancelled) {
          const here = window.location.pathname + window.location.search;
          const loginUrl = `/eval/auth/login?returnTo=${encodeURIComponent(here)}`;
          setState({ kind: "logged_out", loginUrl });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

// Gate global : tant que /me n'a pas répondu, on n'affiche RIEN du SPA.
// Si 401 → redirect direct vers /eval/auth/login (pas de flicker). Si dev
// avec auth désactivée → on laisse passer.
function RequireAuth({
  state,
  children,
}: {
  state: AuthState;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (state.kind === "logged_out") {
      window.location.replace(state.loginUrl);
    }
  }, [state]);

  if (state.kind === "loading" || state.kind === "logged_out") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: LGM_COLORS.charcoal,
          color: "rgba(255,255,255,.6)",
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 14,
        }}
      >
        {state.kind === "loading" ? "Chargement…" : "Redirection vers Google…"}
      </div>
    );
  }
  return <>{children}</>;
}

function UserBadge({ state }: { state: AuthState }) {

  if (state.kind === "loading" || state.kind === "disabled") return null;

  if (state.kind === "logged_out") {
    return (
      <div
        style={{
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <a
          href={state.loginUrl}
          style={{
            color: LGM_COLORS.charcoal,
            background: LGM_COLORS.green,
            fontSize: 13,
            fontWeight: 600,
            padding: "6px 12px",
            borderRadius: 6,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            textDecoration: "none",
          }}
        >
          <UserOutlined />
          Se connecter avec Google
        </a>
      </div>
    );
  }

  return (
    <div
      style={{
        marginLeft: "auto",
        display: "flex",
        alignItems: "center",
        gap: 16,
      }}
    >
      <span
        style={{
          color: "rgba(255,255,255,.75)",
          fontSize: 13,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <UserOutlined />
        {state.email}
      </span>
      <a
        href="/eval/auth/logout"
        style={{
          color: LGM_COLORS.green,
          fontSize: 13,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          textDecoration: "none",
        }}
      >
        <LogoutOutlined />
        Se déconnecter
      </a>
    </div>
  );
}

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
  const authState = useAuth();
  const selected =
    NAV.find((n) => loc.pathname.startsWith(n.key))?.key ?? "/discover";

  return (
    <RequireAuth state={authState}>
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
        <UserBadge state={authState} />
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
    </RequireAuth>
  );
}
