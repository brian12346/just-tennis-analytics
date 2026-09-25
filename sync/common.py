"""Shared helpers: settings, database connection, bulk upserts and sync-run logging."""
from __future__ import annotations

import contextlib
import datetime as dt
import os
import pathlib
import sys
import traceback
from zoneinfo import ZoneInfo

import psycopg

STORE_TZ = ZoneInfo("America/Los_Angeles")
ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_env(path: pathlib.Path | None = None) -> None:
    """Read KEY=VALUE lines from .env into os.environ (without overriding real env vars)."""
    p = path or ROOT / ".env"
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def env(name: str, required: bool = True) -> str:
    v = os.environ.get(name, "").strip()
    if required and not v:
        sys.exit(f"Missing setting {name}. Add it to .env locally or as a GitHub Actions secret.")
    return v


def connect() -> psycopg.Connection:
    return psycopg.connect(env("DATABASE_URL"), autocommit=False, prepare_threshold=None)


def store_today() -> dt.date:
    return dt.datetime.now(STORE_TZ).date()


def store_day(ts: str | dt.datetime) -> dt.date:
    if isinstance(ts, str):
        ts = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return ts.astimezone(STORE_TZ).date()


def gid_num(gid) -> int | None:
    if gid in (None, ""):
        return None
    return int(str(gid).rsplit("/", 1)[-1])


def money(x) -> float:
    try:
        return round(float(str(x).replace(",", "")), 2)
    except (TypeError, ValueError):
        return 0.0


# ---------------------------------------------------------------- bulk writes
def _copy_to_temp(cur: psycopg.Cursor, table: str, cols: list[str], rows: list[tuple]) -> str:
    tmp = "tmp_" + table.replace(".", "_")
    cur.execute(f"create temp table if not exists {tmp} (like {table} including defaults) on commit drop")
    cur.execute(f"truncate {tmp}")
    with cur.copy(f"copy {tmp} ({', '.join(cols)}) from stdin") as cp:
        for r in rows:
            cp.write_row(r)
    return tmp


def upsert(conn: psycopg.Connection, table: str, cols: list[str], rows: list[tuple],
           key: list[str], update: list[str] | None = None) -> int:
    """Insert rows, updating existing ones on key conflict. Returns rows written."""
    if not rows:
        return 0
    update = [c for c in (update if update is not None else cols) if c not in key]
    with conn.cursor() as cur:
        tmp = _copy_to_temp(cur, table, cols, rows)
        sets = ", ".join(f"{c} = excluded.{c}" for c in update) or f"{key[0]} = excluded.{key[0]}"
        cur.execute(
            f"insert into {table} ({', '.join(cols)}) select distinct on ({', '.join(key)}) {', '.join(cols)} from {tmp} "
            f"on conflict ({', '.join(key)}) do update set {sets}"
        )
        return cur.rowcount


def replace_where(conn: psycopg.Connection, table: str, where: str, params: tuple,
                  cols: list[str], rows: list[tuple]) -> int:
    """Delete rows matching `where`, then load `rows` (idempotent re-sync of a window)."""
    with conn.cursor() as cur:
        cur.execute(f"delete from {table} where {where}", params)
        if not rows:
            return 0
        tmp = _copy_to_temp(cur, table, cols, rows)
        cur.execute(f"insert into {table} ({', '.join(cols)}) select {', '.join(cols)} from {tmp}")
        return cur.rowcount


# ---------------------------------------------------------------- run logging
@contextlib.contextmanager
def sync_run(conn: psycopg.Connection, job: str):
    """Record a job in jt.sync_runs. The body sets run['rows'] / run['detail']."""
    with conn.cursor() as cur:
        cur.execute("insert into jt.sync_runs (job) values (%s) returning id", (job,))
        run_id = cur.fetchone()[0]
    conn.commit()
    run = {"rows": 0, "detail": ""}
    try:
        yield run
        conn.commit()
        ok = True
    except BaseException as e:  # noqa: BLE001 - log every failure, then re-raise
        conn.rollback()
        ok = False
        run["detail"] = (run.get("detail") or "") + "".join(traceback.format_exception_only(type(e), e))[-2000:]
        raise
    finally:
        with conn.cursor() as cur:
            cur.execute("update jt.sync_runs set finished_at = now(), ok = %s, rows = %s, detail = %s where id = %s",
                        (ok, run.get("rows"), str(run.get("detail") or "")[:4000], run_id))
        conn.commit()
        print(f"[{job}] {'ok' if ok else 'FAILED'} rows={run.get('rows')} {run.get('detail') or ''}".strip())
