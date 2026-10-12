// Left nav: how many entries each payout page has waiting to post (the same rules as the pages' "To post" lists) —
// Amazon settlements not in QuickBooks; per Shopify store, paid payouts since the switch not in QuickBooks plus finished
// weeks of other payments, and for Just Tennis finished PayPal fee months. Refreshed on every page change.
(() => {
  const Q = `select
    (select count(*) from fin.v_amz_settlements where posted = '{}'::jsonb and coalesce(cardinality(a2x_docs), 0) = 0) as amz,
    (select count(*) from fin.shopify_payouts p where p.store = 'justtennis' and p.posted = '{}'::jsonb and cardinality(p.a2x_docs) = 0 and p.status = 'PAID'
       and p.issued_at >= (coalesce(fin.shop_cfg(p.store)->>'start', '2026-10-01'))::date - 14)
     + (select count(*) from fin.v_shop_pay_weeks where store = 'justtennis' and posted = '{}'::jsonb and complete)
     + (select count(*) from fin.v_paypal_months where posted = '{}'::jsonb and complete and (fees <> 0 or disputes <> 0)) as shop,
    (select count(*) from fin.shopify_payouts p where p.store = 'acenrally' and p.posted = '{}'::jsonb and cardinality(p.a2x_docs) = 0 and p.status = 'PAID'
       and p.issued_at >= (coalesce(fin.shop_cfg(p.store)->>'start', '2026-10-01'))::date - 14)
     + (select count(*) from fin.v_shop_pay_weeks where store = 'acenrally' and posted = '{}'::jsonb and complete) as anr`;
  let busy = false;
  async function refresh() {
    if (busy) return; busy = true;
    try {
      const [r] = await FIN.sql(Q, true);
      for (const el of document.querySelectorAll(".nav-n[data-count]")) {
        const n = +(r && r[el.dataset.count]) || 0;
        el.textContent = n; el.hidden = !n;
        el.title = n ? `${n} to post` : "";
      }
    } catch (_) { /* counts are a convenience: the pages say what's waiting */ }
    busy = false;
  }
  window.addEventListener("fin:page", () => FIN.ready.then(refresh));
  // after anything is posted or checked (the amzpay function), count again
  const fn = FIN.fn;
  FIN.fn = async (...a) => { try { return await fn(...a); } finally { if (a[0] === "amzpay") setTimeout(refresh, 800); } };
  window.addEventListener("fin:shopother", () => setTimeout(refresh, 1500));
})();
