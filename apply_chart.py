from pathlib import Path

path = Path('src/App.tsx')
text = path.read_text(encoding='utf-8')

rankings_block = "const rankingsByYear = useMemo(() => {\n  if (matches.length === 0) return [];\n  return computeEloRankings(matches, kFactor);\n}, [matches, kFactor, idToName, idToCountry]);"
if rankings_block not in text:
    raise SystemExit('rankingsByYear block not found')

if "const topYearlyElo" not in text:
    addition = "\n\nconst topYearlyElo = useMemo(() => {\n  if (rankingsByYear.length === 0) return [];\n  const bestByYear = new Map<number, typeof rankingsByYear[number]>();\n  for (const entry of rankingsByYear) {\n    const current = bestByYear.get(entry.year);\n    if (!current || entry.elo > current.elo) {\n      bestByYear.set(entry.year, entry);\n    }\n  }\n  return Array.from(bestByYear.values()).sort((a, b) => a.year - b.year);\n}, [rankingsByYear]);"
    text = text.replace(rankings_block, rankings_block + addition)

anchor = "        </div>\n\n        {/* Last 5 match results */}"
if anchor not in text:
    raise SystemExit('UI anchor not found')

chart_block = "        </div>\n\n        {topYearlyElo.length > 0 && (\n          <div style={{ marginTop: 24, background: \"transparent\", padding: 16, borderRadius: 12 }}>)"
