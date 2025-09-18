import React, { useEffect, useMemo, useState } from "react";
import { csvParse } from "d3-dsv";
import { Treemap, ResponsiveContainer, Tooltip, Cell } from "recharts";

type MatchCsvRow = Record<string, string>;

type CountryNode = {
  name: string;
  code: string;
  value: number; // number of GS titles
  fill?: string; // color per node
};

function parseCsvSmart(text: string) {
  // Basic CSV parse; falls back automatically via d3-dsv for commas
  // The file is comma-delimited in this project
  return csvParse(text) as unknown as (MatchCsvRow & { [key: string]: string })[] & { columns: string[] };
}

// Small helpers for stable colors
function stringHash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return Math.abs(h);
}

function colorFor(code: string) {
  const h = stringHash(code) % 360; // hue 0..359
  const s = 60; // saturation
  const l = 50; // lightness
  return `hsl(${h} ${s}% ${l}%)`;
}

export default function GrandSlamCountryTreemap() {
  const [matchesCsv, setMatchesCsv] = useState<string>("");
  const [countryMap, setCountryMap] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  // No UI toggle; we selectively show flags for a few countries

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setStatus("loading");
        const [mText, codes] = await Promise.all([
          fetch("/matches.csv").then(r => r.text()),
          fetch("/CountryCodes.json").then(r => r.json()),
        ]);
        if (cancelled) return;
        setMatchesCsv(mText);
        setCountryMap(codes || {});
        setStatus("ready");
      } catch (e: any) {
        if (cancelled) return;
        setErrorMsg(e?.message || "Failed to load matches or country codes");
        setStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // IOC -> ISO2 mapping for flags stored in /public/flags/{iso2}.svg
  const IOC_TO_ISO2: Record<string, string> = {
    ESP: "es",
    SRB: "rs",
    SUI: "ch",
    USA: "us",
    ITA: "it",
    RUS: "ru",
    GBR: "gb",
    BRA: "br",
    CRO: "hr",
    AUS: "au",
    ARG: "ar",
    AUT: "at",
    SWE: "se",
  };

  // Countries that should show full-tile flags (stretched)
  const FLAG_CODES = new Set(["ESP", "SRB", "SUI"]);

  // Hand-picked colors for other countries (fallback to hashed color if missing)
  const COLOR_BY_IOC: Record<string, string> = {
    USA: "#0d3b66", // deep blue
    ITA: "#2e7d32", // green
    ARG: "#2e86de", // light blue
    AUS: "#ef6c00", // orange
    AUT: "#c62828", // red
    BRA: "#1b5e20", // green (darker)
    CRO: "#1565c0", // blue
    GBR: "#283593", // indigo
    RUS: "#455a64", // blue-grey
    SWE: "#1976d2", // blue
  };

  const data: CountryNode[] = useMemo(() => {
    if (!matchesCsv) return [];
    const rows = parseCsvSmart(matchesCsv);

    // Identify key columns (robust to minor header differences)
    const tlKey = rows.columns.find(c => /tourney[_ ]?level/i.test(c)) ?? "tourney_level";
    const roundKey = rows.columns.find(c => /^round$/i.test(c)) ?? "round";
    const winnerIocKey = rows.columns.find(c => /winner.*ioc/i.test(c)) ?? "winner_ioc";

    const counts = new Map<string, number>();

    for (const r of rows) {
      const level = String(r[tlKey] ?? "").toUpperCase();
      const round = String(r[roundKey] ?? "").toUpperCase();
      if (level !== "G" || round !== "F") continue; // Only Grand Slam finals

      const code = String(r[winnerIocKey] ?? "").trim().toUpperCase();
      if (!code) continue;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }

    // Convert to array and map to country names
    const displayName = (code: string) => {
      const c = code.toUpperCase();
      if (c === "USA") return "USA"; // keep short
      if (c === "GBR") return "UK";  // short label for readability
      return countryMap[c] || c;
    };

    const nodes: CountryNode[] = Array.from(counts.entries())
      .map(([code, value]) => {
        const iso2 = IOC_TO_ISO2[code as keyof typeof IOC_TO_ISO2];
        const useFlag = FLAG_CODES.has(code) && !!iso2;
        const patternId = useFlag ? `flag-${iso2}-stretch` : undefined;
        return {
          code,
          value,
          name: displayName(code),
          // Spain/Serbia/Switzerland show stretched flags; others get curated colors
          fill: patternId ? `url(#${patternId})` : (COLOR_BY_IOC[code] ?? colorFor(code)),
        } as CountryNode;
      })
      // Sort descending for stable coloring/labels
      .sort((a, b) => b.value - a.value);

    return nodes;
  }, [matchesCsv, countryMap]);

  // Collect the unique ISO2 codes present to define patterns once
  const patternIso2s = useMemo(() => {
    const s = new Set<string>();
    for (const n of data) {
      if (!FLAG_CODES.has(n.code)) continue;
      const iso2 = IOC_TO_ISO2[n.code];
      if (iso2) s.add(iso2);
    }
    return Array.from(s);
  }, [data]);

  // Flags are stretched to fill (for selected countries)
  const preserveAR = 'none';

  if (status === "loading") {
    return <div style={{ color: "#ccc", margin: "16px 0" }}>Loading treemap...</div>;
  }
  if (status === "error") {
    return <div style={{ color: "#f66", margin: "16px 0" }}>{errorMsg}</div>;
  }

  return (
    <div className="treemap-root" style={{ background: "#0b0b18", borderRadius: 12, padding: 16, margin: "24px auto", maxWidth: 1200 }}>
      <h2 style={{ color: "#eaeaea", fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600, margin: 0, marginBottom: 8 }}>
        Grand Slam Titles by Country
      </h2>
      <p style={{ color: "#9aa0a6", marginTop: 0, marginBottom: 12, fontSize: 14 }}>
        Men's singles, from available data in matches.csv
      </p>
      <div style={{ width: "100%", height: 520 }}>
        <ResponsiveContainer>
          <Treemap
            data={data}
            dataKey="value"
            nameKey="name"
            stroke="#13132a"
            fill="#000000"
            aspectRatio={4 / 3}
            isAnimationActive={false}
          >
            {/* Define patterns used as cell fills */}
            <defs>
              {patternIso2s.map((iso2) => (
                <pattern
                  key={`${iso2}-stretch`}
                  id={`flag-${iso2}-stretch`}
                  width="1"
                  height="1"
                  patternUnits="objectBoundingBox"
                >
                  {/* Background so letterboxing areas have a neutral base */}
                  <rect width="100%" height="100%" fill="#0b0b18" />
                  <image
                    href={`/flags/${iso2}.svg`}
                    width="100%"
                    height="100%"
                    preserveAspectRatio={preserveAR}
                  />
                </pattern>
              ))}
            </defs>
            {/* Per-cell fills to apply flag patterns */}
            {data.map((d) => (
              <Cell key={d.code} fill={d.fill} stroke="#13132a" />
            ))}
            {/* Force tooltip text to black instead of series color */}
            <Tooltip
              contentStyle={{ color: "#000", borderColor: "#cfd8dc" }}
              labelStyle={{ color: "#000" }}
              itemStyle={{ color: "#000" }}
              wrapperStyle={{ outline: "none" }}
            />
          </Treemap>
        </ResponsiveContainer>
      </div>
      {/* Spain, Serbia, Switzerland rendered with stretched flags. Others use curated colors. */}
    </div>
  );
}

