(() => {
  // ===================== Amazon listing -> Shopify variant guesser =====================
  // Scores every live Shopify variant against an Amazon listing (title + seller SKU) and returns the best
  // candidates with the reasons. Used by the "Amazon matching" tab; shared with tests (window.JTMatch).
  //
  // Signals: Shopify SKU / barcode written in the listing, brand, product words (weighted by rarity), and
  // attributes that must agree when both sides state them: pack size, string gauge, grip size, colour.
  // "2 Packs of <string>" style listings are matched as 2 Shopify units.

  const STOP = new Set(("the a an and or of for with in on to by from x w new pro tennis racquet racket racquets rackets " +
    "sporting goods unisex adult adults mens men womens women s set pack packs pk count ct pcs piece pieces grip grips size " +
    "inch inches in ft feet foot mm g gauge strung unstrung pre prestrung choice colors colour color colours multiple default title " +
    "fba fbm nc sal wsl dt tp").split(" ").filter(w => w !== "pro"));
  const BRANDS = [
    ["Wilson", ["wilson", "wil"]], ["Babolat", ["babolat", "bab"]], ["Head", ["head", "hed"]], ["Yonex", ["yonex", "yon", "ynx"]],
    ["Selkirk", ["selkirk"]], ["Tecnifibre", ["tecnifibre", "tec", "tfx"]], ["Dunlop", ["dunlop", "dun"]], ["Joola", ["joola"]],
    ["Solinco", ["solinco", "sol"]], ["Diadem", ["diadem"]], ["Luxillon", ["luxilon", "luxillon", "luxilion", "lux"]], ["Tifosi", ["tifosi"]],
    ["Lacoste", ["lacoste"]], ["K Swiss", ["kswiss", "k-swiss"]], ["New Balance", ["newbalance"]], ["Gamma", ["gamma"]],
    ["Penn", ["penn"]], ["ProPenn", ["propenn"]], ["Kirschbaum", ["kirschbaum"]], ["Gosen", ["gosen"]], ["Match Tuff", ["matchtuff", "ezscore"]],
    ["Paddletek", ["paddletek"]], ["Engage Pickleball", ["engage"]], ["CRBN", ["crbn"]], ["Gearbox", ["gearbox"]], ["Six Zero", ["sixzero"]],
    ["Franklin", ["franklin"]], ["Onix", ["onix"]], ["Pro Kennex", ["prokennex"]], ["Slazenger", ["slazenger"]], ["Gexco", ["gexco"]],
  ];
  const COLORS = [
    ["white", ["white", "wht", "wh", "w"]], ["black", ["black", "blk", "bk", "bl"]], ["green", ["green", "grn", "gr"]],
    ["yellow", ["yellow", "ylw", "yel", "yl", "y"]], ["red", ["red", "rd", "r"]], ["pink", ["pink", "pnk"]],
    ["blue", ["blue", "blu"]], ["orange", ["orange", "or", "o", "burn"]], ["purple", ["purple", "pur", "prp", "pr", "dp", "lilac", "palelilac"]],
    ["grey", ["grey", "gray", "gry", "anthracite", "anthra", "an", "graphite", "gt"]], ["silver", ["silver", "si", "slv", "s"]],
    ["natural", ["natural", "nat", "n", "xn"]], ["lime", ["lime"]], ["mint", ["mint"]], ["gold", ["gold"]], ["teal", ["teal"]],
  ];
  const colorWord = new Map(); for (const [c, ws] of COLORS) for (const w of ws) if (w.length > 2) colorWord.set(w, c);
  const colorAbbr = new Map(); for (const [c, ws] of COLORS) for (const w of ws) colorAbbr.set(w, c);

  const norm = (t) => String(t || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const lower = (t) => String(t || "").toLowerCase();
  const ALIAS = { junior: "jr", jnr: "jr", racket: "racquet", rackets: "racquet", racquets: "racquet", over: "over", champions: "champion", grips: "grip", strings: "string", balls: "ball", dampeners: "dampener", overgrips: "overgrip" };
  function words(t) {
    return lower(t).replace(/['’]s\b/g, "s").replace(/['’]/g, "").replace(/(\d)\.(\d)/g, "$1_$2").split(/[^a-z0-9_]+/).filter(Boolean).map(w => ALIAS[w] || w);
  }
  // pieces like "hyper-g" -> "hyperg" too, so "Hyper G" / "Hyper-G" / "HyperG" meet
  const JOINS = new Map();   // joined token -> its two words ("speedmp" -> speed, mp)
  function tokens(t, joins = true) {
    const w = words(t), out = new Set();
    for (let i = 0; i < w.length; i++) {
      const x = w[i]; if (!STOP.has(x) && !/^\d+$/.test(x)) out.add(x);
      const nx = w[i + 1];
      if (joins && nx && x.length <= 8 && nx.length <= 4 && !STOP.has(x) && !/^\d+$/.test(x) && !STOP.has(nx)
          && (!/^\d+$/.test(nx) || (x.length <= 5 && nx.length <= 3 && !/^(pack|pk|packs|count|ct|can|ft|feet|m|wraps)$/.test(w[i + 2] || "")))) { out.add(x + nx); JOINS.set(x + nx, [x, nx]); }
    }
    return out;
  }

  // ---- attributes ----
  function packOf(t) {
    const s = lower(t);
    let m = /\b(\d{1,3})\s*-?\s*(?:pack|pk|wraps|count|ct|grips|er)\b/.exec(s) || /\(\s*(\d{1,3})\s*pk\s*\)/.exec(s) || /\b(\d{1,3})x\s*(?:wraps)?\b/.exec(s)
      || /pack of (\d{1,3})\b/.exec(s) || /(\d{1,3})\s*can case/.exec(s) || /\b(\d{1,2})\s+(?:tennis\s+)?overgrips?\b/.exec(s);
    if (!m) return null;
    const n = +m[1]; return n >= 2 && n <= 200 ? n : null;
  }
  function multOf(title, sku) {
    const m = /^\s*(\d)\s*packs? of\b/i.exec(title || "") || /^\s*(\d)\s*x\s/i.exec(title || "") || /^\s*([2-6])\s+of\b/i.exec(title || "")
      || (catOfListing(title) === "string" ? /\b([2-6])\s*-?\s*(?:packs?|sets|pk)\b/i.exec(title || "") || /x([2-6])(?:1[5-9])/i.exec(sku || "") : null);
    if (m) return +m[1];
    const s = norm(sku); const k = /([2-6])X(?:HG|1[5-9])/.exec(s) || /X([2-6])1[5-9]/.exec(s) || /([2-6])PK(?:16|17|18|15)/.exec(s);
    if (/strin|gut|poly|hyper|set/i.test(title || "") && k) return +k[1];
    return 1;
  }
  const MM = { 135: "15L", 130: "16", 132: "16", 128: "16", 127: "16L", 126: "16L", 125: "16L", 124: "17", 123: "17", 122: "17", 120: "17", 118: "17", 117: "18", 115: "18", 110: "19" };
  function gaugeOf(t) {
    const s = lower(t); const out = {};
    let m = /\b1[._](\d{2})\s*mm\b/.exec(s) || /\b1[._](\d{2})\b/.exec(s) || /\((1\d{2})\)/.exec(s) || /\b(1[1-3]\d)\s*(?:mm|\)|\/)/.exec(s);
    if (m) out.mm = +(m[1].length === 2 ? "1" + m[1] : m[1]);
    m = /\b(1[5-9]l?)\s*(?:g\b|ga\b|gauge|guage|\()/.exec(s) || /\bgauge\s*(1[5-9]l?)\b/.exec(s) || /\((1[5-9]l?)\)/.exec(s) || /\b(1[5-9]l?)g\b/.exec(s) || /(?:^|[^0-9])(1[5-9]l)(?:[^0-9a-z]|$)/.exec(s);
    if (m) out.g = m[1].toUpperCase();
    if (!out.g && out.mm && MM[out.mm]) out.g = MM[out.mm];
    return out.g || out.mm ? out : null;
  }
  // Listings often just say "Hyper-G 17" or "Natural Gut 125": bare gauge / mm numbers count for strings.
  function gaugeOfListing(title, sku) {
    const g = gaugeOf(title); if (g) return g;
    if (catOfListing(title) !== "string") return gaugeOf(sku);
    const s = lower(title) + " " + lower(sku).replace(/[()\-_]/g, " ");
    let m = /(?:^|[^0-9.])(1[5-9]l)(?![0-9])/.exec(s); if (m) return { g: m[1].toUpperCase() };
    m = /(?:^|[^0-9.$])(1[1-3]\d)(?![0-9])/.exec(lower(title)); if (m && MM[+m[1]]) return { mm: +m[1], g: MM[+m[1]] };
    m = /(?:^|[^0-9.$])(1[5-9])(?![0-9]|\s*(?:pack|pk|ft|feet|m\b|meter|can))/.exec(lower(title)); if (m) return { g: m[1] };
    m = /\((1[1-3]\d)\)/.exec(sku || "") || /[a-z](1[1-3]\d)(?:[a-z]|$)/.exec(lower(sku).replace(/[^a-z0-9]/g, "")); if (m && MM[+m[1]]) return { mm: +m[1], g: MM[+m[1]] };
    m = /(?:[a-z(]|^)(1[5-9]l?)(?:[)a-z]|$)/.exec(lower(sku).replace(/[^a-z0-9()]/g, "")); if (m) return { g: m[1].toUpperCase() };
    return null;
  }
  const GRIPS = { "0": "0", "1": "1", "2": "2", "3": "3", "4": "4", "5": "5" };
  function gripOf(t, sku) {
    const s = lower(t);
    let m = /\b4\s*(0|1|3|5)\/8\b/.exec(s); if (m) return { "0": "0", "1": "1", "3": "3", "5": "5" }[m[1]];
    m = /\b4\s*1\/4\b/.exec(s) || /\bl2\b/.exec(s); if (m) return "2";
    m = /\b4\s*1\/2\b/.exec(s); if (m) return "4";
    m = /\bgrip\s*(?:size)?\s*([0-5])\b/.exec(s); if (m) return m[1];
    if (sku) { m = /\((0[0-5])\)/.exec(sku) || /[A-Z]0([0-5])(?:[A-Z]|$)/.exec(norm(sku).replace(/NC$|F$|FBA$/, "")); if (m) return GRIPS[m[1].slice(-1)]; }
    return null;
  }
  function gripOfVariant(t) {
    const s = lower(t);
    let m = /(?:^|[^0-9])4?\s*(0|1|3|5)\/8(?![0-9])/.exec(s); if (m) return { "0": "0", "1": "1", "3": "3", "5": "5" }[m[1]];
    if (/(?:^|[^0-9])4?\s*1\/4(?![0-9])/.test(s)) return "2";
    if (/(?:^|[^0-9])4?\s*1\/2(?![0-9])/.test(s)) return "4";
    m = /\bg([0-5])\b/.exec(s) || /\bl([0-5])\b/.exec(s); if (m) return m[1];
    return null;
  }
  function colorsOf(t, skuText) {
    const out = new Set();
    for (const w of words(t)) { const c = colorWord.get(w); if (c) out.add(c); }
    if (!out.size && skuText) {
      // abbreviations inside the seller SKU, e.g. WIL-POG(BLK)30PK, 06YNX3WHNC
      const parts = lower(skuText).split(/[^a-z]+/).filter(Boolean);
      for (const p of parts) { const c = colorAbbr.get(p); if (c && p.length >= 2) out.add(c); }
      if (!out.size) for (const p of parts) for (const [ab, c] of colorAbbr) if (ab.length >= 3 && p.includes(ab)) out.add(c);
    }
    return out;
  }
  // All brands named in the title (e.g. "WILSON Luxilon ALU Power" = Wilson + Luxilon); else from the SKU prefix.
  function brandsOf(title, sku) {
    const w = words(title); const n = norm(sku).toLowerCase(); const t = lower(title).replace(/[^a-z]/g, "");
    const out = BRANDS.filter(([b, al]) => al.some(a => a.length >= 4 && (w.includes(a) || (a.length >= 6 && t.includes(a))))).map(x => x[0]);
    if (out.length) return out;
    return BRANDS.filter(([b, al]) => al.some(a => a.length === 3 && (n.startsWith(a) || n.slice(2).startsWith(a) || n.slice(3).startsWith(a)))).map(x => x[0]).slice(0, 1);
  }
  const brandOf = (title, sku) => brandsOf(title, sku)[0] || null;

  // What kind of product a listing / Shopify product type is.
  function catOfListing(t) {
    const s = lower(t);
    if (/racquet|racket/.test(s) && /\d{2}x\d{2}|pre-?strung|\bstrung\b|grip size|\b4\s*[0-5]\/[248]|\b(junior|jr)\b/.test(s) && !/string set|tennis string\b|string -/.test(s)) return "racquet";
    if (/racquet grip|racket grip|replacement grip/.test(s)) return "grip";
    if (/\d\.\d{2}\s*mm|\b12\s?m\b|\b200\s?m\b|40'|40 ?ft/.test(s) && !/racquet|racket|shoe/.test(s)) return "string";
    if (/\b(string|strings|gut|multifilament|monofilament|reel|polyester)\b|poly ?tour|alu power|hyper-?g|x-one|triax|nxt|lynx|hawk touch|rpm blast/.test(s)) return "string";
    if (/overgrip|over grip|over-grip|super ?grap|\bgrap\b|wraps|prime tour|pro overgrip/.test(s)) return "overgrip";
    if (/replacement grip|leather|hydrosorb|sublime|contour|\bgrip tape|handle grip/.test(s)) return "grip";
    if (/dampener|\bdamp\b|vibration/.test(s)) return "dampener";
    if (/\bballs?\b|\bcans?\b/.test(s)) return "balls";
    if (/\bbag\b|backpack|duffel|tour bag/.test(s)) return "bag";
    if (/\bshoes?\b|sneaker/.test(s)) return "shoes";
    if (/paddle/.test(s)) return "paddle";
    if (/racquet|racket/.test(s)) return "racquet";
    return null;
  }
  function catOfType(t) {
    const s = lower(t);
    if (/string/.test(s)) return "string";
    if (/overgrip|over grip/.test(s)) return "overgrip";
    if (/replacement grip/.test(s)) return "grip";
    if (/dampener/.test(s)) return "dampener";
    if (/\bballs\b|pickleballs/.test(s)) return "balls";
    if (/bag|backpack/.test(s)) return "bag";
    if (/shoe/.test(s)) return "shoes";
    if (/paddle/.test(s)) return "paddle";
    if (/racquet/.test(s)) return "racquet";
    return s ? "other" : null;
  }
  const MODELS = new Set(["mp", "s", "pro", "lite", "team", "tour", "elite", "os", "l", "ul"]);
  const modelsOf = (title) => new Set((String(title || "").match(/\b(MP|S|Pro|PRO|Lite|LITE|Team|TEAM|Tour|TOUR|Elite|OS|L|UL)\b/g) || []).map(x => x.toLowerCase()));
  // junior racquet length: 17" .. 26"
  function jrLenOf(title, sku) {
    let m = /\b(1[7-9]|2[0-6])\s*(?:"|”|in\b|inch)/i.exec(title || "") || /\b(?:jr|junior)\s*(1[7-9]|2[0-6])\b/i.exec(title || "") || /\b(1[7-9]|2[0-6])\s*(?:v\d|jr|junior)\b/i.exec(title || "") || /\((1[7-9]|2[0-6])(?:-\d+)?\)/.exec(sku || "");
    return m ? m[1] : null;
  }
  // model numbers in racquet names: "Pro Staff 97", "Clash 108", "Precision 100" (not grip, gauge, pack or length)
  function modelNums(t) {
    const s = lower(t).replace(/\b4\s*[0-5]\/[248]\b|\b[0-5]\/[248]\b/g, " ").replace(/\b\d{1,3}\s*(?:pack|pk|count|ct|cans?|balls|inch|in\b|"|”|mm|m\b|ft|feet|l\b|g\b|gauge|oz)/g, " ")
      .replace(/\(\d+\)/g, " ").replace(/\b(?:grip size|size)\s*\d\b/g, " ");
    return new Set((s.match(/\b(8[5-9]|9\d|1[0-3]\d)\b/g) || []));
  }
  const SPORT = /\b(padel|pickleball|squash|badminton|junior|jr|kids?)\b/;

  // ---- index over the catalog ----
  function buildIndex(cat) {
    const df = new Map(), byTok = new Map(), bySku = new Map(), byBar = new Map();
    for (const v of cat) {
      const text = [v.product, v.variant, v.title, v.sku].join(" ");
      v._tok = tokens(text); v._ptok = tokens(v.product || v.title, false);
      v._pack = packOf(v.variant) || packOf(v.product) || packOf(v.title);
      v._gauge = gaugeOf(v.variant) || gaugeOf(v.title);
      v._grip = gripOfVariant(v.variant || "") || null;
      v._colors = colorsOf(v.variant || v.title);
      v._model = (() => { const m = /^\s*([A-Za-z]+)\s*\//.exec(v.variant || ""); const k = m && m[1].toLowerCase(); return k && MODELS.has(k) ? k : null; })();
      v._cat = catOfType(v.type);
      v._years = new Set((String(v.product || v.title).match(/\b20[12]\d\b/g) || []));
      v._nums = v._cat === "racquet" || v._cat === "paddle" ? modelNums(v.product || v.title) : new Set();
      v._jr = /junior|\bjr\b/i.test(v.type + " " + v.product) ? ((/\b(1[7-9]|2[0-6])\b/.exec(v.variant || "") || /\b(1[7-9]|2[0-6])\b/.exec(v.product || "") || [])[1] || null) : null; v._sport = new Set((lower(v.product || v.title).match(new RegExp(SPORT.source, "g")) || []).map(x => x === "junior" ? "jr" : x));
      v._sku = norm(v.sku); v._bar = norm(v.barcode).replace(/^0+/, "");
      for (const t of v._tok) { df.set(t, (df.get(t) || 0) + 1); const l = byTok.get(t) || []; l.push(v); byTok.set(t, l); }
      if (v._sku.length >= 5) { const l = bySku.get(v._sku) || []; l.push(v); bySku.set(v._sku, l); }
      if (v._bar.length >= 8) byBar.set(v._bar, v);
    }
    const N = cat.length;
    const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)));
    return { cat, byTok, bySku, byBar, idf, skus: [...bySku.keys()].filter(k => k.length >= 6) };
  }

  // ---- guess ----
  function guess(ix, listing, opts = {}) {
    const title = listing.title || "", sku = listing.sku || "";
    const text = title + " " + sku.replace(/[()\-_]/g, " ");
    const L = {
      brand: brandOf(title, sku), brands: new Set(brandsOf(title, sku)), tok: tokens(title), pack: packOf(title) || packOf(sku.replace(/(\d)PK/i, "$1 pk")), gauge: gaugeOfListing(title, sku),
      cat: catOfListing(title), models: modelsOf(title), nums: modelNums(title), years: new Set((title.match(/\b20[12]\d\b/g) || [])), jr: jrLenOf(title, sku), sport: new Set((lower(title).match(new RegExp(SPORT.source, "g")) || []).map(x => x === "junior" ? "jr" : x)),
      grip: gripOf(title, sku), colors: colorsOf(title, sku), mult: multOf(title, sku), code: norm(title + " " + sku),
    };
    // Shopify SKU written in the listing (e.g. "(WRZ4005WH)", "AC102-12W")
    const codeHits = new Set();
    for (const w of (title + " " + sku).split(/[\s,()\[\]]+/)) { const k = norm(w); if (k.length >= 5 && ix.bySku.has(k)) for (const v of ix.bySku.get(k)) codeHits.add(v); }
    // candidates: variants sharing a rare-enough word (brand-filtered when the brand is known)
    const cand = new Map();
    // the brand is a filter, not evidence: leave its words out of the word overlap
    const brandWords = new Set([...L.brands].flatMap(b => [...tokens(b)].concat((BRANDS.find(x => x[0] === b) || [0, []])[1])));
    const isBrandTok = (t) => brandWords.has(t) || [...brandWords].some(b => b.length >= 4 && t.startsWith(b));
    const ltoks = [...L.tok].filter(t => (ix.byTok.get(t) || []).length > 0 && !isBrandTok(t));
    const wsum = ltoks.reduce((a, t) => a + ix.idf(t), 0) || 1;
    for (const t of ltoks) {
      const list = ix.byTok.get(t); if (list.length > 2500) continue;
      for (const v of list) { if (L.brands.size && !L.brands.has(v.vendor)) continue; cand.set(v, (cand.get(v) || 0) + ix.idf(t)); }
    }
    for (const v of codeHits) if (!cand.has(v)) cand.set(v, 0);
    // a joined listing word ("speed mp") also counts for a product that has both words apart ("Speed Legend MP")
    for (const t of ltoks) { const pr = JOINS.get(t); if (!pr) continue; for (const [v, sc] of cand) if (!v._tok.has(t) && v._tok.has(pr[0]) && v._tok.has(pr[1])) cand.set(v, sc + ix.idf(t)); }
    const out = [];
    for (const [v, shared] of cand) {
      const why = []; let s = shared / wsum;                             // share of the listing's words found in the product
      const pw = [...v._ptok]; const pmiss = pw.filter(t => !L.tok.has(t) && !isBrandTok(t) && ix.idf(t) > 2.5).length;
      s -= Math.min(0.45, pmiss * 0.12);                                  // product words the listing doesn't mention
      const lmiss = ltoks.filter(t => ix.idf(t) > 5.5 && !v._tok.has(t) && !JOINS.has(t)).length;
      s -= Math.min(0.3, lmiss * 0.1);                                    // distinctive listing words the product lacks
      if (L.cat && v._cat && v._cat !== "other") { if (L.cat === v._cat) s += 0.2; else s -= 0.5; }
      for (const sp of v._sport) if (!L.sport.has(sp)) s -= 0.3;          // padel / pickleball / junior product, listing doesn't say so
      for (const sp of L.sport) if ((sp === "padel" || sp === "pickleball" || (sp === "jr" && v._cat === "racquet")) && !v._sport.has(sp)) s -= 0.6;
      if (L.years.size && (v._cat === "racquet" || v._cat === "paddle" || v._cat === "shoes")) {
        if ([...v._years].some(y => L.years.has(y))) { s += 0.15; why.push("year"); } else s -= v._years.size ? 0.4 : 0.2;
      }
      if (L.nums.size && v._nums.size) { if ([...v._nums].some(n => L.nums.has(n))) { s += 0.2; why.push("model " + [...v._nums].join("/")); } else s -= 0.5; }
      if (L.jr && v._jr) { if (L.jr === v._jr) { s += 0.3; why.push(v._jr + '"'); } else s -= 0.6; }
      // racquet model within a family: "Radical S" vs "Radical MP"
      if (L.models.size && v._model) { if (L.models.has(v._model)) { s += 0.2; why.push("model " + v._model.toUpperCase()); } else s -= 0.25; }
      if (codeHits.has(v)) { s += 1.2; why.push("SKU in listing"); }
      if (L.brands.has(v.vendor)) why.push("brand");
      if (L.pack && v._pack) { if (L.pack === v._pack) { s += 0.25; why.push(v._pack + " pack"); } else s -= 0.8; }
      else if (L.pack && !v._pack && L.pack > 1) s -= 0.15;
      else if (!L.pack && v._pack && v._pack > 1 && !/grip|overgrip|dampener|ball/i.test(title)) s -= 0.1;
      if (L.gauge && v._gauge) {
        const ok = (L.gauge.mm && v._gauge.mm && Math.abs(L.gauge.mm - v._gauge.mm) <= 1) || (L.gauge.g && v._gauge.g && L.gauge.g === v._gauge.g);
        const bad = (L.gauge.mm && v._gauge.mm && Math.abs(L.gauge.mm - v._gauge.mm) > 2) || (!L.gauge.mm && L.gauge.g && v._gauge.g && L.gauge.g !== v._gauge.g);
        if (ok) { s += 0.3; why.push("gauge " + (v._gauge.g || v._gauge.mm)); } else if (bad) s -= 0.7;
      }
      if (L.grip != null && v._grip != null) { if (L.grip === v._grip) { s += 0.3; why.push("grip"); } else s -= 0.8; }
      else if (L.grip != null && v._grip == null && /racquet|racket/i.test(v.type || "")) s -= 0.1;
      if (L.colors.size && v._colors.size) { if ([...v._colors].some(c => L.colors.has(c))) { s += 0.25; why.push("colour"); } else s -= 0.45; }
      if (v.status === "ACTIVE") s += 0.03; else if (v.status === "ARCHIVED") s -= 0.05;
      if (v.cost != null) s += 0.02;
      const catOk = !(L.cat && v._cat && v._cat !== "other" && L.cat !== v._cat);
      out.push({ v, score: Math.round(s * 1000) / 1000, why, catOk, cover: shared / wsum });
    }
    out.sort((a, b) => b.score - a.score);
    const top = out.slice(0, opts.limit || 6);
    const best = top[0], second = top[1];
    let conf = "low";
    if (best) {
      const gap = best.score - (second ? second.score : 0);
      if (best.why.includes("SKU in listing") && gap > 0.2) conf = "high";
      else if (best.score >= 0.95 && gap >= 0.15 && best.catOk && best.cover >= 0.45) conf = "high";
      else if (best.score >= 0.7 && gap >= 0.08 && best.catOk) conf = "medium";
    }
    // "Dampener 2 Pack" sold against a single dampener in Shopify: 2 units
    let units = L.mult;
    if (best && units === 1 && L.pack > 1 && !best.v._pack && L.cat === "dampener") units = L.pack;
    return { listing: L, units, conf, top };
  }

  window.JTMatch = { buildIndex, guess, _t: { packOf, gaugeOf, gripOf, gripOfVariant, colorsOf, brandOf, multOf, tokens } };
})();
