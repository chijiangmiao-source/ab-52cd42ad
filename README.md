# 深海探测阵列 · 检查点屏障对齐回放台

多条乱序链路回收后，确认一次检查点不会把已越过屏障的数据混入此前状态，
浏览器中断后也不会重复计入。本项目以流处理屏障对齐（barrier alignment）
为模型，提供事件录入、Worker 内持久化回放与逐步通道状态查看。

## 核心规则

1. **2–4 条输入通道、最多 48 项事件**，事件按捕获顺序排列，类型为
   `data` / `barrier` / `fault` / `reopen`。
2. 每条通道的数据序号 `seq` 必须**连续严格递增**。
3. 某检查点屏障先到一个通道后，该通道的后续 `data` 进入**缓存**；
   直到**全部通道**的同编号屏障到齐，才封存累计状态，并按**捕获原序**释放缓存。
4. 封存状态区分两个口径：
   - `sealedTotals`：屏障时刻、缓存释放**之前**的状态（已越过屏障的数据不混入）；
   - `totals`（发布快照）：缓存按原序释放**之后**的完整累计状态。
5. **Worker 内三阶段持久化**（严格顺序，缺一不算发布）：
   `intent → snapshot（含输入序号）→ publish 发布标记`。
6. 故障（`fault`）抹除所有未完整发布的片段；重开（`reopen`）只采用
   **最新完整发布**的检查点，把处理指针倒回 `inputIndex + 1`，从日志
   原序重放其后事件。缓存项已并入快照，倒回窗口不包含它们，**杜绝重复计入**。
7. 屏障失配、编号回退/跳号、重复屏障、序号断层、错误释放/重复数据，
   均**定位首个事件**（返回事件 ID 与捕获序号）。

在 `barrier` 行选择“崩溃注入阶段 = intent / snapshot”，可在该检查点
（封存触发事件上）持久化中途注入崩溃，用于验证“故障注入后重开不得显示
半完成快照”。

## 页面展示内容

- 每个检查点**纳入的数据范围**（各通道 from→to 的序号清单）；
- 每项缓存数据的**缓存原因**（等待哪些通道的同编号屏障）与封存后释放顺序；
- 重开时的**恢复起点**（采用的检查点、重放起始输入序号、被忽略的半完成片段）；
- 每一步各通道的**当前累计值**、已观测/已计入末序号、屏障位置、缓存队列；
- 事件时间线（重放步以“重放”标记区分）。

## 本地运行（无第三方运行时依赖）

```bash
npm install --cache /tmp/npm-cache   # 仅构建需要 esbuild
npm run build                        # 产出 dist/
npm start                            # 默认 0.0.0.0:8080
curl http://127.0.0.1:8080/healthz
```

## Docker Compose

宿主端口可通过 `.env` 中的 `HOST_PORT`（默认 `8080`）或环境变量配置：

```bash
HOST_PORT=9090 docker compose up --build web
```

- `web` 服务提供页面与 `/healthz` 健康响应（容器内 8080）；
- `verify` 服务为一次性任务：运行屏障/恢复/错误边界代码测试、页面构建、
  HTTP 冒烟后退出，**以退出码报告结果**（0 全部通过）：

```bash
docker compose build
docker compose run --rm verify
```

## verify 流程（等价于容器 verify 服务）

```bash
npm run verify
```

依次执行：单元测试（`node --test`）→ esbuild 页面构建 →
HTTP 冒烟测试 → 真实启动服务器请求 `/healthz`、`/`、`/assets/app.js`，
任一失败即以退出码 1 报告。

## 目录结构

```
src/shared/events.js     事件模型与录入校验（首个错误事件定位）
src/shared/aligner.js    屏障对齐引擎（缓存、封存、释放、失配检测）
src/shared/replayer.js   三阶段持久化存储 + 故障/重开/倒回重放编排
src/web/worker.js        回放 Worker
src/web/app.js           页面逻辑（录入、整段回放、逐步状态）
src/server/server.js     静态页面与 /healthz
test/                    单元测试与 HTTP 冒烟
scripts/build.mjs        esbuild 构建
scripts/verify.mjs       verify 编排（退出码报告）
```
