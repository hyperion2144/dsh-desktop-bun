# 交接：会话切换卡顿（0.1.7-rc.1 手机端，2026-09-23）

> 一句话：**卡顿属上游宿主前端**——每次切换整段挂载 + 没有有效预算的 Shiki 高亮全部代码块（预热调用是 `tokenizeTimeLimit:0`，渲染路径落到默认 500ms/**行**，见 §2.4）；本插件不含任何高亮逻辑、也不渲染会话正文，但它在「首屏之后那一段」的占比在当前宿主上**未量化**（§4 / §6-2）。DSHA 只是提供 WebView 与 ARM 单主线程的平台。
> **状态（2026-09-23 晚更新）：定位完成，未动任何代码或宿主文件。** 处置已定：走 B（提交上游官方）——**已提交 <https://github.com/deepseek-ai/deepseek-harness/discussions/7647>**；A 的 dist 单点替换经 §2.4 精读确认在当前宿主上失效。量化 A/B 因容器浏览器通道与设备 shell 双双不可用而搁置（§6-2）。

## 0. 症状与复现

- 在抽屉里切换会话（**双击**行才切换；单点只选中并显示该行的操作按钮——用户口径，2026-09-23 实测确认）。
- 首屏约 1s 就出来（§2.3 实测），**卡的是首屏之后**：接下来十几秒到一分钟里滚动/输入发涩，长任务堆积。
- **随上下文长度放大**：短会话（52 KB、0 个代码块）几乎无感；两个长会话分别是 **5.3 MB / 153 个代码块** 与 **5.9 MB / 176 个代码块**。

## 1. 归因表（先给结论）

| 层 | 是不是它 | 依据 |
| --- | --- | --- |
| **上游宿主前端** | **主因** | Shiki 高亮器 `tokenizeTimeLimit:0`（单块不限时）逐块 tokenize；会话包无窗口化 ⇒ 整段挂载。见 §2.1 / §2.2 |
| 本插件 dsh-web-mobile | 否（已排除） | 既有回调级计时实测：flush ≤8ms、MutationObserver ≤9ms、最慢选择器 4.9ms（§2.1）；插件代码里没有任何 Shiki/tokenize 调用 |
| DSHA（App） | 平台，非成因 | 它只是跑 WebView 的宿主与 CPU 来源；不产生这些 longtask。App 侧插件（状态悬浮条等）与切换无关 |

## 2. 关键证据

### 2.1 既有的回调级计时（2026-09-14/18，最硬的量化，仍然有效）

`docs/upstream/host-jank-feedback.md` §问题 2 记着当时的做法与结果：包装 rAF / MutationObserver / setTimeout / querySelectorAll 逐回调计时，再用"屏蔽前端资产差分"定位到宿主 index bundle 的语法高亮器：

- Shiki（`css-variables` 主题、`tokenizeTimeLimit:0`）；触发链是 `setTimeout(()=>{hr()})` 调度 + 语言包懒加载完成后的 `then(l=>{hr()})` **重跑**，每遍 tokenize 全部待高亮代码块 **110–400ms**（1x CPU），多遍叠加成 **400–1900ms longtask**；
- **第三方移动端插件的响应路径已逐一排除**：flush ≤8ms、MutationObserver ≤9ms、最慢选择器 4.9ms。

### 2.2 今天在 0.1.7-rc.1 上的复核

| 项 | 命令 / 位置 | 结果 |
| --- | --- | --- |
| Shiki 预算 | `grep -o "tokenizeTimeLimit:[0-9]*" <dsh-web-frontend/dist/assets/index-*.js>` | **`tokenizeTimeLimit:0`**，但**精读后确认这只是预热调用**（`Qk()` 的 3 个样例片段）；渲染路径不带该参数、落到 Shiki 默认的 **500ms/行**。详见 §2.4。当年那条止血手改被宿主升级抹回，仓库 2026-09-18 定案「默认不重放」 |
| 宿主会话包窗口化 | 在 `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 里数 `virtual` / `windowing` / `IntersectionObserver` / `content-visibility` | **全部 0 命中 ⇒ 无窗口化/懒渲染，整段挂载** |
| 会话体量（多帧 zstd 切分解码，见 §3.1） | `/root/.dsh/sessions/--root--/*/session.v4.jsonl.zstd` | 你好问候 22 记录 / 52 KB / 0 块；手机UI插件新版 1634 / 5.9 MB / **176 块**；Release（本场）1526 / 5.3 MB / **153 块** |
| 宿主侧解码成本 | 同上脚本里的解码耗时 | 29–40 ms（**不是瓶颈**，瓶颈在客户端 WebView 主线程） |

### 2.3 真机时间线（双击切换）

用 DSHA 桥的坐标点按双击行，然后每 0.4s 读一次无障碍树：

```
A 双击切到短会话 你好问候 (52K / 0 代码块)
   0.5s 节点=  73 抽屉=开
   0.9s 节点=  49 抽屉=关 标题='你好问候'      ← 首屏
B 双击切回长会话 Release (5.3M / 153 代码块)
   0.5s 节点= 201 抽屉=开
   0.9s 节点= 201 抽屉=关 标题='Release 0.1.7-rc.1 adaptat…'   ← 首屏
```

**短会话与长会话首屏都是 ~0.9s**（含一次 dump 调用约 0.4s 的开销）⇒「切换动作本身」不慢，与 §0 的描述吻合：卡在首屏之后那一段整段挂载 + 高亮。

### 2.4 更正（2026-09-23 晚，bundle 精读）：`:0` 只在预热，渲染路径吃 500ms/行

`tokenizeTimeLimit` 在 `index-3dwByubT.js` 与 `vendor-CCJJTK99.js` 里**各只出现 1 次**：

| 位置 | 代码 | 作用 |
| --- | --- | --- |
| `index-*.js`（唯一一处） | `Qk()`：highlighter 建好后用 3 个样例片段跑 `codeToTokens(…, {tokenizeTimeLimit:0})` | **预热**，只管那 3 个片段 |
| `index-*.js` 渲染调用 | `N6()` → `codeToTokens(code, {lang, theme:"css-variables"})`；流式类的 `tokenize()` → `codeToTokensBase(code, {lang, theme, grammarState?})` | **不带预算** |
| `vendor-*.js`（唯一一处） | Shiki 内部 `Ji()`：`{tokenizeMaxLineLength = 0, tokenizeTimeLimit = 500}` | 默认 **500ms/行**（逐行 `tokenizeLine(line, state, 500)`） |

⇒ ① §2.2 那句「单块不限时」要收回：按块看只是**没有有效预算**（代价 ≈ Σ 每块行数 × 每行 tokenize 时间）；② **§5A 的 sed 在 0.1.7-rc.1 上只能改到预热**，渲染路径照旧——它不再是「可打可不打」的选项，要见效必须给渲染调用传预算（宿主源码改动，不是 dist 单点替换）。上游反馈文里的同一处说法已同步更正。

## 3. 复现命令（接手照抄）

### 3.1 会话体量（jsonl.zstd 是多帧追加，`zstdDecompressSync` 只解第一帧，必须按 magic 切帧）

```sh
cd /root/.dsh/sessions/--root-- && node --input-type=module -e "
import fs from 'node:fs'; import zlib from 'node:zlib';
const magic = Buffer.from([0x28,0xb5,0x2f,0xfd]);
for (const f of fs.readdirSync('.').filter(d=>d.startsWith('session-')).map(d=>d+'/session.v4.jsonl.zstd').filter(f=>fs.existsSync(f))) {
  const buf = fs.readFileSync(f); const offs = []; let i = 0;
  while ((i = buf.indexOf(magic, i)) !== -1) { offs.push(i); i += 4; }
  let raw = '';
  for (let k = 0; k < offs.length; k++) {
    const end = k+1 < offs.length ? offs[k+1] : buf.length;
    try { raw += zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8'); } catch {}
  }
  console.log(f.slice(0,20), '记录', raw.split('\n').filter(Boolean).length, '字符', raw.length,
              '代码块', Math.round((raw.match(/\x60\x60\x60/g)||[]).length/2));
}
"
```

### 3.2 Shiki 预算与窗口化

```sh
D=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
F=$(grep -rl "tokenizeTimeLimit" $D/dsh-web-frontend/dist/assets/ | head -1)   # 文件名 hash 每次升级可能变
grep -o "tokenizeTimeLimit:[0-9]*" $F        # :0 = 未打止血补丁
for k in virtual windowing IntersectionObserver content-visibility; do \
  printf "%-22s %s\n" "$k" "$(grep -c "$k" $D/dsh-client-ui-conversation/lib/client.js)"; done
```

### 3.3 真机时间线（双击）

要点：① 文本点按对 WebView 节点无效，**必须坐标点按**；② 会话行**双击**才切换（两次相隔约 0.22s）；③ 每 0.4–0.5s 读一次 `/app/ui/dump` 记节点数与标题；④ 抽屉关 + 标题匹配 + 节点数够多才算首屏。本次脚本是 `/root/tmp/` 下的一次性文件（已删），逻辑即上面四步。

## 4. 未验的边界（别当已验）

- 真机没有 JS eval、容器里 chromium 已挂（`1.1` 那节记的 GPU SIGSEGV），所以**首屏之后那波 tokenize 尖刺无法在真机上直接量化**——本次只能引用 §2.1 那份回调级计时。
- §2.1 的 longtask 数字来自 0.1.6-alpha.2 时期的 headless CDP 测量；当前宿主是 **0.1.7-rc.1**，数字**未重测**（开关、触发链、无窗口化三条已复核，量级未复核）。
- 无障碍树对长会话只暴露 ~200 个节点（本次长会话恒为 201），**不能当作"整段渲染完成"的信号**；`0.9s` 只是"首屏有内容"。
- 插件侧的 `MutationObserver` 是 O(records) 的（切换时会被几千条 record 打一次），本次没有单独 A/B 量它——不过 §2.1 的实测已把插件响应路径整体排除在毫秒级。

## 5. 可选处置（两条路，都待拍板）

### A. 本地止血：给 Shiki 设预算（宿主 dist 手改）

```sh
F=$(grep -rl "tokenizeTimeLimit" $D/dsh-web-frontend/dist/assets/ | head -1)
cp $F ~/tmp/$(basename $F).bak-pre-shiki
sed -i "s/tokenizeTimeLimit:0/tokenizeTimeLimit:100/" $F
grep -o "tokenizeTimeLimit:[0-9]*" $F     # 复核：:100 才算打上
```

- 当时（`0.1.1-rc.2` 代）实测过：served 生效、真会话 boot 正常、尖刺消除；**超预算的代码块会降级成纯文本**（内容完整，只是没语法色）——真机上若见个别块无色即此预期。
- **2026-09-23 晚更正：这条 sed 在 0.1.7-rc.1 上已失效**——bundle 里 `tokenizeTimeLimit` 只剩预热那一处，改它打不到渲染路径（§2.4）。所以 A 现在**不是一个可执行选项**，除非改为动宿主源码给渲染调用传预算（超出 dist 单点替换的范围，属上游域）。
- 代价：**每次宿主升级整包替换 dist ⇒ 补丁必被抹掉**；属对上游代码的本机手改，不是插件不变式。仓库 2026-09-18 定案「默认不重放」，但当时明确保留为**应急**——判据正是「真机明显被大 code 块卡到」。
- 生效条件：页面需要重载一次（`dsh web` 服务端 no-cache 现读该文件）。

### B. 上游根治（推荐并行，2026-09-23 已定为主路）

`docs/upstream/host-jank-feedback.md` §问题 2 是成稿（含证据与三条修法建议），**本次已补 0.1.7-rc.1 复核 + §2.4 更正**：`tokenizeTimeLimit` 在 dist 里只剩预热一处（渲染路径落到 Shiki 默认 **500ms/行**）、会话包仍无窗口化、长会话体量 5.3–5.9 MB / 153–176 块。建议上游按三条走：① 给**渲染调用**显式传预算（注意默认是逐行预算，须配合分片）；② 高亮改成**视口驱动/懒执行**（只 tokenize 进入视口的块）；③ 会话正文**窗口化渲染**（当前整段挂载）。

### C. 插件侧

明确**不做**：插件碰不到 Shiki 与宿主的渲染调度，任何"插件内绕路"（例如自己重写高亮、或拦 DOM 挂载）都会被宿主下一次改动推翻，且违背"第三方兼容用标记 + 最小干预"的既有原则。可做的只有：把本文件与 §2.1 的证据继续留在仓库，方便下次报障直接引用。

## 6. 待办

1. **已定：走 B（上游）**。A 的 dist 单点替换经 §2.4 精读确认在当前宿主上打不到渲染路径，不再作为止血手段；2026-09-23 用户拍板把问题提交官方。**已提交：<https://github.com/deepseek-ai/deepseek-harness/discussions/7647>** —— `deepseek-ai/deepseek-harness` 的 issues 是关闭的，官方反馈入口是 Discussions → General（标题带 `[Bug]`）；帖子正文＝`host-jank-feedback.md` §问题 2 的证据 + §2.4 更正 + 体量数字。
2. **量化 A/B 被环境卡住（不是没做）**：容器里 chromium 通道 18:17 起失效（GPU 进程 SIGSEGV 带崩浏览器；本次复现：完整版 153 / 136 / 131 三个构建 + headless shell 全败，`Page.navigate` 与 `Emulation` 域直接挂住）；设备 shell 通道未连（设置 → 设备能力授权），`dumpsys` 被策略拦。⇒「插件在首屏之后那段里占多少」仍未量化，§4 的三条插件侧嫌疑（6 个无 scope 任务每帧全跑、O(records) MutationObserver、7 条 `body:has` 门）保持**未验**，不要当已排除。
3. 通道恢复后可直接跑已就位的三臂脚本（`/root/tmp/jank-ab.mjs`：现状 / Shiki 预算 / 插件停用；采 longtask + LoAF 归因）。取证注意：一次性 cookie 用 `.credentials.yaml` 密钥铸（须店主授权）；`Network.setCookie` 在 headless shell 上不返回，改用 `Network.setExtraHTTPHeaders` 注 Cookie。
4. 宿主下一次升级后，**重跑 §3.2 的三条复核 + §2.4 的位置核对**（渲染路径是否终于显式传预算、是否终于有了窗口化）。
