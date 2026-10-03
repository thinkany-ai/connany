(() => {
  'use strict';
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const toast = document.querySelector('#toast');
  let toastTimer;
  function notify(message) {
    toast.textContent = message; toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
  }
  // A gateway in front of Connany can answer with its own HTML page (e.g. on 502/504).
  async function readJson(response) {
    const text = await response.text();
    try { return JSON.parse(text); }
    catch { return { error: { message: `服务器返回了非预期的响应（HTTP ${response.status}），请稍后重试或查看服务日志。` } }; }
  }
  try { const notice = sessionStorage.getItem('connany_notice'); sessionStorage.removeItem('connany_notice'); if (notice) notify(notice); } catch {}
  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const input = document.getElementById(button.dataset.copy);
    try { await navigator.clipboard.writeText(input.value); notify('已复制'); }
    catch { input.focus(); input.select(); notify('已选中文本，请手动复制'); }
  }));
  const dialog = document.querySelector('#key-dialog');
  function closeKey() { document.querySelector('#issued-key').value = ''; window.location.assign(dialog.dataset.return || location.pathname); }
  document.querySelector('#close-key').addEventListener('click', closeKey);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeKey(); });
  // Never persist full keys in local/session storage or expose them through a GET endpoint.
  window.addEventListener('pagehide', () => { document.querySelector('#issued-key').value = ''; });
  const accountMenu = document.querySelector('.account-menu');
  const closeAccountMenu = () => { if (accountMenu) accountMenu.open = false; };
  document.addEventListener('click', event => { if (accountMenu && !accountMenu.contains(event.target)) closeAccountMenu(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && accountMenu?.open) { closeAccountMenu(); accountMenu.querySelector('summary').focus(); }
  });
  accountMenu?.querySelector('[data-dialog]')?.addEventListener('click', closeAccountMenu);
  const settingsDialog = document.querySelector('#account-settings');
  const settingsTabs = [...document.querySelectorAll('[data-settings-tab]')];
  function selectSettingsTab(tab) {
    settingsTabs.forEach(button => {
      const selected = button === tab;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      document.getElementById(button.getAttribute('aria-controls')).hidden = !selected;
    });
  }
  settingsTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectSettingsTab(tab));
    tab.addEventListener('keydown', event => {
      const direction = ['ArrowDown','ArrowRight'].includes(event.key) ? 1 : ['ArrowUp','ArrowLeft'].includes(event.key) ? -1 : 0;
      if (!direction && !['Home','End'].includes(event.key)) return;
      event.preventDefault();
      const next = settingsTabs[event.key === 'Home' ? 0 : event.key === 'End' ? settingsTabs.length-1 : (index+direction+settingsTabs.length)%settingsTabs.length];
      selectSettingsTab(next); next.focus();
    });
  });
  settingsDialog?.addEventListener('close', () => {
    settingsDialog.querySelector('form').reset();
    settingsDialog.querySelector('.form-error').hidden = true;
    accountMenu?.querySelector('summary').focus();
  });
  // Generic dialogs: [data-dialog] opens by id, [data-close] closes, a matching #hash opens on load.
  document.querySelectorAll('[data-dialog]').forEach(button => button.addEventListener('click', () => {
    const target = document.getElementById(button.dataset.dialog);
    if (!target) return;
    history.replaceState(null, '', `#${target.id}`);
    target.showModal();
  }));
  document.querySelectorAll('dialog').forEach(item => {
    item.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => item.close()));
    item.addEventListener('click', event => { if (event.target === item) item.close(); });
    item.addEventListener('close', () => { if (location.hash === `#${item.id}`) history.replaceState(null, '', location.pathname + location.search); });
  });
  const hashed = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (hashed instanceof HTMLDialogElement && hashed.id !== 'key-dialog') hashed.showModal();
  const confirmDialog = document.querySelector('#confirm-dialog');
  // Styled replacement for window.confirm. Resolves true only when the action button is used.
  function confirmAction({ confirm: message, confirmTitle, confirmAction: action, danger }) {
    const ok = document.querySelector('#confirm-ok');
    document.querySelector('#confirm-title').textContent = confirmTitle || '确认操作';
    document.querySelector('#confirm-message').textContent = message;
    ok.textContent = action || '确定';
    ok.classList.toggle('danger', danger !== undefined);
    confirmDialog.returnValue = '';
    confirmDialog.showModal();
    return new Promise(resolve => confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true }));
  }
  document.querySelector('#confirm-ok').addEventListener('click', () => confirmDialog.close('ok'));
  document.querySelectorAll('form[data-api]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    if (form.dataset.confirm && !(await confirmAction(form.dataset))) return;
    const button = form.querySelector('button[type="submit"]');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    const error = form.querySelector('.form-error');
    if (error) error.hidden = true;
    const data = Object.fromEntries(new FormData(form));
    if ('return_urls' in data) data.return_urls = data.return_urls.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    form.querySelectorAll('input[type="checkbox"]').forEach(input => { data[input.name] = input.checked; });
    if (typeof data.enabled === 'string') data.enabled = data.enabled === 'true';
    try {
      const response = await fetch(form.dataset.api, { method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(data) });
      const result = await readJson(response);
      if (!response.ok) {
        if (response.status === 401 && result.error?.code === 'admin_unauthorized') { window.location.assign('/admin/login'); return; }
        const fields = result.error?.fields?.map(f => `${f.path.join('.')}: ${f.message}`).join('\n');
        throw new Error(fields || result.error?.message || '操作失败，请重试。');
      }
      form.querySelectorAll('input[type="password"]').forEach(input => { input.value = ''; });
      if (form.hasAttribute('data-key-result')) {
        document.querySelector('#issued-key').value = result.api_key;
        form.closest('dialog')?.close();
        dialog.dataset.return = result.project ? `/admin/projects/${encodeURIComponent(result.project.id)}` : location.pathname;
        dialog.showModal();
        return;
      }
      if (result.redirect_url) window.location.assign(result.redirect_url);
      else if (form.dataset.redirect) window.location.assign(form.dataset.redirect);
      else if (form.hasAttribute('data-reload')) {
        // Do not reopen the dialog this form was submitted from.
        if (form.closest('dialog')) history.replaceState(null, '', location.pathname + location.search);
        try { sessionStorage.setItem('connany_notice', result.revocation_status === 'failed' ? 'Connany 已断开连接，但平台撤销失败，可重试撤销。' : (form.dataset.success || '操作已完成')); } catch {}
        window.location.reload();
      }
      else notify(form.dataset.success || '操作已完成');
    } catch (failure) {
      // A rejected inline change (e.g. demoting the last administrator) reverts the control.
      if (form.hasAttribute('data-auto-submit')) form.reset();
      if (error) { error.textContent = failure.message || '网络异常，请重试。'; error.hidden = false; }
      else notify(failure.message || '网络异常，请重试。');
    } finally { if (button) button.disabled = false; }
  }));

  const testForm = document.querySelector('#connection-test');
  if (testForm) {
    const key = document.querySelector('#test-key');
    const user = document.querySelector('#test-user');
    const connector = document.querySelector('#test-connector');
    const status = document.querySelector('#test-status');
    const output = document.querySelector('#test-result');
    const githubPanel = document.createElement('div');
    output.before(githubPanel);
    const open = document.querySelector('#test-open');
    const check = document.querySelector('#test-check');
    const read = document.querySelector('#test-read');
    let session = null, connection = null, busy = false;
    function reset() {
      githubPanel.replaceChildren();
      session = null; connection = null; check.disabled = true; read.disabled = true;
      open.hidden = true; open.removeAttribute('href'); output.hidden = true; output.textContent = '';
      status.textContent = '等待创建测试会话。';
    }
    [key,user,connector].forEach(input => input.addEventListener('input', reset));
    window.addEventListener('pagehide', () => { key.value = ''; reset(); });
    async function request(path, body) {
      const response = await fetch('/v1' + path, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error',
        headers: {Authorization: `Bearer ${key.value.trim()}`, 'Content-Type':'application/json'},
        ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal: AbortSignal.timeout(60000)
      });
      const result = await readJson(response);
      if (!response.ok) throw new Error(`${result.error?.code || response.status}: ${result.error?.message || '请求失败'}${result.request_id ? ' · ' + result.request_id : ''}`);
      return result;
    }
    async function run(task) {
      if (busy) return;
      busy = true;
      const controls = [...testForm.querySelectorAll('input,select,button'),check,read];
      controls.forEach(control => { control.disabled = true; });
      try { await task(); } catch (error) { status.textContent = error.message || '请求失败，请重试。'; }
      finally {
        busy = false;
        testForm.querySelectorAll('input,select').forEach(control => { control.disabled = false; });
        testForm.querySelector('button').disabled = !connector.selectedOptions[0] || connector.selectedOptions[0].disabled;
        check.disabled = !session || ['error','expired'].includes(session.status);
        read.disabled = !connection;
      }
    }
    testForm.addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        reset(); status.textContent = '正在验证API Key并创建会话…';
        session = await request(`/connectors/${encodeURIComponent(connector.value)}/sessions`, {external_user_id:user.value});
        open.href = session.connect_url; open.hidden = false;
        status.textContent = '授权链接已生成，15 分钟内有效。打开授权页面，完成后回来检查结果。';
      });
    });
    check.addEventListener('click', () => run(async () => {
      status.textContent = '正在查询授权结果…';
      session = await request(`/connectors/${encodeURIComponent(session.connector)}/sessions/${encodeURIComponent(session.id)}?external_user_id=${encodeURIComponent(user.value)}`);
      connection = session.status === 'connected' ? session.connection_id : null;
      const labels = {pending:'等待打开授权页面。',authorizing:'等待完成平台授权；完成后再次检查。',processing:'正在处理授权，请稍后再次检查。',connected:'授权成功，可以试读数据。',expired:'链接已过期，请重新创建授权链接。',error:`授权失败：${session.error_code || '未知错误'}。检查配置后重新创建链接。`};
      status.textContent = labels[session.status] || session.status;
      if (session.status !== 'pending') { open.hidden = true; open.removeAttribute('href'); }
      output.textContent = JSON.stringify(session,null,2); output.hidden = false;
    }));
    read.addEventListener('click', () => run(async () => {
      status.textContent = '正在读取已授权的数据…'; output.hidden = true; output.textContent = '';
      const toolsPath = `/connections/${encodeURIComponent(connection)}/tools`;
      const callTool = (tool,input) => request(`${toolsPath}/${encodeURIComponent(tool)}/call`,{external_user_id:user.value,input});
      const listTools = () => request(`${toolsPath}?${new URLSearchParams({external_user_id:user.value,limit:'5'})}`);
      let result;
      if (connector.value === 'github') {
        githubPanel.replaceChildren();
        const installations = [];
        let nextPage = 1, addUrl;
        while (nextPage) {
          const response = await request(`/connections/${encodeURIComponent(connection)}/access?${new URLSearchParams({external_user_id:user.value,page:String(nextPage),limit:'100'})}`);
          installations.push(...response.data); addUrl = response.add_url; nextPage = response.next_page;
        }
        const addLink = (label,url,parent) => {
          const parsed = new URL(url);
          if (parsed.origin !== 'https://github.com') return;
          const link = document.createElement('a'); link.textContent = label; link.href = url;
          link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'button secondary'; parent.append(link);
        };
        addLink('添加组织 / 仓库 ↗',addUrl,githubPanel);
        for (const installation of installations) {
          const row = document.createElement('div'); row.className = 'test-actions';
          const label = document.createElement('strong'); label.textContent = installation.name; row.append(label);
          if (installation.manage_url) addLink('管理仓库权限 ↗',installation.manage_url,row);
          const button = document.createElement('button'); button.className = 'button secondary'; button.textContent = '试读此组织仓库';
          button.addEventListener('click', () => run(async () => {
            output.hidden = true;
            const repositories = await callTool('github.repositories.list',{installation_id:Number(installation.id),limit:10});
            output.textContent = JSON.stringify(repositories,null,2); output.hidden = false;
            status.textContent = `${installation.name} 仓库读取成功。`;
          }));
          row.append(button); githubPanel.append(row);
        }
        const tools = await listTools();
        result = {installations,tools};
        status.textContent = installations.length ? '已获取组织列表，请选择组织试读。管理入口可能需要组织管理员权限。' : '账号已连接，尚未添加仓库。可以点击添加组织 / 仓库，完成后再次试读刷新列表。';
      } else {
        result = await listTools();
        status.textContent = '读取成功。空列表表示当前授权范围内没有可见数据。';
      }
      output.textContent = JSON.stringify(result,null,2); output.hidden = false;
    }));
  }
  // Filters apply as soon as a selection changes; paging restarts from the first page.
  // API forms go through the submit handler above; plain GET filters navigate.
  document.querySelectorAll('form[data-auto-submit]').forEach(form => form.addEventListener('change', () => form.dataset.api ? form.requestSubmit() : form.submit()));
  // Connectors page: status and category filters and name search, applied in place.
  const connectorSearch = document.querySelector('[data-connector-search]');
  if (connectorSearch) {
    const statuses = [...document.querySelectorAll('[data-connector-status]')];
    const categories = [...document.querySelectorAll('[data-connector-category]')];
    const cards = [...document.querySelectorAll('[data-connector]')];
    const stored = key => { try { return localStorage.getItem(key) || 'all'; } catch { return 'all'; } };
    const valid = (buttons, attr, value) => buttons.some(b => b.dataset[attr] === value) ? value : 'all';
    let status = valid(statuses, 'connectorStatus', stored('connany.connectorStatus'));
    let category = valid(categories, 'connectorCategory', stored('connany.connectorCategory'));
    // A link to a specific card (from the overview) shows everything so the card is visible.
    if (location.hash.startsWith('#card-') || location.hash.startsWith('#connector-')) status = category = 'all';
    const statusMatch = card => status === 'all' || (card.dataset.enabled === 'true') === (status === 'enabled');
    const apply = () => {
      const query = connectorSearch.value.trim().toLowerCase();
      let shown = 0;
      document.querySelectorAll('.connector-group').forEach(group => {
        let visible = 0;
        group.querySelectorAll('[data-connector]').forEach(card => {
          const match = statusMatch(card) && (category === 'all' || card.dataset.category === category) && (!query || card.dataset.search.includes(query));
          card.hidden = !match; if (match) visible++;
        });
        group.hidden = !visible; shown += visible;
        group.querySelector('[data-group-count]').textContent = `${visible} 个`;
      });
      document.querySelector('[data-connector-empty]').hidden = shown > 0;
      // Category counts follow the selected status so the chips stay truthful.
      categories.forEach(c => {
        const value = c.dataset.connectorCategory;
        const count = cards.filter(card => statusMatch(card) && (value === 'all' || card.dataset.category === value)).length;
        c.querySelector('span').textContent = count; c.classList.toggle('empty', !count);
        c.setAttribute('aria-pressed', String(value === category));
      });
      statuses.forEach(s => s.setAttribute('aria-pressed', String(s.dataset.connectorStatus === status)));
    };
    statuses.forEach(s => s.addEventListener('click', () => { status = s.dataset.connectorStatus; try { localStorage.setItem('connany.connectorStatus', status); } catch {} apply(); }));
    categories.forEach(c => c.addEventListener('click', () => { category = c.dataset.connectorCategory; try { localStorage.setItem('connany.connectorCategory', category); } catch {} apply(); }));
    connectorSearch.addEventListener('input', apply);
    apply();
  }
  document.querySelectorAll('[data-copy-code]').forEach(button => button.addEventListener('click', async () => {
    const code = button.closest('.docs-code').querySelector('pre code');
    try { await navigator.clipboard.writeText(code.textContent); notify('已复制'); }
    catch { const range = document.createRange(); range.selectNodeContents(code); getSelection().removeAllRanges(); getSelection().addRange(range); notify('已选中文本，请手动复制'); }
  }));
  if (document.querySelector('.admin-docs')) {
    const updateDocsNav = () => {
      const docs = [...document.querySelectorAll('.admin-docs')].find(el => el.offsetParent);
      if (!docs) return;
      const sections = [...docs.querySelectorAll('.docs-section')];
      const current = sections.filter(section => section.getBoundingClientRect().top <= 80).at(-1) || sections[0];
      docs.querySelectorAll('.admin-docs-layout>nav a').forEach(link => { if (link.hash === '#' + current?.id) link.setAttribute('aria-current','location'); else link.removeAttribute('aria-current'); });
    };
    document.addEventListener('scroll', updateDocsNav, { passive: true });
    new MutationObserver(updateDocsNav).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    updateDocsNav();
  }
})();
