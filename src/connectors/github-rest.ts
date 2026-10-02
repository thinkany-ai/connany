import {z} from 'zod';
const segment=z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/).refine(v=>v!=='.'&&v!=='..');
const repo={owner:segment,repo:segment};
const paging={page:z.number().int().min(1).max(10000).default(1),limit:z.number().int().min(1).max(100).default(20)};
const number=z.number().int().positive();
const text=z.string().min(1).max(1000);
const file=z.string().min(1).max(1000).refine(v=>v.split('/').every(p=>p&&p!=='.'&&p!=='..')&&!v.includes('\\'),'Use a relative repository path without dot segments.');
const e=encodeURIComponent;
const base=(i:any)=>`/repos/${e(i.owner)}/${e(i.repo)}`;
const query=(values:Record<string,unknown>)=>new URLSearchParams(Object.entries(values).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)])).toString();
const list=(i:any)=>query({page:i.page,per_page:i.limit,state:i.state,sha:i.sha});
type Operation={connector:'github';description:string;keywords:string;read_only:boolean;required_permissions:string[];schema:z.ZodObject;request:(i:any)=>{path:string;method?:string;body?:unknown}};
const op=(description:string,keywords:string,permissions:string[],shape:z.ZodRawShape,request:Operation['request'],readOnly=true):Operation=>({connector:'github',description,keywords,read_only:readOnly,required_permissions:permissions,schema:z.object(shape).strict(),request});
export const githubRestTools={
 'github.me.get':op('Get the authenticated GitHub user.','用户 我 身份 profile',['None'],{},()=>({path:'/user'})),
 'github.repository.get':op('Get repository metadata.','仓库 详情',['Metadata: read'],repo,i=>({path:base(i)})),
 'github.branches.list':op('List repository branches.','分支 列表',['Contents: read'],{...repo,...paging},i=>({path:`${base(i)}/branches?${list(i)}`})),
 'github.commits.list':op('List commits, optionally on a branch or SHA.','提交 历史',['Contents: read'],{...repo,...paging,sha:text.optional()},i=>({path:`${base(i)}/commits?${list(i)}`})),
 'github.commit.get':op('Get a commit and changed files.','提交 差异',['Contents: read'],{...repo,ref:text},i=>({path:`${base(i)}/commits/${e(i.ref)}`})),
 'github.files.get':op('Read a file or list a directory. File content may be base64; GitHub file-size limits apply.','文件 内容 目录 代码',['Contents: read'],{...repo,path:file.optional(),ref:text.optional()},i=>({path:`${base(i)}/contents${i.path?'/'+i.path.split('/').map(e).join('/'):''}?${query({ref:i.ref})}`})),
 'github.pull_requests.list':op('List pull requests.','PR 拉取请求 列表',['Pull requests: read'],{...repo,...paging,state:z.enum(['open','closed','all']).default('open')},i=>({path:`${base(i)}/pulls?${list(i)}`})),
 'github.pull_requests.get':op('Get a pull request.','PR 拉取请求 详情',['Pull requests: read'],{...repo,pull_number:number},i=>({path:`${base(i)}/pulls/${i.pull_number}`})),
 'github.pull_requests.files':op('List changed files and available patches in a pull request.','PR 差异 diff 修改文件',['Pull requests: read'],{...repo,pull_number:number,...paging},i=>({path:`${base(i)}/pulls/${i.pull_number}/files?${list(i)}`})),
 'github.issues.list':op('List repository issues; GitHub also includes pull requests in this response.','事项 问题 issue 列表',['Issues: read'],{...repo,...paging,state:z.enum(['open','closed','all']).default('open')},i=>({path:`${base(i)}/issues?${list(i)}`})),
 'github.issues.get':op('Get an issue.','事项 问题 issue 详情',['Issues: read'],{...repo,issue_number:number},i=>({path:`${base(i)}/issues/${i.issue_number}`})),
 'github.branches.create':op('Create a branch from an existing commit SHA.','创建 新建 分支',['Contents: write'],{...repo,branch:text,sha:z.string().regex(/^[a-fA-F0-9]{40}$/)},i=>({path:`${base(i)}/git/refs`,method:'POST',body:{ref:`refs/heads/${i.branch}`,sha:i.sha}}),false),
 'github.files.put':op('Create or update one file and commit it. Content must be base64. Updating requires the current file SHA. Explicit branch required.','创建 更新 修改 写入 文件 代码 提交',['Contents: write','Workflows: write when editing .github/workflows'],{...repo,path:file,branch:text,message:text,content:z.string().max(20000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),sha:z.string().regex(/^[a-fA-F0-9]{40}$/).optional()},i=>({path:`${base(i)}/contents/${i.path.split('/').map(e).join('/')}`,method:'PUT',body:{message:i.message,content:i.content,branch:i.branch,sha:i.sha}}),false),
 'github.issues.create':op('Create an issue.','创建 新建 issue 问题 事项',['Issues: write'],{...repo,title:text,body:z.string().max(20000).optional()},i=>({path:`${base(i)}/issues`,method:'POST',body:{title:i.title,body:i.body}}),false),
 'github.issues.comment':op('Add a comment to an issue or pull request.','评论 回复 issue PR',['Issues: write OR Pull requests: write'],{...repo,issue_number:number,body:z.string().min(1).max(20000)},i=>({path:`${base(i)}/issues/${i.issue_number}/comments`,method:'POST',body:{body:i.body}}),false),
 'github.pull_requests.create':op('Create a pull request from an existing head branch into a base branch.','创建 新建 PR 拉取请求',['Pull requests: write'],{...repo,title:text,head:text,base:text,body:z.string().max(20000).optional(),draft:z.boolean().default(false)},i=>({path:`${base(i)}/pulls`,method:'POST',body:{title:i.title,head:i.head,base:i.base,body:i.body,draft:i.draft}}),false),
} as const;
