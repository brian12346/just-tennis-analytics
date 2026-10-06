#!/usr/bin/env python3
"""
Seller Sage invoice digitizer.

  python3 engine.py extract <pdf-or-folder> [--out out_dir] [--vendor wilson]

Each vendor has a template (templates/<slug>.json) describing where things are on
its invoices, plus a learned file (learned/<slug>.json) that grows as Brian
confirms SKU mappings, QB accounts, terms and received quantities during review.
Output = Seller Sage invoice v1 JSON (schema/seller_sage_invoice.schema.json).
"""
import json, re, subprocess, sys, os, glob, datetime, argparse, shutil, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEMPLATES = ROOT / "templates"
LEARNED = ROOT / "learned"
TOL = 0.015  # cents tolerance


# ---------------------------------------------------------------- text layer
def ocr_clean(t):
    """Undo the commonest OCR slips in numbers: 299,20 -> 299.20, §89.72 -> 589.72."""
    t = re.sub(r"(?<![\d,.])(\d{1,3}),(\d{2})(?![\d,])", r"\1.\2", t)
    t = re.sub(r"§(?=\d)", "5", t)
    return t


def pdf_text(path):
    """Return (pages[list[str]], method). Falls back to OCR for scanned PDFs."""
    try:
        out = subprocess.run(["pdftotext", "-layout", str(path), "-"],
                             capture_output=True, text=True, timeout=120).stdout
    except Exception:
        out = ""
    out = out.replace("\ufb01", "fi").replace("\ufb02", "fl").replace("\u00a0", " ")
    pages = out.split("\f")
    if pages and not pages[-1].strip():
        pages = pages[:-1]
    if sum(len(p.strip()) for p in pages) > 80:
        return pages, "pdf_text"
    # OCR fallback (cached by file hash — OCR is slow)
    if not shutil.which("tesseract"):
        return pages, "pdf_text"
    import hashlib
    cache_dir = Path(os.environ.get("OCR_CACHE", ROOT / ".ocr_cache"))
    cache_dir.mkdir(exist_ok=True)
    key = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    cf = cache_dir / f"{key}.txt"
    if cf.exists():
        return [ocr_clean(p) for p in cf.read_text().split("\f")], "ocr"
    tmp = tempfile.mkdtemp()
    subprocess.run(["pdftoppm", "-r", "300", "-png", str(path), f"{tmp}/p"], capture_output=True)
    pages = []
    for img in sorted(glob.glob(f"{tmp}/p*.png")):
        r = subprocess.run(["tesseract", img, "-", "--psm", "6"], capture_output=True, text=True)
        pages.append(ocr_clean(r.stdout))
    shutil.rmtree(tmp, ignore_errors=True)
    cf.write_text("\f".join(pages))
    return pages, "ocr"


# ---------------------------------------------------------------- helpers
def num(s):
    if s is None:
        return None
    s = s.strip().replace(",", "").replace("$", "").replace("U", "")
    neg = s.endswith("-") or s.startswith("-") or (s.startswith("(") and s.endswith(")"))
    s = s.strip("-()")
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def iso(d, fmt):
    if not d:
        return None
    try:
        return datetime.datetime.strptime(d.strip(), fmt).date().isoformat()
    except ValueError:
        return None


def first(regex, text, flags=re.M):
    m = re.search(regex, text, flags)
    return m.group(1).strip() if m else None


def load_json(p, default):
    p = Path(p)
    return json.loads(p.read_text()) if p.exists() else default


def load_templates():
    return {p.stem: json.loads(p.read_text()) for p in TEMPLATES.glob("*.json")}


def learned_for(slug):
    return load_json(LEARNED / f"{slug}.json", {
        "qb_vendor_name": None, "terms_map": {}, "sku_map": {}, "sku_category": {},
        "po_reference_map": {}, "corrections": [], "stats": {"invoices_reviewed": 0}})


def identify(text, templates, forced=None):
    if forced:
        return forced
    for slug, t in templates.items():
        ident = t.get("identify", {})
        if all(re.search(r, text, re.I) for r in ident.get("all", [])) and \
           (not ident.get("any") or any(re.search(r, text, re.I) for r in ident["any"])):
            return slug
    return None


def filename_note(fname):
    stem = Path(fname).stem
    m = re.match(r"^(?:invoice-)?\d{6,}\s*[-(]?\s*(.*?)\)?$", stem)
    note = m.group(1).strip(" -") if m else None
    return note or None


# ---------------------------------------------------------------- positional helpers
NUMTOK = re.compile(r"(?:USD\s*)?-?\$?-?\(?[\d,]*\d\.\d{2}\)?-?|\d{1,2}/\d{1,2}/\d{2,4}")


def columns_after_header(text, spec, fmt):
    """Find a header line, then read the next non-blank line and assign each value to the header label it sits
    under (nearest by right edge, then by left edge).  Handles summary rows with blank columns."""
    out = {}
    lines = text.splitlines()
    for i, l in enumerate(lines):
        if not re.search(spec["header"], l):
            continue
        labels, masked = [], l
        for field, label in sorted(spec["fields"].items(), key=lambda kv: -len(kv[1])):
            mm = re.search(r"(?<![A-Za-z])" + re.escape(label) + r"(?![A-Za-z])", masked)
            if mm:
                labels.append((field, mm.start(), mm.end()))
                masked = masked[:mm.start()] + "#" * (mm.end() - mm.start()) + masked[mm.end():]
        if not labels:
            continue
        rows = [x for x in lines[i + 1:i + 1 + spec.get("lookahead", 3)] if x.strip()][:spec.get("rows", 1)]
        for row in rows:
            for m in NUMTOK.finditer(row):
                tok = m.group(0)
                s0, e0 = m.start(), m.end()
                best = min(labels, key=lambda t: min(abs(e0 - t[2]), abs(s0 - t[1]), abs((s0 + e0) / 2 - (t[1] + t[2]) / 2)))
                field = best[0]
                if field in out:
                    continue
                out[field] = iso(tok, fmt) if field.endswith("_date") else num(tok.replace("USD", ""))
        if out:
            break
    return out


# ---------------------------------------------------------------- parser
def parse_layout_text(pages, tpl, variant, method="pdf_text"):
    full = "\n".join(pages)
    doc = {"header": {"notes": []}, "shipment": {"tracking_numbers": []}, "lines": [], "totals": {}}
    h = doc["header"]

    # doc type
    first_line = next((l for l in full.splitlines() if l.strip()), "")
    h["doc_type"] = "invoice"
    for label, dt in variant.get("doc_type", {}).items():
        if label in first_line.upper():
            h["doc_type"] = dt
            break

    fmt = variant.get("date_format", "%m/%d/%Y")
    for field, rx in variant.get("header", {}).items():
        val = first(rx, pages[0] if pages else full)
        if field.endswith("_date"):
            val = iso(val, fmt)
        h[field] = val

    # rows that sit under a column header line (shipment block, order block)
    lines0 = pages[0].splitlines() if pages else []
    for block, spec in variant.get("row_after_header", {}).items():
        for i, l in enumerate(lines0):
            if re.search(spec["header"], l):
                for nxt in lines0[i + 1:i + 3]:
                    m = re.search(spec["regex"], nxt)
                    if m:
                        for k, v in m.groupdict().items():
                            if v is None:
                                continue
                            v = v.strip()
                            if k.endswith("_date"):
                                v = iso(v, fmt)
                            if k == "cartons":
                                v = int(v)
                            (doc["shipment"] if block == "shipment" else h)[k] = v
                        break
                break
    sv = doc["shipment"].get("ship_via")
    if sv:
        sv = re.sub(r"\s{2,}", " ", sv)
        for w in variant.get("freight_terms_words", []):
            if w in sv:
                doc["shipment"]["freight_terms"] = w
                sv = sv.replace(w, "").strip()
        doc["shipment"]["ship_via"] = sv

    # line items + notes + tracking, page by page
    li = variant.get("line_item")
    item_rx = re.compile(li["regex"]) if li else None
    ign = [re.compile(r) for r in variant.get("ignore_lines", [])]
    trk = variant.get("tracking")
    skip_rx = [re.compile(r) for r in (li or {}).get("skip_regex", [])]
    adj_rx = re.compile(li["adjustment_regex"]) if li and li.get("adjustment_regex") else None
    chg_rx = re.compile(li["charge_regex"]) if li and li.get("charge_regex") else None
    wrap = (li or {}).get("wrap_fields", {})
    pending = None
    for pno, page in enumerate(pages, 1):
        pl = page.splitlines()
        in_region, last_item = False, None
        wrap_state = None
        pending = None if pno == 1 else pending
        for i, l in enumerate(pl):
            if variant.get("line_region_start") and re.search(variant["line_region_start"], l):
                in_region = True
                continue
            if not in_region:
                continue
            if re.search(variant["line_region_end"], l):
                in_region = False
                if trk and re.search(trk["start"], l):
                    for t in pl[i:i + 12]:
                        doc["shipment"]["tracking_numbers"] += re.findall(trk["token"], t)
                continue
            if not l.strip() or any(r.search(l) for r in ign):
                continue
            if any(r.search(l) for r in skip_rx):
                wrap_state = None
                continue
            am = adj_rx.search(l) if adj_rx and not (item_rx and item_rx.match(l)) else None
            if am:
                ga = am.groupdict()
                amt = num(ga["amount"])
                doc["lines"].append({"line_no": len(doc["lines"]) + 1, "vendor_sku": li.get("discount_sku", "DISCOUNT"),
                                     "upc": None, "description": re.sub(r"\s{2,}", " ", (ga.get("label") or "Discount").strip())
                                     + (f" on {last_item['vendor_sku']}" if last_item and last_item.get("vendor_sku") not in (None, "DISCOUNT") else ""),
                                     "qty": 1.0, "qty_backordered": None, "uom": "EA", "unit_cost": amt, "extended_cost": amt,
                                     "page": pno, "flags": ["line_discount"], "category": "Discounts"})
                wrap_state = None
                continue
            cm = chg_rx.search(l) if chg_rx else None
            if cm:
                gc = cm.groupdict()
                amt = num(gc["amount"])
                if amt:
                    doc["lines"].append({"line_no": len(doc["lines"]) + 1, "vendor_sku": li.get("charge_sku", "FREIGHT"),
                                         "upc": None, "description": re.sub(r"\s{2,}", " ", (gc.get("label") or "Shipping").strip()),
                                         "qty": 1.0, "qty_backordered": None, "uom": "EA", "unit_cost": amt, "extended_cost": amt,
                                         "page": pno, "flags": ["charge"], "category": li.get("charge_category", "Freight In")})
                wrap_state = None
                continue
            m = item_rx.match(l) if item_rx else None
            partial = False
            if not m and li and li.get("partial_regex"):
                m = re.match(li["partial_regex"], l)
                partial = bool(m)
            if not m and pending is not None and li.get("fill_regex"):
                fm = None
                for frx in li["fill_regex"]:
                    fm = re.search(frx, l)
                    if fm:
                        break
                if fm:
                    for k, v in fm.groupdict().items():
                        if v is not None and v.strip() and pending.get(k) is None:
                            pending[k] = num(v) if k in ("qty", "unit_cost", "extended_cost") else v
                    if pending.get("qty") is not None and pending.get("extended_cost") is not None:
                        q0, e0 = pending["qty"], pending["extended_cost"]
                        if pending.get("unit_cost") is None or (q0 and abs(round(q0 * pending["unit_cost"], 2) - e0) > TOL):
                            pending["unit_cost"] = round(e0 / q0, 4) if q0 else 0.0
                        pending["flags"] = [f for f in pending["flags"] if f != "pending"]
                        pending = None
                    continue
            if m:
                g = m.groupdict()
                flags = [variant.get("line_flags", {}).get(g["flag"], g["flag"])] if g.get("flag") else []
                desc = re.sub(r"\s{2,}", " ", g["description"].strip()) if g.get("description") else None
                unit, ext = num(g.get("unit_cost")), num(g.get("extended_cost"))
                if li.get("qty_from_price_discount") and ext is not None and g.get("list_price"):
                    lp, dp = num(g["list_price"]), num(g.get("discount_pct")) or 0
                    net = round(lp * (1 - dp / 100), 4) if lp else 0
                    qd = ext / net if net else 0
                    isint = lambda q, e: abs(q - round(q)) < 0.02 and (round(q) >= 1 or not e)
                    if net and not isint(qd, ext):
                        # OCR misreads seen on scans: "$" for a leading 5, a bare 0.60/0.80 for 0.00 (nothing shipped)
                        raw = (g.get("extended_cost") or "").strip()
                        alts = []
                        if raw.startswith("$"): alts.append(num("5" + raw[1:]))
                        if ext < net: alts.append(0.0)
                        for e2 in alts:
                            q2 = e2 / net
                            if e2 is not None and isint(q2, e2):
                                ext, qd = e2, q2
                                g = {**g, "extended_cost": f"{e2:.2f}"}
                                break
                    if abs(qd - round(qd)) < 0.02:
                        g = {**g, "qty": str(int(round(qd)))}
                        exp = round(round(qd) * net, 2)
                        if net and 0.01 < abs(exp - ext) <= max(1.0, 0.002 * ext):
                            # a single misread digit in the amount column; price × multiplier is the better reading
                            ext = exp
                            g = {**g, "extended_cost": f"{exp:.2f}"}
                            flags.append("ocr_amount_fixed")
                    else:
                        g = {**g, "qty": g.get("qty") if re.fullmatch(r"\d+", g.get("qty") or "") else "0"}
                if li.get("sku_tokens_until"):
                    toks = (g.get("vendor_sku") or "").split()
                    keep = []
                    for tk in toks:
                        if re.fullmatch(li["sku_tokens_until"], tk):
                            break
                        keep.append(tk)
                    g = {**g, "vendor_sku": "".join(keep).strip("|[]") or None}
                qty0 = num(g.get("qty")) or 0
                if li.get("drop_zero_qty") and not qty0 and not ext:
                    last_item = None
                    wrap_state = None
                    continue
                if li.get("unit_from_extended") and ext is not None and qty0:
                    if unit is None or abs(round(qty0 * unit, 2) - ext) > TOL:
                        if unit is not None:
                            g = {**g, "list_price": g.get("list_price") or g.get("unit_cost")}
                        unit = round(ext / qty0, 4)
                if unit is None and ext is None and li.get("free_goods_ok"):
                    unit, ext = 0.0, 0.0
                    flags.append("no_charge")
                for rx, fl in (li.get("desc_flags") or {}).items():
                    if desc and re.search(rx, desc):
                        flags.append(fl)
                line = {"line_no": len(doc["lines"]) + 1,
                        "vendor_sku": g.get("vendor_sku"),
                        "upc": g.get("upc"),
                        "description": desc,
                        "qty": num(g.get("qty")),
                        "qty_backordered": num(g.get("qty_backordered")),
                        "uom": g.get("uom"),
                        "unit_cost": unit,
                        "extended_cost": ext,
                        "page": pno,
                        "flags": flags}
                if g.get("size"):
                    line["size"] = re.sub(r"\s+", "", g["size"])
                if not line["vendor_sku"] and li.get("sku_from_description_regex") and desc:
                    dm = re.match(li["sku_from_description_regex"], desc)
                    if dm:
                        line["vendor_sku"] = re.sub(r"\s+", "-", re.sub(r"-\s+", "-", dm.group(1).strip()))
                for rule in li.get("sku_compose") or []:
                    m2 = re.match(rule["size_regex"], line.get("size") or "")
                    if m2:
                        line["material"] = line["vendor_sku"]
                        line["vendor_sku"] = rule["format"].format(*m2.groups(), sku=line["vendor_sku"], size=line.get("size") or "")
                        break
                if li.get("compose_sku"):
                    line["material"] = g.get("style") or line.get("vendor_sku")
                    line["vendor_sku"] = li["compose_sku"].format(**{k: (v or "").strip() for k, v in g.items()})
                    for k in ("style", "width", "size", "color"):
                        if g.get(k):
                            line[k] = g[k].strip()
                if g.get("list_price"):
                    line["list_price"] = num(g["list_price"])
                if g.get("discount_pct"):
                    line["discount_pct"] = num(g["discount_pct"])
                if partial and g.get("charge"):
                    line.update({"vendor_sku": li.get("charge_sku", "FREIGHT"), "description": re.sub(r"\s{2,}", " ", g["charge"].strip()),
                                 "category": li.get("charge_category", "Freight In")})
                    line["flags"].append("charge")
                if partial:
                    line["flags"].append("pending")
                    line["qty"] = num(g.get("qty")) if g.get("qty") else None
                    pending = line
                doc["lines"].append(line)
                last_item = line
                wrap_state = {f: (m.start(f) if m.group(f) is not None else None, 0) for f in wrap if f in m.groupdict()}
                continue
            if li and li.get("sku_next_line_regex") and last_item is not None and not last_item.get("vendor_sku"):
                sm = re.search(li["sku_next_line_regex"], l)
                if sm:
                    last_item["vendor_sku"] = sm.group(1)
                    continue
                last_item.setdefault("note", l.strip())
            if wrap_state and last_item is not None:
                took = False
                for f, (col, n) in list(wrap_state.items()):
                    if col is None or n >= li.get("wrap_max_lines", 2):
                        continue
                    tm = None
                    for t in re.finditer(r"\S+(?: \S+)*", l):
                        if abs(t.start() - col) <= li.get("wrap_tolerance", 2):
                            tm = t
                            break
                    if tm:
                        frag = tm.group(0) if f == "description" else tm.group(0).split()[0]
                        cur = last_item.get(f) or ""
                        joiner = wrap[f] if (f == "description" or not cur.endswith(("-", "_", "/"))) else ""
                        last_item[f] = (cur + joiner + frag).strip()
                        wrap_state[f] = (col, n + 1)
                        took = True
                if took:
                    continue
            indent = len(l) - len(l.lstrip())
            if last_item is not None and last_item["description"] is None and li.get("description") == "next_line" \
                    and (indent >= li.get("description_min_indent", 0) or method == "ocr"):
                last_item["description"] = re.sub(r"\s{2,}", " ", l.strip())
                continue
            if variant.get("notes_region"):
                doc["header"]["notes"].append(re.sub(r"\s{2,}", " ", l.strip()))
        # tracking may also appear outside the item region
        if trk:
            for i, l in enumerate(pl):
                if re.search(trk["start"], l):
                    for t in pl[i:i + 12]:
                        doc["shipment"]["tracking_numbers"] += re.findall(trk["token"], t)
    doc["lines"] = [ln for ln in doc["lines"] if not ("pending" in (ln.get("flags") or []) and "charge" in ln["flags"])]
    for i, ln in enumerate(doc["lines"], 1):
        ln["line_no"] = i
    for ln in doc["lines"]:
        if "pending" in (ln.get("flags") or []):
            ln["flags"] = [f for f in ln["flags"] if f != "pending"] + ["no_price"]
            ln["unit_cost"] = ln["unit_cost"] or 0.0
            ln["extended_cost"] = ln["extended_cost"] or 0.0
            ln["qty"] = ln["qty"] or 0.0
    if li and li.get("charge_note_regex"):
        for ln in doc["lines"]:
            if not ln.get("vendor_sku") and re.search(li["charge_note_regex"], (ln.get("note") or "") + " " + (ln.get("description") or "")):
                ln.update({"vendor_sku": li.get("charge_sku", "FREIGHT"), "category": li.get("charge_category", "Freight In"),
                           "description": ln.get("note") or ln.get("description")})
                ln["flags"] = (ln.get("flags") or []) + ["charge"]
    doc["shipment"]["tracking_numbers"] = list(dict.fromkeys(doc["shipment"]["tracking_numbers"]))
    # notes that are really the tracking header etc.
    doc["header"]["notes"] = [n for n in dict.fromkeys(doc["header"]["notes"])
                              if not re.search(r"Tracking Number|^1Z|^\d{12,}$", n)]

    # totals from the last page that carries them
    tp = pages[-1] if pages else ""
    if variant.get("totals_page") == "first":
        tp = pages[0] if pages else ""
    elif variant.get("totals_page") == "last":
        anchor = (variant.get("totals") or {}).get("total") or (variant.get("totals_columns") or [{}])[0].get("header")
        for p in reversed(pages):
            if anchor and re.search(anchor, p, re.M):
                tp = p
                break
    else:
        tp = full
    for k, rx in variant.get("totals", {}).items():
        doc["totals"][k] = num(first(rx, tp))
    for spec in variant.get("totals_columns", []):
        for k, v in columns_after_header(tp if variant.get("totals_page") in ("last", "first") else full, spec, fmt).items():
            if k.startswith("_"):
                continue
            if "#" in k:
                base = k.split("#")[0]
                doc["totals"][base] = round((doc["totals"].get(base) or 0) + (v or 0), 2)
                continue
            if k.endswith("_date"):
                h[k] = h.get(k) or v
            elif doc["totals"].get(k) is None:
                doc["totals"][k] = v
    for spec in variant.get("header_columns", []):
        for k, v in columns_after_header(full, spec, fmt).items():
            h[k] = h.get(k) or v
    T0 = doc["totals"]
    if T0.get("early_pay_amount") and h.get("early_pay_date"):
        T0["payment_schedule_early"] = {"pay_by": h.pop("early_pay_date"), "amount": T0.pop("early_pay_amount")}
    T0.pop("early_pay_save", None)
    ps = variant.get("payment_schedule")
    doc["totals"]["payment_schedule"] = []
    if ps:
        after = tp.split(ps["after"], 1)[1] if ps["after"] in tp else ""
        for l in after.splitlines()[:12]:
            m = re.search(ps["regex"], l)
            if m:
                doc["totals"]["payment_schedule"].append({"pay_by": iso(m.group(1), fmt), "amount": num(m.group(2))})
        if doc["totals"]["payment_schedule"] and not h.get("due_date"):
            h["due_date"] = doc["totals"]["payment_schedule"][-1]["pay_by"]
    return doc


PARSERS = {"layout_text": parse_layout_text}


# ---------------------------------------------------------------- style/colour/size block parser (Babolat Cegid print)
AMT = r"-?\d{1,3}(?: \d{3})*\.\d{2}-?"


def bnum(s):
    return num(s.replace(" ", "")) if s else None


def parse_style_block(pages, tpl, variant, method="pdf_text"):
    """Lines are printed as a STYLE row (code + name) followed by one or more COLOUR rows that carry a
    quantity/size breakdown ("2/7.5 2/8 ..."), total qty, unit price and amount.  Each size becomes its own
    line so it can be matched to a Shopify variant."""
    full = "\n".join(pages)
    V = variant
    doc = {"header": {"notes": []}, "shipment": {"tracking_numbers": []}, "lines": [], "totals": {}}
    h = doc["header"]
    fmt = V.get("date_format", "%m/%d/%y")
    for field, rx in V.get("header", {}).items():
        val = first(rx, full)
        if field.endswith("_date"):
            val = iso(val, fmt)
        h[field] = val
    title = first(r"^\s*([A-Z][A-Z ]+?)\s+-\s+[A-Z]+\s+No\s+\d+", full) or "INVOICE"
    h["doc_type"] = next((dt for k, dt in V.get("doc_type", {}).items() if k in title.upper()), "invoice")
    sv = first(r"References\s+CURRENCY\s+\S+\s+(.+?)\s*$", full)
    sv2 = first(r"Cust\. No\.:.*?CHEQUE\s+(\S.*?)\s*$", full)
    if sv:
        doc["shipment"]["ship_via"] = " ".join(x for x in (sv, sv2) if x)
    m = re.search(r"Your ref\.:.*\n(?:\s*\n)*\s{20,}([A-Z][A-Z .'-]+?)(?:\s{2,}|\s*$)", full)
    if m:
        h["sales_rep"] = m.group(1).strip()

    style_rx = re.compile(V["style_regex"])
    color_rx = re.compile(V["color_regex"])
    cont_rx = re.compile(V["size_continuation_regex"])
    adj_rx = re.compile(V["adjustment_regex"])
    size_tok = re.compile(r"(\d+)/([0-9A-Z.+]+)")
    rules = V.get("sku_compose", [])
    nosize = re.compile(V.get("no_size_regex", r"^(UNIQ|0{2,})$"))

    blocks = []          # one per colour row: dict(style, desc, color, cname, sizes, qty, unit, amt, page, disc)
    adjustments = []     # after INVOICE TOTAL (tariff etc.)
    style = desc = None
    after_total = False
    for pno, page in enumerate(pages, 1):
        in_region = False
        for l in page.splitlines():
            if re.search(V["line_region_start"], l):
                in_region = True
                continue
            if not in_region or not l.strip():
                continue
            if V.get("subtotal_regex"):
                sm = re.search(V["subtotal_regex"], l)
                if sm:
                    doc["totals"]["subtotals"] = doc["totals"].get("subtotals", []) + [bnum(sm.group(1))]
                    continue
            if re.search(V["line_region_end"], l):
                after_total = True
                gm = re.search(r"(GROSS|NET) BT TOTAL:?\s+(" + AMT + r")\s*$", l)
                if gm and "lines_total" not in doc["totals"]:
                    doc["totals"]["lines_total"] = bnum(gm.group(2))
                continue
            am = adj_rx.search(l)
            if am:
                a = {"label": re.sub(r"\s{2,}", " ", am.group("label").strip()), "pct": num(am.group("pct")),
                     "base": bnum(am.group("base")), "amount": bnum(am.group("amount")), "page": pno}
                if after_total:
                    adjustments.append(a)
                elif blocks:
                    blocks[-1]["adjustments"].append(a)
                continue
            if after_total:
                continue
            m = style_rx.match(l)
            if m:
                style, desc = m.group("style"), (m.group("desc") or "").strip() or None
                continue
            m = color_rx.match(l)
            if m and style:
                g = m.groupdict()
                blocks.append({"style": style, "desc": desc, "color": g["color"], "cname": (g.get("cname") or "").strip(" ."),
                               "sizes": size_tok.findall(g.get("sizes") or ""), "qty": num(g.get("qty")),
                               "unit": bnum(g["unit"]), "amt": bnum(g["amt"]), "page": pno, "disc": None,
                               "adjustments": []})
                continue
            m = cont_rx.match(l)
            if m and blocks:
                blocks[-1]["sizes"] += size_tok.findall(m.group(1))
                continue
            dm = re.match(r"^\s*((?:Special )?Discount:.*?)\s*$", l)
            if dm and blocks:
                blocks[-1]["disc"] = re.sub(r"\s{2,}", " ", dm.group(1))
                continue

    for b in blocks:
        base_desc = b["desc"] or b["style"]
        sizes = b["sizes"] or [(str(int(b["qty"] or 0)), "UNIQ")]
        if sum(int(q) for q, _ in sizes) != int(b["qty"] or 0):
            sizes = [(str(int(b["qty"] or 0)), "UNIQ")]
            b["size_mismatch"] = True
        for q, s in sizes:
            size = None if nosize.match(s) else s
            sku = b["style"]
            for r in rules:
                if re.search(r.get("style_regex", ".*"), b["style"]) and re.fullmatch(r.get("size_regex", ".*"), size or "") \
                        and re.search(r.get("color_regex", ".*"), b["color"]):
                    sku = r["format"].format(style=b["style"], color=re.sub(r"\D+$", "", b["color"]), size=size or "")
                    break
            q = int(q)
            unit = b["unit"]
            line = {"line_no": len(doc["lines"]) + 1, "vendor_sku": sku, "material": b["style"], "upc": None,
                    "description": " ".join(x for x in (base_desc, b["cname"], size) if x),
                    "qty": float(q), "qty_backordered": None, "uom": "EA", "unit_cost": unit,
                    "extended_cost": round(q * (unit or 0), 2), "page": b["page"], "flags": [],
                    "color": b["color"], "size": size}
            if b.get("size_mismatch"):
                line["flags"].append("size_breakdown_unreadable")
            if b["disc"]:
                line["discount_note"] = b["disc"]
                pm = re.findall(r"([\d.]+)\s*%", b["disc"])
                if pm:
                    line["discount_pct"] = num(pm[-1])
            doc["lines"].append(line)
        printed = b["amt"]
        made = round(sum(round(int(q) * (b["unit"] or 0), 2) for q, _ in sizes), 2)
        if printed is not None and abs(made - printed) > TOL:
            doc["lines"][-1]["flags"].append(f"block_amount_mismatch {made}≠{printed}")
            doc["lines"][-1]["extended_cost"] = round(doc["lines"][-1]["extended_cost"] + printed - made, 2)
        for a in b["adjustments"]:
            doc["lines"].append({"line_no": len(doc["lines"]) + 1, "vendor_sku": V.get("discount_sku", "DISCOUNT"),
                                 "material": b["style"], "upc": None,
                                 "description": f"{a['label']} on {b['style']} {base_desc}", "qty": 1.0, "qty_backordered": None,
                                 "uom": "EA", "unit_cost": a["amount"], "extended_cost": a["amount"], "page": a["page"],
                                 "flags": ["line_discount"], "category": "Discounts"})

    # totals: B.T AMOUNT / FREIGHT ... / DUE DATES / NET TO PAY
    T = doc["totals"]
    T["other"] = round(sum(a["amount"] for a in adjustments), 2) if adjustments else None
    if adjustments:
        T["other_detail"] = adjustments
    hdr = None
    for p in reversed(pages):
        if "B.T AMOUNT" in p and re.search(r"USD\s*$", p, re.M):
            hdr = p
            break
    T["payment_schedule"] = []
    if hdr:
        after = hdr.split("B.T AMOUNT", 1)[1]
        cols = after.splitlines()[0]
        charge_labels = re.findall(r"[A-Z][A-Z.\-]*(?: [A-Z][A-Z.\-]*)*", cols.split("DUE DATES")[0])
        rows = [r for r in after.splitlines()[1:] if r.strip()][:8]
        for i, r in enumerate(rows):
            dm = re.search(r"(\d{2}/\d{2}/\d{2})\s+(" + AMT + ")", r)
            if i == 0:
                pre = r[:dm.start()] if dm else r
                vals = [bnum(x) for x in re.findall(AMT, pre)]
                if vals:
                    T["bt_amount"] = vals[0]
                    for lab, v in zip(charge_labels, vals[1:]):
                        if lab.startswith("FREIGHT"):
                            T["freight"] = round((T.get("freight") or 0) + v, 2)
                        else:
                            T["other"] = round((T.get("other") or 0) + v, 2)
                tm = re.search(r"(" + AMT + r")\s+USD\s*$", r)
                if tm:
                    T["total"] = bnum(tm.group(1))
            if dm:
                T["payment_schedule"].append({"pay_by": iso(dm.group(1), fmt), "amount": bnum(dm.group(2))})
            if re.search(r"USD\s*$", r) and i > 0:
                break
    T["merchandise"] = T.pop("lines_total", None)
    subs = T.pop("subtotals", None)
    if T["merchandise"] is None and subs:
        T["merchandise"] = round(sum(subs), 2)
    if T.get("merchandise") is None and T.get("bt_amount") is not None:
        T["merchandise"] = round(T["bt_amount"] - (T.get("other") or 0), 2)
    if T["payment_schedule"]:
        h["due_date"] = T["payment_schedule"][-1]["pay_by"]
        if T.get("total") is not None and len(T["payment_schedule"]) == 1:
            T["payment_schedule"][0]["amount"] = T["payment_schedule"][0]["amount"]
    return doc


PARSERS["style_block"] = parse_style_block


def split_documents(pages, tpl):
    """Some PDFs hold several invoices back to back. Group pages by the document number printed on each page."""
    rx = tpl.get("split_by")
    if not rx:
        return [pages]
    groups, cur_key = [], object()
    for p in pages:
        m = re.search(rx, p, re.M)
        key = m.group(1) if m else cur_key
        if not groups or key != cur_key:
            groups.append([])
            cur_key = key
        groups[-1].append(p)
    return groups


def extract_all(path, forced_vendor=None, templates=None, keep_text=False):
    """Like extract() but returns a list — one doc per invoice found in the file."""
    templates = templates or load_templates()
    pages, method = pdf_text(path)
    slug = identify("\n".join(pages), templates, forced_vendor)
    groups = split_documents(pages, templates[slug]) if slug else [pages]
    docs = []
    for i, g in enumerate(groups):
        d = _extract(path, forced_vendor, templates, g, method)
        if len(groups) > 1:
            d["source"]["part"] = f"{i + 1}/{len(groups)}"
        if keep_text:
            d["_raw_text"] = "\f".join(g)
        docs.append(d)
    return docs


# ---------------------------------------------------------------- enrichment (the "learning" layer)
def categorize(line, learned, glob_):
    sku = line.get("vendor_sku") or ""
    if sku in learned.get("sku_category", {}):
        return learned["sku_category"][sku], "confirmed"
    # learned prefix rules: most specific confirmed prefix wins
    best = None
    for pre, cat in learned.get("sku_prefix_category", {}).items():
        if sku.startswith(pre) and (best is None or len(pre) > len(best[0])):
            best = (pre, cat)
    if best:
        return best[1], "learned_rule"
    desc = (line.get("description") or "").upper()
    for r in glob_["category_keywords"]:
        if (r.get("sku_regex") and re.search(r["sku_regex"], sku)) or re.search(r["regex"], desc):
            return r["category"], "keyword_guess"
    return None, None


def enrich(doc, slug, tpl):
    learned = learned_for(slug)
    glob_ = load_json(LEARNED / "_global.json", {"category_accounts": {}, "category_keywords": []})
    doc["vendor"]["qb_vendor_name"] = learned.get("qb_vendor_name")
    t = doc["header"].get("terms")
    doc["header"]["qb_terms"] = learned.get("terms_map", {}).get(t) if t else None
    po = doc["header"].get("po_reference")
    if po and po in learned.get("po_reference_map", {}):
        doc["header"]["seller_sage_po"] = learned["po_reference_map"][po]
    for line in doc["lines"]:
        if line.get("category"):
            cat, src = line["category"], "template"
        else:
            cat, src = categorize(line, learned, glob_)
        line["category"], line["category_source"] = cat, src
        line["seller_sage_sku"] = learned.get("sku_map", {}).get(line.get("vendor_sku"))
        line["qb_account"] = glob_["category_accounts"].get(cat) if cat else None
        line["qty_received"] = None
    return doc


# ---------------------------------------------------------------- validation
def validate(doc, variant):
    checks = []
    def chk(name, ok, detail=""):
        checks.append({"check": name, "passed": bool(ok), "detail": detail})

    h, T, L = doc["header"], doc["totals"], doc["lines"]
    for f in ("invoice_number", "invoice_date"):
        chk(f"header.{f}", h.get(f), "" if h.get(f) else "missing")
    chk("totals.total", T.get("total") is not None, "" if T.get("total") is not None else "missing")

    if variant.get("line_item"):
        chk("has_lines", len(L) > 0, f"{len(L)} lines")
        bad = [l for l in L if abs(round((l["qty"] or 0) * (l["unit_cost"] or 0), 2) - (l["extended_cost"] or 0)) > TOL]
        chk("line_math (qty × unit = extended)", not bad,
            "; ".join(f"line {b['line_no']} {b['vendor_sku']}: {b['qty']}×{b['unit_cost']}≠{b['extended_cost']}" for b in bad))
        miss_sku = [l["line_no"] for l in L if not l.get("vendor_sku")]
        chk("item numbers captured", not miss_sku, f"missing on lines {miss_sku}" if miss_sku else "")
        miss_desc = [l["line_no"] for l in L if not l["description"]]
        chk("descriptions captured", not miss_desc, f"missing on lines {miss_desc}" if miss_desc else "")
        s = round(sum(l["extended_cost"] or 0 for l in L), 2)
        m = T.get("merchandise")
        if m is None and T.get("total") is not None:
            m = round(T["total"] - sum(T.get(k) or 0 for k in ("freight", "other", "tax")), 2)
            T["merchandise"] = m
            T["merchandise_derived"] = True
        chk("lines sum = merchandise subtotal", m is not None and abs(s - m) <= TOL, f"lines {s:,.2f} vs MDSE {m}")
    else:
        chk("has_lines", False, variant.get("review_reason", "template captures no line detail"))

    parts = [T.get(k) or 0 for k in ("merchandise", "freight", "other", "tax")]
    calc = round(sum(parts) - (T.get("discount") or 0), 2)
    if T.get("total") is not None and T.get("merchandise") is not None:
        chk("subtotal + freight + other + tax = total", abs(calc - T["total"]) <= TOL, f"calc {calc:,.2f} vs total {T['total']:,.2f}")
    ps = T.get("payment_schedule") or []
    if ps and T.get("total") is not None:
        chk("final payment-schedule amount = total", abs(ps[-1]["amount"] - T["total"]) <= TOL,
            f"{ps[-1]['amount']} vs {T['total']}")

    unmapped = [l for l in L if not l.get("seller_sage_sku")]
    guess = [l for l in L if l.get("category_source") in ("keyword_guess", None)]
    passed = all(c["passed"] for c in checks)
    status = "auto_ok" if passed else "needs_review"
    conf = sum(c["passed"] for c in checks) / max(len(checks), 1)
    doc["validation"] = {
        "status": status,
        "confidence": round(conf, 3),
        "checks": checks,
        "supervision_needed": {
            "unmapped_skus": len(unmapped),
            "unconfirmed_categories": len(guess),
            "qb_vendor_unset": doc["vendor"].get("qb_vendor_name") is None,
            "qb_terms_unset": bool(h.get("terms")) and not h.get("qb_terms"),
        },
    }
    return doc


# ---------------------------------------------------------------- driver
def extract(path, forced_vendor=None, templates=None, keep_text=False):
    templates = templates or load_templates()
    pages, method = pdf_text(path)
    if keep_text:
        _raw = "\f".join(pages)
        return _attach(_extract(path, forced_vendor, templates, pages, method), _raw)
    return _extract(path, forced_vendor, templates, pages, method)


def _attach(doc, raw):
    doc["_raw_text"] = raw
    return doc


def _extract(path, forced_vendor, templates, pages, method):
    full = "\n".join(pages)
    base = {"schema_version": "1.0",
            "source": {"file": Path(path).name, "file_note": filename_note(Path(path).name),
                       "pages": len(pages), "text_method": method}}
    slug = identify(full, templates, forced_vendor)
    if not slug:
        return {**base, "vendor": {"slug": None, "name": None}, "header": {}, "lines": [], "totals": {},
                "validation": {"status": "unsupported", "checks": [{"check": "vendor_identified", "passed": False,
                                                                    "detail": "no template matched"}]}}
    tpl = templates[slug]
    for pat, why in tpl.get("unsupported_patterns", {}).items():
        if re.search(pat, full, re.I):
            return {**base, "vendor": {"slug": slug, "name": tpl["vendor_name"]}, "header": {}, "lines": [],
                    "totals": {}, "validation": {"status": "unsupported", "checks": [
                        {"check": "document_type", "passed": False, "detail": why}]}}
    variant = next((v for v in tpl["variants"] if re.search(v["match"], full, re.I)), None)
    if not variant:
        return {**base, "vendor": {"slug": slug, "name": tpl["vendor_name"]}, "header": {}, "lines": [],
                "totals": {}, "validation": {"status": "needs_review", "checks": [
                    {"check": "layout_variant", "passed": False,
                     "detail": "vendor recognised but layout is new — add a template variant"}]}}
    doc = PARSERS[tpl["parser"]](pages, tpl, variant, method)
    # header fallbacks: other places on the page, then the file name (scans often garble the header block)
    hh = doc["header"]
    for field, rxs in variant.get("header_fallback", {}).items():
        if hh.get(field):
            continue
        for rx in ([rxs] if isinstance(rxs, str) else rxs):
            src = Path(path).name if rx.startswith("file:") else full
            val = first(rx[5:] if rx.startswith("file:") else rx, src)
            if val:
                if field.endswith("_date"):
                    val = iso(val, variant.get("date_format", "%m/%d/%Y"))
                if val:
                    hh[field] = val
                    hh.setdefault("notes", []).append(f"{field} read from {'the file name' if rx.startswith('file:') else 'a fallback spot on the page'}")
                    break
    doc = {"schema_version": "1.0",
           "vendor": {"slug": slug, "name": tpl["vendor_name"], "account_number": doc["header"].pop("account_number", None)},
           **doc}
    doc["header"].pop("remit_to", None)
    doc["header"].setdefault("currency", "USD")
    doc["source"] = {**base["source"], "template": f"{slug}:{variant['id']}", "template_version": tpl["version"]}
    doc = enrich(doc, slug, tpl)
    doc = validate(doc, variant)
    priceless = len(re.findall(r"^\s*[\d,]+\s+[\d,]+\s+[A-Z]{2,4}\s+[A-Z0-9][A-Z0-9\-]+\s*$", full, re.M))
    if re.search(r"redact|redated", Path(path).name, re.I) or (priceless and not doc["lines"]):
        doc["validation"]["status"] = "unsupported"
        doc["validation"]["checks"].append({"check": "redacted_copy", "passed": False,
            "detail": "prices removed from this copy — process the original invoice instead"})
    if method == "ocr":
        ok = doc["validation"]["status"] == "auto_ok" and doc.get("lines")
        if not ok:
            doc["validation"]["status"] = "needs_review"
        doc["validation"]["checks"].append({"check": "text_source", "passed": bool(ok),
            "detail": "scanned PDF read by OCR — every line and total re-added and matched" if ok else "scanned PDF read by OCR — verify numbers"})
        doc["source"]["ocr"] = True
    return doc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["extract"])
    ap.add_argument("path")
    ap.add_argument("--out", default="out")
    ap.add_argument("--vendor")
    a = ap.parse_args()
    p = Path(a.path)
    files = sorted(f for f in p.iterdir() if f.suffix.lower() == ".pdf") if p.is_dir() else [p]
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    templates = load_templates()
    summary, seen = [], {}
    for f, d in ((f, d) for f in files for d in extract_all(f, a.vendor, templates)):
        key = (d["vendor"].get("slug"), d.get("header", {}).get("invoice_number"))
        if key[1] and key in seen:
            d["validation"]["status"] = "needs_review"
            d["validation"]["checks"].append({"check": "duplicate", "passed": False,
                                              "detail": f"same invoice # as {seen[key]}"})
        elif key[1]:
            seen[key] = f.name
        name = (d.get("header", {}).get("invoice_number") or f.stem).replace("/", "_")
        (out / f"{d['vendor'].get('slug') or 'unknown'}_{name}__{f.stem.replace(' ','_')}{'_p'+d['source']['part'].split('/')[0] if d['source'].get('part') else ''}.json").write_text(json.dumps(d, indent=2))
        summary.append((f.name, d["validation"]["status"], len(d.get("lines", [])),
                        d.get("totals", {}).get("total"),
                        "; ".join(c["check"] + (": " + c["detail"] if c["detail"] else "")
                                  for c in d["validation"]["checks"] if not c["passed"])))
    for s in summary:
        print(f"{s[1]:13} {s[2]:>3} lines  total {s[3]!s:>12}  {s[0]}  {s[4]}")
    from collections import Counter
    print(Counter(s[1] for s in summary))


if __name__ == "__main__":
    main()
