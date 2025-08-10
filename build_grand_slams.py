
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Grand Slam ATP data prep + Elo baseline (2000–2025)

Usage (example):
    python build_grand_slams.py \
        --data-root "/path/to/local/tennis_atp" \
        --out-dir "./out" \
        --years 2000 2025 \
        --compute-elo

Assumptions:
- You cloned https://github.com/JeffSackmann/tennis_atp locally and pass that path to --data-root.
- Script reads yearly files like atp_matches_YYYY.csv.
- For 2025, if the file is missing, you can add a --extra-csv path (e.g., a hand-curated CSV).

Outputs (in --out-dir):
- grand_slams_2000_2025.parquet      (tidy matches subset, one row per match)
- players_2000_2025.parquet          (unique players with name variants and first/last seen years)
- elo_timeseries.parquet             (optional) Elo per player per match-time (after each match)
- Also CSV equivalents for convenience.

Notes:
- We keep original UTF-8 names, plus a normalized ASCII version for joins/search.
- We correct the Elo expected-score formula to: E = 1 / (1 + 10^((opp - player)/400)).
- K-factor and decay are configurable; defaults are sensible for Grand Slams only.
"""


import argparse
import os
import sys
from pathlib import Path
from typing import List, Optional, Tuple

import pandas as pd

try:
    from unidecode import unidecode
except ImportError:
    # Minimal fallback if unidecode isn't present
    def unidecode(x):  # type: ignore
        try:
            return x.encode("ascii", "ignore").decode("ascii")
        except Exception:
            return x


GS_LEVEL = {"G"}  # Sackmann uses "G" for Grand Slam
REQUIRED_COLUMNS = [
    "tourney_id","tourney_name","surface","tourney_date","draw_size","tourney_level",
    "match_num","best_of",
    "winner_id","winner_name","winner_hand","winner_ioc","winner_age","winner_rank","winner_seed","winner_ht",
    "loser_id","loser_name","loser_hand","loser_ioc","loser_age","loser_rank","loser_seed","loser_ht",
    "score","round","minutes"
]


def parse_args():
    p = argparse.ArgumentParser(description="Grand Slam ATP data prep + Elo baseline")
    p.add_argument("--data-root", required=True, help="Path to local clone of JeffSackmann/tennis_atp")
    p.add_argument("--out-dir", default="./out", help="Where to write outputs")
    p.add_argument("--years", nargs=2, type=int, default=[2000, 2025],
                   help="Inclusive start, inclusive end years, e.g. 2000 2025")
    p.add_argument("--extra-csv", nargs="*", default=[],
                   help="Optional extra CSV paths to include (e.g., manually curated 2025 Grand Slam matches)")
    p.add_argument("--compute-elo", action="store_true", help="Emit a first-pass Elo timeline")
    p.add_argument("--elo-k", type=float, default=32.0, help="Base K-factor")
    p.add_argument("--elo-k_gs_bonus", type=float, default=0.0, help="Optional extra K for later rounds")
    p.add_argument("--elo-decay-per-365d", type=float, default=0.0,
                   help="Optional passive decay per 365 idle days (in Elo points)")
    p.add_argument("--seed-elo", type=float, default=1500.0, help="Initial Elo for unseen players")
    return p.parse_args()


def year_file(data_root: Path, year: int) -> Path:
    return data_root / f"atp_matches_{year}.csv"


def load_year(data_root: Path, year: int) -> Optional[pd.DataFrame]:
    f = year_file(data_root, year)
    if not f.exists():
        return None
    try:
        df = pd.read_csv(f)
        df["__source_year"] = year
        return df
    except Exception as e:
        print(f"[WARN] Failed to read {f}: {e}", file=sys.stderr)
        return None


def normalize_name(name: str) -> str:
    if pd.isna(name):
        return name
    # Keep a simple lowercase ascii version for consistent joins/search
    return unidecode(str(name)).lower().strip().replace("  ", " ")


def load_and_filter(data_root: Path, y0: int, y1: int, extra_csv: List[str]) -> pd.DataFrame:
    frames: List[pd.DataFrame] = []
    for y in range(y0, y1 + 1):
        df = load_year(data_root, y)
        if df is not None:
            frames.append(df)

    # Append any extra CSVs (e.g., hand-curated 2025 matches if upstream missing)
    for p in extra_csv:
        try:
            e = pd.read_csv(p)
            e["__source_year"] = pd.to_datetime(e.get("tourney_date", "2000-01-01"), errors="coerce").dt.year
            frames.append(e)
        except Exception as exc:
            print(f"[WARN] Failed to read extra CSV {p}: {exc}", file=sys.stderr)

    if not frames:
        raise FileNotFoundError("No yearly files found. Check --data-root and --years.")

    df_all = pd.concat(frames, ignore_index=True)

    # Ensure required columns exist (Sackmann columns evolved slightly over time; fill if missing)
    for c in REQUIRED_COLUMNS:
        if c not in df_all.columns:
            df_all[c] = pd.NA

    # Keep only Grand Slams
    df_gs = df_all[df_all["tourney_level"].astype(str).isin(GS_LEVEL)].copy()

    # Parse date: tourney_date is yyyymmdd int (per Sackmann). Convert to datetime
    # If it's already a date-like string, coerce
    def parse_sackmann_date(x):
        try:
            s = str(int(x))
            return pd.to_datetime(s, format="%Y%m%d", errors="coerce")
        except Exception:
            return pd.to_datetime(x, errors="coerce")

    df_gs["tourney_date"] = df_gs["tourney_date"].apply(parse_sackmann_date)

    # Basic cleaning: name normalization
    df_gs["winner_name_norm"] = df_gs["winner_name"].astype(str).map(normalize_name)
    df_gs["loser_name_norm"]  = df_gs["loser_name"].astype(str).map(normalize_name)

    # Keep a compact schema
    keep = [
        "tourney_id","tourney_name","surface","tourney_date","draw_size","tourney_level",
        "match_num","best_of","round","minutes","score",
        "winner_id","winner_name","winner_name_norm","winner_hand","winner_ioc","winner_age","winner_rank","winner_seed","winner_ht",
        "loser_id","loser_name","loser_name_norm","loser_hand","loser_ioc","loser_age","loser_rank","loser_seed","loser_ht",
        "__source_year"
    ]
    df_gs = df_gs[keep].copy()

    # Add keys
    # Some years may have missing match_num; generate a stable key
    df_gs["match_key"] = (
        df_gs["tourney_id"].astype(str) + "_" +
        df_gs["round"].astype(str) + "_" +
        df_gs["winner_name"].astype(str) + "_vs_" +
        df_gs["loser_name"].astype(str)
    )

    # Sort chronologically within tournament date (best effort)
    df_gs = df_gs.sort_values(["tourney_date", "tourney_id", "match_num"], na_position="last").reset_index(drop=True)
    return df_gs


def make_players_table(df_gs: pd.DataFrame) -> pd.DataFrame:
    w = df_gs[["winner_name","winner_name_norm","winner_ioc","winner_hand","winner_ht"]].rename(
        columns={
            "winner_name":"name",
            "winner_name_norm":"name_norm",
            "winner_ioc":"ioc",
            "winner_hand":"hand",
            "winner_ht":"height_cm"
        }
    )
    l = df_gs[["loser_name","loser_name_norm","loser_ioc","loser_hand","loser_ht"]].rename(
        columns={
            "loser_name":"name",
            "loser_name_norm":"name_norm",
            "loser_ioc":"ioc",
            "loser_hand":"hand",
            "loser_ht":"height_cm"
        }
    )
    players = pd.concat([w,l], ignore_index=True).drop_duplicates().reset_index(drop=True)
    # Aggregate first/last seen
    first_seen = (
        df_gs.assign(player=df_gs["winner_name"])
            .groupby("winner_name")["tourney_date"]
            .min()
            .rename("first_seen_date")
            .to_frame()
    )
    last_seen = (
        df_gs.assign(player=df_gs["winner_name"])
            .groupby("winner_name")["tourney_date"]
            .max()
            .rename("last_seen_date")
            .to_frame()
    )
    # Merge (use outer on name; also compute for loser side)
    first_seen_l = (
        df_gs.assign(player=df_gs["loser_name"])
            .groupby("player")["tourney_date"]
            .min().rename("first_seen_date_l")
            .to_frame()
    )
    last_seen_l = (
        df_gs.assign(player=df_gs["loser_name"])
            .groupby("player")["tourney_date"]
            .max().rename("last_seen_date_l")
            .to_frame()
    )

    # Collapse into a single range per player (by original name as key)
    fs = first_seen.join(first_seen_l, how="outer")
    ls = last_seen.join(last_seen_l, how="outer")
    rng = pd.DataFrame({
        "first_seen_date": fs[["first_seen_date","first_seen_date_l"]].min(axis=1),
        "last_seen_date": ls[["last_seen_date","last_seen_date_l"]].max(axis=1),
    }).reset_index().rename(columns={"index":"name"})
    players = players.merge(rng, how="left", on="name")
    return players


# ------------- Elo -------------

import math
from collections import defaultdict


def expected_score(elo_player: float, elo_opp: float) -> float:
    # Standard Elo expectation
    return 1.0 / (1.0 + 10.0 ** ((elo_opp - elo_player) / 400.0))


def round_weight(round_str: str) -> float:
    """Optional: provide a slightly larger K as rounds progress.
       Feel free to tune these weights; here is a simple mapping.
    """
    r = str(round_str).upper()
    mapping = {
        "R128": 0.0, "R64": 2.0, "R32": 3.0, "R16": 4.0,
        "QF": 5.0, "SF": 6.0, "F": 8.0
    }
    # Use substring heuristics too
    if "F" == r: return 8.0
    if "SF" in r: return 6.0
    if "QF" in r: return 5.0
    if "16" in r: return 4.0
    if "32" in r: return 3.0
    if "64" in r: return 2.0
    return mapping.get(r, 0.0)


def compute_elo_timeseries(
    df_gs: pd.DataFrame,
    seed_elo: float = 1500.0,
    base_k: float = 32.0,
    gs_bonus_k: float = 0.0,
    decay_per_365d: float = 0.0
) -> pd.DataFrame:
    """Compute a simple Elo through time over Grand Slam matches only.
       decay_per_365d: passive decay points per year of inactivity (linear on days).
    """
    # Work on a copy sorted by date, then by tournament id
    df = df_gs.sort_values(["tourney_date", "tourney_id", "match_num"], na_position="last").reset_index(drop=True)

    elo = defaultdict(lambda: seed_elo)
    last_date = {}  # name_norm -> last activity date

    records = []
    for i, row in df.iterrows():
        d = row["tourney_date"]
        wn = row["winner_name_norm"]
        ln = row["loser_name_norm"]
        w_orig = row["winner_name"]
        l_orig = row["loser_name"]
        rd = str(row.get("round", ""))

        # Passive decay for both players before this match (if configured)
        if decay_per_365d > 0 and pd.notna(d):
            for p in (wn, ln):
                if p in last_date and pd.notna(last_date[p]):
                    idle_days = (d - last_date[p]).days
                    if idle_days and idle_days > 0:
                        # Linear decay proportional to idle days
                        elo[p] = elo[p] - (decay_per_365d * idle_days / 365.0)

        ew = elo[wn]
        el = elo[ln]

        # Expectations
        exp_w = expected_score(ew, el)
        exp_l = 1.0 - exp_w

        # Outcome: winner gets 1, loser 0
        outcome_w = 1.0
        outcome_l = 0.0

        # Optional later-round bonus to K
        k = base_k + (gs_bonus_k * round_weight(rd))

        # Updates
        ew_new = ew + k * (outcome_w - exp_w)
        el_new = el + k * (outcome_l - exp_l)

        elo[wn] = ew_new
        elo[ln] = el_new

        # Activity dates
        if pd.notna(d):
            last_date[wn] = d
            last_date[ln] = d

        records.append({
            "tourney_id": row["tourney_id"],
            "tourney_name": row["tourney_name"],
            "tourney_date": d,
            "round": row["round"],
            "surface": row["surface"],
            "winner_name": w_orig,
            "loser_name": l_orig,
            "winner_name_norm": wn,
            "loser_name_norm": ln,
            "winner_elo_pre": ew,
            "loser_elo_pre": el,
            "winner_elo_post": ew_new,
            "loser_elo_post": el_new,
            "k_used": k,
            "exp_winner": exp_w,
            "exp_loser": exp_l,
        })

    return pd.DataFrame.from_records(records)


def main():
    args = parse_args()
    data_root = Path(args.data_root).expanduser().resolve()
    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    y0, y1 = args.years
    df_gs = load_and_filter(data_root, y0, y1, args.extra_csv)

    # Write matches subset
    matches_out_parquet = out_dir / f"grand_slams_{y0}_{y1}.parquet"
    matches_out_csv = out_dir / f"grand_slams_{y0}_{y1}.csv"
    df_gs.to_parquet(matches_out_parquet, index=False)
    df_gs.to_csv(matches_out_csv, index=False)

    # Players table
    players = make_players_table(df_gs)
    players_out_parquet = out_dir / f"players_{y0}_{y1}.parquet"
    players_out_csv = out_dir / f"players_{y0}_{y1}.csv"
    players.to_parquet(players_out_parquet, index=False)
    players.to_csv(players_out_csv, index=False)

    print(f"[OK] Wrote matches -> {matches_out_parquet}")
    print(f"[OK] Wrote players -> {players_out_parquet}")

    if args.compute_elo:
        elo_df = compute_elo_timeseries(
            df_gs,
            seed_elo=args.seed_elo,
            base_k=args.elo_k,
            gs_bonus_k=args.elo_k_gs_bonus,
            decay_per_365d=args.elo_decay_per_365d
        )
        elo_out_parquet = out_dir / "elo_timeseries.parquet"
        elo_out_csv = out_dir / "elo_timeseries.csv"
        elo_df.to_parquet(elo_out_parquet, index=False)
        elo_df.to_csv(elo_out_csv, index=False)
        print(f"[OK] Wrote Elo -> {elo_out_parquet}")


if __name__ == "__main__":
    main()
