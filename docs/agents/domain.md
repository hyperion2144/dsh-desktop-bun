# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout: single-context（已与用户确认）

本仓库的域文档布局在初始化时与用户确认为 **single-context**：一个仓库共用一份根目录的 `CONTEXT.md`，架构决定放 `docs/adr/`。不采用 multi-context；本次初始化不创建 `CONTEXT-MAP.md` 与各子项目的 `CONTEXT.md`，留到第一次真正写下词条时再建。

> 命名注记：技能套件模板（含 `/domain-modeling`、`/wait-what`）默认把这两个文件叫 `GLOSSARY.md` / `GLOSSARY-MAP.md`；本仓库按上述确认以 `CONTEXT.md` / `CONTEXT-MAP.md` 为准，二者指同一物，遇到模板字样请对应替换。

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo（本仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-example-decision.md
│   └── 0002-another-decision.md
└── src/
```

Multi-context repo（根目录出现 `CONTEXT-MAP.md` 时才成立；本仓库不采用）：map 指向各子上下文自己的 `CONTEXT.md` 与 `docs/adr/`。

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007（对应某条已定架构决策）, but worth reopening because…_
