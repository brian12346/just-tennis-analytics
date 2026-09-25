"""Build the single-file dashboard page from dashboard/src.

  python dashboard/build.py            -> dashboard/dist/just-tennis-sales.html

index.html holds the page shell; each <!-- @inline path --> marker is replaced with that file's
contents (the Claude artifact host needs one self-contained file).
"""
from __future__ import annotations

import pathlib
import re
import sys

SRC = pathlib.Path(__file__).resolve().parent / "src"
DIST = pathlib.Path(__file__).resolve().parent / "dist"
MARK = re.compile(r"<!-- @inline ([\w./-]+) -->")


def build() -> str:
    html = (SRC / "index.html").read_text()

    def sub(m: re.Match) -> str:
        p = SRC / m.group(1)
        if not p.exists():
            sys.exit(f"missing {p}")
        return p.read_text().rstrip("\n")

    out = MARK.sub(sub, html)
    if MARK.search(out):
        sys.exit("nested @inline markers are not supported")
    return out


def main() -> None:
    DIST.mkdir(exist_ok=True)
    out = build()
    (DIST / "just-tennis-sales.html").write_text(out)
    print(f"built dashboard/dist/just-tennis-sales.html ({len(out) // 1024} KB)")


if __name__ == "__main__":
    main()
