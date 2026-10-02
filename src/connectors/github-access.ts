import type { ConnectorAccess } from './catalog.js';

/** GitHub Apps grant repository access by installing the App into accounts or organizations. */
export const githubAccess: ConnectorAccess = {
  label: '添加组织 / 仓库',
  needsAccess: identity => identity.needs_installation === true,
  addUrl: runtime => runtime.installUrl(),
  async list({ call, page, limit }) {
    const result = await call('github.installations.list', { page, limit }) as any;
    return {
      total: result.total_count,
      data: (result.installations || []).map((installation: any) => {
        let manageUrl: string | null = null;
        try {
          const url = new URL(installation.html_url);
          if (url.origin === 'https://github.com' && !url.username && !url.password) manageUrl = url.toString();
        } catch {}
        return { id: String(installation.id), type: installation.account?.type === 'Organization' ? 'organization' : 'user',
          name: installation.account?.login || String(installation.id), selection: installation.repository_selection === 'all' ? 'all' : 'selected',
          suspended: !!installation.suspended_at, manage_url: manageUrl };
      }),
    };
  },
};
