# 部署 Connany

所有命令默认在仓库根目录执行。镜像使用根目录 `Dockerfile`，包含编译后的服务、数据库迁移和管理员命令，不需要在运行容器中安装开发依赖。

**服务启动时会自动执行未完成的数据库迁移**（事务 + advisory lock，多副本同时启动也安全），所以在 Dokploy、Railway 等平台只需配置环境变量，无需额外的迁移步骤。下文 Compose 的 `migrate` 服务和 Kubernetes 的 initContainer 保留为显式的迁移步骤，能让迁移失败时更早暴露；与自动迁移同时存在没有问题。如需由外部流程统一执行迁移，设置 `MIGRATE_ON_START=false` 关闭自动迁移。

| 方式 | 数据库 | 配置 |
| --- | --- | --- |
| [Docker Compose](#docker-compose) | 自动创建 PostgreSQL 16 + 持久卷 | `deploy/docker/.env` |
| [Kubernetes](#kubernetes) | 自备 PostgreSQL 15+，推荐托管数据库 | `connany-runtime` Secret |

部署前确定公开域名。`PUBLIC_BASE_URL` 必须为 HTTPS origin（不能含路径），本机试用可用 `http://localhost:3000`。所有副本必须使用相同数据库、公开域名和 `TOKEN_ENCRYPTION_KEY`。

## Docker Compose

要求 Docker Engine / Docker Desktop 和 Compose v2。

```bash
cp deploy/docker/.env.example deploy/docker/.env
chmod 600 deploy/docker/.env
openssl rand -hex 24       # 填入 POSTGRES_PASSWORD
openssl rand -base64 32    # 填入 TOKEN_ENCRYPTION_KEY
```

编辑 `.env` 填入生成的值，生产使用真实 `PUBLIC_BASE_URL=https://connect.example.com`。数据库密码使用上述十六进制值，避免在连接字符串中额外转义。

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yaml up -d --build
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yaml ps -a
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yaml logs migrate
# 密码交互输入，不回显；至少 8 位。
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yaml exec app \
  node dist/scripts/create-admin.js admin@example.com
curl --fail http://localhost:3000/health
```

启动顺序：数据库健康 → 迁移成功 → 启动应用。打开 `/admin` 配置连接器，`/docs` 查看 API。若端口已占用，修改 `HTTP_PORT`；本地试用同时调整 `PUBLIC_BASE_URL` 的端口。

应用只绑定宿主机 `127.0.0.1`，PostgreSQL 不暴露宿主端口。生产由宿主机的 HTTPS 反向代理转发到 `127.0.0.1:3000`（或你的 HTTP_PORT），保留 Host、Origin、Cookie、查询参数；不重写 `/oauth/*`，不缓存 API 和授权页面，不记录 OAuth URL/query。若使用容器化代理，将其加入同一网络并代理 `app:3000`。

升级前备份数据库和加密密钥，然后：

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yaml build
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yaml stop app
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yaml run --rm migrate
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yaml up -d app
```

仅在迁移成功后继续启动；升级步骤有短暂停机。`down` 保留数据卷；**不要运行 `down -v`，除非明确要删除数据库**。不要为了更新版本重新生成密钥，也不要直接更改已初始化数据库的密码（需先在数据库中轮换）。

使用外部数据库时可以直接运行镜像：

```bash
docker build -t connany:local .
# deploy/k8s/.env 可作为模板：另存为 .env.production，加入 PUBLIC_BASE_URL 和 PORT=3000。
# DATABASE_URL 必须是容器可访问的地址，不能照搬宿主机 localhost。
docker run --rm --env-file .env.production connany:local node dist/scripts/migrate.js
docker run --rm -it --env-file .env.production connany:local \
  node dist/scripts/create-admin.js admin@example.com
docker run -d --name connany --restart unless-stopped --init \
  --env-file .env.production -p 127.0.0.1:3000:3000 connany:local
```

## Kubernetes

参考 grouter 的 Deployment + Service + Ingress 组织方式，运行凭证独立为 Secret。本目录不创建或修改现有集群，也不包含数据库、真实域名或仓库凭证。

### 1. 准备镜像和数据库

准备 PostgreSQL 15+。GitHub Actions 在测试通过后自动构建镜像并推送到 GHCR（amd64 + arm64）：

| 触发 | 镜像标签 |
| --- | --- |
| 推送到 `main` | `ghcr.io/thinkany-ai/connany:main`、`:sha-<完整提交号>` |
| 推送版本标签 `v1.2.3` | `:1.2.3`、`:1.2`、`:latest`、`:sha-<完整提交号>` |

`main` 标签会随每次推送变化；生产建议使用版本标签、`sha-` 标签或 digest。仓库为私有时镜像也是私有的，拉取前需要用有 `read:packages` 权限的 GitHub Token 登录 `ghcr.io`（集群中配置 imagePullSecret）。

也可以自行构建推送到你的镜像仓库：

```bash
# platform 应与集群节点架构一致。
docker buildx build --platform linux/amd64 \
  -t <你的镜像地址>:<标签> --push .
```

将 `deploy/k8s/connany.yaml` 中 **initContainer 与应用容器两处镜像**改为同一版本。修改 `PUBLIC_BASE_URL`；修改 `ingress.yaml` 中两处域名、Ingress class 与 TLS 配置。模板假设已有 nginx Ingress controller 和名为 `letsencrypt-prod` 的 cert-manager ClusterIssuer；其他网关需使用相应配置。已有证书时删掉 cert-manager annotation，将 TLS Secret 改成你的证书。

### 2. 注入运行配置

```bash
kubectl apply -f deploy/k8s/namespace.yaml
cp deploy/k8s/.env.example deploy/k8s/.env
chmod 600 deploy/k8s/.env
openssl rand -base64 32    # 填入 TOKEN_ENCRYPTION_KEY
```

编辑 `.env` 中的数据库地址和密钥。数据库账号密码中的特殊字符需 URL 编码，TLS 按数据库服务要求配置；私有 CA 需另外挂载受信任 CA 并配置客户端信任。`kubectl --from-env-file` 的值不要加引号。

```bash
kubectl -n connany create secret generic connany-runtime \
  --from-env-file=deploy/k8s/.env --dry-run=client -o yaml | kubectl apply -f -
```

私有镜像还需创建 `registry-credentials` 类型的镜像拉取 Secret，并启用 Deployment 中的 `imagePullSecrets` 注释块。该凭证仅需拉取权限；不要把运行 Secret 或 registry token 提交到仓库。

### 3. 启动应用

```bash
kubectl apply -f deploy/k8s/connany.yaml
kubectl -n connany rollout status deployment/connany --timeout=300s
kubectl -n connany exec -it deployment/connany -c connany -- \
  node dist/scripts/create-admin.js admin@example.com
kubectl apply -f deploy/k8s/ingress.yaml
curl --fail https://connect.example.com/health
```

initContainer 在应用启动前执行迁移；迁移使用事务、版本记录和 PostgreSQL advisory lock，多副本并发启动不会重复执行。迁移失败时 Pod 不会启动应用，可运行 `kubectl -n connany logs deployment/connany -c migrate` 排查。

应用无本地持久数据，可增加 replicas；每个进程最多 10 个数据库连接，应按数据库容量设置副本数。readiness 检查数据库，liveness 检查 TCP 监听，避免数据库暂时不可用导致所有 Pod 重启。

### 4. 升级和维护

备份数据库与加密密钥，修改两处镜像后重新 `kubectl apply -f deploy/k8s/connany.yaml`，再检查 rollout。更新 Secret 后运行 `kubectl -n connany rollout restart deployment/connany`。使用相同 `main` 标签重新发布镜像时也需要显式 rollout restart。

滚动升级期间旧、新版本会短暂共存，迁移必须兼容旧代码。不兼容迁移需先安排维护窗口并将副本缩到 0。应用回滚可用 `kubectl rollout undo`，但**数据库迁移不会自动回滚**，需先确认 schema 兼容性。

## 必须持久保存的内容

- PostgreSQL：管理员、连接器配置、项目及 API Key 哈希、用户连接及加密后的凭证。
- `TOKEN_ENCRYPTION_KEY`：32 字节随机值的 base64 编码，丢失后数据库中的平台凭证无法解密。不可直接替换已有密钥；轮换需配套重加密迁移。
- 公开域名：更换后需同步 GitHub App 回调，并重新保存 Notion / Linear 配置，处理已有连接迁移。

更多约束见 [架构与运行](../docs/operations.md) 和 [连接器配置](../docs/connector-setup.md)。

配置参考：[Compose 启动依赖](https://docs.docker.com/compose/how-tos/startup-order/)、[Kubernetes init containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/)。
