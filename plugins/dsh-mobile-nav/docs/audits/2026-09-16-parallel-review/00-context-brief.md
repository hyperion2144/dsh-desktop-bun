# 共享上下文包（每个审查 agent 开工先读这份，不要重新摸索）

## 仓库与基线
- 仓库：`~/dsh-mobile-nav`（项目名 dsh-web-mobile），分支 `fix/50-52-49-verified`。
- 本审查的主文档：`docs/audits/2026-09-15-css-surface-audit.md`（A–H 类发现 + T0–T8 任务 + 指纹与再审查协议）——**你的任务是补充它没覆盖的**，别重复它的 A–F 条目。
- 冻结指纹（若你读到的文件 sha1 与此不符，说明有人正在改，请在报告里点名）：
  - `src/client/styles/base.css.ts` e6f2bac570a1fcb4e237dd151a8ae58cd21efe35（285 行）
  - `src/client/styles/compat.css.ts` 110f753c746ba9ca30cf204b60308bdd947367e8（930 行）
  - `src/client/styles/layout.css.ts` ef22d818bbab120ceb49ed02f42fd77218badf64（1126 行）
  - `src/client/styles/misc.css.ts` 4f5a5477a43040e5bb53af059a1be30ee4b500fc（277 行）
- 已知门禁全绿：`pnpm verify`、`pnpm test:core`（120/120）、`pnpm build`、`git diff --exit-code lib`。

## 硬约束（违反会让你的发现作废）
1. **只读**：不得编辑仓库内任何文件；不得 `git commit/checkout/stash/add`；**不得跑 `pnpm build`**（它会重写 `lib/`，与父会话正在进行的 CSS 修复冲突）。
2. 允许：读文件、`grep`/`rg`、`node` 一次性脚本（别写进仓库）、`node --test tests/*.test.ts`、对 `http://127.0.0.1:3080` 发 curl（cookie 见下）。
3. **不要起 chromium/CDP**（父会话与其它 agent 共用本机，起了会互相抢资源并泄漏进程）。
4. 临时文件一律放 `~/tmp/review-2026-09-16/`（**禁止写 `/tmp`**，Termux 上不可写）。
5. 你的产出写到 `~/tmp/review-2026-09-16/<你的代号>.md`，**不要**写进 `docs/`（父会话统一合并）。

## 证据纪律（本仓库的规矩，务必遵守）
- 每条发现必须是**可复现的事实**：给出命令 + 输出摘录，或真实引擎实测结果。**禁止**「应该/大概/可能有问题」的猜测——那类一律写成「未验证线索」并明确标注。
- 行号必须是真实文件行号（`sed -n 'Np'` 能取出你引用的那一行）。
- 说话要能自证：能跑测试就跑，能读实现就读实现；不确定就承认不确定。
- 报告格式：`Status:` DONE / DONE_WITH_CONCERNS / BLOCKED，然后「发现数」，然后每条一行（文件:行 + 一句话事实 + 证据命令），最后「自检：我可能错在哪」。
- 返回给父会话的摘要 ≤40 行，细节留在你的 .md 里。

## cookie（只有需要访问 3080 时用）
```
C=$(grep -o 'dsh-auth-[^=]*=[^ ]*' ~/tmp/mint.out | head -1)
curl -s -H "Cookie: $C" http://127.0.0.1:3080/ | ...
```
无 cookie 一律 401。组合加载器 URL 形如 `/plugins/??dsh-web-mobile/client.js&rev=<rev>`（注意 `??` 是 index 语法）。

## 判定基线（别把这些当新发现）
- A1 compat L743–817 缩进/重复 media（父会话正在修，16 条 fatal 检测器输出就是它）
- A2 `order: 3` 死声明、A3 compat L402–409 死规则、A4 特异度平局注释、B1 两处被批量替换改反的注释、C1–C4 冗余/失实注释、D1–D3 注释与 iOS 门、E1/E2、F1 死代际探针（已由提交 6111603 修）
- 已知 info 级：`layout.css.ts` 1007 的 `vh`→`dvh` 兜底对（合法）、142/171/626 与 compat 789 的拆分选择器（C3 相关）
