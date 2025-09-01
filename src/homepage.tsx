import React from "react";
import ReactDOM from "react-dom/client";
import TennisDashboard from "./components/TennisDashboard";

const rootEl = document.getElementById("chart-root");
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
        <TennisDashboard />
    </React.StrictMode>

  );
} else {
  console.log("❌ #chart-root not found");
}


