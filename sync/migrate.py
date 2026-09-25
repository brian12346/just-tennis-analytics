"""Apply db/migrations/*.sql in order, once each (tracked in jt.schema_migrations).

    python -m sync.migrate
"""
from __future__ import annotations

import hashlib

from .common import ROOT, connect, load_env


def main() -> None:
    load_env()
    files = sorted((ROOT / "db" / "migrations").glob("*.sql"))
    with connect() as conn, conn.cursor() as cur:
        cur.execute("create schema if not exists jt")
        cur.execute("""create table if not exists jt.schema_migrations (
                         name text primary key, sha256 text not null, applied_at timestamptz not null default now())""")
        cur.execute("select name, sha256 from jt.schema_migrations")
        done = dict(cur.fetchall())
        for f in files:
            sql = f.read_text()
            sha = hashlib.sha256(sql.encode()).hexdigest()
            if f.name in done:
                if done[f.name] != sha:
                    print(f"warning: {f.name} changed after it was applied; add a new migration instead of editing it")
                continue
            cur.execute(sql)
            cur.execute("insert into jt.schema_migrations (name, sha256) values (%s, %s)", (f.name, sha))
            print(f"applied {f.name}")
        conn.commit()
    print("database is up to date")


if __name__ == "__main__":
    main()
