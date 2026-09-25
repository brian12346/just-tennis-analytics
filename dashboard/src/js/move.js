(() => {
  // Leftover from the move to Supabase: two documents that only exist in the Claude page's own storage.
  // Inside Claude, copy each one into jt.docs if Supabase doesn't have it yet (never overwrites). Remove once done.
  const JT = window.JT;
  if (!JT || JT.standalone || !(window.claude && window.claude.use)) return;
  const DOCS = [["amzmeta", "titles"], ["costs", "catalog"]];
  Promise.all([window.claude.use("db"), JT.getMcp()]).then(async ([db, mcp]) => {
    if (!db || !mcp) return;
    for (const [c, id] of DOCS) {
      try {
        const have = await JT.run(`select 1 as x from jt.docs where collection = ${JT.q(c)} and id = ${JT.q(id)}`, true);
        if (have.length) continue;
        const d = await db.collection(c).doc(id).get();
        if (!d.exists) continue;
        await JT.run(`insert into jt.docs (collection, id, data) values (${JT.q(c)}, ${JT.q(id)}, ${JT.q(JSON.stringify(d.data()))}::jsonb)
          on conflict (collection, id) do nothing returning 1 as ok`, true);
        console.info("[JT] copied", c + "/" + id, "to Supabase");
      } catch (e) { console.warn("[JT] copy of", c + "/" + id, "failed", e && e.code); }
    }
  }).catch(() => {});
})();
