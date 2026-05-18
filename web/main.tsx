import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App as AntApp, ConfigProvider, theme } from "antd";
import frFR from "antd/locale/fr_FR";
import "antd/dist/reset.css";
import { Shell } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={frFR}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: { colorPrimary: "#1a5", borderRadius: 6 },
      }}
    >
      <AntApp>
        <BrowserRouter basename="/eval">
          <Shell />
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
