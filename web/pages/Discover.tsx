import { useState } from "react";
import {
  Typography,
  Input,
  InputNumber,
  Checkbox,
  Button,
  Space,
  Table,
  Tag,
  App,
} from "antd";
import { useNavigate } from "react-router-dom";
import { http, DiscoverResp } from "../api";

export function Discover() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [limit, setLimit] = useState(50);
  const [repliedOnly, setRepliedOnly] = useState(true);
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<DiscoverResp | null>(null);

  const run = async () => {
    setLoading(true);
    try {
      const { data } = await http.post<DiscoverResp>("/discover", {
        input,
        limit,
        repliedOnly,
      });
      setResp(data);
      message.success(`${data.count} conversation(s) pour ${data.users} société(s)`);
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? "Erreur découverte");
    } finally {
      setLoading(false);
    }
  };

  const sendToAnalyze = () => {
    if (!resp?.ids.length) return;
    sessionStorage.setItem("eval.ids", resp.ids.join(", "));
    navigate("/analyze");
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <div>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          Trouver des conversations
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          Colle un CSV LGM (colonne <code>company_id</code>) ou des userId
          24-hex. On renvoie les conversations les plus récentes par société.
        </Typography.Paragraph>
      </div>

      <Input.TextArea
        rows={6}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="CSV LGM, ou userId séparés par virgules / sauts de ligne"
        style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}
      />

      <Space size="large" wrap>
        <Space>
          <span>Conversations / société :</span>
          <InputNumber
            min={1}
            max={200}
            value={limit}
            onChange={(v) => setLimit(v ?? 50)}
          />
        </Space>
        <Checkbox
          checked={repliedOnly}
          onChange={(e) => setRepliedOnly(e.target.checked)}
        >
          Seulement les fils où le lead a répondu (leadReplied:true)
        </Checkbox>
        <Button type="primary" loading={loading} onClick={run}>
          Découvrir
        </Button>
      </Space>

      {resp && (
        <>
          <Space>
            <Tag color="green">{resp.count} conversationId</Tag>
            <Tag>{resp.users} société(s)</Tag>
            <Button
              onClick={() => {
                navigator.clipboard.writeText(resp.ids.join(", "));
                message.success("Copié");
              }}
            >
              Copier les ID
            </Button>
            <Button
              type="primary"
              disabled={!resp.ids.length}
              onClick={sendToAnalyze}
            >
              Envoyer vers Analyse →
            </Button>
          </Space>
          <Table
            size="small"
            rowKey="userId"
            dataSource={resp.perUser}
            pagination={false}
            columns={[
              { title: "userId", dataIndex: "userId", width: 240 },
              {
                title: "conversations",
                dataIndex: "ids",
                render: (ids: string[]) => (
                  <Typography.Text
                    style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
                  >
                    {ids.length ? ids.join(", ") : "—"}
                  </Typography.Text>
                ),
              },
              {
                title: "n",
                dataIndex: "ids",
                width: 60,
                render: (ids: string[]) => ids.length,
              },
            ]}
          />
        </>
      )}
    </Space>
  );
}
