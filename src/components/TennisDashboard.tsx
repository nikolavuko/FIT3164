import React from "react";
import App from "../App";  // <-- this is your chart code

type TennisDashboardProps = {
  worldStatsExtra?: React.ReactNode;
};

export default function TennisDashboard({ worldStatsExtra }: TennisDashboardProps) {
  return (
    <div style={{ margin: "40px auto", maxWidth: 1200, padding: "0 16px" }}>
      <App worldStatsExtra={worldStatsExtra} />
    </div>
  );
}

