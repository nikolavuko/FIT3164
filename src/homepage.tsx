import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import TennisDashboard from "./components/TennisDashboard";

class ErrorBoundary extends React.Component<{ fallback?: React.ReactNode }, { hasError: boolean; message?: string }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, message: undefined };
  }
  static getDerivedStateFromError(err: any) {
    return { hasError: true, message: err?.message || String(err) };
  }
  componentDidCatch(err: any) {
    console.error("Treemap crashed:", err);
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? <div style={{ color: "#f77" }}>Treemap failed to load.</div>;
    }
    return this.props.children as any;
  }
}

// Lazy-load the treemap so that any runtime error there won't block the dashboard
const GrandSlamCountryTreemap = React.lazy(() => import("./components/GrandSlamCountryTreemap"));

const rootEl = document.getElementById("chart-root");
if (rootEl) {
  const worldStatsTreemap = (
    <ErrorBoundary fallback={<div style={{ color: "#f77", padding: "12px 0" }}>Treemap failed to load.</div>}>
      <Suspense fallback={<div style={{ color: "#bbb", padding: "12px 0" }}>Loading country treemap...</div>}>
        <GrandSlamCountryTreemap />
      </Suspense>
    </ErrorBoundary>
  );

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <TennisDashboard worldStatsExtra={worldStatsTreemap} />
    </React.StrictMode>
  );
} else {
  console.log("#chart-root not found");
}
