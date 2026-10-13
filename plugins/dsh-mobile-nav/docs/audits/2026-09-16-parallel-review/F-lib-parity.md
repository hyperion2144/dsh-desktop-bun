# F — `lib/` ↔ `src/` 一致性与脆弱点审查

- **审查者**：F（只读审查员）
- **报告基线**：`HEAD = c95d0cc`，工作区干净（`git status --porcelain` 为空），2026-09-16 22:56 +0800
- **对照过的历史基线**：`1d5ab8d`（CONTEXT.md 冻结指纹成立的那一点）、`26ca8e9`、`acc26ec`（审查中途父会话产生的两个提交）
- **未做**：没有编辑仓库任何文件；没有 git 写操作；**没有在仓库里跑 `pnpm build`**。唯一的"构建"发生在 `~/tmp/review-2026-09-16/clone*` 两个一次性 clone 里（`git clone` 只读源仓库）。仓库 `lib/` 的 sha1 快照在操作前后一致，证明无写入（见 §方法 M0）。

**结论一句话**：**当前 HEAD 的 `lib/` 与 `src/` 完全一致（我用真实构建证明了，不是"看起来一致"）**；但"`lib/` 是提交进库的生成物"这套流程有 **4 个可复现的结构性洞**，其中 2 个在本次审查期间**真实发生过**（`acc26ec` 那一版过不了自己的 CI）。

---

## 发现数：12（真漂移 0 现存 / 2 历史性 / 6 结构性 / 4 信息级）

---

### A. 一致性对账（现存状态 = 一致）

#### F-1 ｜ 模块清单：27/27 完全一致 ✅
**事实**：`lib/client.js` 内联的 `__modules[...]` 定义键集合 = 从 `src/client/index.tsx` 出发的真实可达闭包，**集合完全相等，双向零差异**（27 个）。

**键名规则**（读 `scripts/build-client.mjs` 得到，非猜测）：
- 键 = tsc 发射目录（`.client-build/`）下 **`*.js` 的相对正斜杠路径**（L17–34 `collectSources`），所以 `index.tsx → index.js`、`styles/base.css.ts → styles/base.css.js`；
- 只有**从 `index.js` 经相对 `require("./x.js")` 可达**的模块被内联（L48–61 `visit()` 拓扑序），不可达的模块**被剪掉**；
- `REQUIRE_RE = /require\("(\.[^"]+\.js)"\)/g`（L38）只认双引号相对 require。

**证据命令**（三条独立路径，互相印证）：
```sh
# ① 从 src 独立重算闭包（不读任何构建产物）—— 我自己的实现，不是复用仓库脚本
node ~/tmp/review-2026-09-16/closure.mjs
#   → src files total: 28 / reachable: 27 / expected keys: 27
#   → NOT reachable: core/css-rules.ts   （原因见 F-12）
# ② 真实编译器：把 tsc 输出重定向到 ~/tmp（declarationDir 也重定向，仓库零写入）
node node_modules/typescript/bin/tsc -p tsconfig.client.json \
  --outDir ~/tmp/review-2026-09-16/cb --declarationDir ~/tmp/review-2026-09-16/dt --sourceMap false
#   → 发射 28 个 .js（含 core/css-rules.js）
# ③ 用 build-client.mjs 的原样闭包逻辑回放 ② 的产物
node ~/tmp/review-2026-09-16/replay.mjs      # closure size: 27
diff ~/tmp/review-2026-09-16/real-keys.txt ~/tmp/review-2026-09-16/defs-keys.txt
#   → IDENTICAL: real-tsc closure == bundle definitions
```
另外两个自洽检查：bundle 里 **"被 require 但无定义" 的模块 = 0**；"有定义但从未被 require" = 仅 `index.js`（入口，正确）。

**影响**：无。"源码有而 bundle 没有" = `core/css-rules.ts`（**设计如此**，见 F-12）；"bundle 有而源码已删" = 0。

#### F-2 ｜ CSS 字符串：四个模块逐字节一致 ✅（三条腿都验了）
**方法要点**：**不**做文本 grep/cmp（会因转义假报漂移），而是把两侧都当**真实 JavaScript 求值**后比较结果字符串 —— 转义语义交给引擎：
- src 侧：从 `.css.ts` 里取出 `export const X_CSS = \`...\`` 的模板字面量，`new Function('return ' + literal)` 求值；
- bundle 侧：从 `lib/client.js` 抠出 `__modules["styles/X.css.js"]` 的函数体，用假 `require` 在沙箱里执行，读 `module.exports.X_CSS`；
- d.ts 侧：d.ts 里是**双引号字符串**且**非 ASCII 被转义成 `\uXXXX`**，所以先 `JSON.parse` 反解再比。

**证据命令**：
```sh
node ~/tmp/review-2026-09-16/css-parity.mjs   'HEAD:HEAD' 'WORKTREE:WORKTREE' '1d5ab8d:1d5ab8d'
node ~/tmp/review-2026-09-16/dts-css-parity.mjs HEAD
```
| 对照 | base | compat | layout | misc |
|---|---|---|---|---|
| `HEAD:HEAD`（c95d0cc / src vs bundle） | 逐字节一致 | 逐字节一致 | 逐字节一致 | 逐字节一致 |
| `WORKTREE:WORKTREE` | 逐字节一致 | 逐字节一致 | 逐字节一致 | 逐字节一致 |
| `1d5ab8d:1d5ab8d` | 逐字节一致 | 逐字节一致 | 逐字节一致 | 逐字节一致 |
| `HEAD`（src vs **d.ts**，解码后） | 一致 | 一致 | 一致 | 一致 |
| `acc26ec`（历史，见 F-5） | 一致 | **不一致** | **不一致** | 一致 |

**「合法转义 vs 真漂移」的答复**：存在**合法编码差异，不是漂移** —— 同一段 CSS 在 `lib/client.js` 里是**字面 UTF-8**（`字` = 字节 `e5 ad 97`），在 `lib/types/client/styles/*.css.d.ts` 里是 **`\u5B57` 转义**：
```sh
grep -cF '字'     lib/client.js                            # 3
grep -cF '字'     lib/types/client/styles/layout.css.d.ts  # 0
grep -cF '\u5B57' lib/types/client/styles/layout.css.d.ts  # 1
```
两者**解码后完全相同**（上表 d.ts 行）。所以：**任何直接对 d.ts 做字节/grep 比对的检查都会在这里假报漂移**，本报告用解码后比较就是为了避开它。

#### F-3 ｜ 类型产物：文件集与导出符号都对得上 ✅
**事实**：`lib/types` 的 31 个 `.d.ts` + 31 个 `.d.ts.map` 与"从 src 推导出的应有产物集"**精确相等，双向零差异**。
```sh
comm -23 expected-dts.txt actual-dts.txt   # 空：源码有而产物缺
comm -13 expected-dts.txt actual-dts.txt   # 空：产物有而源码已删（孤儿）
diff expected-maps.txt actual-maps.txt     # IDENTICAL
```
**导出符号对账**：31/31 文件，**0 处名字不匹配**（`node ~/tmp/review-2026-09-16/exports-parity.mjs`）。
- 检查器**过了负对照**（这一步我一开始做错了两次，见 §自检）：往 `lib/types/client/debug.d.ts` 里植入 `export declare const GHOST_EXPORT` 后，检查器 exit 1 并点名 `GHOST_EXPORT`；真实树上 exit 0。**所以"0"是有信息量的 0**。

#### F-4 ｜ `package.json` 与 `lib/` 实际产物：全部对得上，无坏包风险 ✅
**事实**：`main` / `types` / `exports` 的 8 个目标、`files[]` 的 6 个条目、`dsh.bundle.patch` **全部存在**（`node -e` 逐条 `fs.existsSync` 断言，见命令）。**权威文件清单**（在一次性 clone 里跑，避开 `prepack`）：
```sh
cd ~/tmp/review-2026-09-16/clone && npm pack --dry-run --ignore-scripts --json
# entryCount 108, unpackedSize 2752646, 顶层: lib 69 / src 31 / assets 4 / +4 单文件
# lib/client.js、lib/index.js、lib/types/index.d.ts、lib/types/client/index.d.ts、cordis.patch.yml 全部 IN
```
另外验证了消费者真正会加载的那条链路：
```sh
node -e "import('./lib/index.js')"     # → OK exports: apply,name    （AGENTS.md 记载的检查，通过）
# lib/index.js 的 2 条相对导入 ./compress.js、./delete-session.js 全部可解析
```
**影响**：消费者不会装到坏包。唯一可议之处（信息级）：`files` 同时发 `src`（31 文件）与 `lib`（69 文件），tarball 里既有源码又有其生成副本 —— 读者可能读 `src` 而实际跑 `lib`，这正是漂移最容易骗人的地方，但也正是 `src` 不入 `files` 就丢源码的选择。非缺陷。

---

### B. 真漂移（历史性，已修复但流程洞仍在）

#### F-5 ｜【高风险·本次审查期间真实发生】两个提交只入库了 `lib/`，源改动留在工作区 → 该版本过不了自己的 CI
**事实**：
```sh
git show --name-only --format='' 26ca8e9
#   lib/client.js
#   lib/types/client/styles/compat.css.d.ts
#   lib/types/client/styles/compat.css.d.ts.map      ← 没有 src/**
git show --name-only --format='' acc26ec
#   lib/client.js
#   lib/types/client/styles/layout.css.d.ts          ← 没有 src/**
```
两个提交的 `src/client/styles/compat.css.ts` / `layout.css.ts` 改动当时**仍在工作区未提交**（当时 `git status` = ` M src/client/styles/compat.css.ts` + ` M src/client/styles/layout.css.ts`）。

**后果实测**（这是一次真实的 CI 等价实验，不是推理）：
```sh
git clone --quiet --no-hardlinks --single-branch . ~/tmp/review-2026-09-16/clone
cd ~/tmp/review-2026-09-16/clone && git checkout acc26ec
ln -s ~/dsh-mobile-nav/node_modules node_modules
node node_modules/typescript/bin/tsc -p tsconfig.json          # pnpm build 的第 1 步
node node_modules/typescript/bin/tsc -p tsconfig.client.json   # 第 2 步
node scripts/build-client.mjs                                  # 第 3 步
git diff --exit-code lib
#   → [GATE EXIT=1]      ← CI 会红
git diff --stat lib
#   lib/client.js                               | 38 +++++++++-------------
#   lib/types/client/styles/compat.css.d.ts     |  2 +-
#   lib/types/client/styles/compat.css.d.ts.map |  2 +-
#   lib/types/client/styles/layout.css.d.ts     |  2 +-
```
即：**`acc26ec` 这个提交，把它的源码重新构建一遍，产不出它自己提交的 `lib/`。**

**影响**：
1. 该 ref 上一个不自洽的 `lib/` 被当成"消费者直接安装的产物"。任何从 git ref/归档安装、或按 ref re-vendor 的下游（AGENTS.md 记载 DSHA 就是 vendored 副本）会拿到与同目录源码不符的行为。
2. 一开 PR 就会红（`pull_request:` 无分支过滤）。
3. 这是**流程洞的实证**：`lib/` 与 `src/` 分两次 `git add` 时，可以产生"生成物已入库、源码没入库"的提交。

**当前状态**：已不复现。`c95d0cc`（含随后的提交）下同样的实验是 **`[GATE EXIT=0]`**，且 CSS 三条腿全部逐字节一致 → **当前 HEAD 自洽**。所以 F-5 是"已发生并已修复"，但它证明了下面的 F-6/F-7/F-8 不是纸上风险。

---

### C. 结构性脆弱点（可复现机制）

#### F-6 ｜ 新鲜度门看不见 `lib/` 下的「未跟踪文件」——多出来的产物永远不报警
**事实（实验证明，非推理）**：在干净 clone（`lib` 与 HEAD 完全一致、门禁 exit 0）里植入两个"生成物孤儿"后：
```sh
echo "export declare const ghost: number;" > lib/types/client/effects/ghost-deleted-module.d.ts
echo "console.log(1)" > lib/ghost-deleted.js
git diff --exit-code lib        # → [GATE EXIT=0]   ← 门看不见它们！
git status --porcelain lib
#   ?? lib/ghost-deleted.js
#   ?? lib/types/client/effects/ghost-deleted-module.d.ts
git add lib && git diff --exit-code lib   # → [GATE EXIT=0]  ← 连 add 之后也不报
```
**机制**：`git diff` 只比较**两边都存在**的文件内容；未跟踪文件完全不在它的视野里。门禁只验证"**已入库**的 `lib` 文件内容没变"，**不验证"入库集合是否等于构建产出集合"**。

**影响**（两个方向都危险）：
- **多**：源文件删了但 `tsc` **从不清理 outDir** —— 同一实验证明遗产文件在完整重建后**原样存活**（`ls lib/ghost-deleted.js lib/types/client/effects/ghost-deleted-module.d.ts` 重建后仍在）。于是"删源码 + 构建 + `git add lib`"会把孤儿 `.d.ts`（甚至孤儿 `.js`）**永久提交**，而门禁此后**永远绿**。当前树没有孤儿（F-3 已证），属潜在洞。
- **少**：如果构建**新**产出一个文件而忘了 `git add`（例如新增 host 半区模块 → 新增 `lib/xxx.js` + `lib/types/xxx.d.ts`），它在 CI 里就是未跟踪文件 → **门禁照样绿**，而提交进去的 `lib/` 是**残缺**的。对 host 半区这是致命的：`lib/index.js` 会 `import './xxx.js'` 而文件不在库里（正是 AGENTS.md 记载 pitfall #31 的失败形态：`ERR_MODULE_NOT_FOUND`，插件树加载失败、`dsh web` 直接崩）。

**建议的最小修法**（不改现有语义，一行级别）：门禁换成能看见未跟踪文件的判据，例如
`git add -A lib && git diff --cached --exit-code lib` —— 或者补一条 `git status --porcelain --ignored lib` 必须为空。**注意别只把 `--exit-code lib` 换成 `git status --porcelain lib`**：`??` 也要算失败才行。

#### F-7 ｜ 同一条门禁命令在本地是「空转」，绿不代表任何东西
**事实**：同一时刻、同一提交，两条路径结论相反：
```sh
# 仓库工作区（父会话刚 rebuild 并 git add 过 lib）
git diff --exit-code lib      # → exit 0  （本地"绿"）
# 干净检出同一提交 + 真构建
git diff --exit-code lib      # → exit 1  （CI"红"，见 F-5）
```
**机制**：`git diff <path>`（不带 `--cached`）比的是**工作区 vs 索引**。流程里"先 `pnpm build` 再 `git add lib`"会让索引 == 工作区，于是这条命令**恒绿**，而它**从不 rebuild**，所以它根本没有检验"源码能否产出这份产物"。

**影响**：开发者按 AGENTS.md 在本地跑"lib 新鲜度"自查会得到假绿；只有 CI（干净检出 + 真构建）才有判别力。F-5 就是这么产生的。

#### F-8 ｜ 推分支不触发任何 CI —— 不自洽的提交可以零信号地推到远端
**事实**（`.github/workflows/ci.yml` L3–7）：
```yaml
on:
  push:
    branches: [main]
  pull_request:
```
**影响**：本次分支是 `fix/50-52-49-verified`，`git push origin fix/50-52-49-verified` **不触发 CI**；F-5 那种不自洽提交可以一路推上去，只有开 PR 时才暴露。既然 `lib/` 的完整性全靠这条 CI 步骤守，分支推送没有信号是这套设计的实际缺口。

#### F-9 ｜ 生成物是「单行 1 万~6.5 万字符」的巨行 —— review 与合并都被它拖垮
**事实**：
```sh
awk '{if(length($0)>m)m=length($0)}END{print m}' lib/types/client/styles/*.css.d.ts
#   base 9895 / compat 44421 / layout 65265 / misc 16051   （每个文件都只有 1 行）
```
**影响**：任何 CSS 改动（哪怕纯缩进）都会整行重写这些文件。F-5 里 `26ca8e9` 的 compat 缩进修复，`git diff --stat` 显示 `lib/types/.../compat.css.d.ts | 2 +-` —— 这一个 "+-" 就是**整条 44k 字符行**的替换，review 时无法阅读，只能当黑盒。并发改同一 CSS 模块的两个分支必然在这里行级冲突（AGENTS.md 已把它记为已知坑，本报告给出量化：**冲突面是 9.9k–65k 字符的单行**）。

#### F-10 ｜ `lib/client.js` 没有 sourcemap，而 host 半区的 `.js.map` 全都发出去
**事实**：
```sh
ls lib/client.js.map        # No such file or directory
ls lib/*.js.map             # compress.js.map / delete-session.js.map / index.js.map 都在
tail -c 60 lib/client.js    # 结尾是 `return module.exports; } });`，无 sourceMappingURL
```
**机制**：`scripts/build-client.mjs` L95 显式 `rm` 掉 `lib/client.js.map`，且从不给 bundle 写 sourceMappingURL。
**影响**：占 `lib/` 体积绝对多数的那个文件（353 KB / 69 文件中最大）**出货后不可回溯到源码**；host 半区却有 map。排查线上报错时只能靠 7003 行里的注释人工定位。非阻塞，但这是有意丢弃的可调试性。

#### F-11 ｜ CSS 占 bundle 37%，即源码里已有的 CSS 在 `lib/` 里被完整复制了一遍；顺带：AGENTS.md 的行数说明已过期
**事实**：
```sh
node -e '...'   # 见 §方法 M5
# css modules total: 130812 B = 37.0% of 353082 B bundle; non-CSS bundle: 222270 B
```
**影响**：bundle 有超过三分之一是四个 CSS 模块的**逐字副本**（src 侧已存在）。任何 CSS 改动都同时改 src 与这 37%，是 F-9 巨行问题的来源。**附带发现（文档漂移）**：`AGENTS.md` L33 写 ``lib/ … （client.js≈2 万行内联 bundle）``，实测 **7003 行**（353082 B，最长行 2853）。建议改成字节数或模块数（27），行数这个指标会随排版漂。

---

### D. 信息级

#### F-12 ｜ `lib/types/client/core/css-rules.d.ts` 会被发布，但该模块永不进 bundle —— 这是设计，不是漂移
**事实**：`css-rules.ts`（180 行）只被 `tests/css-rules.test.ts` 导入；`src/client/**` 里**无人导入它**，所以闭包把它剪掉（F-1）。但 tsconfig 的 `include: src/client/**/*.ts` 仍为它生成 d.ts，并被打进 tarball（`lib/types/client/core/css-rules.d.ts` 1.5 kB）。
**核实**：`grep -rn "css-rules" src/ scripts/ tests/` → 只命中 `tests/` 与它自己的头注释（"written for the SOURCE-LEVEL guards in tests/"）。
**影响**：无（它是有意的测试辅助）。记录在此，避免后来者把它当"bundle 少了一个模块"。

#### F-13 ｜ `src` 也进 `files`，tarball 2.75 MB 中 1.75 MB 是 README 配图
**事实**：`npm pack` 明细里 `assets/banner.png` 1.3 MB + 其余 3 张共约 1.75 MB，占 `unpackedSize` 2752646 的 ~64%。
**影响**：安装体积换 README 可读性，纯信息级。

---

## 方法（可复现命令清单）

- **M0 只读自证**：操作前后对 `find lib -type f -exec sha1sum` 取快照并 `diff`。唯一一次快照变化发生在父会话并发 `pnpm build` 的窗口内（时间戳可查：`stat -c '%y %n' lib/client.js` → 22:37:19），我的 tsc 探针本身写的是 `~/tmp`。`git status` 全程只有父会话的 CSS 改动，无我的痕迹。
- **M1 模块闭包**：`~/tmp/review-2026-09-16/closure.mjs`（从 src 独立重算）、`replay.mjs`（回放 build-client 的闭包逻辑到真实 tsc 产物）。
- **M2 真编译器**：`tsc -p tsconfig.client.json --outDir <tmp> --declarationDir <tmp>`（**两个输出目录都重定向**，否则会覆写仓库 `lib/types`）。踩坑：tsc 不接受 `--declaration false` 与 `declarationDir` 并用（TS5069），所以保留 declaration 只改目录。
- **M3 CSS 三条腿**：`css-parity.mjs`（src↔bundle，运行期字符串）、`dts-css-parity.mjs`（src↔d.ts，解码后字符串）。
- **M4 CI 等价实验**：一次性 clone + 手工执行 `pnpm build` 展开的三条命令 + `git diff --exit-code lib`。**没有在仓库里跑 `pnpm build`**。
- **M5 bundle 组成**：`node -e` 用页面里给出的片段统计各 `__modules["styles/*.css.js"]` 函数体字节数。
- **M6 打包面**：一次性 clone 里 `npm pack --dry-run --ignore-scripts`（`--ignore-scripts` 用来跳过 `prepack`，避免任何构建）。

---

## 自检：我可能错在哪

1. **最该怀疑的一点：我的负对照一开始是错的，而且错了两次。**
   - 第一次：往 `debug.d.ts` 追加植入的 ghost，落到 `//# sourceMappingURL=...` **同一行**（文件无尾换行），成了注释的一部分 → 检查器"正确地"没看见，我差点据此以为检查器坏了。
   - 第二次：`dts-css-parity.mjs` 的 `slice(s, e)` **漏掉收尾引号**导致语法错误（不是结论错误，是工具崩了）。
   - 两次都修好后才得到结论。**如果我只跑一遍不验证，我会报一个假的"检查器正常"或假的"漂移"。**
2. **`acc26ec` 的 CI 红是我在 clone 里复现的，不是 CI 服务真跑出来的。** 我复现的是 `ci.yml` 那两步（build → `git diff --exit-code lib`），环境差异：clone 通过**符号链接复用仓库 node_modules**（tsc 6.0.3、Node v24.18.0 与仓库一致）。若 CI 上的 tsc 版本不同，理论上可能本就不该重现 —— 但 `.git diff` 抓到的正是 CSS 内容差异，与编译器版本无关。
3. **F-5 是并发窗口内的时序产物。** 父会话在我审查期间连续提交并重建（`git reflog` 可见 `1d5ab8d → 26ca8e9 → acc26ec → … → c95d0cc`）。我只断言"这两个 ref 自洽性不成立"（有实验），**不断言父会话做错了**——它随后把源改动补上了，`c95d0cc` 是自洽的。
4. **未验证项**：**served bundle 与 `lib/client.js` 的字节前缀判据我没做成** —— `~/tmp/mint.out` 的 cookie 已过期（22:19），组合 URL 返回空 body（sha1 `da39a3ee…`，正是 AGENTS.md 警告的"别误判"形态）。所以"服务器实际提供的就是这份 `lib/`"这条链路**本次未取证**，我不对下结论。
5. **`closure.mjs` 的 import 抽取是正则**（`from '…'` / `import('…')` / `require('…')`），不是真正的解析器。它对本仓库成立，并被"与真实 tsc 产物回放结果完全一致"这条独立证据交叉验证过；但若将来出现动态拼接的 require，两者会一起漏。
6. **`exports-parity.mjs` 是词法级比较**：同名但签名漂移它抓不到（例如 `installX(ctx: A)` 变 `installX(ctx: B)`）。本次未做签名级对账。
7. **我没有验证 `lib/types/**` 里 d.ts 的"内容"正确性**（只验证了文件集、导出名、以及 CSS 字符串）。d.ts 与 src 的完整类型等价性需要 `tsc` 级别的对比，超出本次范围。
8. **F-13 不属于本任务范围**（打包体积），只是一条顺手观察，勿当结论用。
