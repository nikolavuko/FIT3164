import fs from 'fs/promises';
import path from 'path';
import { load as cheerioLoad } from 'cheerio';

const ROOT = path.resolve('.');
const htmlPath = path.join(ROOT, 'public', 'usopen2025_men.html');
const matchesCsvPath = path.join(ROOT, 'public', 'matches.csv');
const playersCsvPath = path.join(ROOT, 'public', 'players.csv');
const countryCodesPath = path.join(ROOT, 'public', 'CountryCodes.json');

function deburr(s) {
  try {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (_) {
    return s;
  }
}

function normName(s) {
  return deburr(String(s || '')).replace(/\s*\((?:tennis|born\s*\d{4}|.*)\)\s*$/i, '').replace(/\s+/g, ' ').trim();
}

async function loadPlayers() {
  const text = await fs.readFile(playersCsvPath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines.shift();
  const cols = header.split(',');
  const players = [];
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const player_id = parts[0];
    const name = parts[1];
    const name_norm = parts[2];
    const ioc = parts[3] || '';
    const first_seen_date = parts[4] || '';
    const last_seen_date = parts[5] || '';
    const match_count = parts[6] || '';
    players.push({ player_id, name, name_norm, ioc, first_seen_date, last_seen_date, match_count });
  }
  const byName = new Map();
  const byId = new Map();
  for (const p of players) {
    byName.set(normName(p.name).toLowerCase(), p);
    byId.set(p.player_id, p);
  }
  return { players, byName, byId, header };
}

async function loadCountryCodes() {
  try {
    const raw = await fs.readFile(countryCodesPath, 'utf8');
    const json = JSON.parse(raw);
    const nameToIoc = new Map(); // map full country name (upper) -> IOC
    for (const [ioc, country] of Object.entries(json)) {
      nameToIoc.set(String(country).toUpperCase(), ioc);
    }
    return { nameToIoc };
  } catch (e) {
    return { nameToIoc: new Map() };
  }
}

function textWithTiebreak($, td) {
  if (!td) return '';
  const node = $(td);
  let t = node.text().replace(/\s+/g, ' ').trim();
  // normalize tiebreaks like 7<sup>10</sup> appearing as '7 10' into '7(10)'
  const sup = node.find('sup').first().text().trim();
  if (sup && /^\d+$/.test(sup)) {
    // If main text already contains the sup as separate token, compress
    const base = t.replace(new RegExp('\\s*' + sup + '$'), '').trim();
    if (/^\d+$/.test(base)) {
      t = base + '(' + sup + ')';
    }
  }
  return t;
}

function expandRowCells($, tr) {
  const cells = [];
  let col = 0;
  $(tr)
    .children('td,th')
    .each((_, td) => {
      const span = parseInt($(td).attr('colspan') || '1', 10) || 1;
      for (let k = 0; k < span; k++) {
        cells[col++] = td;
      }
    });
  return cells;
}

// Expand a row into columns, honoring both colspan and rowspan by using a shared carry map.
function expandRowCellsWithRowspan($, tr, carry) {
  const cells = [];
  let col = 0;
  const tds = $(tr).children('td,th').toArray();
  let idx = 0;
  const hasCarryAt = (c) => Object.prototype.hasOwnProperty.call(carry, c);

  // Fill columns until we've consumed all tds and carry for current columns
  while (idx < tds.length || hasCarryAt(col)) {
    if (hasCarryAt(col)) {
      const info = carry[col];
      cells[col] = info.td;
      info.remain -= 1;
      if (info.remain <= 0) delete carry[col];
      col += 1;
      continue;
    }

    if (idx >= tds.length) {
      // No more tds; break to avoid infinite loop
      break;
    }

    const td = tds[idx++];
    const colspan = parseInt($(td).attr('colspan') || '1', 10) || 1;
    const rowspan = parseInt($(td).attr('rowspan') || '1', 10) || 1;
    for (let k = 0; k < colspan; k++) {
      cells[col] = td;
      if (rowspan > 1) {
        carry[col] = { td, remain: rowspan - 1 };
      }
      col += 1;
    }
  }
  return cells;
}

function findHeaderGroups($, table) {
  const groupCandidates = [
    'First round', 'Second round', 'Third round', 'Fourth round',
    'Quarterfinals', 'Quarterfinal',
    'Semifinals', 'Semifinal',
    'Finals', 'Final'
  ];
  const groups = [];
  const trs = $(table).find('tr').toArray();
  for (const tr of trs) {
    const t = $(tr).text().replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const cells = expandRowCells($, tr);
    // Look for a header row that contains any of the group labels
    const labels = cells.map(td => $(td).text().replace(/\s+/g, ' ').trim());
    const hasAny = labels.some(x => groupCandidates.some(gc => x.toLowerCase().includes(gc.toLowerCase())));
    if (!hasAny) continue;
    // Build groups with their start/end columns based on labels order and spans
    let col = 0;
    for (let i = 0; i < cells.length; i++) {
      const td = cells[i];
      const label = $(td).text().replace(/\s+/g, ' ').trim();
      const span = 1; // expanded already
      const found = groupCandidates.find(gc => label.toLowerCase().includes(gc.toLowerCase()));
      if (found) {
        let from = i;
        // extend to the right while contiguous cells belong to same label
        let j = i + 1;
        while (j < cells.length) {
          const nxt = $(cells[j]).text().replace(/\s+/g, ' ').trim();
          if (nxt.toLowerCase().includes(found.toLowerCase())) j++;
          else break;
        }
        groups.push({ label: found, from: i, to: j - 1 });
        i = j - 1;
      }
    }
    if (groups.length) break;
  }
  return groups;
}

// Advanced parser: expands all rows honoring rowspan and pairs opponent cells by vertical step
function parseBracketTableAdvanced($, table, tourney) {
  const groups = findHeaderGroups($, table);
  const out = [];
  const trs = $(table).find('tr').toArray();
  const carry = {};
  const expanded = trs.map(tr => expandRowCellsWithRowspan($, tr, carry));

  const seenTop = new Set();
  const labels = groups.map(g => g.label.toLowerCase());
  const isFinalsTable = labels.some(l => l.includes('quarterfinal') || l.includes('semifinal') || l.includes('final'));
  for (let r = 0; r < expanded.length; r++) {
    const cells = expanded[r] || [];
    for (let c = 0; c < cells.length; c++) {
      const td1 = cells[c];
      if (!td1) continue;
      const label = labelForCol(groups, c);
      const round = roundCode(label);
      if (!round) continue;
      // Avoid duplicates by restricting which rounds are allowed from this table type:
      // - Finals table contributes only QF/SF/F
      // - Section tables contribute only R128/R64/R32/R16
      const isEarlyRound = round === 'R128' || round === 'R64' || round === 'R32' || round === 'R16';
      const isLateRound = round === 'QF' || round === 'SF' || round === 'F';
      if (!isFinalsTable && !isEarlyRound) continue;
      if (isFinalsTable && !isLateRound) continue;

      // Only consider the top of a rowspan block to avoid double counting
      if (r > 0) {
        const prevRow = expanded[r - 1] || [];
        if (prevRow[c] === td1) continue;
      }
      const a1Count = $(td1).find('a[title]').not('.flagicon a').length || $(td1).find('a[title]').length;
      if (!a1Count) continue;
      const name1 = parseNameFromCell($, td1);
      if (!name1) continue;

      // Find opponent row by scanning downward for a compatible player cell with a valid combined score row
      let r2 = -1;
      const maxScan = Math.min(expanded.length - r - 1, 64);
      for (let d = 1; d <= maxScan; d++) {
        const cand = (expanded[r + d] || [])[c];
        if (!cand || cand === td1) continue;
        const a2 = $(cand).find('a[title]').not('.flagicon a').length || $(cand).find('a[title]').length;
        if (!a2) continue;
        const nm2 = parseNameFromCell($, cand);
        if (!nm2) continue;
        const testScore = collectScore($, expanded[r], expanded[r + d], c);
        if (isProbablyValidScore(testScore)) { r2 = r + d; break; }
      }
      if (r2 === -1) continue;
      const td2 = (expanded[r2] || [])[c];
      const name2 = parseNameFromCell($, td2);
      // Allow opponent cell regardless of its own rowspan top; relying on td1 top-of-span to prevent duplicates

      const key = `${r}:${c}`;
      if (seenTop.has(key)) continue;
      seenTop.add(key);

      const bold1 = isBold($, td1);
      const bold2 = isBold($, td2);
      const score = collectScore($, expanded[r], expanded[r2], c);
      const winnerName = bold1 && !bold2 ? name1 : (!bold1 && bold2 ? name2 : name1);
      const loserName = winnerName === name1 ? name2 : name1;

      out.push({
        tourney_id: tourney.tourney_id,
        tourney_name: tourney.tourney_name,
        surface: tourney.surface,
        tourney_date: tourney.tourney_date,
        draw_size: tourney.draw_size,
        tourney_level: tourney.tourney_level,
        best_of: 5,
        round,
        score,
        winnerName,
        loserName,
        col: c,
      });
    }
  }
  console.log(`[table/adv] parsed ${out.length} matches`);
  return out;
}

function roundCode(label) {
  const L = label.toLowerCase();
  if (L.includes('first')) return 'R128';
  if (L.includes('second')) return 'R64';
  if (L.includes('third')) return 'R32';
  if (L.includes('fourth')) return 'R16';
  if (L.includes('quarter')) return 'QF';
  if (L.includes('semi')) return 'SF';
  if (L.includes('final')) return 'F';
  return '';
}

function labelForCol(groups, col) {
  for (const g of groups) {
    if (col >= g.from && col <= g.to) return g.label;
  }
  return '';
}

function parseNameFromCell($, td) {
  // Prefer anchor not inside .flagicon; otherwise fall back to the last anchor with a title
  let anchors = $(td).find('a[title]').toArray();
  let filtered = anchors.filter(a => $(a).closest('.flagicon').length === 0);
  let el = null;
  if (filtered.length) {
    el = filtered[filtered.length - 1]; // often the last is the player link
  } else if (anchors.length) {
    el = anchors[anchors.length - 1];
  }
  let title = el ? ($(el).attr('title') || $(el).text() || '') : '';
  title = title.replace(/\s*\((?:tennis|born\s*\d{4}|.*)\)\s*$/i, '');
  return normName(title);
}

function isBold($, td) {
  return $(td).find('b').length > 0;
}

function collectScore($, cells1, cells2, startCol) {
  const sets = [];
  for (let k = 1; k <= 5; k++) {
    const td1 = cells1[startCol + k];
    const td2 = cells2[startCol + k];
    if (!td1 || !td2) break;
    const s1 = textWithTiebreak($, td1);
    const s2 = textWithTiebreak($, td2);
    if ((!s1 && !s2) || (s1 === '' && s2 === '')) break;
    if (/^[-–]$/.test(s1) || /^[-–]$/.test(s2)) break;
    // both empty? stop
    const hasDigit = /\d/.test(s1) || /\d/.test(s2);
    if (!hasDigit) break;
    // normalize like '6(10)' to '6-? (10)' => but we need pair s1-s2
    sets.push(`${s1 || ''}-${s2 || ''}`.replace(/\s+/g, ' ').trim());
  }
  return sets.join(' ').trim();
}

function isValidSetToken(tok) {
  if (!tok || !tok.includes('-')) return false;
  const m = tok.match(/^(\d+)(?:\((\d+)\))?-(\d+)(?:\((\d+)\))?$/);
  if (!m) return false;
  const a = parseInt(m[1], 10), b = parseInt(m[3], 10);
  if (isNaN(a) || isNaN(b)) return false;
  if (a === b) return false;
  // Tennis best-of-5 set validity:
  // - Higher games must be 6 or 7
  // - If 6, the opponent must have 0..4
  // - If 7, the opponent must have 5 or 6 (tiebreak typical for 7-6)
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi < 6 || hi > 7) return false;
  if (hi === 6) {
    return lo >= 0 && lo <= 4;
  }
  // hi === 7
  return lo === 5 || lo === 6;
}

function isProbablyValidScore(score) {
  if (!score) return false;
  const toks = score.split(/\s+/).filter(Boolean);
  if (toks.length < 3 || toks.length > 5) return false;
  return toks.every(isValidSetToken);
}

function parseBracketTable($, table, tourney) {
  const groups = findHeaderGroups($, table);
  const out = [];
  const aCount = $(table).find('a[title]').length;
  console.log(`[table] anchor nodes: ${aCount}`);
  const trs = $(table).find('tr').toArray();
  const carry = {};
  for (let r = 0; r < trs.length - 1; r++) {
    const row1 = trs[r];
    const cells1 = expandRowCellsWithRowspan($, row1, carry);
    const row2 = trs[r + 1];
    const cells2 = expandRowCellsWithRowspan($, row2, carry);
    const maxC = Math.max(cells1.length, cells2.length);
    const row1Anchors = cells1.filter(td => $(td).find('a[title]').length > 0).length;
    const row2Anchors = cells2.filter(td => $(td).find('a[title]').length > 0).length;
    if (row1Anchors && row2Anchors) {
      // Lightweight trace for development
      // console.log('Row pair with anchors:', row1Anchors, row2Anchors);
    }

    const rowCandidates = [];
    for (let c = 0; c < maxC; c++) {
      const td1 = cells1[c];
      const td2 = cells2[c];
      if (!td1 || !td2) continue;

      const a1Count = $(td1).find('a[title]').not('.flagicon a').length || $(td1).find('a[title]').length;
      const a2Count = $(td2).find('a[title]').not('.flagicon a').length || $(td2).find('a[title]').length;
      if (!a1Count || !a2Count) continue;

      const name1 = parseNameFromCell($, td1);
      const name2 = parseNameFromCell($, td2);
      if (!name1 || !name2) continue;

      const bold1 = isBold($, td1);
      const bold2 = isBold($, td2);
      const score = collectScore($, cells1, cells2, c);
      const label = labelForCol(groups, c);
      const round = roundCode(label);
      if (!round) continue;

      const winnerName = bold1 && !bold2 ? name1 : (!bold1 && bold2 ? name2 : name1);
      const loserName = winnerName === name1 ? name2 : name1;
      rowCandidates.push({ col: c, round, score, winnerName, loserName });
    }

    if (rowCandidates.length) {
      const bestByPair = new Map();
      for (const m of rowCandidates) {
        const key = [m.winnerName.toLowerCase(), m.loserName.toLowerCase()].sort().join('|');
        const prev = bestByPair.get(key);
        if (!prev || m.col < prev.col) bestByPair.set(key, m);
      }
      for (const m of bestByPair.values()) {
        out.push({
          tourney_id: tourney.tourney_id,
          tourney_name: tourney.tourney_name,
          surface: tourney.surface,
          tourney_date: tourney.tourney_date,
          draw_size: tourney.draw_size,
          tourney_level: tourney.tourney_level,
          best_of: 5,
          round: m.round,
          score: m.score,
          winnerName: m.winnerName,
          loserName: m.loserName,
          col: m.col,
        });
      }
    }
  }
  console.log(`[table] parsed ${out.length} matches`);
  return out;
}

async function main() {
  const html = await fs.readFile(htmlPath, 'utf8');
  const $ = cheerioLoad(html);

  const { players, byName, byId, header } = await loadPlayers();
  const { nameToIoc } = await loadCountryCodes();

  const tourney = {
    tourney_id: '2025-560',
    tourney_name: 'US Open',
    surface: 'Hard',
    tourney_date: '2025-08-25',
    draw_size: 128,
    tourney_level: 'G',
  };

  console.log(`[main] Section_1 headings: ${$('h4#Section_1').length}`);
  const sections = [];
  for (let i = 1; i <= 8; i++) {
    const h = $(`h4#Section_${i}`);
    if (h.length) {
      const tbl = h.parent().nextAll('table').first();
      if (tbl && tbl.length) sections.push(tbl);
    }
  }
  // Finals table: look for an h3/h4 labeled Finals, then its table
  const finalsHead = $('h3#Finals, h4#Finals').first();
  if (finalsHead && finalsHead.length) {
    const tbl = finalsHead.parent().nextAll('table').first();
    if (tbl && tbl.length) sections.push(tbl);
  }

  let parsed = [];
  for (const tbl of sections) {
    parsed = parsed.concat(parseBracketTableAdvanced($, tbl, tourney));
  }
  console.log(`[all] total parsed before dedupe: ${parsed.length}`);

  // Filter self-matches and dedupe by unordered pair; prefer deepest round (Final > SF > ... > R128)
  const roundOrder = new Map([
    ['R128', 1], ['R64', 2], ['R32', 3], ['R16', 4], ['QF', 5], ['SF', 6], ['F', 7]
  ]);
  const best = new Map();
  for (const m of parsed) {
    if (!m.winnerName || !m.loserName) continue;
    if (m.winnerName.toLowerCase() === m.loserName.toLowerCase()) continue;
    const pairKey = [m.winnerName.toLowerCase(), m.loserName.toLowerCase()].sort().join('|');
    const prev = best.get(pairKey);
    const ord = roundOrder.get(m.round || '') || 0;
    const prevOrd = prev ? (roundOrder.get(prev.round || '') || 0) : -1;
    if (!prev || ord > prevOrd) {
      best.set(pairKey, m);
    }
  }
  let matches = Array.from(best.values());

  // Drop matches with implausible scores
  matches = matches.filter(m => isProbablyValidScore(m.score));

  // Enforce bracket consistency top-down: QF must be between R16 winners; SF between QF winners; F between SF winners
  function namesKey(s) { return normName(s).toLowerCase(); }
  function winnersOf(roundCode) {
    const s = new Set();
    for (const m of matches) if (m.round === roundCode) s.add(namesKey(m.winnerName));
    return s;
  }
  // R16 winners
  const r16W = winnersOf('R16');
  // Filter QF
  matches = matches.filter(m => {
    if (m.round !== 'QF') return true;
    const a = namesKey(m.winnerName), b = namesKey(m.loserName);
    return r16W.has(a) && r16W.has(b);
  });
  // QF winners
  const qfW = winnersOf('QF');
  // If still more than 4 QFs, greedily enforce uniqueness per player
  const qfAll = matches.filter(m => m.round === 'QF');
  if (qfAll.length > 4) {
    const used = new Set();
    const chosen = [];
    for (const m of qfAll) {
      const a = namesKey(m.winnerName), b = namesKey(m.loserName);
      if (used.has(a) || used.has(b)) continue;
      chosen.push(m);
      used.add(a); used.add(b);
      if (chosen.length === 4) break;
    }
    const nonQF = matches.filter(m => m.round !== 'QF');
    matches = nonQF.concat(chosen);
  }
  // Filter SF
  matches = matches.filter(m => {
    if (m.round !== 'SF') return true;
    const a = namesKey(m.winnerName), b = namesKey(m.loserName);
    return qfW.has(a) && qfW.has(b);
  });
  // SF winners
  const sfW = winnersOf('SF');
  // Filter F
  matches = matches.filter(m => {
    if (m.round !== 'F') return true;
    const a = namesKey(m.winnerName), b = namesKey(m.loserName);
    return sfW.has(a) && sfW.has(b);
  });

  // Enforce per-round uniqueness and caps for early rounds
  const roundCaps = new Map([
    ['R128', 64], ['R64', 32], ['R32', 16], ['R16', 8], ['QF', 4], ['SF', 2]
  ]);
  const rounds = ['R128','R64','R32','R16','QF','SF'];
  const byRound = new Map();
  for (const r of rounds) byRound.set(r, []);
  const rest = [];
  for (const m of matches) {
    if (byRound.has(m.round)) byRound.get(m.round).push(m); else rest.push(m);
  }
  const rebuilt = [];
  for (const r of rounds) {
    const cap = roundCaps.get(r) || Infinity;
    const list = byRound.get(r) || [];
    if (list.length <= cap) { rebuilt.push(...list); continue; }
    const used = new Set();
    const kept = [];
    for (const m of list) {
      const a = namesKey(m.winnerName), b = namesKey(m.loserName);
      if (used.has(a) || used.has(b)) continue;
      kept.push(m);
      used.add(a); used.add(b);
      if (kept.length === cap) break;
    }
    rebuilt.push(...kept);
  }
  // Append any non-round-tagged entries (shouldn't exist)
  rebuilt.push(...rest);
  matches = rebuilt;

  // Do not synthesize Final from infobox; rely only on Finals bracket to avoid false positives

  // map names to players; create new placeholder players if missing
  function ensurePlayer(name) {
    const k = normName(name).toLowerCase();
    let p = byName.get(k);
    if (p) return p;
    // create new player ID in a high range to avoid collisions
    const base = 99000000;
    let maxId = base;
    for (const ex of players) {
      const n = parseInt(ex.player_id, 10);
      if (!isNaN(n)) maxId = Math.max(maxId, n);
    }
    const newId = String(maxId + 1);
    // Try to infer IOC from flag in HTML by searching the first occurrence
    let ioc = '';
    // fallback empty; we'll compute later if needed
    const name_norm = k;
    const pNew = { player_id: newId, name: normName(name), name_norm, ioc, first_seen_date: tourney.tourney_date, last_seen_date: tourney.tourney_date, match_count: '0' };
    players.push(pNew);
    byName.set(k, pNew);
    byId.set(newId, pNew);
    return pNew;
  }

  const newLines = [];
  let matchNum = 1;

  const isDraft = process.argv.includes('--draft') || process.env.DRAFT_ONLY === '1';
  // Load header from existing matches.csv for consistent columns
  const existingText = await fs.readFile(matchesCsvPath, 'utf8');
  const existingLines = existingText.split(/\r?\n/).filter(Boolean);
  const existingHeader = existingLines.shift();
  const keepExisting = isDraft ? [] : existingLines.filter(s => !s.startsWith(`${tourney.tourney_id},`));
  const existingSet = new Set(keepExisting.map(s => s.toLowerCase()));

  function makeCsvLine(m, winner, loser) {
    const score = m.score || '';
    const round = m.round || '';
    const cols = [];
    cols[0] = tourney.tourney_id;
    cols[1] = tourney.tourney_name;
    cols[2] = tourney.surface;
    cols[3] = tourney.tourney_date;
    cols[4] = String(tourney.draw_size);
    cols[5] = tourney.tourney_level;
    cols[6] = String(matchNum);
    cols[7] = '5';
    cols[8] = round;
    cols[9] = '';
    cols[10] = score;
    cols[11] = '';
    cols[12] = winner.name || '';
    cols[13] = (winner.name || '').toLowerCase();
    cols[14] = '';
    cols[15] = winner.ioc || '';
    cols[16] = '';
    cols[17] = '';
    cols[18] = '';
    cols[19] = '';
    cols[20] = '';
    cols[21] = loser.name || '';
    cols[22] = (loser.name || '').toLowerCase();
    cols[23] = '';
    cols[24] = loser.ioc || '';
    cols[25] = '';
    cols[26] = '';
    cols[27] = '';
    cols[28] = '';
    cols[29] = '2025';
    cols[30] = `${tourney.tourney_id}_${round}_${winner.name}_vs_${loser.name}`;
    cols[31] = winner.player_id;
    cols[32] = loser.player_id;
    return cols.join(',');
  }

  for (const m of matches) {
    const w = ensurePlayer(m.winnerName);
    const l = ensurePlayer(m.loserName);
    // update last seen
    w.last_seen_date = tourney.tourney_date;
    l.last_seen_date = tourney.tourney_date;
    const line = makeCsvLine(m, w, l);
    if (!existingSet.has(line.toLowerCase())) {
      newLines.push(line);
      matchNum += 1;
    }
  }

  if (isDraft) {
    const outPath = process.env.OUTPUT_FILE || path.join(ROOT, 'public', 'matches_2025_usopen_draft.csv');
    const outputMatches = [existingHeader, ...newLines].join('\n') + '\n';
    await fs.writeFile(outPath, outputMatches, 'utf8');
    console.log(`Wrote draft file with ${newLines.length} US Open 2025 matches -> ${outPath}`);
  } else {
    // Write back matches.csv with 2025-560 replaced by parsed set
    const outputMatches = [existingHeader, ...keepExisting, ...newLines].join('\n') + '\n';
    await fs.writeFile(matchesCsvPath, outputMatches, 'utf8');
    console.log(`Wrote ${newLines.length} US Open 2025 matches (replaced existing 2025-560 entries).`);
  }

  if (!isDraft) {
    // Recompute match_count per player from matches.csv (winners/losers by player_id)
    const updatedCsv = await fs.readFile(matchesCsvPath, 'utf8');
    const mlines = updatedCsv.split(/\r?\n/).filter(Boolean);
    mlines.shift();
    const counts = new Map();
    for (const ln of mlines) {
      const parts = ln.split(',');
      const winner_pid = parts[parts.length - 2];
      const loser_pid = parts[parts.length - 1];
      counts.set(winner_pid, (counts.get(winner_pid) || 0) + 1);
      counts.set(loser_pid, (counts.get(loser_pid) || 0) + 1);
    }
    for (const p of players) {
      if (counts.has(p.player_id)) p.match_count = String(counts.get(p.player_id));
    }

    // Write back players.csv
    const outPlayers = [];
    outPlayers.push('player_id,name,name_norm,ioc,first_seen_date,last_seen_date,match_count');
    for (const p of players) {
      const row = [p.player_id, p.name, p.name_norm, p.ioc || '', p.first_seen_date || '', p.last_seen_date || '', p.match_count || ''];
      outPlayers.push(row.join(','));
    }
    await fs.writeFile(playersCsvPath, outPlayers.join('\n') + '\n', 'utf8');
    console.log(`Updated players.csv with ${players.length} players (recomputed match_count).`);
  } else {
    console.log('Draft mode: players.csv left unchanged.');
  }
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
