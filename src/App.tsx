import React, { useEffect, useMemo, useState } from "react";
import { csvParse, dsvFormat } from "d3-dsv";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Legend
} from "recharts";

/* =======================
   Types
======================= */
type Player = {
  player_id: string;
  name: string;
  country?: string;
};

type MatchRow = {
  date: string;  // ISO
  tourney: string;
  surface: "Hard" | "Clay" | "Grass" | "Other" | string;
  winner_id: string;
  loser_id: string;
};

/* =======================
   Helpers
======================= */
// smarter parsing: handle comma or semicolon-delimited CSV
function parseCsvSmart(text: string) {
  let rows = csvParse(text);
  if (rows.columns.length <= 1 && /;/.test(text)) {
    const semi = dsvFormat(";");
    rows = semi.parse(text);
  }
  return rows;
}

function tidySurface(s: string): "Hard" | "Clay" | "Grass" | "Other" {
  const t = (s || "").toLowerCase();
  if (t.includes("hard")) return "Hard";
  if (t.includes("clay")) return "Clay";
  if (t.includes("grass")) return "Grass";
  return "Other";
}

function expectedScore(Ra: number, Rb: number, s = 400) {
  return 1 / (1 + Math.pow(10, (Rb - Ra) / s));
}

function updateElo(Ra: number, Rb: number, scoreA: 0 | 1, K = 32) {
  const Ea = expectedScore(Ra, Rb);
  const Eb = 1 - Ea;
  const newA = Ra + K * (scoreA - Ea);
  const newB = Rb + K * ((1 - scoreA) - Eb);
  return [newA, newB];
}

// Robust date parsing: YYYYMMDD, YYYY-MM-DD, DD/MM/YYYY, etc.
function parseDateFlexible(raw: string): Date | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Jeff Sackmann style YYYYMMDD
  if (/^\d{8}$/.test(s)) {
    const y = +s.slice(0, 4);
    const m = +s.slice(4, 6);
    const d = +s.slice(6, 8);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return isNaN(+dt) ? null : dt;
  }
  // ISO-ish 2024-01-14 or 2024/01/14
  if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(s)) {
    const dt = new Date(s.replace(/\//g, "-"));
    return isNaN(+dt) ? null : dt;
  }
  // D/M/YYYY or DD-MM-YYYY
  const m1 = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m1) {
    const d = +m1[1], m = +m1[2], y = +m1[3] < 100 ? 2000 + +m1[3] : +m1[3];
    const dt = new Date(Date.UTC(y, m - 1, d));
    return isNaN(+dt) ? null : dt;
  }
  const dt = new Date(s);
  return isNaN(+dt) ? null : dt;
}

/* =======================
   App
======================= */
export default function App() {
  const [playersCsvText, setPlayersCsvText] = useState<string>("");
  const [matchesCsvText, setMatchesCsvText] = useState<string>("");
  const [selectedPlayerName, setSelectedPlayerName] = useState<string>("Novak Djokovic"); // prefill
  const [kFactor, setKFactor] = useState<number>(32);
  const [loading, setLoading] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");

  // Load CSVs from /public
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading("loading");
        const [pText, mText] = await Promise.all([
          fetch("/players.csv").then(r => r.text()),
          fetch("/matches.csv").then(r => r.text()),
        ]);
        if (cancelled) return;
        setPlayersCsvText(pText);
        setMatchesCsvText(mText);
        setLoading("ready");
      } catch (e: any) {
        if (cancelled) return;
        setErrorMsg(e?.message || "Failed to fetch CSVs from /public");
        setLoading("error");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Parse players
  const players: Player[] = useMemo(() => {
    if (!playersCsvText) return [];
    const rows = parseCsvSmart(playersCsvText);

    const idKey =
      rows.columns.find(c => c.toLowerCase() === "player_id")
      ?? rows.columns.find(c => /(^|_)id$/i.test(c))
      ?? "player_id";

    const nameKey =
      rows.columns.find(c => c.toLowerCase() === "name")
      ?? rows.columns.find(c => /name|player/i.test(c))
      ?? "name";

    const countryKey = rows.columns.find(c => /country|national/i.test(c));

    return rows.map(r => ({
      player_id: String(r[idKey] ?? "").trim(),
      name: String(r[nameKey] ?? "").trim(),
      country: countryKey ? String(r[countryKey] ?? "").trim() : undefined,
    })).filter(p => p.player_id && p.name);
  }, [playersCsvText]);

  const playerNames = useMemo(() => players.map(p => p.name).sort((a,b)=>a.localeCompare(b)), [players]);

  const nameToId = useMemo(() => {
    const m = new Map<string, string>();
    players.forEach(p => m.set(p.name.toLowerCase(), p.player_id));
    return m;
  }, [players]);

  const idToName = useMemo(() => {
    const m = new Map<string, string>();
    players.forEach(p => m.set(p.player_id, p.name));
    return m;
  }, [players]);

  // Parse matches (IDs or names)
const matches: MatchRow[] = useMemo(() => {
  if (!matchesCsvText) return [];
  const rows = parseCsvSmart(matchesCsvText);

  const dateKey = rows.columns.find(c => /date|tourney_date|match_date/i.test(c)) ?? rows.columns[0];
  const surfaceKey = rows.columns.find(c => /surface/i.test(c)) ?? rows.columns[1];

const winnerIdKey =
  rows.columns.find(c => /winner.*player.*id/i.test(c)) // winner_player_id (preferred)
  ?? rows.columns.find(c => /winner.*_id|^winnerid$|^winner_id$/i.test(c));

const loserIdKey  =
  rows.columns.find(c => /loser.*player.*id/i.test(c))  // loser_player_id (preferred)
  ?? rows.columns.find(c => /loser.*_id|^loserid$|^loser_id$/i.test(c));

  const winnerNameKey= rows.columns.find(c => /winner.*name|^winner$/i.test(c));
  const loserNameKey = rows.columns.find(c => /loser.*name|^loser$/i.test(c));

  const tourneyKey = rows.columns.find(c => /tourn|event|slam|name/i.test(c)) ?? "tourney";

  const out: MatchRow[] = [];
  for (const r of rows) {
    const d = parseDateFlexible(String(r[dateKey] ?? ""));
    if (!d) continue;

    // Try ID fields first
    let w = (winnerIdKey ? String(r[winnerIdKey] ?? "").trim() : "");
    let l = (loserIdKey  ? String(r[loserIdKey]  ?? "").trim() : "");

    // If IDs missing, fall back to names → convert to ID via players
    if ((!w || !l) && (winnerNameKey || loserNameKey)) {
      const wName = winnerNameKey ? String(r[winnerNameKey] ?? "").trim().toLowerCase() : "";
      const lName = loserNameKey ? String(r[loserNameKey] ?? "").trim().toLowerCase() : "";

      if (!w && wName) {
        const found = players.find(p => p.name.toLowerCase() === wName);
        if (found) w = found.player_id;
      }
      if (!l && lName) {
        const found = players.find(p => p.name.toLowerCase() === lName);
        if (found) l = found.player_id;
      }
    }

    if (!w || !l) continue; // skip if still no IDs

    out.push({
      date: d.toISOString(),
      tourney: String(r[tourneyKey] ?? ""),
      surface: tidySurface(String(r[surfaceKey] ?? "")),
      winner_id: w,
      loser_id: l,
    });
  }

  console.log("Parsed matches with winners/losers mapped:", out.length);
  return out;
}, [matchesCsvText, players]);


  // Compute ELO & surface stats
  const { eloSeries, surfaceStats } = useMemo(() => {
    const result = {
      eloSeries: [] as { date: string; year: number; elo: number }[],
      surfaceStats: { Hard: { w: 0, t: 0 }, Clay: { w: 0, t: 0 }, Grass: { w: 0, t: 0 }, Other: { w: 0, t: 0 } }
    };
    if (!selectedPlayerName || matches.length === 0) return result;

    const pid = nameToId.get(selectedPlayerName.toLowerCase());
    if (!pid) return result;

    const elo = new Map<string, number>();
    const base = 1500;
    const series: { date: string; year: number; elo: number }[] = [];

    for (const m of matches) {
      const Ra = elo.get(m.winner_id) ?? base;
      const Rb = elo.get(m.loser_id) ?? base;
      const [newW, newL] = updateElo(Ra, Rb, 1, kFactor);
      elo.set(m.winner_id, newW);
      elo.set(m.loser_id, newL);

      if (m.winner_id === pid || m.loser_id === pid) {
        const post = elo.get(pid) ?? base;
        series.push({ date: m.date, year: new Date(m.date).getFullYear(), elo: post });

        const sKey = tidySurface(m.surface);
        const isWin = m.winner_id === pid;
        result.surfaceStats[sKey].t += 1;
        if (isWin) result.surfaceStats[sKey].w += 1;
      }
    }

    result.eloSeries = series;
    return result;
  }, [matches, nameToId, selectedPlayerName, kFactor]);

  const surfaceWinData = useMemo(() =>
    (Object.keys(surfaceStats) as Array<keyof typeof surfaceStats>).map(s => {
      const { w, t } = surfaceStats[s];
      return { surface: s as string, winPct: t ? Math.round((w / t) * 1000) / 10 : 0, wins: w, total: t };
    }), [surfaceStats]);

  /* =======================
     UI
  ======================= */
  return (
    <div style={{ minHeight: "100vh", background: "#0b0b0b", color: "#f1f1f1", padding: 24 }}>
      <div style={{ maxWidth: "min(1600px, 95vw)", margin: "0 auto" }}>
        <h1 style={{ fontSize: 32, fontWeight: 800, marginBottom: 8 }}>Tennis ELO Demo</h1>
        <p style={{ opacity: 0.8, marginBottom: 16 }}>
          Data auto-loads from <code>/public/players.csv</code> and <code>/public/matches.csv</code>.
        </p>

        {/* Debug info */}
        <div style={{fontSize:12, opacity:0.7, margin:"6px 0 12px"}}>
          Parsed players: {players.length} · Parsed matches: {matches.length}
          {selectedPlayerName && (() => {
            const pid = nameToId.get(selectedPlayerName.toLowerCase());
            const played = pid ? matches.filter(m => m.winner_id === pid || m.loser_id === pid).length : 0;
            return <> · {selectedPlayerName} matches found: {played}</>;
          })()}
        </div>

        {loading === "loading" && <div>Loading CSVs…</div>}
        {loading === "error" && <div style={{ color: "#ff7b7b" }}>Error: {errorMsg}</div>}

        {/* Controls */}
        <div style={{ marginBottom: 16 }}>
          <label>Select player: </label>
          <input
            list="players-list"
            value={selectedPlayerName}
            onChange={(e) => setSelectedPlayerName(e.target.value)}
            placeholder="Type a name"
          />
          <datalist id="players-list">
            {playerNames.map(n => <option key={n} value={n} />)}
          </datalist>
        </div>

        {/* Charts */}
        <div style={{ display: "grid", gap: 24, gridTemplateColumns: "3fr 2fr" }}>
          <div style={{ background: "#161616", padding: 16, borderRadius: 12 }}>
            <h3>ELO over time</h3>
            <div style={{ height: 350 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={eloSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                  <XAxis dataKey="date" tickFormatter={(d) => new Date(d).getFullYear().toString()} />
                  <YAxis domain={[1200, "dataMax + 50"]} />
                  <Tooltip labelFormatter={(d) => new Date(d as string).toDateString()} />
                  <Line type="monotone" dataKey="elo" dot={false} stroke="#82ca9d" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{ background: "#161616", padding: 16, borderRadius: 12 }}>
            <h3>Surface Win %</h3>
            <div style={{ height: 350 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={surfaceWinData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                  <XAxis dataKey="surface" />
                  <YAxis domain={[0, 100]} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="winPct" fill="#8884d8" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
