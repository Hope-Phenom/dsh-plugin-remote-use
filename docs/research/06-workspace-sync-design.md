# 06 — 工作区同步 + 文件传输子系统设计（`dsh-plugin-remote-use`）

- 设计者：teammate `sync-design`
- 目标版本：DeepSeek Harness Desktop `0.2.0-rc.2`（Electron asar）
- 只读范围：`C:\Users\you\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（未修改）
- 解包镜像：`F:\WorkSpace\dsh-plugin-remote-use\.research\asar\dsh\node_modules\@deepseek-ai\<pkg>\...`
- ACP SDK 镜像：`F:\WorkSpace\dsh-plugin-remote-use\.research\sdk\`
- **证据路径约定**：正文中 `@deepseek-ai/<pkg>/lib/...:LINE` 均指解包镜像内同名文件的行号（与 asar 内一致）。本报告新增一条**本机实测**证据（§2.1），实测脚本未落盘，命令原样引用。

---

## 0. 结论速览

| 议题 | 结论 |
|---|---|
| 同步模型 | **推荐 (d) 混合，但形态是「git 树管被 git 覆盖的文件 + sha256 CAS 管被 ignore 的夹具/二进制 + 非 git 项目退化为纯 CAS」**。三者共用一个 manifest 与一条传输通道，不是三套系统。 |
| git 的角色 | git 只用来**生成 manifest + 打包内容**，绝不用来做「主机 push / 从机 pull 分支」。复用 DSH 自己的 `snapshotTree` 技法：私有 index + 私有 object store + alternates，只 `write-tree`，不动仓库。 |
| git 不可用时 | 从机没有 git 就要能跑（DSH 自己也不捆绑 git，见 §3）。git 层缺席时全部文件走 CAS。 |
| 脏工作区 | 天然覆盖。`git add --all` 进私有 index 后 `write-tree`，快照包含「已修改 + 未跟踪但未被 ignore」的工作树，仓库 index/refs/worktree 全不动。 |
| `.git` 目录 | **默认不传**。原因：体积、宿主历史/凭据泄漏（`.git/config` 可能内嵌 token）、从机拿到 `.git` 后 `git status` 会给出误导性的「干净/脏」结论。需要 git 语义时用 bundle 传一个合成提交，从机侧用 `git init` + `read-tree`/`checkout-index` 物化。 |
| 路径一致性 | **要求从机在完全相同的绝对路径上放一个真实目录**。这是唯一的正解。`subst`/junction 都会被 `fs.realpath` 解析成真实路径（本机实测，§2.1），不能用来伪装路径。路径不一致时必须显式降级并告知用户，不能静默。 |
| 传输通道 | **不复用 ACP 的 WebSocket**（证据：它只收发 text frame，二进制帧被静默丢弃；见 §2.5）。在配对连接用的中继进程上**开第二个通道**：HTTP/1.1 `application/octet-stream` 流式上传 + `offset` 参数实现断点续传。这是 DSH 自己上传文件的同款做法。 |
| 事务性 | 「先 staging、后校验、再切换、最后才 `session/new`」。半成品只存在于 staging，绝不落在会话路径上。切换用「journal + 两次 rename」并在启动时恢复。 |
| blob 存储 | `<dataRoot>/blobs/sha256/<xx>/<digest>`，`dataRoot` 默认 `$DSH_HOME/storages/dsh-plugin-remote-use/`（可配）。**不要把 blob 放在任何工作区内**。 |
| 现成能力 | `ctx.attachments` 的 `saveFileStream`/`readFileStream` 是**唯一现成的 GB 级内容寻址流式存储**，可以直接复用（若组件跑在 DSH 进程内）；但 **DSH 没有任何 attachment GC**，所以垃圾回收必须我们自己写。 |
| 最容易被低估的 3 件事 | ① realpath 路径身份（决定 workspace 归属与 `session/resume`）；② 用 (mtime,size) 当增量判据会静默跑旧夹具 → **GUI 测试假绿**；③ Windows 上「替换一个非空目录」不是原子操作，且 staging+blob+目标 = 峰值 3 倍磁盘 + 文件占用（EACCES/EBUSY/EPERM）。 |

**一句话推荐**：主机侧插件把工作区表达成「(git 树, CAS 差集) 清单」→ 推给从机侧中继（独立 HTTP 流式通道）→ 从机写 staging、逐文件校验、原子切换 → 成功后主机才用该路径发 ACP `session/new`。

---

## 1. 同步模型选型

### 1.1 结论

**(d) 混合**，但不是「git 一套 + blob 一套」两个独立系统，而是**一份 manifest、两种内容来源**：

```
manifest = {
  git 层:  私有 index 的 write-tree 结果 → 一个 git 树对象（含 tracked + 未跟踪但未被 ignore 的文件）
  cas 层:  被 .gitignore 忽略、但任务确实需要的文件（几 GB 二进制/驱动/测试数据）
}
```

选择依据（每一条都有 DSH 内部证据）：

1. **DSH 自己已经证明「不碰仓库地拿到完整工作树快照」是可行且廉价的**：`@deepseek-ai/dsh-workspace-changes/lib/types/git.js:83-129`。它用 `GIT_OBJECT_DIRECTORY` + `GIT_ALTERNATE_OBJECT_DIRECTORIES` 建立私有对象库（`:90-95`），把仓库 index 拷成私有 index（`:108-117`），然后
   ```js
   // git.js:118-124
   const added = await git.run(['add', '--all', '--ignore-errors', ...pathspec], { cwd: workspace.root, env, signal });
   if (added.exitCode !== 1) ok(added, `git add in ${workspace.root}`);
   return ok(await git.run(['write-tree'], { cwd: workspace.root, env, signal }), 'git write-tree').stdout.trim();
   ```
   注释把语义写死了（`:97-102`）："Write the complete work tree, **including untracked and modified files but not ignored ones**, as a tree object through a private index seeded from the repository's index. New blobs and the tree land in the private object store; **the repository's index, object store, work tree, and refs stay unchanged**."
   这句话一次性回答了「脏工作区怎么办」「未 tracked 新文件怎么办」「`.git` 要不要传」三个问题：快照本身就是内容，不需要宿主 commit，也不需要传 `.git`。

2. **git 覆盖不到的部分恰好就是最重的那部分**：`git add --all` 明确「not ignored ones」，而几 GB 的驱动/测试数据几乎一定会被写进 `.gitignore`（否则每次 `git status` 都是灾难）。所以必须有 CAS 层。这一点让「纯 (a) git」直接出局。

3. **纯 (b) 自研 manifest 在「几万文件 + 几 GB」上要全量 sha256**，冷启动一次扫描的 IO 就是数 GB 读取（磁盘带宽量级分钟数），而 git 树的生成只需要 git 自己算（且 git 的 blob 哈希已经算过一遍，pack 复用现有对象）。所以纯 (b) 只在非 git 项目上作为**降级路径**。

4. **(c) rsync / tar+ssh / robocopy 不适合做主干**，见 §1.3 反例。

### 1.2 为什么不是「主机 push 临时分支 / 从机 pull」

- 会污染宿主的**仓库状态**（refs / 临时分支 / 可能的 stash），而这个仓库是用户正在用的工作仓库；DSH 的 `workspace-changes` 明确以「仓库 index、object store、work tree、refs stay unchanged」为设计前提（`git.js:99-102`），改成 push 分支就破坏了这个前提，也会让主机的 GUI 变更面板出现莫名其妙的条目。
- 未提交改动需要先 commit 才能 push，等于替用户决定提交历史。
- 几 GB 二进制无论走 git 还是 HTTP 都要走网络，git 在这部分**没有优势**：`.gitignore` 的夹具进不了 git，硬塞进去还会让宿主 object store 翻倍。
- 从机是**无状态的一次性执行环境**，给它「分支」这种长期身份没有意义；它需要的是一条命令式指令：「把工作区变成这个 manifest 的样子」。

### 1.3 反例（为什么其它选项出局）

**反例 A：rsync / tar+ssh / robocopy 作为主干**

- **不保证存在**。Windows 上 `robocopy`/`xcopy` 是系统自带，但 `rsync`/`tar`/`ssh` 不是；DSH 自己从不依赖它们（见 §3 的「未找到」清单）。而 `robocopy` 的语义与需求相反：`/MIR` 会删目标侧文件、`/XO` 只跳过旧文件、退出码 > 7 才算失败（`0-7` 都是成功码），在无人值守同步里极易误判成功。
- **没有内容寻址**。传输单元是「文件」，所以「同名但内容不同」和「内容相同但 mtime 不同」无法区分，机器间 mtime 不可信（§6 第 2 条），于是要么全传（浪费几 GB）要么跳过（静默用旧内容）。
- **没有断点续传**。一个 3 GB 的 `.tar` 传到 90% 断网，只能从头来。
- **删除语义危险**。镜像同步必须处理「主机删了、从机还在」；`--delete`/`/MIR` 是「一把梭」，一旦路径映射配错就是删用户数据；用 manifest 表达删除是可审计、可预演的。
- **无法做完整性验证**。没有 digest，就没有「要么完整要么不开始」的判定依据。

**反例 B：纯自研 manifest + CAS（不用 git）**

- 冷启动要对全部文件做 sha256。一个 8 万文件、3 GB 的前端仓库，冷启动哈希成本 ≈ 3 GB 顺序读 + 8 万次 hash，而 git 树可以复用仓库已有对象（`GIT_ALTERNATE_OBJECT_DIRECTORIES`，`git.js:94`）。
- 自己实现 pack/压缩/delta，会得到一个比 git 差的 git。
- 但它**必须保留**为非 git 项目与「从机无 git」的路径，所以它不是被抛弃，而是被降级。

**反例 C：纯 git（bare repo + 每任务 worktree / push 临时分支）**

- `.gitignore` 的夹具传不过去 → 从机上 GUI 测试起不来，这是**功能性失败**而不是性能问题。
- 强行把几 GB 夹具加入 git：宿主 `git add` 会把它们复制进 object store（峰值 2× 磁盘），而且 `git status` 从此变慢，直接干扰用户。
- 从机上用 `git worktree` 需要从机有一个 bare repo 长期存在并保持与宿主同步，等于多加一个「仓库同步」子系统，比同步文件更难。

**反例 D：走 ACP 的 WebSocket 传二进制**

- 见 §2.5：协议层直接丢弃二进制帧。

### 1.4 四个必答问题

| 问题 | 答案 | 机制 |
|---|---|---|
| 主机工作区**脏** | 完整覆盖，无需 commit | `git add --all --ignore-errors` 进**私有** index（`GIT_INDEX_FILE`）→ `write-tree`；宿主 index/worktree/refs 不动（`git.js:108-124`） |
| 未 tracked 的新文件 | 包含在内 | 同上，`--all` 而非 `-u`，且不是 `git status`（`git.js:97-102`）。被 ignore 的新文件走 CAS 层 |
| **非 git 项目** | 降级为纯 CAS | `locateGitWorkspace` 在「not a git repository」时返回 `null`（`git.js:85-86`）；此时 manifest 的 git 层为 `null`，所有文件进 cas 层，用 (size,mtime) 做宿主侧哈希缓存加速 |
| **`.git` 要不要传** | **默认不传** | 体积大；`.git/config` 可能内嵌 `https://user:token@...`（凭据外泄）；从机拿到 `.git` 后 `git status` 会给出误导结论（从机上的路径/ignore 规则与宿主不同）。需要 git 语义时用 bundle 传一个**合成提交**（§2.4.3） |

补充：**`.git` 之外还有几个 DSH 自己的目录必须排除**，它们含凭据与完整会话记录：`$DSH_HOME/.credentials.yaml`、`$DSH_HOME/settings.yaml*`、`$DSH_HOME/sessions/`（zstd 会话日志，含完整 prompt/工具输出）、`$DSH_HOME/attachments/`（可能含用户上传的图片/文件）、`$DSH_HOME/profiles/`。真实布局见 §3.6。

### 1.5 决策树

```
构建 manifest(cwd):
  repo = locateGitWorkspace(cwd)            # 只 rev-parse，不写仓库
  if repo == null or git unavailable:
       层 = 纯 CAS(全量 walk + 哈希缓存)
  else:
       gitTree = snapshotTree(repo)         # 私有 index + write-tree
       层 = git 层(gitTree) + CAS 层(walk 中所有被 ignore 但未被用户排除的文件)
  合并 → manifest（§2.2）
```

---

## 2. 关键设计细节

### 2.1 路径一致性（本子系统**最**容易出错的地方）

#### 结论

1. 主机把工作区的 **`fs.realpath` 规范化路径**（不是用户输入的原始字符串）作为 `targetCanonicalPath` 交给从机。
2. 从机必须在**完全相同的绝对路径**上准备一个**真实目录**（真实 inode，不是 junction、不是 subst 盘、不是符号链接）。做不到就**显式失败**，不要静默改路径。
3. 允许用户配置显式映射（`pathMap`）作为「我知道后果」的逃生门，但插件必须在会话开始前打印受影响的清单，并把映射表注入从机的 agent 指令。

#### 为什么这么严格：DSH 的 workspace 身份就是 realpath 字符串

`@deepseek-ai/dsh-workspace/lib/types/paths.js:30-48`：

```js
 * Canonicalize a fully qualified directory path via `fs.realpath`: trailing
 * slashes, `..` segments, and symlinks are all resolved. This is the ONE
 * uniqueness canon of the package — workspace paths are stored canonicalized,
 * uniqueness is string equality of canonicalized paths (a symlink to an
 * existing workspace's directory collides), and attach-time session `cwd`
 * checks go through the same canon. Relative paths reject before `realpath` can
 * resolve them from the Host cwd or current Windows drive. A path that does not
 * exist rejects with the original `ENOENT` — this is `create`'s reject path (a
 * workspace must point at an existing directory).
async function realpathNormalize(path) {
	if (!fullyQualifiedWorkspacePath(path)) throw new TypeError(`Workspace path is not fully qualified: '${path}'`);
	return await realpath(path);
}
```

而 workspace 的durable id **不是**从路径派生的：`@deepseek-ai/dsh-workspace/lib/types/index.js:433` → `const id = WorkspaceId(randomUUID());`（每个 DSH home 一份随机 UUID，随注册表持久化在 `$DSH_HOME/storages/workspace.json`）。按路径查找是**对规范化字符串的线性扫描 + 全等比较**（`types/index.js:417-423`）。

```
⇒ 跨机器唯一可用的 join key 就是那个 realpath 字符串本身；没有哈希、没有大小写折叠。
⇒ 同一项目在不同绝对路径上，在 DSH 眼里就是两个不同的 workspace，不会复用任何东西。
```

#### 具体失败清单（路径不一致时会发生什么）

| # | 失败 | 证据 |
|---|---|---|
| 1 | 从机的 session 被**排除在 workspace 之外** | `@deepseek-ai/dsh-workspace/lib/index.js:872-890`：`indexHeader` 对 `header.cwd` 做 `realpathNormalize` + `stat().isDirectory()`，失败就记入 `invalidSessionPaths`（"cwd ... does not resolve"）；`reportFilteredCandidates:900-909` 随后 warn：`workspace '...' filtered session '...' from membership: ...`。后果：从机的会话不出现在该 workspace 下，GUI 里看不到、用户按 workspace 管理时会错乱。 |
| 2 | `session/resume` 直接报错 | `@deepseek-ai/dsh-acp/lib/index.js:1217` `if (!await sameDirectory(persisted.cwd, params.cwd)) throw invalidParams(\`session cwd does not match: ${params.cwd}\`)`；`:1234-1237` 再查一次。`sameDirectory`（`:1414-1423`）先 `realpath` 比较，两者都能 realpath 时用**物理身份**，不能时才退回 `resolve(left) === resolve(right)`（**字符串比较，Windows 上区分大小写**）。 |
| 3 | `session/list` 过滤掉会话 | `dsh-acp/lib/index.js:1256-1274`：`listSessions` 要求 `cwd` 绝对（`:1258`），并对每个 persisted header 做 `sameDirectory(header.cwd, params.cwd)` 过滤（`:1268`）。 |
| 4 | 从机**写不进**工作区（如果改用另一个根） | `@deepseek-ai/dsh-sandbox-policy/lib/index.js:141-147`：`workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)`；`dsh-sandbox/lib/index.js:166-173` 的 `writableRoots` 只含该 root + `/tmp` + `tmpdir()`。即 workspace-write 模式下**只能写会话 cwd 之下**。 |
| 5 | 测试脚本里的**绝对路径断言/配置**失效 | Playwright/Vitest/Jest/Cypress/pytest/dotnet 的 config 里常见 `F:\WorkSpace\proj\...`、`file:///F:/...`；`path.resolve(__dirname, ...)` 相对路径没事，硬编码绝对路径全废。快照文件名、`--project` 过滤串、baseURL、fixture 目录同理。 |
| 6 | DSH 自身的 workspace 注册表无法跨机器复用 | `$DSH_HOME/storages/workspace.json` 里存的是宿主的绝对路径（实测：`"path": "F:\\WorkSpace\\dsh-plugin-remote-use"`）。把它拷到从机没有意义——从机有它自己的 DSH home。 |

#### 实测：`subst` 与 junction **都不能**伪装路径

我原本假设「从机用 `subst F: <真实目录>` 或 junction 就能让 realpath 保持 `F:\proj`」。**本机在 Windows 上实测否证了这个假设**：

```powershell
New-Item -ItemType Directory -Force -Path "$root\d\proj"
subst "X:" "$root\d"
New-Item -ItemType Junction -Path "$root\jproj" -Target "$root\d\proj"
node -e "const fs=require('fs'),fp=require('fs/promises');
  (async()=>{for(const t of process.argv.slice(1)){
    console.log(t, '|native:', fs.realpathSync.native(t), '|promises:', await fp.realpath(t));}})()" \
  "X:\proj" "$root\jproj" "$root\d\proj"
```

实测输出（`$root` = `F:\WorkSpace\dsh-plugin-remote-use\.research\winsym-test2`）：

```
X:\proj                                    |native: F:\...\winsym-test2\d\proj |promises: F:\...\winsym-test2\d\proj
F:\...\winsym-test2\jproj                  |native: F:\...\winsym-test2\d\proj |promises: F:\...\winsym-test2\d\proj
F:\...\winsym-test2\d\proj                 |native: F:\...\winsym-test2\d\proj |promises: F:\...\winsym-test2\d\proj
```

结论（实测，非推测）：

- `fs.realpathSync.native`（`dsh-fs-local` 用的 API）与 `fs/promises.realpath`（`dsh-workspace`/`dsh-acp` 用的 API）**都**把 subst 盘和 junction 解析到真实底层路径。两者行为一致。
- 因此 **junction / subst 会破坏路径身份而不是修复它**：宿主 `F:\proj` 的 realpath 是 `F:\proj`，从机经 junction 得到的是 `D:\real\proj`，`===` 不成立。
- 唯一身份保持的映射是「从机上存在**同盘符同名**的真实目录」。若从机 `F:` 被占用，只能：换盘符让出 `F:`（需要用户操作）、或接受路径不一致并进入显式降级模式。
- **未验证的替代方案**（不要当结论用）：卷挂载点（volume mount point，把卷挂到 `F:\proj` 这个文件夹）在 `GetFinalPathNameByHandleW` 下是否返回 `F:` 前缀未实测。若要在生产用，先跑同一段脚本验证。

#### 与之配套的检查（主机侧，同步前）

```
1. hostPath = await realpath(cwd)                     # 与 dsh-workspace 同一 canon
2. 询问从机: "realpath(<hostPath>) 存在吗？是目录吗？盘符 <X>: 存在吗？"
3. 若 hostPath 或任一祖先段是从机的 junction/symlink/reparse point → 警告并要求确认
   （reparse 点会让从机上的 realpath 与宿主不同，正是我们要防的）
4. 若盘符不存在 → Rejected，附人类可读指引：
   "从机没有 F: 盘。请让出该盘符，或在配置中显式设置 pathMap（会破坏路径断言/workspace 身份/session 复用）。"
5. 若用户配置了 pathMap → 进入 degraded 模式：
   - manifest.root.targetCanonicalPath = 映射后的路径
   - 从机的 agent 指令里注入路径映射表（写成工作区内的 AGENTS.md 片段或系统提示补充）
   - 会话开始时向用户显式回报「本次为路径重写模式，已知影响：…」
```

**注意**：`dsh-workspace` 还要求路径是「完全限定」的，Windows 上必须是带盘符的绝对路径：

`@deepseek-ai/dsh-workspace/lib/types/paths.js:14-19`
```js
export function fullyQualifiedWorkspacePath(path, platform = process.platform) {
    if (platform !== 'win32') return posix.isAbsolute(path);
    const root = win32.parse(path).root;
    return win32.isAbsolute(path) && root !== '\\' && root !== '/';
}
```
即 `F:proj`（驱动器相对）被拒，UNC `\\server\share\proj` 可以。**收路径时先过这个判定**，否则从机侧会在很晚的地方抛 `TypeError`。

### 2.2 Manifest 格式

#### 结论

- **一份 JSON 文档**，包含 git 层（一个树对象 oid + 一个 bundle 引用）和 cas 层（逐文件 path/size/mtime/sha256）。
- **生成时机**：任务创建前，对每个 (peer, workspace) 生成一次；结果按「工作区内容指纹」缓存复用（见 2.2.3）。
- **协议方向：主机先推 manifest，从机回 `have`/`need`**（不是从机先报）。理由：
  - 冷启动时从机什么都没有，「从机先报」等于白跑一次往返；
  - 主机本来就必须遍历工作区才能得到 manifest，让它先推不增加主机成本；
  - **更重要**：从机可以在收到 manifest 后、任何字节落地前做路径/安全/配额校验（§2.9），这是「要么完整、要么不开始」的第一道闸。
- 从机回 `have`（它已有 digest 的集合）而不是 `have`（路径→digest）：因为从机可能把同一内容放在别的路径（上次同步后的重命名），按 digest 去重能让传输量最小。
- 冷启动 vs 增量：
  - **冷启动**：从机 `have = {}`，`need = 全部 cas 条目 + 1 个 bundle`。
  - **增量**：从机持有上次提交的 manifest（`<target>/.dsh-remote/state.json` 里存 manifest 摘要 + 完整清单），按 digest 求差集。

#### 2.2.1 清单 JSON 草案

```jsonc
{
  "manifestVersion": 1,
  "syncId": "sy_01JQ8Z3K7M2N4P6R8T0V2X4Z6B",     // 本次同步事务 id（ULID/ULID-like，单调）
  "taskId": "t_01JQ8Z3K7M2N4P6R8T0V2X4Z6C",
  "peerId": "peer_office_pc_02",
  "generatedAt": "2026-02-11T09:12:33.412Z",
  "generator": { "plugin": "dsh-plugin-remote-use", "version": "0.1.0-dev", "dsh": "0.2.0-rc.2" },

  "root": {
    "hostCanonicalPath":   "F:\\WorkSpace\\proj",   // = fs.realpath(host cwd)
    "targetCanonicalPath": "F:\\WorkSpace\\proj",   // 默认相同；不同 = degraded 模式
    "pathMode": "identical",                        // "identical" | "mapped"
    "volume": "F:",                                 // 从机侧校验盘符与剩余空间
    "requiresFreeBytes": 4026531840                 // totals.bytes * safetyFactor，见 §2.7
  },

  "layers": {
    "git": {
      "available": true,
      "repoRoot": "F:\\WorkSpace\\proj",
      "headOid": "<oid>",  // 宿主 HEAD（仅作诊断/记录）
      "snapshotTree": "<oid>", // 私有 index 的 write-tree 结果
      "baseTree": "<oid>",     // 从机回报「我有」的 tree（无则 null）
      "unknownBase": false,        // true = 从机有仓库但 tree 对不上，bundle 必须自包含
      "transport": "bundle",       // "bundle" | "none"(git 层缺席)
      "bundle": {
        "path": "blobs/pack/<oid>.bundle",
        "bytes": 184320512,
        "sha256": "<digest>"
      },
      "trackedCount": 8123,
      "excludes": [".dsh-remote", "node_modules", "test-results", "playwright-report"]
    },
    "cas": {
      "count": 214,
      "bytes": 3221225472,
      "entries": [
        { "p": "drivers/chromedriver.exe",
          "s": 16777216, "m": 1739340000123,
          "h": "sha256:<digest>",
          "x": true },                          // x = 从机可执行位（仅 POSIX；Windows 忽略）
        { "p": "fixtures/models/vision.onnx",
          "s": 268435456, "m": 1739340001234,
          "h": "sha256:<digest>",
          "x": false }
      ]
    }
  },

  "dirs": ["drivers", "fixtures", "fixtures/models", "test-results"],
  "emptyDirs": ["test-results/artifacts"],
  "symlinks": [],                                  // 默认空；需要时见 §2.9
  "reparsePoints": [],                             // 从机侧的 junction/symlink 会被拒绝或独立处理

  "totals": { "files": 8337, "bytes": 3405545984, "casBytes": 3221225472 },

  "delete": {                                      // 镜像语义：从机多出来的文件
    "mode": "mirror",                              // "mirror" | "keep-extra"
    "paths": ["src/legacy/old_test.py"]            // 由从机回包里的 extra 集合产生（见 2.2.2）
  },

  "policy": {
    "overwriteExisting": "replace-managed-only",   // "refuse" | "replace-managed-only" | "replace"
    "chunkBytes": 8388608,
    "maxFileBytes": 2147483648,
    "allowSymlinks": false,
    "preserveMtime": true,
    "exclude": [
      { "p": ".git/", "reason": "vcs", "rule": "default" },
      { "p": "node_modules/", "reason": "deps", "rule": "default" },
      { "p": "**/.env", "reason": "secret", "rule": "default" },
      { "p": "media/**/*.mp4", "reason": "user-exclude", "rule": "user" }
    ]
  },

  "manifestDigest": "sha256:<digest>"
  // 对除本字段以外的规范化 JSON 求 sha256（键排序、UTF-8、无多余空白）
}
```

设计要点：

- **`h` 用 `sha256:<hex>` 前缀形式**，与 DSH 现有 canonical id 形式一致（`@deepseek-ai/dsh-attachment-local/lib/index.js:275` `const ID_PATTERN = /^sha256:([a-f0-9]{64})$/;`）。如果将来要复用 `ctx.attachments`，可以直接对上。
- **`m` 只作为宿主侧哈希缓存的键，从不作为跨机器「内容相同」的证据**（§6 第 2 条）。从机可以用它避免重写已存在文件（写之前先比 digest），但不能用它跳过 digest 校验。
- **cas 条目的 `p` 是 POSIX 风格相对路径**（`/` 分隔，无前导 `./`，无盘符）。这样 manifest 在 Windows/Unix 两侧同构，也避免 `\` 在 JSON 里的双重转义。落盘时再转 `path.join`。
- **`dirs`/`emptyDirs` 单独列出**：git 不记录空目录，若不列出，从机上 `test-results/artifacts` 这种「框架要求预先存在」的目录会缺失。
- **`delete` 由从机回包决定**：主机不知道从机多什么，所以第一节的 manifest 是 `delete.paths = []`，从机回 `extra` 后主机再确认（见 2.2.2）。这避免了「主机单方面让从机删东西」。
- 时间戳一律 ISO-8601 UTC；`m` 是 Unix 毫秒。**不要**在 manifest 里放本地时区字符串。

#### 2.2.2 协议往返

```
[主机] POST /dsh-remote/v1/sync/plan
       body: manifest（cas.entries 只带 p/s/m/h；bundle 带 sha256+bytes，不带字节）
[从机] 校验 → 200 {
         syncId,
         accepted: true,
         have:   { "sha256:9d2f...": ["drivers/chromedriver.exe"], ... },   // 已在 blob 库或目标路径中
         need:   ["sha256:41ab...", ...],                                   // 需要上传的 blob
         extra:  ["src/legacy/old_test.py"],                                // 目标里有、manifest 里没有
         needGitBase: false,                                                // 从机是否已有 baseTree
         freeBytes: 214748364800,
         pathChecks: { targetExists: true, isManaged: true, volume: "F:", volumeFreeBytes: 214748364800 }
       }
[主机] 对每个 need 的 blob：PUT /dsh-remote/v1/blob?digest=...&offset=... （分块，§2.4）
[主机] PUT /dsh-remote/v1/git/bundle?syncId=... （bundle 也按同一分块机制传）
[主机] POST /dsh-remote/v1/sync/commit { syncId, manifestDigest, deletePaths: [...] }
[从机] 校验全部 → 切换 → 201 { state: "committed", committedManifestDigest, workspacePath, durationMs }
[主机] 此时才 ACP session/new { cwd: targetCanonicalPath }
```

#### 2.2.3 生成时机与缓存

| 缓存 | 位置 | 键 | 失效条件 |
|---|---|---|---|
| 宿主侧「文件 → sha256」缓存 | `<dataRoot>/cache/host-hashes.json`（或 `$DSH_HOME/cache/dsh-plugin-remote-use/`，`dshCachePath` 同款语义，`dsh-home-paths/lib/index.js:91-94`） | `(绝对路径)` → `{size, mtimeMs, sha256}` | 该文件的 `(size,mtimeMs)` 变化。**这只在宿主本机可信**（同一文件系统、同一时钟），所以是安全的加速手段 |
| 从机侧 manifest | `<target>/.dsh-remote/state.json` | workspace | 目标被外部改动（用 digest 抽查发现不符） |
| blob 库 | `<dataRoot>/blobs/` | digest | 永不过期，靠 GC（§2.8） |

**关键区分**：

- 「宿主本机的 `(size,mtime)` 缓存」是**性能优化**，安全（同一文件系统内 mtime 变化 ⇒ 内容可能变化；mtime 相同且 size 相同 ⇒ 极大概率相同，且这是主机自己的文件系统，mtime 语义一致）。
- 「拿从机/宿主的 `(size,mtime)` 相等来推断内容相同」是**错误**的，因为跨机器 mtime 不可比（§6 第 2 条）。**跨机器只认 digest。**

生成 manifest 的代价（冷启动）：
- git 层：`rev-parse` + `add --all` + `write-tree`，git 只对**变化过的**文件重新哈希（index 里有 stat cache）。
- cas 层：只对「被 ignore 但未排除」的文件做哈希。若用户把 `fixtures/` 全排除了，cas 层为空，冷启动几乎零额外 IO。
- **建议默认把「已知巨大且从不变化」的目录（如 `fixtures/models/`）放进一个 `slowChanging` 配置**，这样即使它们进了 cas 层，也能用宿主 hash 缓存命中，不必每次重算。这比「完全不传」更安全。

### 2.3 Blob 存储

#### 结论

- 位置：`<dataRoot>/blobs/sha256/<xx>/<digest>`（`xx` = 前两 hex 字符分片），`<dataRoot>` 默认 `$DSH_HOME/storages/dsh-plugin-remote-use/`，可用 `DSH_REMOTE_DATA_ROOT` 或插件配置覆盖。
- **绝不要把 blob 放在任何工作区内部**。理由：会进 workspace 的变更统计（`dsh-workspace-changes` 会把整棵树快照成 git 树）、会在 workspace-write 沙箱的写范围内被远程 agent 删改、且 `mirror` 删除语义会把它当「多余文件」清掉。
- 也不要放进 `$DSH_HOME/attachments/v1`（除非决定复用 `ctx.attachments`，见下）：那是 DSH 的附件仓，混入几 GB 夹具以后无法分辨归属，而 DSH **没有**任何 attachment GC。
- 落盘算法**照抄** `dsh-attachment-local` 的 `publishImmutableObject`（见 §2.3.1），它恰好把我们要的全部性质都实现了。
- 并发写安全：每个 blob 一个 `<digest>.lock`（`wx` 独占创建 + PID 记录 + 死锁接管），照抄 `@deepseek-ai/dsh-atomic-write/lib/index.js:188-215` 的 `withFileLock`。**同一个 digest 的并发上传不可能冲突**，因为「同 digest ⇒ 同字节」，所以这里的锁只用于避免两个进程同时写同一个临时文件、以及 GC 与上传的竞争。

#### 2.3.1 落盘流程（照抄 `dsh-attachment-local`）

`@deepseek-ai/dsh-attachment-local/lib/index.js:498-535`（`stageImmutableObject`）与 `:536-559`（`publishStagedObject`）：

```js
// :498-524 —— 写入随机命名的暂存文件，边写边算 sha256，fsync 后才返回
const staging = join(root, "tmp");
const temporary = join(staging, randomUUID());
handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 384);
const hash = createHash("sha256");
let bytes = 0;
for await (const chunk of data) {
    signal?.throwIfAborted();
    await handle.writeFile(chunk);
    hash.update(chunk);
    bytes += chunk.byteLength;
}
await handle.sync();
await handle.close();
return { path: temporary, boundary, sha256: hash.digest("hex"), bytes };
```

```js
// :536-554 —— 目标是 digest 派生的路径：先 link，EEXIST 就用 digest 验证（去重），最后 chmod 只读
await ensureDurableDirectory(parent, staged.boundary);
try {
    await link(staged.path, target);
} catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    if (await digestFile(target) !== staged.sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");
}
await unlink(staged.path);
await chmod(target, 256);
```

这套做法的四个性质正好对上我们的需求：

| 性质 | 实现 | 对我们的价值 |
|---|---|---|
| 崩溃安全 | 先写 `tmp/<uuid>`、`handle.sync()`、再 `link` 到最终名 | 断电时最终名要么不存在、要么内容完整 |
| 天然去重 | `link` 收到 `EEXIST` 时用 `digestFile` 复核 | 并发/重传同一 blob 不重复占空间 |
| 只读落地 | `chmod(target, 256)`（`0400`） | 防止后续误改，`mirror` GC 时也容易识别 |
| 同盘硬链接 | `link` 要求同卷 | **`tmp/` 必须与 `blobs/` 同卷**（`dataRoot` 内天然满足） |

注意 Windows 上的差异（照抄时要处理）：

- `syncDirectory` 在 Windows 上是 **no-op**（`dsh-attachment-local/lib/index.js:357-368`）：
  ```js
  async function syncDirectory(path) {
      /* v8 ignore next -- Windows cannot open directory handles; NTFS metadata journaling owns entry durability there. */
      if (process.platform === "win32") return;
  ```
  所以「目录项持久化」在 Windows 上交给 NTFS 日志，不要试图对目录做 `fsync`（Node 在 Windows 上打不开目录句柄）。
- `link`（硬链接）在 NTFS 上可用且不需要管理员权限。
- `chmod` 在 Windows 上只影响只读位；`256`（`0400`）会得到只读文件——**GC 删除只读文件时要先清只读位**，否则 `unlink` 会 `EPERM`。

#### 2.3.2 复用 `ctx.attachments` 的取舍

如果同步组件跑在 DSH 进程内（主机侧插件，或从机侧写成 DSH 插件），可以直接用 `ctx.attachments`：

`@deepseek-ai/dsh-attachment/lib/types/index.js:10-12,109-135`
```js
export class AttachmentStore extends Service {
    constructor(ctx) { super(ctx, 'attachments'); }
    ...
    /** Durably commit one file byte-for-byte from bounded chunks. Providers must
     * apply backpressure and must not collect the complete file in memory. */
    saveFileStream(input) { ... }
    /** Read and verify one verbatim stored file as bounded chunks. */
    async *readFileStream(ref, signal) { ... }
```

并且**文件附件没有大小限制**（`:101-108`："Files carry no admission limits: any byte content and length is accepted, and the stored object is the exact submitted bytes."），实现是 `LocalAttachmentStore.saveFileStream` → `saveFileStreamVerbatim` → `publishImmutableObjectStream`（`dsh-attachment-local/lib/index.js:699-711,452-467`），root 固定为 `join(dshHome, "attachments", "v1")`（`:996`）。

**但有两个硬伤**，所以本设计默认自建：

1. **DSH 从不回收 attachment**。`dsh-attachment/lib/types/index.js:17-18` 写得很直白："storage failures return no partial references, although **already published content-addressed objects may stay unreachable until a future retention policy collects them**"；`dsh-commands/lib/types/index.js:350` 同样称之为 "deferred-GC territory"。全库搜索 `retention|collectUnreachable|garbage|GC|sweep` 在 attachment 相关包内**只**命中这两处注释，没有实现。几 GB 夹具进去就永久占盘。
2. **它不暴露 digest→host path 的完整管理面**：`fileHostPath(ref)` 可以拿到路径（`:1050-1052`），但 `saveFileStreamVerbatim`/`readFileStreamVerbatim` 这些内部函数**没有导出**（`:1079` 的导出清单里只有 `LocalAttachmentStore` 与几个 image 相关函数）。要从外面用只能 `new LocalAttachmentStore(ctx, {dshHome})`，把自己绑在内部 Service 类和它的 `z` 配置上。

**结论**：默认自建 blob 库（照抄算法，约 200 行）；把「复用 `ctx.attachments`」作为一个可配置后端（`blobBackend: "local" | "attachments"`），并在选择 `attachments` 时明确警告「无 GC，需要用户手动清 `$DSH_HOME/attachments`」。

### 2.4 分块与断点续传

#### 结论

- **块大小 8 MiB**（`8388608`）。理由：足够摊薄 HTTP 头开销；单块重传代价可控；远低于 DSH 自己 JSON-RPC 通道的 300 MiB buffered 上限（`@deepseek-ai/dsh-client-connection/lib/index.js:25` `DEFAULT_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024`），即使将来误走那条通道也不会立刻爆。
- **寻址 = `(blobDigest, offset)`**。服务端不维护「上传会话」，只看「这个 digest 的暂存文件现在有多少字节」。
- **最终校验只认整块 blob 的 sha256**。这是断点续传之所以安全的关键：任何拼接错误/中间损坏都会在最终 digest 上暴露，然后重传该 blob。
- **bundle（git 层）也走同一机制**：先把 bundle 写成一个文件，再以它的 sha256 作为 digest 上传。这样代码层只有一条传输路径。

#### 2.4.1 协议

```
PUT /dsh-remote/v1/blob?digest=sha256:<64hex>&offset=<n>&total=<m>
Authorization: Bearer <pairingToken>
Content-Type: application/octet-stream
X-Dsh-Remote-Sync: <syncId>
<块字节，长度 ≤ chunkBytes>

200 { "received": <新的总字节数>, "complete": false }
201 { "received": <m>, "complete": true, "sha256": "<64hex>" }   // 服务端已按临时名 link 进 blobs/
409 { "error": "offset-mismatch", "received": <服务端当前字节数> }   // 只在 offset 与暂存大小不一致时
416 { "error": "already-complete" }                                // blob 已存在
507 { "error": "quota-exceeded", ... }
```

客户端恢复流程：

```
GET /dsh-remote/v1/blob/status?digest=sha256:<hex>
→ 200 { "state": "absent" | "partial" | "complete", "received": <n> }
absent  → offset = 0
partial → offset = received（客户端把自己的流 seek 到该位置，用哈希前缀不能验证，但最终 digest 会兜底）
complete→ 跳过（仍然会把该 digest 记入本次同步的「已落地」集合）
```

服务端暂存：`<dataRoot>/tmp/<digest>.<uploadId>.part`，另有一份 `<dataRoot>/uploads.json`（原子写）记录 `digest → {partPath, bytes, startedAt, syncId}`，进程重启后可以恢复聚合。

**必须做的一件事**：`partial` 的 `received` 是**不可信**的（另一个客户端的半截文件、或恶意客户端伪造）。因此 `complete` 之前一律不 link 进 `blobs/`；`complete` 时服务端**重算 sha256**（流式，`highWaterMark: 65536`，与 `dsh-attachment-local/lib/index.js:719-745` 同款），不等就删暂存并返回 422 `digest-mismatch`。这条让「续传」变成纯优化，不引入正确性风险。

#### 2.4.2 重传与超时

- 单块超时 60 s，整 blob 空闲超时 10 min（可配）。超时 → 关闭连接，客户端退避后重新 `GET status` 续传。
- 退避：1 s → 2 s → 4 s … 上限 30 s，最多 6 次，然后标记该 blob `failed`。
- 断网恢复：主机侧把「本次同步的 blob 队列 + 每个 blob 的 offset」持久化到 `<dataRoot>/cache/inflight/<syncId>.json`（原子写）。重连后从该文件恢复，而不是从零开始。
- 同步的**幂等性**：任何时刻重发同一 `PUT` 都安全（`offset` 决定写入位置）。

#### 2.4.3 git 层的传输：bundle

`git bundle` 是自包含单文件，可流式、可验证、可断点续传，正好套用上面的 blob 机制：

- 主机侧生成（在**私有** object store 上操作，不动宿主仓库）：
  ```
  git -C <repo> -c core.repositoryFormatVersion=0 \
      --git-dir=<privateObjectsDir>?    # 见下
      bundle create <out>.bundle <snapshotTree> --not <baseTree>
  ```
  实操上更稳的做法是：把 `snapshotTree` 做成一个**合成提交**（`git commit-tree <snapshotTree> -m ...`，同样在私有 object store + alternates 下），然后
  ```
  GIT_OBJECT_DIRECTORY=<privateObjects> GIT_ALTERNATE_OBJECT_DIRECTORIES=<repo/.git/objects>
  git bundle create out.bundle <syntheticCommit> --not <baseCommitOrEmpty>
  ```
  这样 bundle 只含差集对象。若从机没有任何 base（冷启动），`--not` 全部省略 ⇒ bundle 自包含完整树。
- 从机侧物化：
  ```
  git init <staging>/.git
  git -C <staging> fetch <bundlePath> 'refs/*:refs/dsh-remote/*'   # 或 FETCH_HEAD
  GIT_INDEX_FILE=<staging>/.git/dsh-index git -C <staging> read-tree <syntheticCommit>
  GIT_INDEX_FILE=<staging>/.git/dsh-index git -C <staging> --work-tree=<staging> checkout-index -a -f
  ```
  `checkout-index` 保证不依赖 HEAD、不需要 worktree 干净。
- **从机没有 git 时**：git 层标记 `available: false`，全部文件（包括本来由 git 覆盖的）进 cas 层。这要求主机在生成 manifest 前先问从机 `GET /dsh-remote/v1/hello` → `{ gitAvailable: bool, gitVersion }`。
- **从机的 `.git`**：物化完成后 `rm -rf <staging>/.git`（默认），因为：
  - 我们不想让远程 agent 在一个「历史被伪造」的仓库里跑 `git log`/`git bisect`；
  - 也不想让 `dsh-workspace-changes` 在从机上因为「这是个 git 仓库」而尝试做快照（虽然它会因为 index 与 worktree 不一致而感到困惑）。
  - 若用户明确需要 git 语义（`syncGitRepo: true`），保留 `.git` 并把 `refs/remotes/dsh-remote/*` 保留成只读参照，同时在从机 agent 指令里说明「这是一个合成历史，不要用来判断变更」。

### 2.5 传输通道

#### 结论

**不要**把 blob 塞进 ACP 的那条 WebSocket。在配对用的中继进程上**另开一条 HTTP/1.1 通道**，用 `application/octet-stream` 流式上传 + `offset` 续传。这既是 DSH 自己的做法，也是唯一能撑住几 GB 的方案。

#### 证据 A：ACP 的 WS transport 只收发 text frame

`@agentclientprotocol/sdk`（镜像 `.research/sdk/sdk/dist/ws-stream.js`）：

```js
// ws-stream.js:6-9（文档注释）
 * Creates an ACP Stream over WebSocket.
 *
 * Sends and receives ACP JSON-RPC messages as WebSocket text frames. In Node,
 * pass a WebSocket constructor such as `ws.WebSocket` via `options.WebSocket`.
```

```js
// ws-stream.js:102-111（发送）
async sendMessage(message) {
    if (this.isClosed) throw new Error("ACP WebSocket stream is closed");
    await this.waitForOpen();
    if (this.isClosed) throw new Error("ACP WebSocket stream is closed");
    this.socket.send(JSON.stringify(message));
}
```

```js
// ws-utils.js:24-30（接收）
export function webSocketMessageToString(args) {
    const data = extractMessageData(args);
    if (typeof data === "string") {
        return data;
    }
    return undefined;          // ← 二进制 → undefined
}
```

`ws-stream.js:119-140` 拿到 `undefined` 就 `return`：

```js
handleSocketMessage(args) {
    if (this.isClosed) return;
    const text = webSocketMessageToString(args);
    if (text === undefined) {
        return;                 // ← 静默丢弃
    }
    ...
    value = JSON.parse(text);
```

而且 `ws-utils.js:31-39` 在 Node 的 `ws` 事件形态下（`message(data, isBinary)`）对二进制帧显式返回 `undefined`：

```js
function normalizeEventEmitterMessageArgs(type, args) {
    if (type !== "message" || typeof args[1] !== "boolean") return args;
    if (args[1]) {                 // isBinary === true
        return [undefined];
    }
    return [decodeWebSocketTextData(args[0])];
}
```

**结论：往这条通道发二进制帧，对端会静默丢弃，不报错。** 这不是「效率问题」而是「完全不工作」。

#### 证据 B：即使退化成 base64 塞进 JSON-RPC，也有硬上限与放大

- base64 放大 4/3；3 GB ⇒ 约 4 GB 的字符串。
- `JSON.stringify`/`JSON.parse` 要在内存里构造整个字符串，几 GB 字符串在 V8 上（`constants.MAX_STRING_LENGTH` 量级）直接抛错。DSH 自己的 base64 编码器就是为绕开「函数参数上限」而按 32768 分片的（`dsh-client-file-upload/lib/client.js:24-29`），但那是为了小图片，不是为 GB 级文件。
- DSH 的 JSON-RPC 请求体走 buffered 模式时上限 **300 MiB**：`@deepseek-ai/dsh-client-connection/lib/index.js:25` `const DEFAULT_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024;`，超了返回 413。
- **没有背压**：`ws-stream.js:97-101` 的 `sendQueue` 只是把 Promise 串起来链式调用，`socket.send` 本身是 fire-and-forget：
  ```js
  queueMessage(message) {
      const send = this.sendQueue.then(() => this.sendMessage(message));
      this.sendQueue = send.catch(() => { });
      return send;
  }
  ```
  生产者不会因为 socket 缓冲满而等待 ⇒ 几 GB 数据会把内存打爆。
- **没有断点续传**：`ws-stream.js:20-24` 明确说 "ACP v1 reconnect creates a new transport connection; ... **ACP v1 does not replay in-flight transport messages emitted while disconnected**"。所以续传必须由应用层实现，而它又只能跑在 text 帧上。

#### 证据 C：DSH 自己的文件上传就是「独立 HTTP 流式路由」

`@deepseek-ai/dsh-client-file-upload/lib/index.js:171-176`：

```js
ctx.effect(() => ctx.connection.fetch.register({
    path: FILE_UPLOAD_PATH,
    methods: ["POST"],
    requestBody: "streaming",              // ← 关键：声明为流式，绕开 buffered 上限
    fetch: (request) => handleFileUploadHttp(this, request)
}), "file-upload: streaming route");
```

`@deepseek-ai/dsh-client-file-upload/lib/types/protocol.js:2`：

```js
export const FILE_UPLOAD_PATH = '/api/session/uploadFileBinary';
```

`@deepseek-ai/dsh-client-file-upload/lib/types/http-route.js:10-34,57-72`：

```js
export async function handleFileUploadHttp(service, request) {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/octet-stream') return new Response('content type must be application/octet-stream', { status: 415 });
    ...
    result = { ok: true, value: await service.uploadStream({
        sessionId: brandString(sessionId),
        data: requestBodyChunks(request.body),          // ← AsyncIterable<Uint8Array>
        signal: request.signal, ...(name === undefined ? {} : { name }) }) };
```
```js
async function* requestBodyChunks(body) {
    if (body === null) return;
    const reader = body.getReader();
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) return;
            yield chunk.value;
        }
    } finally { reader.releaseLock(); }
}
```

落盘端 `dsh-client-file-upload/lib/index.js:215-219` → `this.ctx.attachments.saveFileStream({ data, signal, name })`，也就是「**不聚合地流式写盘 + 边写边哈希**」。

**这就是我们要照搬的形态**：raw octet-stream 请求体 → AsyncIterable → 流式落盘。区别只有一个：我们这个通道是 **peer-to-peer**（节点↔节点），不是 DSH 自己的 client↔host registry，所以不能用 `ctx.connection.fetch`，要在中继进程里自己起 `node:http` 服务。

#### 通道拓扑（推荐）

```
从机侧中继进程（slave relay，standalone Node，零依赖）
├── 监听 0.0.0.0:<port>（默认 8765，可配；只绑 LAN 接口）
│   ├── WS  /acp            → 桥接到子进程 `dsh --profile acp` 的 stdio（沿用既有方案）
│   └── HTTP /dsh-remote/v1/*  → 同步协议 + blob 上传（本文档新增）
│         GET  /hello              能力探测（git 版本、dataRoot 剩余空间、平台、路径校验）
│         POST /sync/plan          manifest 交换（小 JSON）
│         GET  /blob/status       续传查询
│         PUT  /blob               分块 blob 上传（octet-stream）
│         PUT  /git/bundle         git bundle 上传（复用同一分块机制）
│         POST /sync/commit        触发校验+物化+切换，事务提交点
│         GET  /sync/<id>          状态查询（崩溃恢复用）
│         GET  /workspace/<id>     已物化工作区清单（用于反向回传的差集）
│         POST /artifact/plan      反向通道：从机产物回传（§2.10）
└── 子进程 `dsh --profile acp`（stdio JSON-RPC）—— 同步完成后才 spawn/使用
```

- **共用一个监听端口**是对的：Node 的 `http.Server` 可以在同一个 server 上同时处理 `request` 事件和 `upgrade` 事件（DSH 的 `dsh-host-webserver` 就是这么做的：`lib/index.js:261-286` 用 `server.on("upgrade", ...)` 按 pathname 分发），省掉一个防火墙规则。
- **认证必须自己做**：ACP 协议本身无鉴权（见报告 03 的结论「无鉴权（裸协议）」），所以这个 HTTP 通道是唯一的安全边界。用配对阶段协商的 `pairingToken`：
  - 所有请求 `Authorization: Bearer <token>`；
  - 控制类请求（`/sync/plan`、`/sync/commit`）额外带 `X-Dsh-Remote-Hmac: <hex>`，对 `(method + path + bodySha256 + timestamp + nonce)` 用 token 派生密钥做 HMAC-SHA256；
  - `timestamp` 允许 ±120 s，`nonce` 在服务端保留最近 5 分钟（防重放）；
  - 通道默认明文 HTTP（局域网），若需要机密性则套 TLS（自签 + 指纹固定），或在上层做 AES-GCM 信封。**注意**：不要假设局域网可信——同一个 WiFi 上可能有不受控设备。
- **不要把 `dataRoot` 暴露成可下载的**：`/blob` 只允许 `PUT`，**不允许 `GET`**（防止把从机当作任意文件读取器）。反向回传走 `/artifact/*`，只允许拉取「本任务产生」的文件，按 manifest 白名单过滤。

### 2.6 排除清单

#### 默认排除（`default` 规则集）

按「为什么排」分组：

| 组 | 模式 | 理由 |
|---|---|---|
| VCS | `.git/` `.svn/` `.hg/` | §1.4；凭据风险；体积 |
| 依赖 | `node_modules/` `bower_components/` `.venv/` `venv/` `env/` `__pycache__/` `*.pyc` `.tox/` `.nox/` `.mypy_cache/` `.pytest_cache/` `.ruff_cache/` `.gradle/` `.m2/` `packages/**/bin/` `packages/**/obj/` | 从机可重建（`npm ci`/`pip install`），且跨平台常常无法直接复用（原生扩展、平台特定 wheel、`.node`/`.dll`） |
| 构建产物 | `dist/` `build/` `out/` `.next/` `.nuxt/` `.output/` `.parcel-cache/` `coverage/` `.nyc_output/` | 应在从机重建 |
| 测试产物 | `test-results/` `playwright-report/` `allure-results/` `cypress/videos/` `cypress/screenshots/` `.pytest_cache/` `TestResults/` | 上次运行的残留，同步无意义且可能几 GB |
| 密钥/凭据 | `.env` `.env.*` `*.pem` `*.key` `*.pfx` `*.p12` `*.jks` `*.keystore` `.npmrc` `.pypirc` `.netrc` `id_rsa*` `id_ed25519*` `credentials.json` `service-account*.json` `.aws/` `.ssh/` `.docker/config.json` `*.kubeconfig` `kubeconfig` | **不要把这些推到另一台机器** |
| DSH 自己的秘密与状态 | `.credentials.yaml` `settings.yaml*` `sessions/` `storages/` `attachments/` `profiles/` `cache/` `dsh-runtimes/`（即整个 `$DSH_HOME` 内容） | 真实布局见 §3.6；会话日志含完整 prompt/工具输出 |
| 本插件自身 | `.dsh-remote/` | 事务状态、staging、journal、state.json |
| OS 垃圾 | `Thumbs.db` `desktop.ini` `.DS_Store` `$RECYCLE.BIN/` `System Volume Information/` `*.tmp` `~$*` `*.swp` `*.bak` | 无意义 |
| 锁/临时 | `*.lock` `*.lck` `*.pid` `.git/index.lock` `.~lock.*` | 传过去只会造成冲突 |
| 挂载/重解析点 | 任何 `lstat().isSymbolicLink()` 或带 `FILE_ATTRIBUTE_REPARSE_POINT` 的条目 | 见 §2.9；默认跳过并 warn，而不是跟随 |

**特别注意一条容易漏的**：`node_modules` 被排除在**传输**之外，但**不应该**被排除在「从机需要什么」之外。GUI 测试通常需要 `node_modules`。所以设计上必须区分两个概念：

- `excludeFromTransfer`（不传）
- `ensureOnSlave`（从机需要通过包管理器重建）

manifest 里应带一个 `rehydrate` 段：

```jsonc
"rehydrate": [
  { "kind": "npm",  "cwd": ".", "lockfile": "package-lock.json", "lockfileSha256": "sha256:..." },
  { "kind": "pip",  "cwd": ".", "lockfile": "requirements.txt",  "lockfileSha256": "sha256:..." }
]
```
从机在物化完成后、`session/new` 之前按此重建依赖；重建失败 ⇒ 本次同步 `Rejected`（「要么完整，要么不开始」）。**lockfile 的 digest 必须进 manifest**，否则「依赖装好了但和主机版本不一致」会造成同样致命的假绿。

#### 用户配置

优先级（高 → 低）：

1. CLI/任务级 override（`remoteUse.sync.exclude` 一次性覆盖）
2. 工作区根的 `.dsh-remote-sync.yaml`（随项目走，可提交进 git，**不传输**）
3. 插件配置（`$DSH_HOME/cordis.patch.yml` 或 profile 配置）
4. 默认规则集

`.dsh-remote-sync.yaml` 草案：

```yaml
version: 1
exclude:
  append:
    - "media/**/*.mp4"
    - "fixtures/raw/**"
  remove:                 # 强制包含（覆盖默认排除）
    - "dist/"             # 例：测试直接跑 dist 产物
    - "node_modules/@my-org/**"
large:
  maxFileBytes: 3435973836        # 单文件 3.2 GiB
  slowChanging:                   # 命中宿主哈希缓存，不每次重算
    - "fixtures/models/**"
    - "drivers/**"
git:
  enabled: true
  transport: bundle
  keepGitDirOnSlave: false
paths:
  mode: identical                 # identical | mapped
  map: {}                         # 例: { "F:\\WorkSpace\\proj": "D:\\ws\\proj" }
symlinks:
  allow: false
  follow: false
rehydrate:
  enabled: true
  steps:
    - kind: npm
      args: ["ci", "--no-audit", "--no-fund"]
    - kind: pwsh
      script: "scripts/prepare-test-fixtures.ps1"
cleanup:
  keepBlobsDays: 30
  keepCommittedWorkspaces: 3      # 每个 workspace 保留最近 N 个已提交版本
```

**「remove（强制包含）」是必须有的**，否则用户无法把「被默认排除但确实需要」的东西捞回来，只能去改插件代码。

### 2.7 上限与配额

| 配额 | 默认 | 检查时机 | 超限行为 |
|---|---|---|---|
| `maxSyncBytes`（单次同步总字节） | 8 GiB | **传输前**（用 manifest `totals.bytes`，零成本） | `Rejected`，返回「体积榜单 Top 20」让你加排除 |
| `maxFileBytes`（单文件） | 2 GiB | 生成 manifest 时 | 该文件**不进 manifest** + `Rejected`（不静默跳过！要显式告诉用户哪个文件） |
| `maxFiles` | 200 000 | 生成 manifest 时 | `Rejected` + 提示（每个文件有 stat+hash 开销） |
| `maxBlobStoreBytes`（blob 库总量） | 50 GiB | GC 后 / 上传前 | 先触发 GC；仍超则 `Rejected` |
| `freeSpaceFloorBytes`（从机保留空闲） | 15 GiB | 物化前 | `Rejected`；`requiresFreeBytes = totals.bytes × 1.15 + freeSpaceFloorBytes` |
| `maxConcurrentBlobs` | 4 | 传输时 | 排队 |
| `maxSyncDurationMs` | 45 min | 全程 | 中止，保留 staging 以便续传 |

配置（插件配置段）：

```yaml
remoteUse:
  sync:
    maxSyncBytes: 8589934592
    maxFileBytes: 2147483648
    maxFiles: 200000
    maxBlobStoreBytes: 53687091200
    freeSpaceFloorBytes: 16106127360
    chunkBytes: 8388608
    maxConcurrentBlobs: 4
```

**超限行为的原则**：永远**显式失败并指名道姓**，绝不静默跳过文件。GUI 测试最怕的不是「同步失败」，而是「同步悄悄少了一个夹具然后测试通过/莫名其妙地失败」。

**「体积榜单」实现**：把 `cas.entries` + git 层无法逐文件列出的部分（bundle 是整体）按 size 降序取前 20，输出 `path  size  命中规则`。bundle 太大时给出细分建议：「git 层 1.2 GiB，其中 .gitattributes 标记为 binary 的 Top 文件是 …」——用 `git ls-tree -r -l` 拿大小即可（`dsh-workspace-changes/lib/types/git.js:139-149` 已经在用 `ls-tree -z -l`）。

### 2.8 清理

#### 结论

清理必须**我们自己实现**，因为：
- DSH **没有** attachment GC（§2.3.2 证据）；
- `dsh-spill-local` 只有「启动时一次性、按天数的 sweep」（`dsh-spill-local/lib/index.js:499-509` + `cleanupPeriodDays` 默认 30），且它管的是「模型输出落盘」的文本，不是我们的 blob；它甚至**没有任何配额**（§3 表格）。

#### 生命周期与触发点

| 对象 | 何时删 | 触发 |
|---|---|---|
| staging 目录 `<targetParent>/.dsh-remote/staging/<syncId>/` | 提交成功后立刻；或 `Aborted` 且超过 24 h；或从机重启时发现无对应 in-flight 记录 | 提交、启动扫描、定时（每小时） |
| `old/<syncId>`（被替换下来的旧工作区） | 提交成功且新工作区校验通过后延迟 60 s（留出「刚删就被用户要回」的窗口）；或超过 24 h | 启动扫描、定时 |
| `journal.json` | 提交成功后删；恢复成功后删 | 同上 |
| blob（`<dataRoot>/blobs/`） | **标记-清除**：`live = ⋃(每个已提交工作区的 state.json 中引用的 digest) ∪ (每个 in-flight sync 的 need 集合)`；`unreferenced` 且 `mtime` 超过 `keepBlobsDays`（默认 30 天）才删 | 启动时 + 每次提交后 + 每 6 h |
| `uploads.json` 里的 partial | `startedAt` 超过 24 h 且没有活跃上传 | 启动时 + 定时 |
| 已提交工作区 | 每个 workspace 保留最近 `keepCommittedWorkspaces`（默认 3）个版本（若使用版本目录方案）；超出的删最旧 | 提交后 |
| 任务结束/失败 | **不立即删工作区**（用户要复现失败现场）。删除由 `keepCommittedWorkspaces` + `keepBlobsDays` 自然回收；提供显式 `dsh remote-use prune <workspaceId>` | — |
| 从机重启后 | 启动扫描：`journal.json` 恢复；孤儿 staging 删除；孤儿 `old/` 按 journal 判断该回滚还是删除 | 启动 |

#### GC 的两个反模式（要避免）

1. **不要用「最后一次访问时间」当唯一判据**。`atime` 在 Windows 上默认被禁用（`NtfsDisableLastAccessUpdate`），`mtime` 又会被 checkpoint 重写。用「被 manifest 引用」作为主要判据（标记-清除），时间只作为「无引用后多久删」的宽限期。
2. **不要删只读文件时忘了清只读位**。我们的 blob 是 `chmod 0400` 落地的（照抄 `dsh-attachment-local/lib/index.js:548` 的 `chmod(target, 256)`），Windows 上 `unlink` 只读文件会 `EPERM`。GC 必须先 `chmod 0600` 再删（或 `rm(path, {force:true})` 在 Node 上也会失败——实测需先 chmod）。

实现上建议照抄 `dsh-spill-local` 的 sweep 骨架（它把「symlink 不能冒充目录」「不跟随链接」「best-effort 不抛异常」都处理了：`dsh-spill-local/lib/index.js:181-212,263-265,311-321,344-389,400`），但要补上它缺的**配额**和**引用计数**。

### 2.9 安全

#### 路径穿越防护（从机侧，对 manifest 的每一行都当作不可信输入）

校验顺序（任何一步失败 ⇒ 整份 manifest `Rejected`，不落地任何字节）：

```
for each rel in (cas[].p, dirs[], emptyDirs[], symlinks[].path, delete.paths[]):
  1. 非空、UTF-8 合法、无 NUL(\0)、无控制字符 [\u0000-\u001f\u007f]
  2. 不是绝对路径：
       posix.isAbsolute(rel) == false
       且 !/^[A-Za-z]:/ 且 !rel.startsWith('\\\\') 且 !rel.startsWith('//')
  3. 统一分隔符为 '/'，按 '/' split 后：
       每段非空、非 '.'、非 '..'
       每段不含 ':'（防 NTFS ADS，如 file.txt:evil）
       每段不含 '<' '>' '"' '|' '?' '*'（Windows 非法字符）
       每段不以 '.' 或空格结尾（Windows 会静默去掉）
       每段 UTF-8 字节 ≤ 255
       每段不是保留设备名（含带扩展名/尾随点空格的形式）：
         CON PRN AUX NUL COM1-9 LPT1-9
  4. 整条路径长度 ≤ 30000（留出 \\?\ 前缀与长路径余量）
  5. root = realpath(target)；joined = path.resolve(root, ...segments)
     isPathUnder(joined, root) == true   ← 用 dsh-fs-sandbox 的判定（见下）
  6. lstat(joined)：若是 reparse point/symlink ⇒ 走 §2.9.2 的策略，不静默穿透
```

第 3 步的保留设备名与尾随点/空格处理，**直接复用 DSH 已有实现**：`@deepseek-ai/dsh-attachment-local/lib/index.js:619-652`

```js
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
function isWindowsDeviceName(name) {
	const dot = name.indexOf(".");
	const stem = (dot < 0 ? name : name.slice(0, dot)).replace(/[. ]+$/u, "");
	return WINDOWS_DEVICE_NAME.test(stem);
}
...
let clean = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1)
    .replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"|?*]/g, "_").trim().replace(/[. ]+$/u, "");
if (isWindowsDeviceName(clean)) clean = `_${clean}`;
```

第 5 步的 containment 判定，**照抄 `dsh-fs-sandbox`**（`@deepseek-ai/dsh-fs-sandbox/lib/index.js:18-65`）：先做大小写不敏感的**字典序前缀**快路径，拼写不一致时再沿祖先用 `stat(bigint)` 比较 `(dev, ino)` 物理身份——这样能识别 Windows 的 8.3 短名与大小写别名，而不退化成「文本近似」：

```js
async function isPathUnder(path, root, caseSensitive = process.platform !== "win32") {
	if (isLexicallyUnder(path, root, caseSensitive)) return true;
	const rootInfo = await statIfPresent(root);
	if (!rootInfo) return false;
	let ancestor = path;
	while (true) {
		const ancestorInfo = await statIfPresent(ancestor);
		if (ancestorInfo && sameIdentity(ancestorInfo, rootInfo)) return true;
		const parent = dirname(ancestor);
		if (parent === ancestor) return false;
		ancestor = parent;
	}
}
```
（`sameIdentity(left, right)` = `left.dev === right.dev && left.ino === right.ino`，`:38-40`。）

**注意 `dsh-fs-local` 本身不做这个防护**，别误以为有：`@deepseek-ai/dsh-fs-local/README.md:32` — "`config.cwd` is a resolution default, not a containment boundary: absolute paths and `..` escape it."；`dsh-fs-local/lib/index.js:719-723` 同样声明。containment 只在 `dsh-fs-sandbox` 对**写操作**做，且它自己声明「This is containment, not a security boundary」（`dsh-fs-sandbox/lib/index.js:79-85`）。所以**我们这条通道必须自己实现**，而且它是唯一的边界。

#### 符号链接 / 重解析点逃逸

- **默认策略：拒绝**。manifest 里的 `symlinks` 必须为空，或用户显式 `allowSymlinks: true`。
- 允许时：
  - 目标是**相对路径**，且解析（`path.resolve(dirname(linkPath), target)`）后仍在 `root` 之下；否则拒绝。
  - 目录用 `fs.symlink(target, path, 'junction')`（Windows 上 junction 不需要管理员/开发者模式；file symlink 需要，所以**默认把文件符号链接降级为复制其引用内容**）。
  - 绝不在写入时**穿过**已存在的 link：写每个 staging 文件用 `wx` 独占创建，照抄 `dsh-atomic-write` 的理由（`lib/index.js:45-56`）："The content is first written to a random-suffix sibling opened with exclusive create (`wx`): the **open refuses to follow a symlink planted at the temp path**, and ... The rename also replaces a symlinked target itself instead of writing through to its referent"。
  - 覆盖一个已存在的重解析点时：先 `lstat` 确认类型，用 `unlink`（文件）/`rmdir`（目录 junction）**删掉链接本身**，再写真实文件。**不要** `rm -rf` 一个 junction——Node 的 `rm(recursive)` 在某些版本上会跟随（历史上出过 CVE 级问题），要显式判断。
- **从机侧的 reparse point 也要查**：目标路径或其祖先若是 junction/symlink，从机上的 `realpath` 会与宿主不同（§2.1 实测），这既破坏身份也可能把写操作引到预期之外的目录。开同步前 `lstat` 每一段祖先并检查 `isSymbolicLink()`。

#### 覆盖从机既有文件的策略

三级（manifest `policy.overwriteExisting`）：

| 值 | 语义 | 何时用 |
|---|---|---|
| `refuse`（**默认**） | 目标路径存在且没有 `.dsh-remote/state.json` ownership 标记 ⇒ `Rejected` | 首次同步到一个用户已知的目录：**必须先失败**，让用户明确「这个目录会被接管」 |
| `replace-managed-only` | 目标存在且有 ownership 标记 ⇒ 允许整体替换；无标记 ⇒ 拒绝 | 常规增量同步 |
| `replace` | 无条件替换 | 用户显式对某个 peer+path 打开 |

另外维护一个**拒绝名单**（不管什么策略都不允许作为 target）：

```
- 任何卷根（C:\、D:\ 或 F:）
- 任何深度 < 2 的路径（如 C:\Users）
- %SystemRoot% 及其子树
- %ProgramFiles% / %ProgramFiles(x86)% / %ProgramData%
- 用户 profile 根（C:\Users\<name>）本身
- $DSH_HOME 本身及其任何祖先
- dataRoot 本身及其任何祖先（否则 staging/blobs 会落在工作区里，且 mirror 删除会自杀）
- 任何已有 `.git` 是宿主的**另一个**仓库根（防串仓）
```

**ownership 标记**：`<target>/.dsh-remote/state.json`

```jsonc
{
  "stateVersion": 1,
  "workspaceId": "ws_01JQ...",
  "hostPeerId": "peer_office_pc_02",
  "hostCanonicalPath": "F:\\WorkSpace\\proj",
  "committedAt": "2026-02-11T09:31:02.113Z",
  "committedManifestDigest": "sha256:0011...",
  "syncId": "sy_01JQ...",
  "managedBy": "dsh-plugin-remote-use"
}
```
这个文件是「从机允许被覆盖」的唯一凭据，也是 GC 的引用源。

#### 只读挂载 vs 可写

- 同步阶段：从机的目标目录对中继进程**必须可写**，但**在 session/new 之前不 spawn 远程 agent 的写操作**（顺序保证了这一点）。
- 任务阶段：从机 DSH 的沙箱把写限制在**会话 cwd** 之下。证据：`@deepseek-ai/dsh-sandbox-policy/lib/index.js:141-147` 用 `session?.header.cwd` 作为 `workspaceRoot`；`@deepseek-ai/dsh-sandbox/lib/index.js:166-173` 的 `writableRoots` = `[workspaceRoot, "/tmp", tmpdir()]`（canonical 化后）。
- 从机 DSH 的默认模式来自环境变量：`@deepseek-ai/dsh-base/cordis.patch.yml:226-233`
  ```yaml
  - id: sandbox
    name: '@deepseek-ai/dsh-sandbox-local'
  - id: sandbox-policy
    name: '@deepseek-ai/dsh-sandbox-policy'
    config:
      mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
      workspaceRoot: !!js process.cwd()
  ```
  注意 `workspaceRoot: process.cwd()` 是**回退值**，有会话时以 `session.header.cwd` 为准。但**中继进程 spawn `dsh --profile acp` 时的 cwd 决定了这个回退值**，所以中继应该用「本次任务的工作区路径」作为子进程 cwd，而不是中继自己所在的目录。
- **上报能力**：从机应在 `/hello` 里回报 `sandboxMode`，主机据此提示用户「从机是 danger-full-access，远程 agent 可以写整台机器」。
- **真实的隔离边界是操作系统**，不是 DSH 的沙箱：`dsh-fs-sandbox/lib/index.js:79-85` 明说「The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path, **NOT a kernel boundary** ... The residual TOCTOU (an ancestor symlink swapped between the containment re-check and the syscall) is narrowed by re-canonicalizing immediately before delegating and is accepted for this threat model.」如果从机要跑不可信的 GUI 测试代码，应该用**独立低权限用户账户 / 独立 VM / Windows Sandbox**，而不是依赖 DSH 的沙箱。
- `dsh-fs-local` 的实现里确实有 Windows DACL 保留（`ReplaceFileW` + `copyFileDacl`，`dsh-fs-local/lib/index.js:531-561`），但那是为了「替换文件时不丢 ACL」，不是隔离。

### 2.10 反向回传（从机产物 → 主机）

GUI 测试的产物（截图、视频、trace、报告）默认是「主机没有、从机有」。设计上作为**同一套 CAS 的反向实例**：

```
[从机] 任务结束（或用户请求取回）时扫描结果目录（默认 test-results/、playwright-report/、以及用户配置的 outputs[]）
       → result-manifest { paths, size, mtime, sha256, kind: "artifact" }
[主机] POST /artifact/plan → 从机回 have/need（主机已有的 digest 不用传）
[从机] 对 need 的 digest 通过 GET /artifact/blob?digest=... 暴露（**只允许 manifest 白名单内的 digest**，不是任意文件读）
[主机] 拉取并校验 digest，落到主机的结果目录
```

安全要点：`/artifact/blob` 必须按 digest 白名单校验（digest 由从机的 result-manifest 提供、且该 manifest 是本次任务产生的），否则就成了「任意文件读取」。同时给反向通道单独的字节上限（产物常常很大：一次 Playwright 跑出几百 MB 视频很正常）。

---

## 3. DSH 侧可复用的现成能力

### 3.1 结论表

| 候选 | 能不能用 | 结论与证据 |
|---|---|---|
| `ctx.attachments`（`dsh-attachment` + `dsh-attachment-local`） | **能用，但只用算法** | 唯一现成的 GB 级 sha256 内容寻址流式存储。`saveFileStream`/`readFileStream` 有背压、不聚合、边写边哈希、`link` 去重、崩溃安全。**但 DSH 永远不回收 attachment**（`dsh-attachment/lib/types/index.js:17-18`），且非 image 的 stream 函数未导出（`dsh-attachment-local/lib/index.js:1079`）。详见 §2.3 |
| `dsh-fs` / `dsh-fs-local` / `dsh-fs-sandbox` | **部分** | `dsh-fs` 服务本身极薄（只有 `constructor` 绑定 + stub）。**没有流式写**（grep `appendFile|createWriteStream|WriteStream` → 未找到）。可复用：`FsVersion` 版本 token 与 `FS_STALE_VERSION` 乐观并发（`dsh-fs-local/lib/index.js:146,869-870`）、`contains()`（`:798-801`）、containment 判定（`dsh-fs-sandbox/lib/index.js:53-65`）、Windows 原子替换 + DACL（`dsh-fs-local/lib/index.js:531-561`） |
| `dsh-atomic-write` | **能直接用** | 零依赖、9 KB、`writeFileAtomic` + `withFileLock` 正好是我们要的。Windows 重命名瞬时错误重试（`:17-44`：EACCES/EBUSY/EPERM，8 次，20→200 ms）+ PID 死锁接管（`:121-146`，`process.kill(pid,0)`/`ESRCH`）。**注意**：它**不做 fsync**（`:56` "Crash durability (fsync) is out of scope"），所以写 blob 的暂存文件要自己 `handle.sync()`（照抄 `dsh-attachment-local:515`） |
| `dsh-workspace` | **能复用语义** | `realpathNormalize`（`types/paths.js:43-48`）+ `fullyQualifiedWorkspacePath`（`:14-19`）就是路径交换的规范。**身份是随机 UUID**（`types/index.js:433`），跨机器不可用；唯一 join key 是 realpath 字符串 |
| `dsh-workspace-changes` | **复用法，不复用数据** | `git.js:83-129` 是「不碰仓库拿完整工作树快照」的权威实现（私有 index + `GIT_OBJECT_DIRECTORY` + alternates + `write-tree`）；`gitlinkPaths`（`:195-203`）告诉我们嵌套仓库/submodule 是 gitlink、快照不会下钻；`ignoredPaths`（`:214-223`）给 `check-ignore`。**但它的记录是「会话生命周期内」的**（`recorder.js:198-201` 用 `mkdtemp`，`:171-177` dispose 时删除）、且**记录里没有 size/mtime/digest**（`recorder.js:323-332` 只有 `{path, display, added, deleted, binary?, oversized?}`）⇒ **不能当同步 manifest 用** |
| `dsh-home-paths` | **能直接用** | `resolveDshHome`（`:73-76`：configured > `$DSH_HOME` > `~/.dsh`）、`dshHomePath`（`:82-84`）、`dshCachePath`（`:91-94`）、`canonicalizeWatchPath`（`:29-44`：解析最深已存在祖先的 realpath，专治 Windows 8.3 短名与长路径混用） |
| `dsh-storage` / `dsh-storage-domain` / `dsh-storage-json` | **能用于小状态** | `ctx.storage` hub（`dsh-storage/lib/index.js:104-137`，键 `"storage"`、`storage.backend.<name>`）+ `defineDomain`（`dsh-storage-domain/lib/index.js:61-91`）。落盘是 `<root>/<name>.json`（single）或 `<root>/<name>/<table>/<key>.json`（per-record），写用「临时名 + `open(wx,384)` + `handle.sync()` + `rename` + 目录 fsync」（`dsh-storage-json/lib/index.js:25-41`）。`root` 来自配置：`dsh-base/cordis.patch.yml:168-171` `root: !!js dshHomePath('storages')`。**约束**：unit/table 名必须匹配 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（`dsh-storage/lib/index.js:79-80`）⇒ 域名只能用 `dsh_plugin_remote_use` 这类下划线形式，**不能**用 `dsh-plugin-remote-use`。适合存：peer 注册表、workspaceId↔路径映射、同步历史索引 |
| `dsh-spill` / `dsh-spill-local` | **不能复用为 blob 存储** | 只有一个 `saveText(input)`（`dsh-spill/lib/index.js:52-56`；签名见 `dsh-tool-cordis/lib/types/api-catalog.js:2698`）。**非内容寻址、不分块、不去重、无配额**；唯一 sha256 是用来命名**会话目录**的（`dsh-spill-local/lib/index.js:69-71`）。GC 只有「启动时一次性按天数 sweep」（`:499-509`，`cleanupPeriodDays` 默认 30）。README 明说无检索无删除 API（`dsh-spill/README.md:12,136`） |
| `dsh-util-crypto` | **不能用于哈希** | 整个包只有 35 行，导出 `bytesToBase64` 与 `randomUUID`（`lib/index.js:17-33,35`）。**没有 sha256/HMAC/签名**。哈希一律用 `node:crypto` |
| `dsh-session-format*` | **无关** | 导出全是会话日志格式的 schema/版本/迁移工具（`dsh-session-format/lib/index.js:491`：`createSessionFormatCatalog`、`defineSessionFormatMigration`、`sessionFormatLogFilename` …）。没有任何传输/打包/编码工具（grep `zip|pack|transfer|chunk|stream` → 未找到与传输相关者） |
| `dsh-client-file-upload` | **复用形态，不复用代码** | 「认证的 raw-byte 流式 HTTP 上传路由」的权威先例（见 §2.5 证据 C）。但注册在 `ctx.connection.fetch`（DSH 自己的 client↔host registry），不是 P2P；**没有断点续传**（grep `Range|offset|resume|Content-Range` → 未找到） |
| `dsh-host-webserver` | **从机用不上** | `register` / `registerUpgrade` / `registerFallback`（`lib/index.js:171-207`、`:261-286`）是现成的「HTTP 路由 + WS upgrade 注册」机制，**但 acp profile 里没有它**：`dsh-acp-app/cordis.patch.yml` 只含 `@deepseek-ai/dsh-acp`（`dsh-base` 里也没有 webserver；`dsh-web-app` 才有）。所以从机侧必须是自带监听器的 standalone 中继（§2.5 拓扑） |
| `dsh-output-retention` | **无关** | 纯内存的文本截断库，不是服务、不碰磁盘（`lib/index.js:2-31` 明说是 library 不是 cordis service/plugin）；预算全部由调用方给 |
| `dsh-atomic-write` 之外的分块原语 | **未找到可复用者** | 全库搜索 `chunkSize|CHUNK|readChunk|Range|offset|resume` → 只有 `dsh-attachment-local` 的流式 hash/写（`:498-535`、`:719-745`，`highWaterMark: 65536`）与 `dsh-client-file-upload` 的 32768 base64 分片可用作**参考**；没有现成的「可续传传输」实现 |

### 3.2 「未找到」清单（附搜索关键词，便于复核）

| 想要的东西 | 结果 | 搜索关键词 |
|---|---|---|
| 机器间文件传输 | 未找到 | `\bscp\b`、`\brsync\b`、`ssh2`、`node-ssh`、`\bsftp\b`；`dsh-api-remotes` 是「remote API 命名空间」不是文件传输 |
| 流式/分块写文件（`ctx.fs` 层） | 未找到 | `appendFile`、`createWriteStream`、`WriteStream`、写路径的 `offset`；`dsh-fs-local/README.md:134-137` 明确只读路径有流式 |
| 目录 fsync | 未找到（且 Windows 上无意义） | `fsync`、目录句柄 `sync`；`dsh-atomic-write/lib/index.js:56` 声明 out of scope；`dsh-attachment-local/lib/index.js:357-359` 在 win32 直接 return |
| `MoveFileEx` | 未找到 | `MoveFileEx`（`dsh-fs-local` 用的是 koffi 直调 `ReplaceFileW`，`lib/index.js:85-88`） |
| attachment 的 GC / 引用计数 | 未找到 | `retention`、`collectUnreachable`、`garbage`、`sweep` 在 attachment 相关包内只命中注释 |
| `ctx.attachments` 的 verbatim stream 函数导出 | 未找到（未导出） | `dsh-attachment-local/lib/index.js:1079` 的 export 清单 |
| `dsh-util-crypto` 的哈希 | 未找到 | 读全文件（35 行） |
| 长路径/保留名检查 | 未找到（除 attachment 的 leaf name 清洗） | `\\?\`、`MAX_PATH`、`long path`、`CON`、`NUL`；只有 `dsh-native-command` 的注释提到 verbatim 前缀，`dsh-attachment-local:619-652` 做 leaf name 清洗 |
| ACP 的鉴权 | 未找到（协议无鉴权） | 见报告 03；`dsh-acp` 只 `validateWorkspaceParams`（`lib/index.js:1409-1413`） |

### 3.3 复用决策汇总（落地时的取舍）

```
直接 import 使用：
  @deepseek-ai/dsh-atomic-write      → writeFileAtomic / withFileLock（主机侧；从机侧复制实现）
  @deepseek-ai/dsh-home-paths        → resolveDshHome / dshHomePath / dshCachePath / canonicalizeWatchPath
  @deepseek-ai/dsh-workspace 的 paths → realpathNormalize / fullyQualifiedWorkspacePath
  @deepseek-ai/dsh-storage(+domain+json) → 同步子系统的持久索引（domain 名用 dsh_plugin_remote_use）
  node:crypto                        → sha256 / HMAC（不要用 dsh-util-crypto）

复制算法（约 200~300 行，从机侧零 DSH 依赖）：
  dsh-attachment-local 的 stage/publish/link/chmod 流程
  dsh-atomic-write 的 Windows rename 重试 + 锁接管
  dsh-fs-sandbox 的 isPathUnder（含 dev/ino 回退）
  dsh-attachment-local 的 Windows 保留名清洗
  dsh-spill-local 的 sweep 骨架（含 symlink 防冒充）
  dsh-workspace-changes/lib/types/git.js 的 git 私有对象库 + write-tree 技法

只在主机侧、且组件跑在 DSH 进程内时才考虑：
  ctx.attachments.saveFileStream / readFileStream（作为 blobBackend: "attachments"，需自建 GC）
```

---

## 4. 与 ACP 的衔接

### 4.1 结论：同步必须在 `session/new` **之前**，因此通道必须是独立的

`session/new` 用 `cwd` 指定从机工作目录，且要求**绝对路径**、**已存在**（DSH 侧 `realpathNormalize` 会对不存在路径抛 `ENOENT`）：

```js
// @deepseek-ai/dsh-acp/lib/index.js:1409-1413
/** Reject workspace features outside the automation contract. */
function validateWorkspaceParams(params) {
	if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`);
	if (params.additionalDirectories !== void 0 && params.additionalDirectories !== null && params.additionalDirectories.length > 0) throw invalidParams("additionalDirectories is not supported");
}
```

```js
// @deepseek-ai/dsh-acp/lib/index.js:1168-1176
async newSession(params, signal) {
    assertOpen();
    validateWorkspaceParams(params);
    const sessionId = brandString(randomUUID());
    let record;
    try {
        record = await AcpSession.create(ctx, {
            sessionId,
            cwd: params.cwd,          // ← 直接成为会话的 workspace
```
`cwd` 随后进 `session.header`（`AcpSession.create` 里 `meta: { cwd: options.cwd }`，`:695-699`），成为沙箱 `workspaceRoot`（§2.9）与 workspace 归属判定的依据（§2.1）。

因此三条硬约束：

1. **工作区必须在 `session/new` 之前就位**，否则从机会把 `cwd` 记成一个空目录（甚至因 `realpath` 失败而在 workspace 注册阶段记成 invalid）。
2. **同步不能走 ACP 会话通道**——会话还不存在。ACP 也没有任何「附带资源/附件随会话建立」的协议位（`additionalDirectories` 被显式拒绝：`:1412`）。
3. 因此同步通道是**独立的**：在**配对连接建立之后、任务创建（`session/new`）之前**，用中继的 HTTP 通道完成。

### 4.2 正确顺序

```
 1. 配对（pairing）：交换 peerId + pairingToken + 能力探测
 2. GET  /dsh-remote/v1/hello           → { platform, gitAvailable, gitVersion, sandboxMode,
                                            dataRoot, volumeFreeBytes, pathChecks }
 3. 路径预检（§2.1 的五步检查）+ 配额预检（§2.7）      ← 失败 ⇒ 不发 session/new
 4. POST /sync/plan (manifest)          → { have, need, extra, pathChecks }
 5. PUT  /blob（分块，可续传）×N + PUT /git/bundle
 6. PUT  /blob 完成后 POST /sync/commit  ← 服务端：校验 → 物化 → 切换 → 写 state.json
 7. 从机 rehydrate（npm ci / pip install / 自定义脚本）← 失败 ⇒ 回滚并 Rejected
 8. ─────────── 事务提交点：从机回报 state="committed" ───────────
 9. ACP initialize
10. ACP session/new { cwd: <targetCanonicalPath>, mcpServers: [...] }
11. ACP session/prompt（任务）
12. 收产物（§2.10）、ACP session/close
13. GC（§2.8）
```

第 3/7 步的存在就是为了让「要么完整、要么不开始」成立：**第 8 步之前绝不发 `session/new`，第 8 步之后从机上的工作区一定是完整的**。

### 4.3 一致性 / 事务性：崩溃矩阵

| 崩溃点 | 从机磁盘状态 | 目标路径状态 | 恢复动作 |
|---|---|---|---|
| 配对后、预检中 | 无变化 | 无变化 | 重试即可 |
| `/sync/plan` 后、传输前 | 只写了元数据 | 无变化 | `Aborted`；清理元数据 |
| 传输中（主机崩 / 从机崩 / 断网） | `<targetParent>/.dsh-remote/staging/<syncId>/` 半成品 | **完全未被触碰** | 重连后 `GET /sync/<id>`：从 `uploads.json` + staging 恢复，续传缺失 blob；staging 超过 24 h 无 in-flight 记录 ⇒ 清理 |
| 校验中失败（digest 不符） | staging 半成品 | 无变化 | `Rejected`（不重试，因为大概率是内容问题）；保留 staging 供诊断，24 h 后清 |
| **切换中、第一次 rename 后**（旧目录已移走） | `old/<syncId>` 完整；staging 完整 | **短暂不存在** | `journal.json` 记录 `phase: "old-moved"`；启动时若 `journal` 说 `old-moved` 而 `<target>` 不存在 ⇒ 把 `old` 改回名（回滚），然后重试切换 |
| **切换中、第二次 rename 后**（staging 已就位） | `old` 完整；staging 已消失 | **新工作区完整** | `journal.json` 记录 `phase: "new-in-place"`；启动时补写 `state.json` 并删 `old`（前滚） |
| 切换后、写 `state.json` 前 | 新工作区完整 | 完整 | 同上一行（前滚，用 manifestDigest 补齐 state.json） |
| `state.json` 后、回报主机前 | 新工作区完整 + 有标记 | 完整 | 主机重试 `commit`：`syncId` 幂等，从机直接回 `committed`（已提交过） |
| `session/new` 后、任务中 | 完整 | 完整 | 与同步无关；会话崩溃按报告 03 的 ACP 语义处理 |
| rehydrate 失败 | 工作区完整但依赖不全 | 完整但不可用 | `Rejected`；**不**标记 committed；目标目录回滚到上一版本（若之前有） |

**关键机制：`journal.json`**

```jsonc
// <targetParent>/.dsh-remote/journal.json   （原子写，内含 syncId + 阶段 + time）
{
  "journalVersion": 1,
  "syncId": "sy_01JQ...",
  "targetPath": "F:\\WorkSpace\\proj",
  "stagingPath": "F:\\WorkSpace\\.dsh-remote\\staging\\sy_01JQ...",
  "oldPath": "F:\\WorkSpace\\.dsh-remote\\old\\sy_01JQ...",
  "phase": "old-moved",          // "staged" | "old-moved" | "new-in-place" | "state-written"
  "previousState": null,         // 旧版本的 state.json（用于回滚后恢复）
  "startedAt": "2026-02-11T09:12:33.412Z"
}
```

一次只允许一个 journal 存在（`<targetParent>/.dsh-remote/journal.json` 用 `wx` 独占创建；已存在 ⇒ 说明上一次未收尾 ⇒ 先恢复再开始新的）。这把「并发切换同一路径」也挡住了。

**为什么必须两次 rename 而不是一次**：Windows 上**不能**把目录 rename 覆盖到一个已存在的非空目录上（`EPERM`/`ENOTEMPTY`）。所以只能「先挪走、再挪进来」，中间必然有一个窗口。这个窗口可接受，因为：
- 切换只发生在**没有活跃会话**时（同一 workspace 上不允许并发 task；用 `.dsh-remote/journal.json` + 内存里的 active-session 表双重保证）；
- 窗口内路径不存在，任何 `lstat` 会失败，所以不会有人读到半成品；
- `journal.json` 让窗口可恢复。

**如果目标目录从不替换（只用「首次创建」路径），事务性最强**：`fs.rename(staging, target)` 单次调用，目标不存在 ⇒ 在 NTFS 同一卷上是原子目录项替换。建议把「每个 task 一个全新的工作区目录」作为**默认策略**（`workspaceStrategy: "per-task"`），把「原地增量同步」作为可选策略（`"sticky"`，省带宽但需要两次 rename）。

> 权衡说明：`per-task` 每次都要全量物化（除非 blob 命中），带宽/磁盘占用高但事务性最干净；`sticky` 省带宽但要面对两次 rename、文件占用、以及「从机上的改动要不要保留」的问题。**推荐 v1 用 `per-task` + 一个长期 blob 库**（blob 命中率高时，物化只是本地硬链接/复制，不走网络），等稳定后再上 `sticky`。

### 4.4 同步状态机

**主体**：一个 (peer, workspace) 上的一次同步事务（`syncId`）。图与迁移条件如下。

```
                    ┌──────────────────────────────────────────────────────┐
                    │                                                      │
                    ▼                                                      │
   [Idle] ──task 创建──▶ [Preflight] ──通过──▶ [Planning] ──accept──▶ [Transferring]
     ▲                      │                    │                        │
     │                      │拒绝                 │拒绝/超限                │断网/超时
     │                      ▼                    ▼                        ▼
     │                  [Rejected]           [Rejected] ────────────▶ [Suspended]
     │                      │                                             │
     │                      │                                             │重连
     │                      │                                             ▼
     │                      │                                        [Transferring]
     │                      │                                             │全部 blob 完成
     │                      │                                             ▼
     │                      │                                        [Verifying]
     │                      │                                        │        │
     │                      │                                   校验失败    校验通过
     │                      │                                        │        ▼
     │                      │                                        │   [Materializing]
     │                      │                                        │        │
     │                      │                                        │   ┌────┴────┐
     │                      │                                        │ 物化失败  物化成功
     │                      │                                        │   │        ▼
     │                      │                                        │   │   [Rehydrating]
     │                      │                                        │   │    │      │
     │                      │                                        │   │ 失败    成功
     │                      │                                        │   │    │      ▼
     │                      │                                        │   │    │  [Committed]
     │                      │                                        │   │    │      │
     │                      │                                        │   │    │   ACP session/new
     │                      │                                        ▼   ▼    ▼      │
     │                      └──────────────────────────────────── [Rejected] │      │
     │                                                                       │      │
     └────────────────────── [Cleaning] ◀──session 结束/失败──────────────────┴──────┘
                                 │
                                 ▼
                              [Garbage]
```

**状态定义与迁移条件**

| 状态 | 含义 | 进入条件 | 离开条件 |
|---|---|---|---|
| `Idle` | 无同步事务 | 初始 / 上轮清理完成 | 用户/主机创建任务 → `Preflight` |
| `Preflight` | 探测能力、路径、配额 | — | 全部检查通过 → `Planning`；任一失败 → `Rejected` |
| `Planning` | 交换 manifest、求差集 | — | 从机 `accepted: true` → `Transferring`；`accepted: false` → `Rejected` |
| `Transferring` | 传 blob / bundle | — | 全部 `need` 的 blob 且 bundle 达到 `complete` → `Verifying`；网络错误/超时 → `Suspended`；用户取消 → `Aborted` |
| `Suspended` | 传输可恢复地挂起（staging 与 `uploads.json` 保留） | 传输期网络/超时 | 重连且 `GET /sync/<id>` 可续 → `Transferring`；挂起超过 `maxSyncDurationMs` × 4 或用户取消 → `Aborted` |
| `Verifying` | 逐文件 digest 校验 + bundle `fetch` 完整性校验 | — | 全部通过 → `Materializing`；任一不符 → `Rejected`（不重试） |
| `Materializing` | staging → 目标路径切换（§4.3） | — | 切换成功 → `Rehydrating`；失败 → `Rejected`（并用 journal 回滚） |
| `Rehydrating` | 从机重建依赖（npm ci 等） | 配置 `rehydrate.enabled` | 全部步骤成功 → `Committed`；失败 → `Rejected` + 回滚 |
| `Committed` | **事务提交点**。目标路径是完整、自洽的工作区；`state.json` 已写 | — | 主机发 `session/new`；会话期间驻留 |
| `Aborted` | 用户/主机主动取消 | 任意非终态收到 cancel | → `Cleaning` |
| `Rejected` | 显式失败（预检/校验/配额/覆盖策略） | — | → `Cleaning`（保留证据目录供诊断） |
| `Cleaning` | 清 staging、`old`、journal、in-flight 记录 | 会话结束、任务失败、`Aborted`、`Rejected` 收尾 | GC 完成后 → `Idle`（blob 本身按 §2.8 的保留策略留给后续同步复用） |

**幂等键**：`(peerId, targetCanonicalPath, manifestDigest)`。
- 若从机已有 `state.json` 且 `committedManifestDigest === manifestDigest` ⇒ 直接跳到 `Committed`（**零传输**），这是最常见的重复任务快路径。
- `POST /sync/commit` 对同一 `syncId` 幂等：重复调用返回同一个 `committed` 结果。

**并发约束**：
- 同一 `(peer, targetCanonicalPath)` 同时只允许一个非终态同步（`journal.json` + 从机侧内存表）。
- 同一 peer 的多个不同工作区可以并行（受 `maxConcurrentBlobs` 与从机磁盘约束）。
- `session/new` 之后，该工作区进入「占用」状态；新的同步必须等待或使用另一个工作区目录。

### 4.5 与主机侧 DSH 的装配点

- 主机侧插件拿到的会话 cwd 就是 `session.header.cwd`（`@deepseek-ai/dsh-workspace-changes/lib/index.js:985-987` 展示了这个取值方式）。同步子系统应该在**创建远程任务**的动作里被调用，而不是挂在每次会话启动上。
- ACP 客户端侧：`initialize` → `session/new { cwd }`。注意本版本 ACP 没有 `session/load`（报告 03 结论），重连只能靠保存 `sessionId` 后走 `session/resume`；而 `session/resume` 会校验 `cwd` 与持久化 header 一致（`dsh-acp/lib/index.js:1217`），所以**恢复会话要求同步后的路径与首次完全一致**（又一次指向 §2.1 的路径一致性）。
- 从机侧 spawn 时把子进程 `cwd` 设为本次任务的工作区（影响沙箱回退 `workspaceRoot`，见 §2.9）。

---

## 5. Windows 特殊性

主机和从机大概率都是 Windows，以下是逐条结论（附实测/证据）。

### 5.1 分隔符与路径形态

- manifest 内部一律用 `/`（POSIX 风格）相对路径；落盘用 `path.join` / `path.win32` 转换。**不要**在 manifest 里放 `\`，否则 JSON 双重转义 + 跨平台不一致。
- 从机的绝对路径必须是「完全限定」：`@deepseek-ai/dsh-workspace/lib/types/paths.js:14-19` 要求 `win32.isAbsolute(path) && root !== '\\' && root !== '/'` ⇒ `F:proj`（驱动器相对）被拒，UNC 可以。收到路径先过这个判定。
- 驱动器相对路径（`F:proj`）与 root-relative（`\proj`）必须拒绝，它们是「跟随当前目录/当前盘」的隐式依赖，跨机器必错。

### 5.2 大小写不敏感

- NTFS 大小写不敏感但**保留大小写**，`fs.realpath` 返回**磁盘上的真实大小写**。
- `dsh-workspace` 的唯一性判定是**大小写敏感的字符串全等**（`paths.js:33-35` + `types/index.js:417-423`）；`dsh-fs-sandbox` 的 containment 才做 `toLowerCase`（`lib/index.js:18-20`）。所以：同一条路径写成 `F:\workspace\proj` 与 `F:\WorkSpace\proj`，在 workspace 层面是**两个不同的东西**。
- 实践规则：
  - 路径交换一律用 `fs.realpath` 的结果，不要用用户输入；
  - 从机侧对 manifest 里的相对路径做「大小写冲突检测」：如果同一目录下出现 `Foo` 与 `foo` 两个条目（在 Linux 端合法、Windows 端会互相覆盖），**必须拒绝**整份 manifest 并报告冲突。这是 Linux→Windows 方向最容易踩的坑。
- 中文/emoji 文件名：用 `fs` 的 UTF-8 API 没问题，但**不要**依赖 `localeCompare` 排序（不同机器 locale 不同）。排序用 UTF-8 字节序（DSH 自己就这么做：`dsh-acp/lib/index.js:1405-1408` `Buffer.compare(Buffer.from(left), Buffer.from(right))`）。

### 5.3 长路径（> 260）

- Node 在 Windows 上会自动把路径转成 `\\?\` 形式（`toNamespacedPath`）用于 Win32 API 调用（`dsh-fs-local/lib/index.js:60-66` 就是显式这么做的），所以**用 Node 的 `fs` API 处理 > 260 的路径基本可行**。
- 但**依赖外部程序时不行**：git、npm、python、chromedriver 都可能因为 `MAX_PATH` 失败。可缓解但不能根治：
  - 目标路径尽量短（`F:\ws\<short>\proj` 优于 `F:\WorkSpace\Company\Team\VeryLongProductName\...`）；
  - 在从机上为目标盘开启长路径支持（注册表 `LongPathsEnabled=1` + 应用的 manifest），但这是部署侧要求，插件无法自己完成；
  - 我们在 manifest 校验时给出「路径长度 Top 20」预警（> 200 字符的相对路径就 warn）。
- DSH 自己的 long-path 相关处理只有：`canonicalizeWatchPath` 解析 8.3 短名（`dsh-home-paths/lib/index.js:16-28`）、`dsh-native-command` 对 `\\?\` 前缀的注释（`lib/index.js:122-123`）。**没有**通用的长路径兼容层。

### 5.4 junction / symlink 权限

- **junction（目录重解析点）不需要管理员权限**；**文件符号链接需要** `SeCreateSymbolicLinkPrivilege`（管理员）或 Developer Mode。所以：
  - 需要 link 时优先用 directory junction；
  - 文件级 symlink 一律降级为「复制引用内容」；
  - 用 `fs.symlink(target, path, 'junction')` 时 `target` 必须是**绝对路径**（Windows 的 junction 语义），而我们 §2.9 要求 link target 是相对路径——两者冲突。解决：校验时用相对路径做 containment 检查，创建时转成绝对路径。
- **junction 会破坏 realpath 身份**（§2.1 实测）。所以**绝对不要**用 junction 来「伪装」工作区路径；只在 manifest 明确声明 symlink 且用户开启 `allowSymlinks` 时创建。
- 从机上删除 junction 要用 `rmdir`（或 `fs.rm` 加 `recursive: false`），不要用可能跟随链接的递归删除。

### 5.5 文件锁（正在被占用的文件无法替换）

这是 `sticky` 策略下最现实的失败源：

- 从机上正在跑的 GUI 测试进程、chromedriver、`node.exe`、杀毒软件、Windows Search Indexer、Explorer 预览都可能持有文件句柄 ⇒ 删除/重命名该文件失败 `EACCES`/`EBUSY`/`EPERM`。
- DSH 里**唯一的** Windows 重试逻辑是 `@deepseek-ai/dsh-atomic-write/lib/index.js:17-44`：
  ```js
  const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
  const WINDOWS_RENAME_RETRY_INITIAL_MS = 20;
  const WINDOWS_RENAME_RETRY_MAX_MS = 200;
  const WINDOWS_RENAME_RETRY_LIMIT = 8;
  ```
  20→200 ms 指数退避、共 8 次 ≈ 最多约 1.1 s。**对杀毒扫描一个大文件来说完全不够。**
- 而 `dsh-fs-local` 自己的替换路径**没有重试**：`ReplaceFileW` 失败就抛（`lib/index.js:531-561` 之后是 cleanup + rethrow）。
- 我们的策略：
  - 写 blob 用**新名字**（digest 派生），不覆盖任何已有文件 ⇒ 天然避开占用问题；
  - 物化到 staging（全新目录）⇒ 不碰目标文件；
  - 只有 `sticky` 的两次 rename 会碰到「正在被占用的目录」⇒ 重试参数放宽到 **10 次、20 ms→2 s**（约 12 s 总窗口），并在失败时给出可操作的错误：「`F:\...\proj` 被占用，请关闭从机上使用该目录的进程；占用者往往是 chromedriver/浏览器/杀毒软件」；
  - 提供 `--force-retry-ms` 让用户在慢机器上加大窗口；
  - 不尝试「强制解锁」：Windows 上除了 `NtQuerySystemInformation` + `DuplicateHandle` 之外没有可靠的用户态解锁手段，不要走这条路。
- **同时提醒用户把从机的 Defender 实时扫描排除 `dataRoot` 和测试工作区**，否则 3 GB 新文件的实时扫描会让物化阶段从秒级变成分钟级。

### 5.6 `robocopy` / `xcopy` 的存在性

- 两者是 Windows 自带（`%SystemRoot%\System32\`），但：
  - 它们**不能**作为主干（§1.3 反例 A）；
  - 退出码语义反直觉：`robocopy` 的 `0`–`7` 都表示成功，`≥ 8` 才是失败，脚本里必须按 `>= 8` 判定；
  - `/MIR` 会删除目标侧文件，且 `/MIR` + 错误的源路径 = 数据丢失；
  - 不支持断点续传一个「大文件」（`/Z` 支持重启模式但依赖 RDC，行为与我们的 digest 语义不一致）。
- 结论：**不依赖**它们。可以作为「用户自己的补救工具」在文档里提一句，但不进代码路径。DSH 自己也不依赖它们（全库 grep `robocopy|xcopy` → 未找到）。

### 5.7 驱动器盘符不同

- `subst` 与 junction **都不能**保持 realpath（§2.1 实测），所以「从机盘符不同」无法用路径技巧解决。
- 可行选项（按推荐度）：
  1. **让出盘符**：从机上把目标盘符腾出来（或给数据卷分配该盘符）。这是唯一不损失语义的方案。
  2. **显式 `pathMap` + 降级模式**：接受后果，插件负责（a）在会话开始前打印影响清单，（b）把映射表注入从机 agent 指令，（c）在 manifest 里记 `pathMode: "mapped"` 以便审计。
  3. **磁盘管理里分配盘符**（需要管理员）：如果从机有多余卷，`diskpart` / `Set-Partition -NewDriveLetter` 可以把卷固定到宿主同款盘符，一次配置长期有效。这实际上就是选项 1 的自动化版本。
  4. 卷挂载点（把卷挂到 `F:\WorkSpace` 目录）——**未验证** realpath 行为，用前必须实测。
- 若宿主路径的**盘符也不固定**（U 盘、动态盘），把「宿主侧的 canonical path 可能在不同会话间变化」也纳入考虑：`workspaceId` 不能只用路径派生，还得带上机器身份（MAC/机器名 hash），否则同一项目换盘符后会被当成新工作区。

### 5.8 其他 Windows 细节

| 项 | 处理 |
|---|---|
| 保留设备名 `CON/NUL/COM1…` | 复用 `dsh-attachment-local/lib/index.js:619-652` 的 `isWindowsDeviceName` + 尾随点/空格清洗逻辑做校验 |
| 尾随 `.` / 空格 | Windows 会静默去掉 ⇒ 校验时拒绝，且与主机上的文件名做一次「规范化后是否冲突」检测 |
| ADS（`file:stream`） | 段内出现 `:` 一律拒绝 |
| 最大路径 32767 | 校验相对路径总长 ≤ 30000 |
| 稀疏文件 / 压缩属性 | 不保留；稀疏的大文件在网络传输+落盘后会变成实心文件，注意磁盘配额 |
| `FILE_ATTRIBUTE_HIDDEN/SYSTEM` | 不保留（除非显式配置）。`System Volume Information`、`$RECYCLE.BIN` 直接排除 |
| 文件时间戳精度 | NTFS 100 ns；FAT32 2 s。`preserveMtime` 只在 NTFS→NTFS 有意义，且**永不**用 mtime 做跨机器内容判定 |
| 权限/ACL | 不传输 ACL。落盘用继承 ACL（`mkdir` 默认）。`dsh-fs-local` 的 DACL 保留（`ReplaceFileW` + `copyFileDacl`）是 DSH 自己替换单文件时的行为，我们不复制它 |
| 中文路径 / 非 BMP 字符 | JSON 用 UTF-8 无 BOM 写出；校验 UTF-16 代理对完整性（避免半个 emoji 让 `fs` 抛错） |
| 杀毒/EDR | 无法绕过；文档里要求排除 `dataRoot` + 工作区；错误信息里提示这一原因 |
| 从机上已有同名只读文件 | 覆盖前 `chmod 0600`（见 §2.8 GC 一节） |

---

## 6. 最容易出错 / 最容易被低估的 3 件事

### 第 1 件：realpath 路径身份 —— 它不是「美观问题」，是功能正确性

**被低估的原因**：直觉上「从机路径不同就用 junction/subst 顶上」看起来是个显然的解法。

**实际后果**（§2.1 完整清单）：

- `@deepseek-ai/dsh-workspace/lib/types/paths.js:33-35`：workspace 的唯一性是**规范化路径的字符串全等**；durable id 是 `randomUUID()`（`types/index.js:433`）⇒ **没有任何跨机器的 join key**，只有那个路径字符串。
- `dsh-workspace/lib/index.js:872-890` + `:900-909`：`cwd` 解析不了/不是目录的 session 会被**踢出 workspace 成员**并 warn。
- `dsh-acp/lib/index.js:1217, 1234-1237`：`session/resume` 直接 `session cwd does not match`；`:1256-1274`：`session/list` 按 `sameDirectory` 过滤。而报告 03 已经确认本版本 ACP **没有 `session/load`**，重连恢复只能靠 `session/resume`。
- `dsh-sandbox-policy/lib/index.js:141-147` + `dsh-sandbox/lib/index.js:166-173`：写权限被限制在 `session.header.cwd` 之下。
- **本机实测**：junction 与 subst 都被 `realpath`（native 与 promises 两种实现）解析到真实底层路径 ⇒ **它们会破坏路径身份，不是修复它**。

**防呆措施**：把「realpath 一致」做成同步前的**硬闸**（`Preflight` 状态），不一致就 `Rejected` 并给出人类可读的修复指引；只有用户显式配置 `pathMap` 才进降级模式，且降级模式必须打印影响清单并注入 agent 指令。

### 第 2 件：(mtime, size) 不是跨机器的内容判据 —— 会静默跑旧夹具，造成 GUI 测试**假绿**

**被低估的原因**：`rsync`/`make`/大多数构建系统都用 mtime+size，直觉上「文件没变就不传」是标准做法。

**为什么在这里是致命的**：

- 机器间 mtime 不可比：FAT32/exFAT 2 秒粒度、时区/DST、拷贝工具（zip 解压、`Expand-Archive`、网盘同步）会重写 mtime、`git checkout` 会把 mtime 设成当前时间（从机上刚物化完就是「现在」）、Windows 上某些同步客户端把 mtime 规整到整秒。**于是「从机的 mtime 比主机新」是常态**。
- 一旦据此跳过传输，从机上就是一个**内容陈旧但看起来正常**的夹具。GUI 测试可能：
  - 因为旧夹具里没有新加的用例/断言而**通过**（假绿，最坏结果）；
  - 因为旧驱动与旧版本不匹配而**超时/闪退**（浪费时间，误判为环境问题）。
- 更隐蔽的是「大小相同、mtime 相同、内容不同」：例如测试把某个 `.exe` 打成同样的 16 MiB 但内部常量不同。

**防呆措施**：

1. **跨机器只认 sha256**（§2.2）。`(size, mtime)` 只用于**宿主本机**的 hash 缓存键（同一文件系统、同一时钟），这是安全的加速。
2. 从机侧在**写之前**再比一次 digest：`如果 target 已存在且 digest 相同 ⇒ 不重写`（省 IO 且保留 mtime），但**判定必须来自 digest 而不是 stat**。
3. 每份 manifest 带 `manifestDigest`，从机的 `state.json` 记 `committedManifestDigest`。任务开始时主机先问「你有没有这个 digest」——**命中就直接零传输**（这是最常见的重复任务路径，也是最容易写错的路径：千万别用「路径+mtime」去判断命中）。
4. 提供 `dsh remote-use verify <workspaceId>` 命令，强制全量重算 digest 并与 `state.json` 比对，用于「怀疑假绿」时的诊断。

### 第 3 件：Windows 上「替换工作区」既不是原子操作，也不是廉价操作

**被低估的原因**：POSIX 思维里「rename 一个目录」是原子的、廉价的、无忧的。

**三个叠加的坑**：

1. **不能 rename 覆盖非空目录** ⇒ 必须「先挪走再挪进来」，中间有一个路径不存在的窗口，必须靠 `journal.json` 才能从崩溃中恢复（§4.3）。这不是理论问题：从机的任务可能被 Ctrl-C、断电、或被用户重启。
2. **文件占用** ⇒ 只要有一个文件被 GUI 测试残留进程/杀毒/索引器持有，删除或重命名就 `EACCES`/`EBUSY`/`EPERM`。DSH 里唯一的重试逻辑只有 `dsh-atomic-write/lib/index.js:17-44`（8 次、20→200 ms ≈ 1.1 s），而 `dsh-fs-local` 的替换路径**完全不重试**（`lib/index.js:531-561`）。我们的重试窗口要放宽到 ~12 s，并且必须能在失败时告诉用户「谁在占用」。
3. **磁盘峰值 ≈ 3 倍工作区**（staging + old + blob 库；如果 blob 是复制而非硬链接则更多），再叠加「staging 必须与目标同卷」这一硬约束（`fs.rename` 不跨卷）和「从机剩余空间必须提前检查」。3 GB 的夹具 + 5 GB 的旧版本 + 3 GB 的 blob，会在一台 256 GB 的测试机上直接把盘写满，然后**同步失败但留下几十 GB 垃圾**。所以：`freeSpaceFloorBytes` 预检（§2.7）+ 提交后立刻删 `old` + blob 的标记-清除 GC（§2.8）**三件都要有**，缺一不可。

**防呆措施**：

- 默认 `per-task` 全新目录策略（单次 rename，无旧目录要挪），把 `sticky` 作为可选；
- 预检剩余空间并把「需要多少 / 现在多少」明确回报；
- 提交后**立即**删 `old`（不必等 60 s：`per-task` 策略下旧目录是新目录的前身，用户在从机上不需要它；若用户要现场，用 `sticky` + 保留 N 版）；
- 所有删除/重命名都带「先清只读位 + 放宽重试 + 可操作的错误信息」。

### 荣誉提名（同样值得写进实现检查单）

- **DSH 没有 attachment GC**（`dsh-attachment/lib/types/index.js:17-18`）⇒ 用 `ctx.attachments` 存几 GB 夹具 = 永久占盘，必须自建引用计数 GC。
- **`$DSH_HOME` 里的凭据与会话日志**（`.credentials.yaml`、`sessions/` 的 zstd 会话日志含完整 prompt/工具输出、`.git/config` 可能内嵌 token）—— 默认排除清单漏一条就是一次凭据外泄。
- **从机 DSH 的沙箱不是内核边界**（`dsh-fs-sandbox/lib/index.js:79-85` 自述 + `dsh-fs-local/README.md:32` 明确 `cwd` 不是 containment）⇒ 要真正隔离不可信代码，必须用低权限账户/VM。
- **`rehydrate` 的 lockfile digest 必须进 manifest**：装了不同版本的依赖会让 GUI 测试给出与主机不同的结论，与第 2 件同构。

---

## 附录 A — 术语与路径约定

| 术语 | 含义 |
|---|---|
| `dataRoot` | 从机侧插件数据根，默认 `$DSH_HOME/storages/dsh-plugin-remote-use/`（覆盖：`DSH_REMOTE_DATA_ROOT`） |
| `blobs/` | `<dataRoot>/blobs/sha256/<xx>/<digest>`，全局内容寻址库 |
| `staging/<syncId>/` | 物化暂存区，位于 `<targetParent>/.dsh-remote/staging/`（**必须与目标同卷**） |
| `old/<syncId>/` | `sticky` 策略下被替换下来的旧工作区 |
| `state.json` | `<target>/.dsh-remote/state.json`，本工具对目标目录的 ownership 标记 + 已提交 manifest 摘要 |
| `journal.json` | `<targetParent>/.dsh-remote/journal.json`，切换事务的恢复日志 |
| `syncId` | 一次同步事务的 id |
| `workspaceId` | 插件内部的工作区标识（`ws_<ulid>`），与 DSH 的 workspace UUID **无关**（后者不可跨机器） |
| manifestDigest | 对 manifest（除自身字段外）规范化后求 sha256 |

## 附录 B — 待验证清单（实现前必须实测）

1. **卷挂载点**能否保持 `realpath`（§2.1 第 4 点未验证项）。用 §2.1 的同一段脚本改成挂载点复测。
2. `fs.rename` 在同卷 NTFS 上「目标不存在」时对目录的原子性（预期成立，但要验证跨 `\\?\` 前缀混用时的行为）。
3. Windows 上对**只读**文件/目录 `fs.rm(path, { recursive: true, force: true })` 是否失败（预期失败，需先 `chmod`）。
4. `git checkout-index --prefix` 在 Windows 上对 CRLF/`core.autocrlf` 的行为（`autocrlf=true` 会让从机上的行尾与宿主不同 ⇒ **必须在从机上强制 `core.autocrlf=false`**，否则 manifest 的 digest 与实际落盘内容不符，校验会失败或更糟——静默不一致）。**这一条应该升级为设计约束而不是待验证项**：bundle 路径下显式 `-c core.autocrlf=false -c core.eol=lf`。
5. 大文件（> 4 GiB）在 `fs.rename`/`link`/`createHash` 流式路径上的行为（`Number` 精度、`highWaterMark`）。

## 附录 C — 证据索引（本文引用到的 DSH 源码位置）

| 主题 | 位置 |
|---|---|
| workspace 路径唯一性 canon | `@deepseek-ai/dsh-workspace/lib/types/paths.js:30-48` |
| workspace 完全限定判定 | `@deepseek-ai/dsh-workspace/lib/types/paths.js:14-19` |
| workspace id = randomUUID | `@deepseek-ai/dsh-workspace/lib/types/index.js:433` |
| 按路径查找 = 全等扫描 | `@deepseek-ai/dsh-workspace/lib/types/index.js:417-423` |
| session cwd 解析失败被踢出 workspace | `@deepseek-ai/dsh-workspace/lib/index.js:869-890, 900-909` |
| ACP cwd 校验 / sameDirectory | `@deepseek-ai/dsh-acp/lib/index.js:1258, 1409-1423` |
| ACP resume/list 的 cwd 一致性 | `@deepseek-ai/dsh-acp/lib/index.js:1217, 1234-1237, 1266-1274` |
| ACP session/new 用 cwd 建会话 | `@deepseek-ai/dsh-acp/lib/index.js:1168-1182`；`AcpSession.create` `:693-705` |
| git 私有对象库 + alternates | `@deepseek-ai/dsh-workspace-changes/lib/types/git.js:83-96` |
| git 完整工作树快照（含未跟踪） | `@deepseek-ai/dsh-workspace-changes/lib/types/git.js:97-129` |
| gitlink / check-ignore | `@deepseek-ai/dsh-workspace-changes/lib/types/git.js:186-223` |
| git 不可用时降级 | `@deepseek-ai/dsh-workspace-changes/lib/index.js:996-1014, 1049-1061` |
| 变更记录无 size/mtime/digest | `@deepseek-ai/dsh-workspace-changes/lib/types/recorder.js:323-332` |
| 变更记录会话生命周期（mkdtemp/rm） | `@deepseek-ai/dsh-workspace-changes/lib/types/recorder.js:171-177, 198-201` |
| attachment CAS 落盘三步 | `@deepseek-ai/dsh-attachment-local/lib/index.js:424-443, 452-467, 498-559` |
| attachment 路径布局 + root | `@deepseek-ai/dsh-attachment-local/lib/index.js:275, 296-299, 667-674, 996` |
| attachment 流式读写 + 分块校验 | `@deepseek-ai/dsh-attachment-local/lib/index.js:699-711, 719-745` |
| Windows 保留名/文件名清洗 | `@deepseek-ai/dsh-attachment-local/lib/index.js:619-652` |
| win32 目录 fsync = no-op | `@deepseek-ai/dsh-attachment-local/lib/index.js:357-368` |
| `saveFileStream` 契约（无大小限制、必须背压） | `@deepseek-ai/dsh-attachment/lib/types/index.js:101-135` |
| attachment 无 GC（注释级证据） | `@deepseek-ai/dsh-attachment/lib/types/index.js:17-18` |
| atomic write + Windows 重试 | `@deepseek-ai/dsh-atomic-write/lib/index.js:17-44, 45-77` |
| `withFileLock` + PID 接管 | `@deepseek-ai/dsh-atomic-write/lib/index.js:121-146, 188-215` |
| fs-local 版本 token / 无流式写 | `@deepseek-ai/dsh-fs-local/lib/index.js:146, 869-870`；README `:134-137` |
| fs-local 原子替换 + DACL + ReplaceFileW | `@deepseek-ai/dsh-fs-local/lib/index.js:514-575` |
| fs-local `cwd` 不是 containment | `@deepseek-ai/dsh-fs-local/README.md:32`；`lib/index.js:719-723` |
| containment 判定（含 dev/ino 回退） | `@deepseek-ai/dsh-fs-sandbox/lib/index.js:18-65, 153-166` |
| 沙箱不是内核边界 | `@deepseek-ai/dsh-fs-sandbox/lib/index.js:79-85` |
| writableRoots / per-session workspaceRoot | `@deepseek-ai/dsh-sandbox/lib/index.js:150-173`；`dsh-sandbox-policy/lib/index.js:141-147` |
| 从机默认沙箱模式与回退 workspaceRoot | `@deepseek-ai/dsh-base/cordis.patch.yml:226-233` |
| `$DSH_HOME` 解析与 cache 路径 | `@deepseek-ai/dsh-home-paths/lib/index.js:29-44, 73-94` |
| `storages` / `sessions` root | `@deepseek-ai/dsh-base/cordis.patch.yml:133, 168-171` |
| storage unit 命名约束 | `@deepseek-ai/dsh-storage/lib/index.js:79-80` |
| storage-json 原子写 | `@deepseek-ai/dsh-storage-json/lib/index.js:25-41` |
| 流式 HTTP 上传路由先例 | `@deepseek-ai/dsh-client-file-upload/lib/index.js:171-176`；`lib/types/http-route.js:10-72`；`lib/types/protocol.js:2` |
| JSON-RPC buffered 上限 300 MiB | `@deepseek-ai/dsh-client-connection/lib/index.js:25` |
| ACP WS 只收发 text frame | `.research/sdk/sdk/dist/ws-stream.js:6-9, 102-111, 119-140`；`ws-utils.js:24-39, 31-39` |
| ACP v1 重连不重放 | `.research/sdk/sdk/dist/ws-stream.js:20-24` |
| webserver 路由注册 | `@deepseek-ai/dsh-host-webserver/lib/index.js:171-207, 261-286` |
| acp profile 无 webserver | `@deepseek-ai/dsh-acp-app/cordis.patch.yml`（只列 `dsh-acp`）；`dsh-base/cordis.patch.yml`（无 webserver）；`dsh-web-app/cordis.patch.yml` 有 |
| spill 只有 saveText / 无配额 | `@deepseek-ai/dsh-spill/lib/index.js:52-56`；`dsh-spill-local/lib/index.js:69-95, 499-509` |
| util-crypto 只有 2 个导出 | `@deepseek-ai/dsh-util-crypto/lib/index.js:17-33, 35` |
| session-format 导出清单 | `@deepseek-ai/dsh-session-format/lib/index.js:491` |
| 实测：subst/junction 的 realpath | 本文 §2.1（PowerShell + Node 脚本，本机 Windows 实测，输出原样引用） |

---

*本报告为只读调研 + 设计产物。除 `F:\WorkSpace\dsh-plugin-remote-use\.research\` 下的文件外未修改任何内容；§2.1 的实测脚本创建的两个临时目录（`winsym-test`、`winsym-test2`）与临时 `subst` 映射均已在同一次命令内清理并验证（`Test-Path` = `False`，`subst /d` 返回 0）。*


