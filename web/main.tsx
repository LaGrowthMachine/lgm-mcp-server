import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App as AntApp, ConfigProvider } from "antd";
import frFR from "antd/locale/fr_FR";
import "antd/dist/reset.css";
import { Shell } from "./App";
import { lgmTheme } from "./theme";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider locale={frFR} theme={lgmTheme}>
      <AntApp>
        <BrowserRouter basename="/eval">
          <Shell />
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
