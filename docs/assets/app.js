// codexgrill — site behaviors
// 1) theme toggle (dark default, localStorage-backed)
// 2) mobile menu
// 3) scroll progress bar
// 4) nav scrolled state
// 5) copy-to-clipboard on code blocks
// 6) tabbed command panels
// 7) active-section highlighting in nav (same-page hash anchors)
// 8) active-page highlighting in nav (cross-page links: index/plan/security)
// 9) year stamp

(function () {
  'use strict';

  const root = document.documentElement;

  // ---------- theme toggle ----------
  const THEME_KEY = 'codexgrill.theme';

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    // keep meta theme-color in sync
    const meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#181614' : '#fdfbf8');
    try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
  }

  const saved = (() => {
    try { return localStorage.getItem(THEME_KEY); } catch (_) { return null; }
  })();
  applyTheme(saved === 'light' ? 'light' : 'dark');

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-toggle]');
    if (!btn) return;
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });

  // ---------- mobile menu ----------
  const nav = document.getElementById('nav');
  const menuBtn = document.getElementById('nav-menu-btn');
  const navLinks = document.getElementById('nav-links');

  function closeMenu() {
    if (!nav) return;
    nav.classList.remove('menu-open');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
  }
  function toggleMenu() {
    if (!nav) return;
    const open = nav.classList.toggle('menu-open');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  if (menuBtn) menuBtn.addEventListener('click', toggleMenu);

  // close menu on link click (mobile)
  if (navLinks) {
    navLinks.addEventListener('click', (e) => {
      if (e.target.closest('a')) closeMenu();
    });
  }
  // close on resize up to desktop
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth > 880 && lastW <= 880) closeMenu();
    lastW = window.innerWidth;
  });
  // close on escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  // ---------- scroll progress + nav state ----------
  const progress = document.querySelector('.scroll-progress span');

  function onScroll() {
    const doc = document.documentElement;
    const scrollTop = window.scrollY || doc.scrollTop;
    const max = (doc.scrollHeight - doc.clientHeight) || 1;
    const pct = Math.max(0, Math.min(100, (scrollTop / max) * 100));
    if (progress) progress.style.width = pct + '%';
    if (nav) {
      if (scrollTop > 6) nav.classList.add('scrolled');
      else nav.classList.remove('scrolled');
    }
  }

  let scrollScheduled = false;
  window.addEventListener('scroll', () => {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      onScroll();
      scrollScheduled = false;
    });
  }, { passive: true });
  onScroll();

  // ---------- copy buttons ----------
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const block = btn.closest('.code-block');
    if (!block) return;
    const code = block.querySelector('pre code, pre');
    if (!code) return;
    const text = code.innerText.replace(/\s+$/, '');
    const label = btn.querySelector('.copy-label');
    const icon  = btn.querySelector('i');
    const originalLabel = label ? label.textContent : '';
    const originalIcon  = icon ? icon.className : '';
    try {
      await navigator.clipboard.writeText(text);
      btn.classList.add('copied');
      if (label) label.textContent = 'Copied';
      if (icon)  icon.className = 'bi bi-check2';
      setTimeout(() => {
        btn.classList.remove('copied');
        if (label) label.textContent = originalLabel || 'Copy';
        if (icon)  icon.className = originalIcon;
      }, 1400);
    } catch (_) {
      // fallback: select + execCommand
      try {
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('copy');
        sel.removeAllRanges();
        if (label) label.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.classList.remove('copied');
          if (label) label.textContent = originalLabel || 'Copy';
        }, 1400);
      } catch (_e) { /* nothing else to do */ }
    }
  });

  // ---------- command tabs ----------
  document.querySelectorAll('[data-tabs]').forEach((group) => {
    const buttons = group.querySelectorAll('.cg-tab-btn');
    const panelHost = document.querySelector('[data-tabs-panel-group="' + group.dataset.tabs + '"]');
    if (!panelHost) return;
    const panels = panelHost.querySelectorAll('.cg-tab-panel');

    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        panels.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        const target = btn.dataset.tabTarget;
        const panel = panelHost.querySelector('[data-tabs-panel="' + target + '"]');
        if (panel) panel.classList.add('active');
      });
    });
  });

  // ---------- active section in nav ----------
  const sections = document.querySelectorAll('section[id], header[id]');
  const navAnchors = document.querySelectorAll('.cg-nav-links a[href^="#"]');
  if (sections.length && navAnchors.length && 'IntersectionObserver' in window) {
    const linkMap = new Map();
    navAnchors.forEach((l) => linkMap.set(l.getAttribute('href').slice(1), l));

    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const link = linkMap.get(entry.target.id);
        if (!link) return;
        if (entry.isIntersecting) {
          navAnchors.forEach((l) => l.classList.remove('active'));
          link.classList.add('active');
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });

    sections.forEach((s) => io.observe(s));
  }

  // ---------- active-page highlight (cross-page nav links) ----------
  // Each top-nav cross-page link carries a `data-nav` attribute (e.g.
  // `data-nav="plan"`). We resolve the current page from window.location
  // and toggle `.active-page` on the matching link. Same-page hash anchors
  // are handled separately by the IntersectionObserver above.
  (function () {
    const pathname = (window.location.pathname || '/').toLowerCase();
    let pageKey = 'index';
    if (pathname.endsWith('/plan.html') || pathname === '/plan') pageKey = 'plan';
    else if (pathname.endsWith('/security.html') || pathname === '/security') pageKey = 'security';
    else if (pathname === '/' || pathname.endsWith('/index.html')) pageKey = 'index';

    document.querySelectorAll('.cg-nav-links a[data-nav]').forEach((a) => {
      if (a.getAttribute('data-nav') === pageKey) {
        a.classList.add('active-page');
        a.setAttribute('aria-current', 'page');
      }
    });
  })();

  // ---------- year stamp ----------
  const y = document.querySelector('[data-year]');
  if (y) y.textContent = new Date().getFullYear();
})();
