// codexgrill — site behaviors
// 1) theme toggle (dark default, localStorage-backed)
// 2) copy-to-clipboard on code blocks
// 3) tabbed command panels
// 4) active-section highlighting in nav

(function () {
  'use strict';

  // ---------- theme toggle ----------
  const THEME_KEY = 'codexgrill.theme';
  const root = document.documentElement;

  function applyTheme(theme) {
    root.setAttribute('data-bs-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (_) { /* private mode */ }
  }

  // initial (default: dark unless user previously chose light)
  const saved = (() => {
    try { return localStorage.getItem(THEME_KEY); } catch (_) { return null; }
  })();
  applyTheme(saved === 'light' ? 'light' : 'dark');

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-toggle]');
    if (!btn) return;
    const next = root.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });

  // ---------- copy buttons ----------
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const block = btn.closest('.code-block');
    if (!block) return;
    const code = block.querySelector('pre code, pre');
    if (!code) return;
    const text = code.innerText.replace(/\s+$/, '');
    try {
      await navigator.clipboard.writeText(text);
      const label = btn.querySelector('.copy-label');
      const original = label ? label.textContent : '';
      btn.classList.add('copied');
      if (label) label.textContent = 'Copied';
      setTimeout(() => {
        btn.classList.remove('copied');
        if (label) label.textContent = original || 'Copy';
      }, 1400);
    } catch (_) {
      // clipboard API blocked — silent
    }
  });

  // ---------- command tabs ----------
  document.querySelectorAll('[data-tabs]').forEach((group) => {
    const buttons = group.querySelectorAll('.cg-tab-btn');
    const panels  = document.querySelectorAll('[data-tabs-panel-group="' + group.dataset.tabs + '"] .cg-tab-panel');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        panels.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.dataset.tabTarget;
        const panel = document.querySelector('[data-tabs-panel="' + target + '"]');
        if (panel) panel.classList.add('active');
      });
    });
  });

  // ---------- active section in nav ----------
  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('.cg-nav .nav-link[href^="#"]');
  if (sections.length && navLinks.length && 'IntersectionObserver' in window) {
    const linkMap = new Map();
    navLinks.forEach((l) => linkMap.set(l.getAttribute('href').slice(1), l));

    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const link = linkMap.get(entry.target.id);
        if (!link) return;
        if (entry.isIntersecting) {
          navLinks.forEach((l) => l.classList.remove('active'));
          link.classList.add('active');
        }
      });
    }, { rootMargin: '-40% 0px -55% 0px' });

    sections.forEach((s) => io.observe(s));
  }

  // ---------- year stamp ----------
  const y = document.querySelector('[data-year]');
  if (y) y.textContent = new Date().getFullYear();
})();
