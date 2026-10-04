(() => {
  const language = document.documentElement.lang;
  const picker = document.querySelector('#docs-language');
  const url = new URL(location.href);
  if (!url.searchParams.has('lang')) {
    try { if(localStorage.getItem('connany.language')==='zh-CN'){url.searchParams.set('lang','zh-CN');location.replace(url);return;} } catch {}
  }
  picker?.addEventListener('change',()=>{
    try { localStorage.setItem('connany.language',picker.value); } catch {}
    url.searchParams.set('lang',picker.value);location.assign(url);
  });
  let timer;
  document.querySelectorAll('[data-copy-code]').forEach(button => button.addEventListener('click',async()=>{
    const code=button.closest('.docs-code').querySelector('pre code');
    const status=document.getElementById('copy-status');
    try { await navigator.clipboard.writeText(code.textContent);status.textContent=language==='zh-CN'?'已复制':'Copied'; }
    catch { const range=document.createRange();range.selectNodeContents(code);getSelection().removeAllRanges();getSelection().addRange(range);status.textContent=language==='zh-CN'?'已选中，请手动复制':'Text selected. Copy it manually.'; }
    clearTimeout(timer);timer=setTimeout(()=>status.textContent='',2500);
  }));
  document.querySelectorAll('[data-copy-target]').forEach(button => button.addEventListener('click',async()=>{
    const source=document.getElementById(button.dataset.copyTarget);
    const status=document.getElementById('copy-status');
    try { await navigator.clipboard.writeText(source.value);status.textContent=language==='zh-CN'?'已复制':'Copied'; }
    catch { status.textContent=language==='zh-CN'?'复制失败，请下载 Markdown':'Copy failed. Download the Markdown instead.'; }
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
