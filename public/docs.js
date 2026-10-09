(() => {
  const language = document.documentElement.lang;
  const messages = {
    'zh-CN': {copied:'已复制',selected:'已选中，请手动复制',failed:'复制失败，请下载 Markdown'},
    'zh-HK': {copied:'已複製',selected:'已選取，請手動複製',failed:'複製失敗，請下載 Markdown'},
    en: {copied:'Copied',selected:'Text selected. Copy it manually.',failed:'Copy failed. Download the Markdown instead.'}
  };
  const t = key => (messages[language] || messages.en)[key];
  const picker = document.querySelector('#docs-language');
  const url = new URL(location.href);
  if (!url.searchParams.has('lang')) {
    try { const saved=localStorage.getItem('connany.language');if(['zh-CN','zh-HK'].includes(saved)){url.searchParams.set('lang',saved);location.replace(url);return;} } catch {}
  }
  picker?.addEventListener('change',()=>{
    try { localStorage.setItem('connany.language',picker.value); } catch {}
    url.searchParams.set('lang',picker.value);location.assign(url);
  });
  let timer;
  document.querySelectorAll('[data-copy-code]').forEach(button => button.addEventListener('click',async()=>{
    const code=button.closest('.docs-code').querySelector('pre code');
    const status=document.getElementById('copy-status');
    try { await navigator.clipboard.writeText(code.textContent);status.textContent=t('copied'); }
    catch { const range=document.createRange();range.selectNodeContents(code);getSelection().removeAllRanges();getSelection().addRange(range);status.textContent=t('selected'); }
    clearTimeout(timer);timer=setTimeout(()=>status.textContent='',2500);
  }));
  document.querySelectorAll('[data-copy-target]').forEach(button => button.addEventListener('click',async()=>{
    const source=document.getElementById(button.dataset.copyTarget);
    const status=document.getElementById('copy-status');
    try { await navigator.clipboard.writeText(source.value);status.textContent=t('copied'); }
    catch { status.textContent=t('failed'); }
    clearTimeout(timer);timer=setTimeout(()=>status.textContent='',2500);
  }));
  const links=[...document.querySelectorAll('.docs-layout>nav a')];
  const sections=[...document.querySelectorAll('.docs-section')];
  function update() {
    const current=sections.filter(section=>section.getBoundingClientRect().top<=140).at(-1)||sections[0];
    links.forEach(link=>{if(link.hash==='#'+current?.id)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');});
  }
  document.addEventListener('scroll',update,{passive:true});update();
})();
