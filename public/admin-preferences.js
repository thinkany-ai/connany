(() => {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { const saved = localStorage.getItem('connany.theme'); if (['light','dark','system'].includes(saved)) preference = saved; } catch {}
  function apply() {
    document.documentElement.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference)));
  }
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-theme-choice]');
    if (!button || !['light','dark','system'].includes(button.dataset.themeChoice)) return;
    preference = button.dataset.themeChoice;
    try { localStorage.setItem('connany.theme', preference); } catch {}
    apply();
  });
  media.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', apply);
  apply();
})();
