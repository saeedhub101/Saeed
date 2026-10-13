// Applies a language add-on's translations to the current window: swaps known English texts
// for their translation and sets right-to-left layout when the language needs it. Runs once at
// startup and keeps watching for new content (the Settings/Add-ons windows redraw a lot).
const api = window.api;

function walk(root, strings) {
  const skip = new Set(['SCRIPT', 'STYLE']);
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (skip.has(n.parentNode && n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  let n;
  while ((n = tw.nextNode())) {
    const raw = n.nodeValue, key = raw.trim();
    if (key && strings[key]) n.nodeValue = raw.replace(key, strings[key]);
  }
  if (root.querySelectorAll) {
    for (const el of root.querySelectorAll('[placeholder],[title],[aria-label]')) {
      for (const attr of ['placeholder', 'title', 'aria-label']) {
        const v = el.getAttribute(attr);
        if (v && strings[v.trim()]) el.setAttribute(attr, strings[v.trim()]);
      }
    }
    if (root.value !== undefined && strings[root.value]) root.value = strings[root.value];
  }
}

export async function applyI18n() {
  let r;
  try { r = await api.uiStrings(); } catch { return; }
  if (!r || r.code === 'en' || !r.strings || !Object.keys(r.strings).length) return;
  document.documentElement.lang = r.code;
  document.documentElement.dir = r.rtl ? 'rtl' : 'ltr';
  walk(document.body, r.strings);
  new MutationObserver((muts) => {
    for (const m of muts) for (const node of m.addedNodes) if (node.nodeType === 1 || node.nodeType === 3) walk(node.nodeType === 1 ? node : node.parentNode, r.strings);
  }).observe(document.body, { childList: true, subtree: true });
}
