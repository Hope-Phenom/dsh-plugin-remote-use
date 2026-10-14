# 测试

三套 harness，**发布前都必须通过**。它们覆盖的层次不同，缺一套就会漏掉一类缺陷：

| 层次 | 命令 | 它抓什么 |
|---|---|---|
| **单元** | `cd packages\dsh-plugin-remote-use ; node --test` | 模块级契约（provider 接缝、任务表、设置路由、配对、自检项、跨站守卫…）。不需要任何外部资源 |
| **冒烟** | `cd prototype\host ; node plugin-smoke.mjs` | 用假 `ctx` 挂载真 `apply()`，检查装配。用临时 `DSH_HOME`，不碰你的配置 |
| **真机** | `node prototype\host\plugin-live.mjs --url <ws-url> --token <token> --cwd <worker-path>` | 对着一个**真的** worker 跑完整协议 |

## 真机 harness 的两个要点

**一、不传 `--entry` 时，它测的是"安装件"。** 入口从 profile 清单里的包名推导（与 loader 同一条规则），
并且**把解析结果打印出来**：

```
entry : C:\Users\<you>\.dsh\profiles\desktop\node_modules\@hope_phenom\dsh-plugin-remote-use\lib\index.js
        resolved from the profile manifest: a real directory in the profile
```

解析到链接时它会打 `WARNING: this run is NOT testing the installed artifact.`，用 `--entry` 显式覆盖时也会说明。

> 这行不是装饰。它以前硬编码了一个**不带作用域**的路径，而那个路径在操作者机器上是指向**源码检出**的
> junction —— 于是它一边打印着读起来像安装件的路径，一边加载开发者的工作树。两边当时逐字节相同，
> 所以谁都没看出来（PITFALLS **D12**）。

**二、没有第二台机器也能跑真机测试** —— 先用回环布防一个工作节点：

```powershell
node tools\arm-loopback-worker.mjs                    # 宣告一行 JSON，含 url 与 token
# 然后 plugin-live 指向它
```

> `arm-loopback-worker.mjs` 由 agent 的 shell 启动时会**继承 DSH 沙箱**，从机自检的 S8（合成输入）会
> 假失败。要避开就用 `tools\run-unconfined.ps1` 把它放到计划任务里跑。

## 真机 harness 实际会验证什么

链路连通 · 17 项自检 · 委派任务完成 · **真实截图且校验 PNG 签名** · 每会话开关（新会话工具被拒、
`on` 后放行、**另一会话仍关**、`off` 后恢复） · **人工审批闭环**（提权进队列 → 决定送达 → 任务完成 →
**审计留痕**） · 本机角色状态（**永不含 token**） · **后台委派的答案能读回且留存** ·
**注册的工具集合与插件自报的名字集合一致**。

判据是最后一行：

```
===== ALL CHECKS PASSED =====     （exit 0）
```

## 发布前再跑两个机械检查

```powershell
pwsh -File .research\privacy-scan.ps1        # 隐私：当前树 + 全部历史
node .research\check-doc-links.mjs           # 文档：相对链接 + 指向本仓库的绝对 URL
```

两个都退出 0 才算过。

- **隐私扫描**的待查清单从 `.research/privacy-replacements.txt` 读 —— 那个文件被 gitignore，
  因为里面是**真实值**；扫描器本身不含任何真实值，而且命中的值在输出里一律显示为 `«REDACTED»`，
  所以它的输出可以直接贴进报告。它同时查**当前树**（推上去就会公开的东西）和**全部历史**
  （提交过又删掉的值，在旧提交里仍然是公开的）。
- **链接检查**只扫 Markdown 的相对链接与指向本仓库的绝对 GitHub URL，并且跳过围栏代码块与行内代码 ——
  调研文档里有整段引用上游 README 的原文，那些链接不是我们的。

## 为什么这些守卫要写成这样

- **判据从被测对象自己那里读**，不抄一份常量。工具数量、包名、行 id 都从 manifest / 插件导出取值 ——
  写死的那一份会在被测对象变化时**接受 bug、拒绝修复**（PITFALLS D11）。
- **新守卫都要做变异检验**：把正确的值改回错的，看它是否立刻失败。不失败就说明"这块没人看着"。
  本项目的每一条新守卫都记录了变异结果。
- **"报 PASS" 的那一刻最该怀疑**。有过两次检查在说谎：一次是在 `status` 的回显里找到了它要找的标记
  （而那个标记就在 prompt 里），一次是加载了源码检出却报告安装件。两次都靠**去看真东西**
  （真 HTTP 端口、打印解析结果）才暴露。
