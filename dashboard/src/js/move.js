(() => {
  // One-time move: copies the Amazon and cost-check data this Claude page keeps in its own storage into
  // Supabase (jt.docs), so the web dashboard can use it. Shown only inside the Claude page.
  const JT = window.JT, bar = document.getElementById("move-bar");
  if (!bar || !JT || JT.standalone || !(window.claude && window.claude.use)) return;
  const COLS = ["amzmap", "amzlistings", "amzmonths", "costlog", "costalerts", "amzdays"];
  const MAX = 300000;   // characters of JSON per database call
  const $ = (id) => document.getElementById(id);
  const say = (html) => { $("move-status").innerHTML = html; };

  async function copy(db) {
    const btn = $("move-go"); btn.disabled = true;
    try {
      const all = [], counts = {};
      for (const c of COLS) {
        say(`Reading ${c}…`);
        const snap = await db.collection(c).limit(1000).get();
        counts[c] = snap.docs.length;
        for (const d of snap.docs) all.push({ c, i: d.id, d: d.data() });
      }
      const batches = []; let cur = [], size = 0;
      for (const x of all) {
        const n = JSON.stringify(x).length;
        if (cur.length && size + n > MAX) { batches.push(cur); cur = []; size = 0; }
        cur.push(x); size += n;
      }
      if (cur.length) batches.push(cur);
      let sent = 0;
      for (let b = 0; b < batches.length; b++) {
        say(`Copying ${sent.toLocaleString()} of ${all.length.toLocaleString()} records (${b + 1} of ${batches.length})…`);
        await JT.run(`with ins as (insert into jt.docs (collection, id, data)
            select x->>'c', x->>'i', x->'d' from jsonb_array_elements(${JT.q(JSON.stringify(batches[b]))}::jsonb) x
            on conflict (collection, id) do update set data = excluded.data, updated_at = now() returning 1)
          select count(*)::int as n from ins`, true);
        sent += batches[b].length;
      }
      const check = await JT.run(`select collection, count(*)::int as n from jt.docs group by 1 order by 1`, true);
      const got = Object.fromEntries(check.map(r => [r.collection, r.n]));
      const bad = COLS.filter(c => (got[c] || 0) < counts[c]);
      say(bad.length ? `<span class="neg">Some records are missing in Supabase (${bad.join(", ")}). Press the button again.</span>`
        : `<b>Done.</b> Copied ${all.length.toLocaleString()} records: ${COLS.map(c => `${c} ${counts[c]}`).join(" · ")}. You can close this; the web dashboard now has this data.`);
      btn.disabled = false; btn.textContent = "Copy again";
    } catch (e) {
      say(`<span class="neg">Stopped: ${String(JT.message(e))}</span> Press the button to try again (records already copied are simply updated).`);
      btn.disabled = false;
    }
  }

  window.claude.use("db").then(db => {
    if (!db) return;
    bar.hidden = false;
    $("move-go").addEventListener("click", () => copy(db));
  }).catch(() => {});
})();
