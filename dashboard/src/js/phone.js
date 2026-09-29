// Phone layout helpers: label table cells for the card view, and the "All columns" toggle on By day.
window.jtLabelCells = function (t) {
  if (!t) return;
  const hs = [...t.querySelectorAll("thead th")].map(th => th.textContent.trim());
  t.querySelectorAll("tbody tr").forEach(tr => [...tr.children].forEach((td, i) => { if (!td.hasAttribute("colspan") && hs[i]) td.setAttribute("data-label", hs[i]); }));
};
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-daycols]"); if (!b) return;
  const p = b.closest(".daycards"); const on = p.classList.toggle("full");
  b.textContent = on ? "Fewer columns" : "All columns";
});
