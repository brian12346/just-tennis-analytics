#!/usr/bin/env python3
"""
Seller Sage invoice reader (from the Invoice Lab hand-off, Oct 2026). Runs inside the app: GitHub Actions workflow
invoice-read.yml starts it when a read is queued (migration 100); it reads what's queued, waits IDLE_SECONDS for more,
then stops.

Reads vendor invoice PDFs with the vendor templates in jt.invoice_templates (text PDFs and scans, with OCR),
and writes the result back for the page to pick up. One engine for every vendor; a new vendor is a new template row.

  python worker.py                      # run forever: LISTEN invoice_reads + poll every POLL_SECONDS
  python worker.py --once               # read whatever is queued, then exit
  python worker.py --idle 150           # read what's queued, keep listening until 150 s without a new read (the workflow)
  python worker.py --file a.pdf [--templates templates/]   # read one local PDF and print the result (no database)
  python worker.py --fetch READ_ID out.pdf          # save the PDF of a read (e.g. from jt.invoices_to_learn) to learn from

Environment:
  DATABASE_URL   the sync's database URL (required unless --file)
  POLL_SECONDS   default 15
  WORKER_NAME    default the host name
  OCR_CACHE      local scratch folder for OCR text (default /tmp/ocr_cache); the durable cache is jt.invoice_ocr
"""
import argparse, base64, hashlib, json, os, socket, sys, tempfile, time, traceback
from pathlib import Path

os.environ.setdefault("OCR_CACHE", "/tmp/ocr_cache")
Path(os.environ["OCR_CACHE"]).mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine  # noqa: E402  (the template engine, unchanged from the Invoice Lab)

TOL = 0.02


# ---------------------------------------------------------------- engine output -> Seller Sage shape
def _r2(x):
    return None if x is None else round(float(x), 2)


def to_seller_sage(doc, templates):
    """One engine doc -> the shape the page's invoice editor already uses (window.JTInvParse.parseInvoice output),
    plus read status, issues and extras. Lines keep invoice order; freight/fees become `charges`."""
    slug = (doc.get("vendor") or {}).get("slug")
    tpl = templates.get(slug) or {}
    h, T = doc.get("header") or {}, dict(doc.get("totals") or {})
    v = doc.get("validation") or {}
    lines, charges = [], []
    charge_from_lines = 0.0
    for l in doc.get("lines") or []:
        flags = [f for f in (l.get("flags") or []) if f]
        amt = l.get("extended_cost")
        if "charge" in flags:
            charges.append({"kind": "inbound_shipping", "label": (l.get("description") or "Freight")[:80], "amount": _r2(amt),
                            "from": "line"})
            charge_from_lines += amt or 0
            continue
        kind = "discount" if "line_discount" in flags else "item"
        lines.append({"item_code": "" if kind == "discount" else (l.get("vendor_sku") or ""),
                      "upc": l.get("upc") or "", "description": (l.get("description") or "")[:300],
                      "qty": l.get("qty"), "unit_cost": l.get("unit_cost"), "amount": _r2(amt),
                      "kind": kind, "flags": flags,
                      **({"size": l["size"]} if l.get("size") else {})})
    if T.get("freight"):
        charges.append({"kind": "inbound_shipping", "label": "Freight", "amount": _r2(T["freight"]), "from": "totals"})
    if T.get("other"):
        charges.append({"kind": "other", "label": T.get("other_label") or "Other charges", "amount": _r2(T["other"]),
                        "from": "totals", "detail": T.get("other_detail")})
    if T.get("discount") and not any(x["kind"] == "discount" for x in lines):
        lines.append({"item_code": "", "upc": "", "description": "Discount", "qty": 1, "unit_cost": -_r2(T["discount"]),
                      "amount": -_r2(T["discount"]), "kind": "discount", "flags": ["order_discount"]})
    merch = T.get("merchandise")
    subtotal = _r2(merch - charge_from_lines) if merch is not None else None
    if T.get("discount") and subtotal is not None:
        subtotal = _r2(subtotal - T["discount"])
    issues = [f'{c["check"]}: {c["detail"]}' if c.get("detail") else c["check"]
              for c in v.get("checks") or [] if not c.get("passed")]
    ps = T.get("payment_schedule") or []
    return {
        "vendor": tpl.get("shopify_vendor") or tpl.get("vendor_name") or "",
        "qbo_vendor": tpl.get("qbo_vendor"),
        "invoice_no": h.get("invoice_number") or "",
        "doc_type": h.get("doc_type") or "invoice",
        "invoice_date": h.get("invoice_date") or "",
        "due_date": h.get("due_date") or "",
        "terms": h.get("terms") or "",
        "po_no": h.get("po_reference") or "",
        "vendor_order_no": h.get("vendor_order_number") or "",
        "subtotal": subtotal,
        "tax": _r2(T.get("tax")),
        "total": _r2(T.get("total")),
        "early_pay": [{"pay_by": p.get("pay_by"), "amount": _r2(p.get("amount"))} for p in ps[:-1]] if len(ps) > 1 else [],
        "lines": lines,
        "charges": charges,
        "status": v.get("status") or "needs_review",        # auto_ok | needs_review | unsupported
        "issues": issues,
        "notes": h.get("notes") or [],
        "template": (doc.get("source") or {}).get("template") or "",
        "part": (doc.get("source") or {}).get("part"),
        "ship": doc.get("shipment") or {},
    }


def read_pdf(pdf_path, templates, ocr_get=None, ocr_put=None):
    """Read one PDF. Returns (outcome, vendor, text_method, sha256, result)."""
    data = Path(pdf_path).read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    cache_file = Path(os.environ["OCR_CACHE"]) / f"{sha}.txt"
    if ocr_get and not cache_file.exists():
        pages = ocr_get(sha)
        if pages:
            cache_file.write_text("\f".join(pages))
    docs = engine.extract_all(pdf_path, templates=templates)
    method = (docs[0].get("source") or {}).get("text_method") if docs else None
    if method == "ocr" and ocr_put and cache_file.exists():
        ocr_put(sha, cache_file.read_text().split("\f"))
    slug = (docs[0].get("vendor") or {}).get("slug") if docs else None
    if not slug:
        return "unknown_vendor", None, method, sha, {"invoices": [], "message": "No vendor template recognised this invoice."}
    invs = [to_seller_sage(d, templates) for d in docs]
    statuses = {i["status"] for i in invs}
    outcome = "unsupported" if statuses == {"unsupported"} else "auto_ok" if statuses == {"auto_ok"} else "needs_review"
    if outcome == "unsupported":
        msg = "; ".join(sorted({x for i in invs for x in i["issues"]}))
        return outcome, invs[0]["vendor"], method, sha, {"invoices": [], "message": msg}
    return outcome, invs[0]["vendor"], method, sha, {"invoices": [i for i in invs if i["status"] != "unsupported"]}


# ---------------------------------------------------------------- database loop
def run(once=False, idle=None):
    import psycopg  # psycopg 3
    from psycopg.types.json import Jsonb
    url = os.environ["DATABASE_URL"]
    name = os.environ.get("WORKER_NAME") or socket.gethostname()
    poll = int(os.environ.get("POLL_SECONDS", "15"))
    conn = psycopg.connect(url, autocommit=True)
    conn.execute("listen invoice_reads")
    print(f"[reader] {name} connected; polling every {poll}s", flush=True)

    def q1(sql, *args):
        return conn.execute(sql, args).fetchone()[0]

    ocr_get = lambda sha: q1("select jt.invoice_ocr_get(%s)", sha)
    ocr_put = lambda sha, pages: conn.execute("select jt.invoice_ocr_put(%s, %s)", (sha, Jsonb(pages)))

    def beat():   # heartbeat: while it's fresh, a new read doesn't start another workflow run (migration 100)
        conn.execute("""insert into jt.settings (key, value, updated_at) values ('invoice_reader', jsonb_build_object('seen_at', now(), 'worker', %s::text), now())
                        on conflict (key) do update set value = excluded.value, updated_at = now()""", (name,))

    last_prune, last_work = 0.0, time.time()
    while True:
        if time.time() - last_prune > 86400:
            q1("select jt.invoice_reads_prune()"); last_prune = time.time()
        beat()
        job = q1("select jt.invoice_read_claim(%s)", name)
        if not job:
            if once or (idle is not None and time.time() - last_work > idle):
                conn.execute("update jt.settings set value = value - 'seen_at', updated_at = now() where key = 'invoice_reader'")
                return
            for _ in conn.notifies(timeout=min(poll, 10), stop_after=1):
                pass
            continue
        last_work = time.time()
        t0 = time.time()
        payload = {"id": job["id"]}
        try:
            templates = q1("select jt.invoice_templates_active()") or {}
            raw = b"".join(base64.b64decode(q1("select jt.invoice_read_file_part(%s, %s)", job["id"], k) or "")
                           for k in range(int(job["file_parts"] or 0)))
            if not raw.startswith(b"%PDF"):
                raise ValueError("the saved file is not a PDF")
            with tempfile.TemporaryDirectory() as td:
                p = Path(td) / (Path(job.get("file_name") or "invoice.pdf").name or "invoice.pdf")
                p.write_bytes(raw)
                outcome, vendor, method, sha, result = read_pdf(p, templates, ocr_get, ocr_put)
            payload.update(outcome=outcome, vendor=vendor, text_method=method, sha256=sha, result=result)
        except Exception as e:  # report, never crash the loop
            traceback.print_exc()
            payload.update(outcome="error", error=f"{type(e).__name__}: {e}"[:500])
        conn.execute("select jt.invoice_read_finish(%s)", (Jsonb(payload),))
        print(f"[reader] read {job['id']} ({job.get('file_name')}): {payload.get('outcome')} "
              f"({payload.get('vendor')}, {payload.get('text_method')}) in {time.time() - t0:.1f}s", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--idle", type=int, help="stop after this many seconds without a read")
    ap.add_argument("--file")
    ap.add_argument("--fetch", nargs=2, metavar=("READ_ID", "OUT_PDF"))
    ap.add_argument("--templates", help="folder of <slug>.json templates (local test); default: the bundled seed")
    a = ap.parse_args()
    if a.fetch:
        import psycopg
        rid, out = int(a.fetch[0]), Path(a.fetch[1])
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            n = conn.execute("select (jt.invoice_read_get(%s))->>'file_parts'", (rid,)).fetchone()[0]
            if not n:
                sys.exit(f"read {rid} not found")
            out.write_bytes(b"".join(base64.b64decode(conn.execute("select jt.invoice_read_file_part(%s, %s)", (rid, k)).fetchone()[0] or "")
                                     for k in range(int(n))))
        print(f"saved {out} ({out.stat().st_size:,} bytes)")
        return
    if a.file:
        tdir = Path(a.templates) if a.templates else Path(__file__).resolve().parent / "templates"
        vend = json.loads((tdir / "_shopify_vendors.json").read_text()) if (tdir / "_shopify_vendors.json").exists() else {}
        templates = {p.stem: {**json.loads(p.read_text()), "shopify_vendor": vend.get(p.stem)}
                     for p in tdir.glob("*.json") if not p.name.startswith("_")}
        outcome, vendor, method, sha, result = read_pdf(a.file, templates)
        print(json.dumps({"outcome": outcome, "vendor": vendor, "text_method": method, "sha256": sha, "result": result},
                         indent=2, default=str))
        return
    run(once=a.once, idle=a.idle)


if __name__ == "__main__":
    main()
