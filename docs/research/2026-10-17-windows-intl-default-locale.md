# Windows 上 Bun Intl 默认 locale 的来源，以及 #76 要不要补 win32 分支

- 日期：2026-10-17
- 归属：issue #76（`systemLocale()` 缺 win32 分支）· 只读调查
- 仓库：`dsh-desktop-bun`，本次工作区为 worktree `.agents/worktrees/issue-76-win-locale`
- 调查方式：只读。下载并逐行阅读 ICU / WebKit(Bun fork) / Chromium / Bun 的上游源码与 MS / Electron 官方文档；**未改任何代码、未提交 git、未在 Windows 真机复现**
- 被调查对象：`desktop-electrobun/src/bun/locale.ts:39-53`（`systemLocale()`），消费点 `src/bun/index.ts:23`（`const locale = await systemLocale()`）→ `src/bun/preload.ts` 的 `bootPreloadScript(locale, ...)` 覆写页面 `navigator`
- 证据分级（全文统一）：
  - **官方**＝上游项目/厂商自己的文档或源码（本笔记绝大多数结论）
  - **实测**＝本机或他人真机跑出来的结果（本次调查只转述，不由我复现）
  - **推断**＝由上述证据推导，未直接观测
  - **二手**＝论坛/博客等转述，只做旁证

## 0. 结论速览

| # | 问题 | 结论 | 级别 |
|---|---|---|---|
| 1 | Windows 上 Bun 的 `Intl.DateTimeFormat().resolvedOptions().locale` 会不会恒为 en-US？ | **不会**。它取自 `WTF::platformUserPreferredLanguages()` → `GetUserDefaultUILanguage()`（Windows **UI 语言**），拿不到时才退到 ICU 的 `uloc_getDefault()` | 源码 |
| 2 | 那 macOS 上的 en-US 是怎么来的？ | macOS 走 `setlocale(LC_CTYPE, nullptr)`，Bun 启动不调 `setlocale`，结果恒为 `"C"`，WTF 映射成 `en-US`；这是 macOS 特有的坑，不是 ICU 的通用行为 | 源码＋官方 PR |
| 3 | Windows 上 ICU 读不读 `LC_ALL/LANG`？ | **不读**。Win32 编译下 `U_POSIX_LOCALE` 被 `#undef`，`uprv_getDefaultLocaleID()` 走 Win32 分支：`GetLocaleInfoEx(LOCALE_NAME_USER_DEFAULT, LOCALE_SNAME, …)`（≈`GetUserDefaultLocaleName`），失败兜底 `"en_US"` | 源码 |
| 4 | Intl 给的是「区域格式」还是「界面语言」？ | 是**界面语言（display language）**。macOS 的 `AppleLocale` 更偏区域/格式；两者语义不同，只有在默认安装（语言与区域一致）时才碰巧一致 | 源码＋官方 |
| 5 | 要不要给 `systemLocale()` 补 win32 分支？ | **不要补 win32 专属探测**。Windows GUI 进程没有 `LANG/LC_*` 时，现有的 `Intl` 兜底已经返回系统 UI 语言，正是页面语言要的语义 | 推断（由 1/2 得出） |
| 6 | 那还剩什么风险？ | ① 语义错配：英文界面＋中文区域的用户，Intl 给 `en-US`，而 macOS 同类用户会拿到 `zh-CN`；② LIP/补充区域设置下 `GetUserDefaultUILanguage()` 可能只给基语言；③ 想改成「跟区域格式」才需要 `GetUserDefaultLocaleName` | 源码＋官方 |

一句话：**#76 的前提（Windows 上 Intl 兜底不可信）在 Bun 1.4.x 上不成立**；`Intl` 兜底在 Windows 上恰好是对的，缺的是把注释里「跟随系统区域」改准为「跟随系统 UI 语言」。

## 1. Bun 的 `Intl` 默认 locale 从哪里来

### 1.1 JSC 侧：`IntlObject::defaultLocale()` 的取值顺序

Bun 用的是自己的 WebKit fork（`oven-sh/WebKit`）。`Source/JavaScriptCore/runtime/IntlObject.cpp`：

```cpp
836: String defaultLocale(JSGlobalObject* globalObject)
845:     if (auto defaultLanguage = globalObject->globalObjectMethodTable()->defaultLanguage) {
851:     Vector<String> languages = userPreferredLanguages();
864:         icuDefaultLocalString.construct(languageTagForLocaleID(uloc_getDefault(), isImmortal));
```

即三段式：**① `defaultLanguage` 钩子 → ② `WTF::userPreferredLanguages()` → ③ `uloc_getDefault()`**。

Bun 侧 ① 目前是 `nullptr`（PR #35600 想把它接到 `uloc_getDefault()` 上，但**该 PR 仍是 open**，见 §2），所以 Bun 实际走 ②，只有 ② 为空才落到 ③。

`userPreferredLanguages()` 最终调 `platformUserPreferredLanguages()`（`Source/WTF/wtf/Language.cpp:120`），各平台实现不同——**这就是 macOS 与 Windows 行为差异的根源**。

### 1.2 Windows 平台实现：`GetUserDefaultUILanguage()`

`Source/WTF/wtf/win/LanguageWin.cpp`（全文 82 行，关键三处）：

```cpp
43:     LANGID langID = GetUserDefaultUILanguage();      // localeInfo()
58: static String platformLanguage()
67:     String countryName = localeInfo(LOCALE_SISO3166CTRYNAME, String());
77: Vector<String> platformUserPreferredLanguages(ShouldMinimizeLanguages)
78:     return { platformLanguage() };
```

- `GetUserDefaultUILanguage()` 拿当前用户的**界面语言** LANGID；
- 再用 `GetLocaleInfo(langID, LOCALE_SISO639LANGNAME / LOCALE_SISO3166CTRYNAME, …)` 拼成 `zh-CN` 这种 BCP-47；
- `platformUserPreferredLanguages()` 只返回这一个值。

MS 对 `GetUserDefaultUILanguage` 的定义（[sdk-api: winnls/nf-winnls-getuserdefaultuilanguage.md](https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/winnls/nf-winnls-getuserdefaultuilanguage.md)）：

> Returns the language identifier for the user UI language for the current user. If the current user has not set a language, GetUserDefaultUILanguage returns the preferred language set for the system. If there is no preferred language set for the system, then the system default UI language (also known as "install language") is returned.

**结论（源码级）**：Windows 上 `Intl.…resolvedOptions().locale` = Windows 界面语言，不是恒 en-US，也不是终端 `LANG`。Bun 官方 PR 正文亦印证：「JSC reports the UI language of the machine there (`LanguageWin.cpp`)」（[#39730](https://github.com/oven-sh/bun/pull/39730)）。

补充坑（官方文档）：若界面语言属于 LIP 且对应 supplemental locale，`GetUserDefaultUILanguage()` 返回 `LOCALE_CUSTOM_UI_DEFAULT`；此时 `GetLocaleInfo` 取不到名字，`localeInfo()` 回落到 `"en"` → 最终可能只得到基语言 `en`。

### 1.3 macOS 为什么是 en-US

`setlocale` 路径的原始说明来自 Bun 官方 PR [#39704](https://github.com/oven-sh/bun/pull/39704) 的 Background：

> JSC's own default locale comes from `WTF::userPreferredLanguages()`, which reads `setlocale(LC_CTYPE, nullptr)`. **Bun never calls `setlocale`**, so that is `"C"`, which WTF maps to `en-US`.

即：macOS 上 Bun 从不初始化 libc locale → `setlocale` 返回 `"C"` → `en-US`。这解释了 `locale.ts` 头注释里「macOS 实测 en-US」。

> **未找到**：本次未定位到 `oven-sh/WebKit` fork 中 Cocoa 平台的 `platformUserPreferredLanguages()` 实现文件（`Source/WTF/wtf/cocoa/LanguageCocoa.mm` 只有 `parseLocale` / `minimizedLanguagesFromLanguages` 等辅助函数，没有该入口）。macOS 侧结论因此以 Bun PR 正文＋本仓既有实测为准，未追到具体源文件行号。

### 1.4 ICU 侧：`uloc_getDefault()` 在两平台读什么

调用链：`uloc_getDefault()`（`icu4c/source/common/uloc.cpp:2264`）→ `locale_get_default()`（`locid.cpp:237`）→ `Locale::getDefault()` → 懒填 `locale_set_default_internal(nullptr)`（`locid.cpp:177-187`）→ `id = uprv_getDefaultLocaleID();`（`locid.cpp:187`）。

`uprv_getDefaultLocaleID()`（`icu4c/source/common/putil.cpp:1703`）按平台三分支：

| 平台 | 分支 | 读什么 |
|---|---|---|
| POSIX/macOS/Linux | `#if U_POSIX_LOCALE`（`putil.cpp:1705`） | `LC_ALL` > `LC_MESSAGES` > `LANG`（经 `uprv_getPOSIXIDForCategory`），裁掉 codeset/`@modifier` 后规范化；全空则 `en_US_POSIX` |
| **Windows（MSVC/ClangCL/MinGW）** | `#elif U_PLATFORM_USES_ONLY_WIN32_API`（`putil.cpp:1814`） | `GetLocaleInfoEx(LOCALE_NAME_USER_DEFAULT, LOCALE_SNAME, windowsLocale, LOCALE_NAME_MAX_LENGTH)`（`putil.cpp:1826`），`_`→`-` 后 `uloc_canonicalize`；失败兜底 `gCorrectedPOSIXLocale = "en_US"`（`putil.cpp:1881`） |
| OS/400 | `#elif U_PLATFORM == U_PF_OS400` | `LC_ALL` > `LANG` > `setlocale(LC_ALL,nullptr)` |

分支归属由 `icu4c/source/common/unicode/platform.h:242-254` 决定：`U_PF_WINDOWS..U_PF_MINGW` → `U_PLATFORM_USES_ONLY_WIN32_API = 1`；`putil.cpp` 里对 Win32 `#undef U_POSIX_LOCALE`，所以**Windows 上 ICU 完全不读 `LC_ALL/LANG`**。

`LOCALE_NAME_USER_DEFAULT` 在 Win32 头里就是 `NULL`（`mingw-w64-headers/include/winnls.h:1117`：`#define LOCALE_NAME_USER_DEFAULT NULL`），语义等价于「用户默认区域设置」，即 `GetUserDefaultLocaleName`。

小结两条独立的 Windows 语义：

```
JSC/WTF 路径（实际生效）  → GetUserDefaultUILanguage()   = 界面语言
ICU 兜底路径（一般够不到） → GetUserDefaultLocaleName()  = 用户区域/格式
```

### 1.5 与 #76 前提的对照

`locale.ts` 现在的假设是「Bun 的 Intl 给的是 ICU 默认值＝en‑US 不可信，只有 macOS 需要 `defaults read -g AppleLocale`」。源码显示这个假设**只在 macOS 成立**：Windows 上 Intl 直接走 `GetUserDefaultUILanguage()`，与旧壳 WKWebView 的 `navigator.language` 语义（界面语言）同源。

这也和本仓已有的真机记录一致（**实测，非我复现**）：`src/bun/locale.ts` 头注释写明「#76 实测（2026-10-17，Bun 1.4.0 / Win11 24H2 zh‑CN），进程环境没有 `LANG/LC_*`（SYSTEM 与登录用户两种上下文都测了）时 Intl 返回 `zh‑CN`」。zh‑CN 系统的界面语言与区域一致，所以这条实测无法区分「界面语言」和「区域格式」两种语义——本文 §1.2 给出的是源码层的区分。

## 2. Bun 侧已知 issue / PR

| 编号 | 标题 | 状态 | 与 #76 的关系 |
|---|---|---|---|
| [#8480](https://github.com/oven-sh/bun/issues/8480) | Default locale for `Intl.DateTimeFormat` should match `$LANG` | open（labels: bug, confirmed bug, good first issue） | macOS 上恒 `en-US` 的原始报障，2024-01；仍 open，说明 Bun 在 POSIX 上至今没修 |
| [#35600](https://github.com/oven-sh/bun/pull/35600) | Intl: default locale follows LC_ALL/LC_MESSAGES/LANG (match Node.js) | **open** | 把 `defaultLanguage` 钩子接到 `uloc_getDefault()`。PR 正文明确：「On POSIX, ICU reads LC_ALL > LC_MESSAGES > LANG … **On Windows it reads GetUserDefaultLocaleName**. Both paths now flow through unchanged」。一旦合入，Bun 在 macOS/Linux 也会跟随 `LANG`（`locale.ts` 的前三级判断变成冗余但无害），**Windows 仍走 `userPreferredLanguages()` 优先，不变** |
| [#39704](https://github.com/oven-sh/bun/pull/39704) | Keep an unparseable LANG / LC_ALL / LC_MESSAGES from crashing ICU | closed（已合） | 新增 `src/jsc/bindings/bun_icu_default_locale.cpp`；**「Empty on Windows, where ICU reads the system locale」**——再次确认 Windows 不走环境变量 |
| [#39730](https://github.com/oven-sh/bun/pull/39730) | Let ICU derive its default locale itself after pinning en_US | closed（已合） | 修 #39704 的残留崩溃。「**The test block is skipped on Windows: JSC reports the UI language of the machine there (`LanguageWin.cpp`), so the en-US assertions are not deterministic**」——Bun 自己的测试把 Windows 判成「跟随机器 UI 语言」，与 §1.2 完全吻合 |

> 注意时间线：#39704/#39730 合于 2026-08-20，Bun 1.4.0 若早于该日期，Windows 行为也不受影响——这两个 PR 只调整 **ICU 内部默认 locale 的填充**（崩溃修复），没有动 JSC 的 `defaultLanguage` 钩子与 `LanguageWin.cpp` 这条平台路径。

## 3. Windows「系统语言」的权威口径对照

| 口径 | 语义 | 权威来源 | 生效时机 | 对应 Electron API |
|---|---|---|---|---|
| `GetUserDefaultUILanguage()` | **界面/显示语言**（Settings → 时间和语言 → 语言和区域 → 显示语言）；回退链：用户已设语言 → 系统首选语言 → 安装语言 | Kernel32 `winnls.h`（[MS 文档](https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/winnls/nf-winnls-getuserdefaultuilanguage.md)） | 换显示语言需注销/重启（新进程立即读到新值） | `app.getLocale()` → `'de'` |
| `GetUserDefaultLocaleName()` | **用户默认区域**（数字/日期/货币格式、排序），单用户机器上与 `GetSystemDefaultLocaleName()` 同值；MS 明确推荐优先用它 | Kernel32（[MS 文档](https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/winnls/nf-winnls-getuserdefaultlocalename.md)） | 改「区域格式」对新进程立即生效 | `app.getSystemLocale()` → `'fi-FI'` |
| `GetSystemDefaultLocaleName()` | 系统范围（machine）的区域；用户未覆盖时才有意义。**MS 明确不推荐优先用它** | Kernel32 | — | `app.getSystemLocale()` 在用户有覆盖时已返回用户值 |
| `GetLocaleInfoEx(LOCALE_NAME_USER_DEFAULT, LOCALE_SNAME)` | 与上一行同源，ICU 实际用的形式 | — | — | — |
| `Get-Culture` | 当前**线程/用户区域格式**（数字、货币、日期显示格式 + 键盘布局） | [PS 文档](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/main/reference/7.5/Microsoft.PowerShell.Utility/Get-Culture.md)：「gets information about the current culture settings … the display format of items such as numbers, currency, and dates」 | — | `app.getSystemLocale()` |
| `Get-UICulture` | 当前用户**界面 culture**（菜单与消息用什么文案） | [PS 文档](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/main/reference/7.5/Microsoft.PowerShell.Utility/Get-UICulture.md) | — | `app.getLocale()` |
| `Get-WinSystemLocale` | 包 `GetSystemDefaultLocaleName` 的 cmdlet | PowerShell `International` 模块 | — | `app.getSystemLocale()` |
| `HKCU\Control Panel\International\LocaleName` | 「区域格式」写入用户注册表的位置，即 `GetUserDefaultLocaleName()` 的落地处 | — | — | — |

**哪个最贴近 macOS `AppleLocale`？**
`AppleLocale`（`defaults read -g AppleLocale`，实测 `zh_CN`）表达的是**区域**。Windows 上对应物是 `GetUserDefaultLocaleName()` / `HKCU\Control Panel\International\LocaleName` / `Get-Culture().Name`，**不是** `GetUserDefaultUILanguage()`。

**哪个适合当壳的「页面语言」来源？**
页面语言要的是**界面语言**，所以是 `GetUserDefaultUILanguage()`／`Get-UICulture`——而这正是 Windows 上 Bun 的 `Intl` 现在已经在做的事，也正是旧壳 WKWebView `navigator.language` 的语义。**页面语言 ≠ 区域格式**，两者不要混。

> **未找到**：本轮未取到 MicrosoftDocs/win32 的 Intl 概念文档（`locale-name-constants.md` / `user-interface-language-management.md` 等），learn.microsoft.com 与 raw 路径均不可达。因此 `LocaleName` 注册表键与「改显示语言需注销」的**文档原文**未取到；`GetUserDefaultUILanguage` 的三级回退链有官方原文（见上表），重启/注销要求目前是**推断**（依据：显示语言涉及 MUI 资源与已加载进程的资源表）。

## 4. 同类实现旁证（Chromium / WebView2 / Electron）

本仓在 Windows 上按契约红线（#84）用**系统 WebView2**（`bundleCEF:false` + `defaultRenderer:'native'`），所以页面自身的 `navigator.language` 才是最终对照物。

- Chromium `navigator.language` 链路：`third_party/blink/renderer/core/frame/navigator_language.cc:36-37` `language() → languages().front()`，最终取 `GetAcceptLanguages()`；`third_party/blink/renderer/platform/language.cc:48-84` 的 `InitializePlatformLanguage()` 用 `Platform::Current()->DefaultLocale()` 填默认语言。
- Chromium 应用 locale 的候选来源（`ui/base/l10n/l10n_util.cc:136-145`）：Windows 分支「**If no override was set, defer to ICU**」→ `icu::Locale::getDefault()`；非 Windows 分支才读 `LANGUAGE/LC_ALL/LC_MESSAGES/LANG`。UI 语言列表另走 `base/i18n/win/preferred_languages.cc:70-71`（`GetUserPreferredUILanguages`）。
  - **旁证意义**：Chromium 与 ICU/JSC 在 Windows 上都不把环境变量当语言来源，都落到系统设置上；只有 POSIX 分支才读 `LANG`。
- Electron 官方文档把两种口径分得很清楚（`electron/electron docs/api/app.md`）：
  > `app.getLocale()` — "The current application locale, fetched using Chromium's `l10n_util` library."
  > `app.getSystemLocale()` — "The current system locale. On Windows and Linux, it is fetched using Chromium's `i18n` library…"
  > 示例注释："On Windows, given application locale is German, the regional format is Finnish … `app.getLocale() // 'de'`，`app.getSystemLocale() // 'fi-FI'`"

  即：**Windows 上「界面语言 = de，区域格式 = fi-FI」是官方承认会同时出现的情况**，这正是本节开头那条「语义错配」风险的现实样本。

- CEF：本次**未取到** CEF 自有 `CefAppHandler::GetLocale()` 的一手实现（CEF 源码不在 GitHub 主仓），故 CEF 一侧**未找到**，不下结论。不过本仓 Windows 已不走 CEF（走 WebView2），对本票影响有限。

## 5. 若一定要在 Bun 里探测，三条路的评估

前提：以下评估假设「需要的是区域格式 `GetUserDefaultLocaleName`」；若只是要界面语言，直接用 `Intl` 即可（§1.2）。

| 路线 | 可靠性 | 启动开销 | 主要坑 |
|---|---|---|---|
| `powershell -NoProfile -NonInteractive -Command "(Get-Culture).Name"` | 语义正确（区域格式）；但**依赖 PowerShell 是否存在/是否被策略禁用**（`Windows PowerShell 5.1` 在 Win11 客户端默认在、部分 Server Core/精简镜像没有；企业组策略可禁用 `-Command`） | 每次 spawn 一次 PowerShell，冷启动通常几百毫秒到 1s+；`-NoProfile` 可减负但仍需 JIT | 输出编码：子进程管道下 PowerShell 输出编码跟随 `$OutputEncoding`/控制台代码页，中文等非 ASCII 需显式 `-EncodedCommand` 或 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`；`-NoProfile` 不保证管理员/用户上下文之外的完整性；PowerShell 5.1 与 7 的 locale 语义一致但输出格式不同 |
| `reg query "HKCU\Control Panel\International" /v LocaleName` | 语义正确（就是区域格式的注册表落地） | 极低（reg.exe 很轻） | **编码坑**：`reg.exe` 被重定向输出时按 Unicode（UTF-16LE）写出，直接当 UTF-8 读会得到乱码/空字符，必须按 UTF-16 解析或转码（此条为**推断**，本次无 Windows 真机验证）；输出格式随系统语言变化（值名可能是 `LocaleName` 也可能是本地化名），需要按 `REG_SZ` 行解析而非字符串匹配 |
| **Bun FFI 调 kernel32 `GetUserDefaultLocaleName`** | 最高：直接命中 Win32 API，无子进程、无编码歧义、无 PowerShell 依赖 | 最低（`dlopen` 一次 + 一次调用，微秒级） | 需要写 FFI 绑定：`Bun.dlopen(suffix('kernel32.dll'), { GetUserDefaultLocaleName: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 } })`，两次调用（先取长度再取缓冲），返回 UTF-16 需按 code unit 读；引入了对 Bun `bun:ffi`（`docs/runtime/ffi.mdx`）的运行时依赖，测试环境需要能加载 `kernel32.dll`；返回长度含结尾 NUL |

**推荐（如果确实要区域格式）**：**Bun FFI**。理由：无子进程、无编码陷阱、无可选组件依赖，且 `winnls.h` 已在 ICU 里证明这条路径在 Bun 进程内是稳定的。PowerShell 路径只适合「一次性、脚本化」场景；`reg query` 只适合调试取证。

若要的是**界面语言**且想比 `Intl` 更直接（例如想拿到 `zh-Hans-CN` 这类带 script 的形式），可以用 FFI 调 `GetUserPreferredUILanguages`（Chromium 就用它，`base/i18n/win/preferred_languages.cc:70-71`），但那是「多语言列表」语义，比现在的 `Intl` 更啰嗦，**不建议**。

## 6. 对 #76 的修法建议

1. **不补 win32 分支**。现有链路 `env → darwin:defaults → Intl → en-US` 在 Windows 上已经得到系统界面语言，行为与旧壳 `navigator.language` 一致；再插一条 PowerShell/reg/FFI 只会增加启动开销与失败面，还会把「界面语言」错换成「区域格式」。
2. **改注释，不改逻辑**（建议在 #76 的提交里做）：
   - 头注释里「#76 实测 … 已跟随系统区域」→ 改成「**已跟随系统 UI 语言**（`GetUserDefaultUILanguage`，经 JSC/WTF 的 `LanguageWin.cpp`）」；
   - 补一句来源链接指向本笔记，并说明与 macOS `AppleLocale`（区域）**语义不同**：Windows 上想要「区域格式」得显式读 `GetUserDefaultLocaleName`。
3. **若将来产品要「区域格式优先」**（例如中文界面 + 美国区域的用户想要英文界面/美式格式），再开独立票，走 §5 推荐的 FFI 路线，并在 `localeCandidates()` 里保留 `en-US` 兜底。
4. **加一条 Windows CI 断言**（可选，成本低）：在 Windows 兜底 job 里跑 `bun -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`，与 `GetUserDefaultUILanguage` 的期望值比对，防止上游 WebKit/Bun 改动（尤其 #35600 一旦合入会改 POSIX 分支行为）时无声回归。

## 7. 未决 / 需真机验证

1. zh‑CN 以外的系统（英文界面 + 中文区域格式等组合）上，Bun 的 `Intl` 实际返回什么——本文的语义结论来自源码，未在真机枚举过。
2. `GetUserDefaultUILanguage()` 返回 `LOCALE_CUSTOM_UI_DEFAULT`（LIP/supplemental locale）时，Bun 的 `Intl` 是否真的退化成 `en`（推断自 `LanguageWin.cpp` 的 `localeInfo()` 回落逻辑）。
3. `reg query` 重定向输出的编码（本笔记按 UTF-16LE 推断，未实测）。
4. 显示语言变更后的生效时机（是否必须注销）——本笔记为推断，官方概念文档未取到。
5. Bun 1.4.0 具体构建里 JSC fork 的 `defaultLanguage` 是否确为 `nullptr`（PR #35600 仍 open，理论上为 nullptr，但未核对该 tag 的 `GlobalObjectMethodTable`）。

## 附录 A：证据索引

| 主题 | 证据 |
|---|---|
| JSC 默认 locale 三段取值 | `oven-sh/WebKit` `Source/JavaScriptCore/runtime/IntlObject.cpp:836,845,851,864` |
| Windows 平台语言实现 | `oven-sh/WebKit` `Source/WTF/wtf/win/LanguageWin.cpp:43,58,67,77-78` |
| `userPreferredLanguages` → 平台实现 | `Source/WTF/wtf/Language.cpp:120` |
| macOS en‑US 根因（不调 `setlocale`） | Bun PR [#39704](https://github.com/oven-sh/bun/pull/39704) Background；[#35600](https://github.com/oven-sh/bun/pull/35600) Cause 段 |
| ICU 默认 locale 分发 | `unicode-org/icu` `icu4c/source/common/putil.cpp:1703,1705,1814,1826,1881` |
| Win32 平台宏 | `icu4c/source/common/unicode/platform.h:242-254` |
| ICU 懒填默认 locale | `icu4c/source/common/locid.cpp:177-187,237`；`uloc.cpp:2264` |
| `LOCALE_NAME_USER_DEFAULT == NULL` | `mingw-w64/mingw-w64-headers/include/winnls.h:1117,1119` |
| `GetUserDefaultUILanguage` 定义与回退链 | [sdk-api `winnls/nf-winnls-getuserdefaultuilanguage.md`](https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/winnls/nf-winnls-getuserdefaultuilanguage.md) |
| `GetUserDefaultLocaleName` / `GetSystemDefaultLocaleName` | [sdk-api 对应两页](https://github.com/MicrosoftDocs/sdk-api/tree/docs/sdk-api-src/content/winnls) |
| `Get-Culture` / `Get-UICulture` 语义 | [PowerShell-Docs 7.5](https://github.com/MicrosoftDocs/PowerShell-Docs/tree/main/reference/7.5/Microsoft.PowerShell.Utility) |
| Chromium 候选 locale（Windows 走 ICU） | `ui/base/l10n/l10n_util.cc:136-145` |
| Chromium Windows UI 语言列表 | `base/i18n/win/preferred_languages.cc:70-71` |
| Blink `navigator.language` 链路 | `third_party/blink/renderer/core/frame/navigator_language.cc:36-37`；`third_party/blink/renderer/platform/language.cc:48-84` |
| 界面语言 ≠ 区域格式（官方例子） | `electron/electron` `docs/api/app.md`（`app.getLocale` / `app.getSystemLocale` / `app.getPreferredSystemLanguages` 三节及其示例注释） |
| Bun 侧 issue/PR | [#8480](https://github.com/oven-sh/bun/issues/8480)、[#35600](https://github.com/oven-sh/bun/pull/35600)、[#39704](https://github.com/oven-sh/bun/pull/39704)、[#39730](https://github.com/oven-sh/bun/pull/39730) |
| Bun FFI 能力 | `oven-sh/bun` `docs/runtime/ffi.mdx`；`packages/bun-types/ffi.d.ts`（`FFIType.u16` 等） |
| 本仓被调查代码 | `desktop-electrobun/src/bun/locale.ts:39-53`；`src/bun/index.ts:23`；`src/bun/preload.ts`（`bootPreloadScript`） |
| 本仓既有实测记录（非本次复现） | `src/bun/locale.ts` 头注释「#76 实测（2026-10-17，Bun 1.4.0 / Win11 24H2 zh-CN）」 |

## 附录 B：本仓真机实测原始记录（VM 复现，2026-10-17）

环境：Parallels Windows 11 Pro 24H2 ARM64（build 10.0.26100.4349），系统区域/UI 语言 zh-CN；Bun 1.4.0 windows-aarch64（官方 release，zip SHA256 f473bfe2…，与本仓 CI 的 Bun 1.4.x 对齐）。进程环境无 `LANG/LC_ALL/LC_MESSAGES`（SYSTEM 与登录用户两种上下文均确认）。

1. `Intl` 各构造器与 `resolvedOptions().locale`（SYSTEM 与 mutou 两种上下文一致）：`DateTimeFormat` / `NumberFormat` / `Collator` / `PluralRules` / `RelativeTimeFormat` / `ListFormat` / `Segmenter` → 全部 `zh-CN`；日期 `2026/1/15`，数字 `1,234,567.89`（zh-CN 格式）。
2. 直接跑 `desktop-electrobun/src/bun/locale.ts` 导出的 `systemLocale()`：`systemLocale()` → `zh-CN`；`systemLocale({})`（纯 Intl 兜底）→ `zh-CN`；`localeCandidates()` → `["zh-CN","zh","en-US","en"]`；`platform=win32`，`bun=1.4.0`。
3. 控制面板：`Get-Culture` / `Get-UICulture` / `Get-WinSystemLocale` 均 `zh-CN`；`HKCU\Control Panel\International\LocaleName=zh-CN`；`UserLangList=zh-Hans-CN,en-US`。本机 UI 语言与区域格式同为 zh-CN，区分不了 §1.2 的两种语义——语义区分靠源码。
