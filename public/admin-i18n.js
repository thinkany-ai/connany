(() => {
  const messages = {
    '总览':'Overview','连接器':'Connectors','管理工作台':'Console','管理导航':'Main navigation','设置':'Settings','退出登录':'Sign out','打开账号菜单':'Open account menu','用户':'User','账户':'Account','通用':'General','关于':'About','设置分类':'Settings sections','关闭设置':'Close settings',
    '管理你的管理员账号和登录密码。':'Manage your administrator account and password.','管理员账号':'Administrator account','修改密码':'Change password','保存后会退出所有登录会话，请使用新密码重新登录。':'Saving signs you out of all sessions. Sign in again with your new password.','当前密码':'Current password','新密码':'New password','确认新密码':'Confirm new password','12–256 个字符。':'12–256 characters.','取消':'Cancel','保存密码':'Save password',
    '外观与当前设备偏好设置。':'Appearance and preferences for this device.','主题':'Theme','选择控制台配色。跟随系统会使用操作系统设置。':'Choose a console theme. System follows your operating system settings.','浅色':'Light','深色':'Dark','跟随系统':'System','界面语言':'Language','选择控制台使用的界面语言。':'Choose the language used in the console.','Connany · Agent 连接器服务':'Connany · Connectors for agents','连接工具与用户数据':'Connect tools and user data','统一管理账号授权、连接与凭证，让 Agent 在用户授权范围内使用工具。':'Manage account authorization, connections and credentials so agents can use tools within each user’s permissions.','Agent 接入文档 ↗':'Agent integration guide ↗',
    '确定':'Confirm','确认操作':'Confirm action','API Key':'API Key','仅显示一次，请立即保存。':'Shown only once. Save it now.','复制':'Copy','我已保存':'I have saved it','已复制':'Copied','已选中文本，请手动复制':'Text selected. Copy it manually.','已保存':'Saved','保存':'Save','创建':'Create','名称':'Name','状态':'Status','用户连接':'User connections','编辑':'Edit','轮换':'Rotate','停用':'Disable','启用':'Enable','删除':'Delete','暂停':'Pause','配置':'Configure','官网 ↗':'Website ↗','未启用':'Not enabled','已启用':'Enabled','已停用':'Disabled','已暂停':'Paused','已删除':'Deleted','创建 API Key':'Create API Key','暂无 API Key':'No API keys yet','下一页 →':'Next page →','旧版密钥':'Legacy key',
    '旧 key 会立即失效，需同步更新 Agent 后端。':'The old key stops working immediately. Update your agent backend.','停用后此 key 无法调用 Connany，用户连接保留。':'This key will no longer work. Existing user connections are retained.',
    '服务总览':'Service overview','连接，从这里开始。':'Your connections start here.','平台凭证集中配置；每个 agent 独立接入，每位用户单独授权。':'Configure credentials centrally. Each agent has its own access and each user authorizes their own accounts.','共享连接器':'Shared connectors','独立 API Key':'Separate API keys','一次配置，所有接入共用。不同 API Key 的接入空间与用户数据相互隔离。':'Configure once for all integrations. Each API key has an isolated space for its users and connections.','已启用平台':'Enabled providers','可用 API Keys':'Active API keys','已授权用户连接':'Authorized connections','开始接入':'Get started','从配置到调用':'From setup to execution','启用连接器':'Enable connectors','启用官方 MCP，配置 GitHub App 和授权回调。':'Enable official MCP services and configure your GitHub App and OAuth callback.','管理连接器':'Manage connectors','启用第一个连接器':'Enable your first connector','为每个产品生成独立 API key，并登记授权返回地址。':'Create a separate API key for each product.','交给 Agent 接入':'Integrate your agent','提供服务地址、API Key和文档，完成一次真实账号授权。':'Use the service URL, API key and documentation to connect a real account.','查看接入说明 ↗':'View integration guide ↗',
    '一个连接服务，多个 Agent':'One connection service. Multiple agents.','配好一次。':'Configure once.','连接每个 agent。':'Connect every agent.','集中管理平台凭证，为不同 agent 分发独立密钥，让用户授权自己的工作空间。':'Manage provider credentials, issue separate keys to agents and let users authorize their own workspaces.','管理员登录':'Administrator sign-in','邮箱':'Email','密码':'Password','进入工作台 →':'Open console →','首次使用或忘记密码？':'First time here or forgot your password?','在服务端运行以下命令创建管理员或重置密码：':'Run this command on the server to create an administrator or reset a password:','密码至少 12 位。重置后其他登录会话会失效。':'Use at least 12 characters. Resetting the password invalidates existing sessions.',
    '已保存，留空不变':'Saved; leave blank to keep unchanged','创建 GitHub App ↗':'Create GitHub App ↗','管理已有应用 ↗':'Manage existing apps ↗','填写应用地址最后一段，例如 my-app':'Last part of the app URL, e.g. my-app','填写 GitHub App 公开地址的最后一段。例如地址为 github.com/apps/my-app，则填写 my-app。用于生成安装链接，不是 App ID。':'Enter the last part of the public GitHub App URL: for github.com/apps/my-app, enter my-app. This is used for installation links, not the App ID.','回调地址':'Callback URL','复制此地址到 GitHub App 设置中的 Callback URL，需保持完全一致。':'Copy this exact URL into the Callback URL field in your GitHub App settings.','页面、数据库与工作区搜索':'Pages, databases and workspace search','仓库、Issue 与 Pull Request':'Repositories, issues and pull requests','Issue、项目与团队协作':'Issues, projects and team collaboration','仓库、代码、Issue 与 Pull Request':'Repositories, code, issues and pull requests','问题、项目与团队协作':'Issues, projects and team collaboration',
    '授权管理':'Authorization','查看各个 agent 用户授权的账号。断开连接会立即阻止 Connany 后续调用。':'View accounts authorized by agent users. Disconnecting blocks subsequent Connany calls.','接入 ID':'Integration ID','全部 API Keys':'All API keys','平台':'Provider','全部平台':'All providers','筛选':'Filter','账号 / 工作区':'Account / workspace','API Key / 用户':'API key / user','已连接':'Connected','需要重连':'Reconnect required','已断开':'Disconnected','平台撤销失败，可重试':'Provider revocation failed; retry available','确定断开此用户连接？这会撤销对应平台授权，共享的上游授权也可能受到影响。':'Disconnect this account? This revokes provider authorization and may affect shared upstream grants.','重试撤销':'Retry revocation','断开连接':'Disconnect','暂无用户连接。将API Key交给 agent，完成一次用户授权后会显示在这里。':'No connections yet. Connect an account through your agent to see it here.',
    '运行记录':'Activity','操作记录':'Activity log','最近 100 条用户调用与管理员操作，不记录 token、凭证或业务正文。':'The latest 100 user calls and administrator actions. Tokens, credentials and resource content are not logged.','用户连接与调用':'Connections and calls','时间（UTC+8）':'Time (UTC+8)','事件':'Event','操作 / 错误':'Action / error','暂无用户调用记录':'No user calls yet','管理员操作':'Administrator actions','管理员':'Administrator','操作':'Action','对象':'Target','暂无管理员操作':'No administrator actions yet',
    '开发者接入':'Developer integration','把这些交给你的 Agent':'Connect your agent','同一套连接器可供多个 agent 使用。每把 API Key 只访问所属接入空间的用户连接。':'Connectors can be shared by multiple agents. Each API key can access only its own user connections.','复制给开发 Agent':'Instructions for your coding agent','把下面的提示交给负责开发的 agent，密钥通过后端环境变量另行配置。':'Give these instructions to your coding agent. Configure secrets separately through backend environment variables.','复制完整接入提示':'Copy integration instructions','服务地址':'Service URL','复制服务地址':'Copy service URL','在「API Keys」创建密钥，安全发送生成的 API key 给对应开发者。密钥只放在 agent 后端。':'Create a key under API Keys and share it securely with your developer. Store keys only in the agent backend.','最小接入流程':'Minimal integration flow','后端调用':'From your backend, call','，传入已认证用户的 external_user_id 和平台名称。':', passing the authenticated external_user_id and provider.','向该用户展示返回的 connect_url，让用户在浏览器中完成授权。':'Show the connect_url to the user and let them authorize in their browser.','后端查询会话结果，获得 connection_id。':'Poll the session from your backend to obtain the connection_id.','调用':'Call','读取已授权的数据。':'to access authorized data.','完整接入文档':'Full integration documentation','下载 Agent 接入文档':'Download integration guide','下载 TypeScript SDK':'Download TypeScript SDK','应用凭证共用不代表用户授权共用。用户须在各个 Agent 中授权自己的账号；上游平台共享应用的权限和撤销语义仍然适用。':'Shared app credentials do not share user consent. Users authorize their accounts in each agent. The provider’s shared-grant permissions and revocation behavior still apply.',
    '真实 API 联调':'Live API testing','测试一个用户连接':'Test a user connection','使用API Key 验证授权与只读调用。建议创建测试专用 API Key，避免混入正式用户数据。':'Test authorization and read-only calls with an API key. Use a dedicated test key to separate production data.','仅在当前页面内存中使用，刷新后清空。此管理员测试工具直接调用 API；产品接入必须通过 agent 后端。':'Kept only in this page’s memory and cleared on refresh. This administrator tool calls the API directly; product integrations must use an agent backend.','测试用户 ID':'Test user ID','测试平台':'Test provider','1. 创建授权链接':'1. Create authorization link','2. 打开授权页面 ↗':'2. Open authorization page ↗','3. 检查授权结果':'3. Check authorization','4. 试读数据':'4. Test read','等待创建测试会话。':'Waiting for a test session.','如何完成测试':'How to test','在「API Keys」创建密钥并安全保存。':'Create and securely save a key under API Keys.','生成链接，在新标签页完成自己的平台授权。':'Generate a link and authorize your account in a new tab.','回到这里检查结果，再试读数据。':'Return here to check the result and test a read.','Notion：读取官方 MCP 工具目录（不写入内容）；GitHub：列出所有可访问安装，由你选择组织试读仓库；Linear：读取官方 MCP 工具目录。空列表表示 API 调用成功，但没有可见数据。':'Notion and Linear: read the official MCP tool catalog without writing content. GitHub: list accessible installations, then choose an organization to list repositories. An empty list means the call succeeded with no visible data.','GitHub 账号授权后，点击试读数据可查看组织、添加安装或管理仓库权限。修改后重新试读以刷新列表。测试结果仅展示在当前页面。':'After GitHub authorization, test a read to view organizations, add installations or manage repository access. Repeat the read after changes. Results stay on this page.','创建测试 API Key ↗':'Create test API key ↗','测试完成后':'After testing','连接会保留在「用户连接」中，可按测试用户 ID 识别并按需断开。断开可能撤销同一平台应用的共享授权。':'Connections remain in User connections. Find them by test user ID and disconnect as needed. Disconnecting may revoke shared grants for the same provider app.','查看用户连接 ↗':'View user connections ↗','复制 Agent 接入提示 ↗':'Copy agent integration instructions ↗',
    '当前密码不正确。':'The current password is incorrect.','两次输入的新密码不一致。':'The new passwords do not match.','新密码不能与当前密码相同。':'Choose a password different from your current password.','尝试过多，请在 15 分钟后重试。':'Too many attempts. Try again in 15 minutes.','登录尝试过多，请在 15 分钟后重试。':'Too many sign-in attempts. Try again in 15 minutes.','邮箱或密码不正确。':'Incorrect email or password.','请登录管理员账号。':'Sign in with an administrator account.','页面已失效，请刷新后重试。':'This page has expired. Refresh and try again.','管理操作必须从本站页面发起。':'Administrator actions must originate from this site.','请使用 JSON 请求。':'Send a JSON request.','API Key 接入记录不存在。':'API key integration not found.','连接不存在。':'Connection not found.',
    '操作失败，请重试。':'Action failed. Please try again.','操作已完成':'Action completed','网络异常，请重试。':'Network error. Please try again.','请求失败':'Request failed','请求失败，请重试。':'Request failed. Please try again.','未知错误':'Unknown error','Connany 已断开连接，但平台撤销失败，可重试撤销。':'Disconnected in Connany, but provider revocation failed. You can retry revocation.','正在验证API Key并创建会话…':'Validating API key and creating session…','授权链接已生成，15 分钟内有效。打开授权页面，完成后回来检查结果。':'Link created, valid for 15 minutes. Open it, authorize, then return to check the result.','正在查询授权结果…':'Checking authorization…','等待打开授权页面。':'Waiting for the authorization page to open.','等待完成平台授权；完成后再次检查。':'Waiting for provider authorization. Check again when finished.','正在处理授权，请稍后再次检查。':'Processing authorization. Check again shortly.','授权成功，可以试读数据。':'Authorized. You can now test a read.','链接已过期，请重新创建授权链接。':'Link expired. Create a new authorization link.','正在读取已授权的数据…':'Reading authorized data…','添加组织 / 仓库 ↗':'Add organization / repositories ↗','管理仓库权限 ↗':'Manage repository access ↗','试读此组织仓库':'List repositories in this organization','仓库读取成功。':'Repositories retrieved.','已获取组织列表，请选择组织试读。管理入口可能需要组织管理员权限。':'Organizations retrieved. Choose one to list repositories. Management may require organization administrator access.','账号已连接，尚未添加仓库。可以点击添加组织 / 仓库，完成后再次试读刷新列表。':'Account connected, but no repositories added. Add an organization or repositories, then repeat the read.','读取成功。空列表表示当前授权范围内没有可见数据。':'Read succeeded. An empty list means no visible data within the current permissions.'
  };
  function translate(text, language) {
    if (language === 'zh-CN') return text;
    const trimmed=text.trim();
    let translated=messages[trimmed];
    if (translated===undefined) {
      const patterns=[
        [/^(轮换|停用|删除) (.+)？$/,(_,action,name)=>`${messages[action]} ${name}?`],
        [/^key 立即失效，(\d+) 个用户连接将被断开并删除，无法恢复。$/,(_,count)=>`The key stops working immediately. ${count} user connections will be disconnected and permanently deleted.`],
        [/^(Notion|GitHub|Linear) 已(暂停|启用)$/,(_,provider,state)=>`${provider} ${state==='暂停'?'paused':'enabled'}`],
        [/^访问 (.+) 官网（新标签页）$/,(_,name)=>`Visit ${name} website (new tab)`],
        [/^(Notion|GitHub|Linear)（未启用）$/,(_,name)=>`${name} (not enabled)`],
        [/^授权失败：(.*)。检查配置后重新创建链接。$/,(_,code)=>`Authorization failed: ${code}. Check configuration and create a new link.`],
        [/^(管理连接器|启用第一个连接器|创建 API Key) ↗$/,(_,label)=>`${messages[label]} ↗`],
        [/^(.+) · Connany$/,(_,title)=>`${messages[title]||title} · Connany`]
      ];
      for(const [pattern,replacement] of patterns) if(pattern.test(trimmed)){translated=trimmed.replace(pattern,replacement);break;}
    }
    return translated===undefined ? text : text.replace(trimmed,translated);
  }
  let language='en';
  try { if(localStorage.getItem('connany.language')==='zh-CN')language='zh-CN'; } catch {}
  const originals=new WeakMap();
  const attributes=new WeakMap();
  const excluded='script,style,code,pre,textarea,[translate="no"]';
  let observer;
  function render() {
    observer?.disconnect();
    document.documentElement.lang=language;
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()) {
      const node=walker.currentNode;
      if(node.parentElement?.closest(excluded))continue;
      const previous=originals.get(node);
      const source=previous&&node.nodeValue===previous.rendered?previous.source:node.nodeValue;
      const rendered=translate(source,language);
      if(node.nodeValue!==rendered)node.nodeValue=rendered;
      originals.set(node,{source,rendered});
    }
    document.querySelectorAll('[placeholder],[aria-label]').forEach(element=>{
      if(element.closest('[translate="no"]'))return;
      const saved=attributes.get(element)||{};
      for(const name of ['placeholder','aria-label']) {
        if(!element.hasAttribute(name))continue;
        const value=element.getAttribute(name),prior=saved[name];
        const source=prior&&value===prior.rendered?prior.source:value;
        const rendered=translate(source,language);if(value!==rendered)element.setAttribute(name,rendered);
        saved[name]={source,rendered};
      }
      attributes.set(element,saved);
    });
    document.querySelectorAll('[data-language-choice]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.languageChoice===language)));
    const title=document.querySelector('title');
    const prior=originals.get(title);const source=prior&&title.textContent===prior.rendered?prior.source:title.textContent;
    const rendered=translate(source,language);title.textContent=rendered;originals.set(title,{source,rendered});
    observer?.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['placeholder','aria-label']});
  }
  window.ConnanyI18n={translate,get language(){return language;}};
  function start() {
    observer=new MutationObserver(render);render();
    document.addEventListener('click',event=>{
      const button=event.target.closest?.('[data-language-choice]');if(!button)return;
      language=button.dataset.languageChoice==='zh-CN'?'zh-CN':'en';
      try { localStorage.setItem('connany.language',language); } catch {}
      render();
    });
    window.addEventListener('storage',event=>{if(event.key==='connany.language'){language=event.newValue==='zh-CN'?'zh-CN':'en';render();}});
  }
  document.documentElement.lang=language;
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
