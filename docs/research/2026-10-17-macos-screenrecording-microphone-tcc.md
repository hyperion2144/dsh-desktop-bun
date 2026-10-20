# macOS ScreenCapture / Microphone 的 TCC 记账与签名归属：资料研究

- 日期：2026-10-17
- 仓库：`dsh-desktop-bun`（Electrobun/Bun 桌面壳），只读调查，无代码改动
- 触发：用户实机报告——会话里执行截图命令反复弹「屏幕录制 / 屏幕与系统音频录制」；语音输入拿不到麦克风权限；**已在系统设置里加过并重启过应用，仍然照弹**
- 背景（不重复推导）：#115 已确诊「发起请求的进程自己的签名不认领 bundle id → UN 通知授权归属失败」；#132 已修「bootstrap 首启自解压用签名前 payload 覆盖整棵 app 树」
- 调查方式：Apple 官方文档/手册（一手）+ Chromium/Electron 官方文档与源码（一手）+ 本机对已安装 app 的只读实测
- 现场环境（本次实测）：macOS 27.0（Build 26A428）、Xcode 27.0；已安装 `/Applications/DeepSeek Harness Desktop BUN.app`

**证据分级标注**（全文统一）：

| 标记 | 含义 |
|---|---|
| 【官方】 | developer.apple.com / support.apple.com / Apple man page / Apple Technical Note 原文 |
| 【源码】 | Chromium / Electron 官方仓库源码或官方文档 |
| 【实测】 | 本机对已安装产物 / 工具的只读观测 |
| 【推断】 | 由上述证据推出的结论，Apple 未明说 |
| 【二手】 | 社区/博客线索，**未采信为结论**，仅供排查方向 |

---

## 0. 结论速览

| # | 问题 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | macOS 按谁记账？ | macOS 按 **responsible code（责任进程）** 记账，即沿进程树回溯到的「那个 app」，**不是发起请求的那个 helper**；授权记录在**整个 app** 名下并在系统设置里以它呈现 | 【官方】TN3179 原文；【源码】Electron `desktop-capturer.md` |
| 2 | Chromium 里谁发起？ | 屏幕录制的 preflight/request 走 `chrome/browser/` 的 `system_permission_settings::CheckSystemScreenCapturePermission()` → **浏览器（主）进程**；麦克风走 `[AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio]`，也在主进程。`askForMediaAccess` **不支持 `screen`** | 【源码】`chrome/browser/media/webrtc/system_media_capture_permissions_mac.mm`、`shell/browser/api/electron_api_system_preferences_mac.mm` |
| 3 | `com.apple.security.device.screen-capture` 必需吗？ | **这个 entitlement 不存在**。Apple Hardened Runtime 文档的 Resource Access 全量清单只有 7 个键，无任何 screen-capture 项；该键在 Apple 文档站返回 404 | 【官方】Hardened Runtime 页 + 文档站 404 实测 |
| 4 | `com.apple.security.device.audio-input` 必需吗？ | 存在（macOS 10.7+），属于 **Hardened Runtime → Resource Access**，与 TCC 弹窗是两套机制；本壳是 ad-hoc、无 hardened runtime，所以**它不是本 bug 的修复点** | 【官方】Audio Input Entitlement 页 |
| 5 | 缺 `NSMicrophoneUsageDescription` 会怎样？ | Apple 明说：**「系统会终止你的 app」**（termination）。本机已安装 app 的 `Contents/Info.plist` 只有 6 个键，**没有** `NSMicrophoneUsageDescription` / `NSCameraUsageDescription` / `NSAudioCaptureUsageDescription` | 【官方】Requesting Authorization for Media Capture on macOS；【实测】PlistBuddy |
| 6 | 屏幕录制需要 usage description 吗？ | **不需要，且不存在这个键**。`NSScreenCaptureUsageDescription` 在 Apple 文档站 404；Electron 自带的 app Info.plist 模板也只写 mic/camera/audio-capture 三条 | 【官方】文档站 404 实测；【源码】`shell/browser/resources/mac/Info.plist` |
| 7 | 重签会让已授的权限失效吗？ | ad-hoc 签名「identifies exactly one instance of code」，重签必然改 CDHash。但 **Apple 没有公开文档说明 TCC 是否因 CDHash 变化而撤销决定**；且本壳每次安装才重签一次，解释不了「加了又弹」。**列为待验证** | 【官方】codesign(1)；【推断】未闭合 |
| 8 | 最可疑的现场事实 | 5 个 `bun Helper*.app`（含 `bun Helper (GPU).app`）**完全没有 `Contents/Info.plist`** → 没有 `CFBundleIdentifier`，签名 identifier 退化成 `bun Helper (GPU)-<hash>`；而 `sign-app.mjs` 层②对 Frameworks 只做 `--sign -`，**不带 `--identifier`、不带 `--entitlements`** | 【实测】find + codesign -dv |
| 9 | 实测手段 | `tccutil reset <service> <bundle id>` 只能按 **bundle id** 复位；本机实测 `ScreenCapture` / `ScreenRecording` 两种服务名都被接受（tccutil 不校验服务名）；TCC.db 需给终端 Full Disk Access，本机 shell 读不到 | 【官方】tccutil(1)；【实测】 |

---

## 1. 现场事实（本机只读实测，macOS 27.0 / 26A428）

### 1.1 外层 Info.plist：usage description 三条全缺

```
$ /usr/libexec/PlistBuddy -c 'Print' "/Applications/DeepSeek Harness Desktop BUN.app/Contents/Info.plist"
Dict {
    CFBundleVersion = 0.1.0
    CFBundlePackageType = APPL
    CFBundleIconFile = AppIcon
    CFBundleIdentifier = com.hyperion.dsh-desktop-bun
    CFBundleExecutable = launcher
    CFBundleName = DeepSeek Harness Desktop BUN
}
```

**【实测】** 关键点：

- `CFBundleExecutable = launcher`，**不是 `bun`**。外层 bundle 的「主可执行体」是 bootstrap launcher；真正的 JS 主进程 `bun` 是 `Contents/MacOS/` 下的一个并列 Mach-O。
- **没有** `NSMicrophoneUsageDescription`、`NSCameraUsageDescription`、`NSAudioCaptureUsageDescription`。
- **没有** `NSAppleEventsUsageDescription` 之类其它键（整个 plist 只有 6 个键）。

### 1.2 Contents/MacOS 与签名归属

```
$ ls -la "$APP/Contents/MacOS"
bspatch   bun   launcher   libElectrobunCore.dylib   libNativeWrapper.dylib   libasar.dylib   zig-zstd

$ codesign -dv --verbose=4 "$APP/Contents/MacOS/bun"
Identifier=com.hyperion.dsh-desktop-bun
CDHash=a8b…（launcher 与外层同理）
Signature=adhoc
TeamIdentifier=not set

$ codesign -d --entitlements :- "$APP/Contents/MacOS/bun"
com.apple.security.cs.allow-dyld-environment-variables
com.apple.security.cs.allow-jit
com.apple.security.cs.allow-unsigned-executable-memory
com.apple.security.cs.disable-executable-page-protection
com.apple.security.cs.disable-library-validation
```

**【实测】**

- `bun` 已被认领为 `com.hyperion.dsh-desktop-bun`（#115 的修复确实生效）。
- entitlements **只有 5 条 CEF/V8 豁免**，没有任何 `com.apple.security.device.*`。
- `launcher` 的 entitlements 是 4 条（比 `bun` 少 `disable-executable-page-protection`），因为 `sign-app.mjs` 的 `preservedEntitlements()` 对「无既有 entitlements 的文件」返回 `null`，于是 launcher 走的是仓库 `resources/entitlements.plist` 的默认 4 条。

### 1.3 Frameworks：helper 没有 Info.plist（本次调查最重的一条现场事实）

```
$ find "$APP/Contents/Frameworks/bun Helper (GPU).app"
.
./Contents
./Contents/_CodeSignature
./Contents/_CodeSignature/CodeResources
./Contents/MacOS
./Contents/MacOS/bun Helper (GPU)
```

**【实测】** 5 个 helper 全部如此：`bun Helper.app`、`bun Helper (Alerts).app`、`bun Helper (GPU).app`、`bun Helper (Plugin).app`、`bun Helper (Renderer).app`。

- **每个都只有 3 个条目：`_CodeSignature/CodeResources` + `MacOS/<name>`。没有 `Contents/Info.plist`。**
- 因此 `PlistBuddy -c 'Print :CFBundleIdentifier'` 直接报 `Entry, ":CFBundleIdentifier", Does Not Exist`。
- 签名 identifier 因此退化成「文件名 + hash」：

```
$ codesign -dv "$APP/Contents/Frameworks/bun Helper (GPU).app"
Identifier=bun Helper (GPU)-555549445b809175c80338c19c0ce872eb44b234
CodeDirectory v=20400 … flags=0x2(adhoc) …
Signature=adhoc
TeamIdentifier=not set
```

对照【官方】`codesign(1)`：

> `-i, --identifier identifier` — During signing, explicitly specify the unique identifier string that is embedded in code signatures. **If this option is omitted, the identifier is derived from either the Info.plist (if present), or the filename of the executable being signed**, possibly modified by the --prefix option.

以及【官方】TN2206《macOS Code Signing In Depth》：

> The signing identifier is also embedded in the DR and will **default to the CFBundleIdentifier found in the Info.plist** for convenience if one is not supplied explicitly.

**【推断】** 因为 helper 没有 Info.plist，它就落进 codesign(1) 的第二种退化路径（文件名），于是 `bun Helper (GPU)-<40 hex>` 这个**每次重签都会变的字符串**就成了它的签名身份。

### 1.4 打包脚本对 helper 做了什么（源码）

`desktop-electrobun/scripts/sign-app.mjs` 的层②（`signAppLayers`）：

```js
// ② 嵌套 bundle / framework / dylib。
for (const entry of readdirSync(frameworksDir)) {
  if (!entry.endsWith('.framework') && !entry.endsWith('.app') && !entry.endsWith('.dylib')) continue
  execFileSync('codesign', ['--force', '--sign', '-', join(frameworksDir, entry)], { stdio: 'inherit' })
}
```

**【源码】** 与层①的对比：

| 层 | 目标 | 是否 `--identifier <bundleId>` | 是否带 `--entitlements` |
|---|---|---|---|
| ① | `Contents/MacOS/*` | ✅ 是 | ✅ 保留既有 |
| ② | `Contents/Frameworks/*` | ❌ **否** | ❌ **否** |
| ③ | 外层 `.app` | ❌ 否 | ✅ 用 `resources/entitlements.plist` |

**【推断】** 层②不传 `--identifier` 在 #115/#132 的语境下是有意为之（helper 不参与 UN 通知授权），但它同时意味着：**helper 既没有 bundle id，也没有任何 entitlements**，包括 `NSMicrophoneUsageDescription` 这种根本不在 entitlements 里、在 Info.plist 里的键。

### 1.5 仓内没有任何屏幕/麦克风代码

`grep -rn 'CGPreflightScreenCaptureAccess|CGRequestScreenCaptureAccess|NSMicrophoneUsageDescription|getMediaAccessStatus|askForMediaAccess'` 覆盖 `desktop-electrobun/` 与 `desktop-plugin/` → **零命中**。`desktop-electrobun/src/types/electrobun.d.ts` 里 `Screen` 只有 `getPrimaryDisplay()` / `getAllDisplays()`。

**【推断】** 截图与语音输入的媒体请求**不是壳自己的 API 发的**，只可能来自：(a) CEF 渲染层里的 `getUserMedia` / `getDisplayMedia`，或 (b) DSH 工具链 spawn 的外部进程。这一点必须实机确认（见 §8）。

---

## 2. Q1 归属（responsible process）规则

### 2.1 Apple 对「责任进程」的唯一成文定义

【官方】TN3179《Understanding local network privacy》：

> When a process performs a local network operation, macOS tries to track down the **responsible code**. For example, **if your app spawns a helper tool and the helper tool performs a local network operation, macOS considers the app to be the responsible code.**
>
> macOS uses the responsible code to:
> - Show a meaningful app name and usage description in the local network alert
> - **Record the user's choice for the whole app, not just that specific helper tool**
> - Present that choice in System Settings

**⚠️ 边界**：TN3179 讲的是 **Local Network** 隐私服务，不是 `kTCCServiceScreenCapture` / `kTCCServiceMicrophone`。它是我能找到的、**Apple 唯一成文的「responsible code」机制说明**，机制同源（同一个 tccd），但**「ScreenCapture/Microphone 完全同规则」这一步是推断**。

### 2.2 Electron 官方口径（Chromium 同源）

【源码】Electron `docs/api/desktop-capturer.md`：

> …in order to facilitate use of Apple's CoreAudio Tap API by Chromium, which is gated behind the **"System Audio Recording"** privacy permission. **macOS attributes that permission to the responsible process**, so when running unpackaged from a terminal or IDE **it is the terminal or IDE that must be granted access.**

这是「归属 responsible process」在 Chromium/Electron 语境下最直接的一手表述，也解释了用户会遇到的「加了终端的权限还是不行」类现象。

### 2.3 Chromium/Electron 里到底哪个进程发起

【源码】`chrome/browser/media/webrtc/system_media_capture_permissions_mac.mm`（Electron 从 Chromium vendor 下来）：

```objc
SystemPermission CheckSystemScreenCapturePermission() {
  SystemPermission system_permission =
      system_permission_settings::CheckSystemScreenCapturePermission();
  …
}

bool ScreenCaptureNeedsSystemLevelPermissions() {
  if (@available(macOS 15, *)) {
    // The native picker does not require TCC, as macOS considers the user's
    // direct interaction with the OS as conferring one-time permission.
    return !base::FeatureList::IsEnabled(media::kUseSCContentSharingPicker);
  }
  return true;
}
```

- 文件位于 `chrome/browser/` → **屏幕录制的 preflight 发生在浏览器（主）进程**，不在 GPU/renderer helper。【源码】
- 麦克风走 AVFoundation，同文件体系下的 Electron 实现（`shell/browser/api/electron_api_system_preferences_mac.mm`）：

```objc
AVMediaType ParseMediaType(const std::string& media_type) {
  if (media_type == "camera")    return AVMediaTypeVideo;
  if (media_type == "microphone") return AVMediaTypeAudio;
  else                            return nil;
}

std::string SystemPreferences::GetMediaAccessStatus(…, const std::string& media_type) {
  if (media_type == "camera")    … CheckSystemVideoCapturePermission();
  else if (media_type == "microphone") … CheckSystemAudioCapturePermission();
  else if (media_type == "screen")     … CheckSystemScreenCapturePermission();
}

v8::Local<v8::Promise> SystemPreferences::AskForMediaAccess(…, const std::string& media_type) {
  if (auto type = ParseMediaType(media_type)) {
    [AVCaptureDevice requestAccessForMediaType:type completionHandler:…];
  } else {
    promise.RejectWithErrorMessage("Invalid media type");
  }
}
```

**两条硬事实**【源码】：

1. `askForMediaAccess` **只支持 `camera` / `microphone`**；传 `'screen'` 走 `else` 分支 → promise 直接 reject `"Invalid media type"`。所以「触发屏幕录制弹窗」只能靠真实的捕获尝试（`getDisplayMedia` / `desktopCapturer`），不能靠这个 API。
2. 麦克风的 OS 授权请求是 `[AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio]`，**在主进程**。

### 2.4 Electron 文档里的状态机

【源码】Electron `docs/api/system-preferences.md`：

> ### `systemPreferences.getMediaAccessStatus(mediaType)` _Windows_ _macOS_
> `mediaType` string - Can be `microphone`, `camera` or `screen`.
> Returns `string` - Can be `not-determined`, `granted`, `denied`, `restricted` or `unknown`.
> … macOS 10.14 Mojave or higher requires consent for `microphone` and `camera` access. macOS 10.15 Catalina or higher requires consent for `screen` access.

【源码】同文档 `askForMediaAccess` 一节末尾：

> **If an access request was denied and later is changed through the System Preferences pane, a restart of the app will be required for the new permissions to take effect.** If access has already been requested and denied, it _must_ be changed through the preference pane; **an alert will not pop up** and the promise will resolve with the existing access status.

这是「改了系统设置要不要重启」在 Electron 侧唯一的官方口径——**只在 denied→重新授权 的路径上要求重启**。

### 2.5 对本问题的直接回答

> **主 app 已授权但请求来自 helper 时会发生什么？**

【推断】按 TN3179 的规则，helper 本身不是记账单元，**macOS 应该仍然记到主 app**。但这有一个前提：helper 必须是「app 的一部分」。本仓的 helper 虽然物理上嵌在 `Contents/Frameworks/`，**却因为没有 `Contents/Info.plist` 而不构成一个完整的 app bundle**——它是「嵌在 app 里的裸 Mach-O + 一份 `_CodeSignature`」。这种形态下：

- 它没有自己的 bundle id，也就没有自己的 usage description；
- 它的签名 identifier 是文件名派生的（每次重签都变）；
- 【官方】Apple 明确说缺 usage description 的**后果是终止 app**，所以它**不可能**自己独立发起一条合法的麦克风授权请求。

**因此 helper 更可能只是问题的「受害者/放大器」，而不是记账主体。真正的记账主体大概率仍是主 app。**（需要 §5 的 log 证据确认。）

---

## 3. Q2 签名与 entitlement 要求

### 3.1 `com.apple.security.device.screen-capture` —— 不存在

【官方】Apple《Hardened Runtime》文档（<https://developer.apple.com/documentation/security/hardened-runtime>）的 Topic Sections 里，**Resource Access 的完整清单**只有 7 项：

```
Resource Access
  com.apple.security.device.audio-input
  com.apple.security.device.camera
  com.apple.security.personal-information.location
  com.apple.security.personal-information.addressbook
  com.apple.security.personal-information.calendars
  com.apple.security.personal-information.photos-library
  com.apple.security.automation.apple-events
```

【实测】Apple 文档站的 entitlement 页面探测：

| entitlement | `tutorials/data/.../entitlements/<key>.json` |
|---|---|
| `com.apple.security.device.screen-capture` | **404** |
| `com.apple.security.device.audio-input` | 200 |
| `com.apple.security.device.camera` | 200 |
| `com.apple.developer.screen-capture.include-passthrough` | 200 |

【官方】唯一带 "screen-capture" 字样的 entitlement 是 `com.apple.developer.screen-capture.include-passthrough`，其平台标注为 **visionOS 2.0+**，abstract 是「To optimize the viewing of displayed content for passthrough…」——**与 macOS 屏幕录制授权无关**。

> ✅ **结论：`com.apple.security.device.screen-capture` 这个 entitlement 不存在，屏幕录制授权没有「免弹窗」捷径。**
> ⚠️ 这个问题原本的前提（问它是否必需）在 Apple 侧不成立。

### 3.2 `com.apple.security.device.audio-input` —— 存在，但与 TCC 是两套机制

【官方】Audio Input Entitlement 页：

> **Key:** `com.apple.security.device.audio-input`
> **Abstract:** A Boolean value that indicates whether the app may **record audio using the built-in microphone** and access audio input using Core Audio.
> **Platforms:** macOS 10.7+
> **Discussion:** To add this entitlement to your app, first enable the **Hardened Runtime** capability in Xcode, and then under **Resource Access**, select **Audio Input**.

【推断】这是 **Hardened Runtime 的「资源直通」豁免**——开了它，Hardened Runtime 签名的 app 访问麦克风时不再需要用户同意（隐私保护 vs 便利性的取舍）。它**不是**、也**不能替代** TCC 的 `kTCCServiceMicrophone` 决定。

【官方】Hardened Runtime 页另一条对本仓很关键的原文：

> **You add entitlements only to executables. Shared libraries, frameworks, and in-process plug-ins inherit the entitlements of their host executable.**

→ **helper app 是独立的可执行体，不会继承主 app 的 entitlements。** 如果将来要走 hardened runtime + resource access 这条路，helper 必须自己签。

**对本仓的现状**：ad-hoc 签名、无 hardened runtime → `com.apple.security.device.audio-input` 加不加都一样，都不解决当前症状。**不是修复点。**

### 3.3 缺 usage description 的后果：Apple 明说「终止 app」

【官方】《Requesting Authorization for Media Capture on macOS》（BundleResources）：

> In macOS 10.14 and later, the user must explicitly grant permission for each app to access cameras and microphones. …
> - If your app uses device cameras, include the **NSCameraUsageDescription** key in your app's `Info.plist` file.
> - If your app uses device microphones, include the **NSMicrophoneUsageDescription** key in your app's `Info.plist` file.
> - **If the appropriate key is not present in your app's `Info.plist` file when your app requests authorization or attempts to use a capture device, the system terminates your app.** The Xcode debug console displays a message that explains the reason for the crash.

【实测】本机已安装 app 的 `Info.plist` **没有** `NSMicrophoneUsageDescription`。

【推断】两者叠加会产生一种非常吻合用户症状的失败模式：**麦克风请求在被 TCC 判定之前，就因为找不到 usage description 而走了「终止 app」/ 请求失败的分支**；用户看到的是反复的弹窗或申请不到，而不是一次干净的拒绝。Electron 官方文档也描述了相邻的静默失败形态：

> **If the permission is missing or has been denied, `desktopCapturer` still produces an audio track, but it is created in the `ended` state and never delivers samples. No warning or error is surfaced to JavaScript.**

### 3.4 ad-hoc 签名在这两个服务上的行为

【官方】`codesign(1)`：

> If identity is the single letter `-` (dash), **ad-hoc signing is performed. Ad-hoc signing does not use an identity at all, and identifies exactly one instance of code. Significant restrictions apply to the use of ad-hoc signed code**; consult documentation before using this.

【推断】对本仓的直接含义：

1. ad-hoc 签名**没有 certificate chain、没有 Team ID**（实测 `TeamIdentifier=not set`），因此 TCC/其它子系统若要做「按签名主体」的判定，只能退化成「identifier + cdhash」。
2. 「identifies exactly one instance of code」= **CDHash 一改，身份就变**（见 §4）。

【官方】关于「responsible code requirement」：**TN3120 并不是这个主题**。TN3120 的实际标题是《Expected use cases for Network Extension packet tunnel providers》（Apple Technotes 目录可查）。与「责任代码」相关的、成文的一手文档是 **TN3179**（§2.1，已引）。

---

## 4. Q3 重签 / 重建的影响

### 4.1 授权记在 bundle id 还是签名身份上

【官方】`tccutil(1)` 是唯一能看到的官方形态：

> `tccutil` – manage the privacy database
> `tccutil command service [bundle_id]`
> reset — Reset all decisions for the specified service, causing apps to prompt again the next time they access the service. **If a bundle identifier is specified, the service will be reset for that bundle only.**

→ **复位接口按 bundle id 索引**，这是 Apple 公开契约里唯一的键。【官方】

【推断】TCC.db 的行主键是 bundle id（实际 schema 里还有 `csreq` 列存 code requirement，用于校验重签名），但 **Apple 没有公开文档说明「code signature 变化后既有决定是否仍然有效」**。

### 4.2 「加了又弹」与重签的关系：目前不成立

【推断】本壳的重签发生在**打包 / 安装时**，不是每次启动。用户的操作序列是「加权限 → 重启应用 → 还是弹」，期间**签名没有变**（可对比重签前后 `codesign -dv` 的 `CDHash`）。所以：

> **「重签导致 CDHash 变化 → 授权失效」这个假设，解释不了本症状，除非用户的 app 是每次启动都被重签（例如走了 #132 那条未修的自解压覆盖路径）。**

**判定方法**：连续两次记录 `codesign -dv "$APP/Contents/MacOS/bun" | grep CDHash`，若一致 → 排除本条。

### 4.3 真正会因重签/重建而变的东西

【实测】helper 的签名 identifier `bun Helper (GPU)-555549445b809175c80338c19c0ce872eb44b234` 里那段 hex **每次重签都会变**（它由文件名 + 内容派生）。所以：

- 若 macOS 把某个 helper 当成独立的「app 主体」记账，它在每次重签后就是一个**全新身份**，之前在系统设置里加的条目对不上 → 表现为「加了又弹」。
- 【推断】这是本仓唯一一处「重签 ⇒ 授权可能丢失」的**结构性**风险点，且和 §1.3 的「helper 无 Info.plist」是同一个洞的两面。

### 4.4 Electron/CEF 生态的已知坑（可复用结论）

【源码】Electron 官方文档里与重签/重装直接相关的只有一条（已引 §2.4）：**denied → 系统设置里改回来后必须重启 app 才生效**。

【二手·仅作线索】Electron 社区长期存在「ad-hoc 签名 / `electron-osx-sign` 漏签 helper 导致 TCC 行为异常」的 issue 讨论；本次**没有**找到 Electron 官方 issue tracker 上被维护者明确认领的结论，**故不作为依据**。

---

## 5. Q4 Info.plist 用法字符串

### 5.1 键的存在性与平台标注（Apple 文档站实测）

| 键 | 文档站 | 平台 / 起始版本 | Apple 的 Discussion 原文 |
|---|---|---|---|
| `NSMicrophoneUsageDescription` | 200 | macOS **10.14+** | "This key is **required** if your app uses APIs that access the device's microphone." |
| `NSCameraUsageDescription` | 200 | macOS **10.14+** | "This key is **required** if your app uses APIs that access the device's camera." |
| `NSAudioCaptureUsageDescription` | 200 | macOS **14.2+** | "For more information, see capturing-system-audio-with-core-audio-taps." |
| `NSScreenCaptureUsageDescription` | **404** | — | **Apple 未定义此键** |

### 5.2 Electron 自带模板的对照

【源码】`shell/browser/resources/mac/Info.plist`（Electron 官方 app Info.plist 模板）里有：

```xml
<key>NSMicrophoneUsageDescription</key><string>This app needs access to the microphone</string>
<key>NSCameraUsageDescription</key><string>This app needs access to the camera</string>
<key>NSAudioCaptureUsageDescription</key><string>This app needs access to audio capture</string>
```

**没有 `NSScreenCaptureUsageDescription`。** → Electron 侧印证 §5.1 的 404 不是我探测错了。

### 5.3 macOS 14+ / 15+ / 26+ 的行为变化

【官方】`NSAudioCaptureUsageDescription` 的起始版本是 **macOS 14.2**。【源码】Electron 文档解释了这个版本号的意义：

> Since Electron 39, Chromium **uses the CoreAudio Tap API by default** for system audio capture on macOS 14.2 and later. … If instead you are running Electron from another program like a terminal or IDE then that parent program must contain the Info.plist key.

【源码】macOS 15 起新增了一条「不需要 TCC」的路径：

```objc
if (@available(macOS 15, *)) {
  // The native picker does not require TCC, as macOS considers the user's
  // direct interaction with the OS as conferring one-time permission.
  return !base::FeatureList::IsEnabled(media::kUseSCContentSharingPicker);
}
```

【官方】Apple 支持页确认系统设置里的分类名（本机 macOS 27 上同样存在）：

> **Screen & System Audio Recording** — Allow apps to record your screen and audio, or just your audio. The listed apps have access. To add an app, click [+] below a list, select the app, then click Open.
> **Microphone** — Allow apps to access the microphone on your Mac. The listed apps have requested access.
> **Remote Desktop** / **Speech Recognition** 也各自独立成类。

> ✅ **对用户症状最关键的一条**：系统设置里「屏幕录制」与「屏幕与系统音频录制」是**两个不同的分类条目**。用户在 A 类里加了 app，代码走的是 B 类的 TCC 服务，就会表现为「加了、重启了、还是弹」。

【二手·未采信】社区称自 macOS 15 Sequoia 起，系统会对屏幕录制类权限做**周期性（每月/每周）再提醒**，且提示文案改成「is requesting to bypass the system private window picker…」。本次**未找到 Apple 一手来源**，不作为结论；但它同样能产生「刚授权又弹」的观感，排查时需与 TCC 记账问题区分开（区分法见 §7）。

---

## 6. Q5 实测手段（维护者自查清单）

### 6.1 签名侧（无副作用，优先做）

```bash
APP="/Applications/DeepSeek Harness Desktop BUN.app"

# 外层与主可执行体的身份
codesign -dv --verbose=4 "$APP"            2>&1 | grep -E 'Identifier|CDHash|TeamIdentifier|Signature'
codesign -dv --verbose=4 "$APP/Contents/MacOS/bun"      2>&1 | grep -E 'Identifier|CDHash|TeamIdentifier|Signature'
codesign -dv --verbose=4 "$APP/Contents/MacOS/launcher" 2>&1 | grep -E 'Identifier|CDHash|TeamIdentifier|Signature'

# entitlements（注意 ':' 语法已 deprecated，会打 warning，但本机仍可用）
codesign -d --entitlements :- "$APP/Contents/MacOS/bun" 2>&1

# helper 的身份（有 Info.plist 才会显示文件名，否则是 hash 退化形式）
for h in "$APP/Contents/Frameworks"/bun*.app; do
  echo "== $(basename "$h")"; codesign -dv "$h" 2>&1 | grep -E 'Identifier|TeamIdentifier'
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$h/Contents/Info.plist" 2>&1 | tail -1
done
```

**判读**：`Identifier=bun Helper (GPU)-<hex>` 就是「这个 helper 没有 Info.plist」的信号（`codesign(1)` 明确说了 identifier 在无 Info.plist 时由文件名派生）。

### 6.2 复位 TCC（Apple 官方接口）

【官方】`tccutil reset <service> [bundle_id]`。**【实测】** 本机用**不存在的 bundle id** 探测（安全，无副作用）：

```
$ tccutil reset ScreenCapture   com.hyperion.dsh-desktop-bun.__nonexistent__
tccutil: No such bundle identifier "…": The operation couldn't be completed. (OSStatus error -10814.)   # exit 64
$ tccutil reset ScreenRecording com.hyperion.dsh-desktop-bun.__nonexistent__
（同上，exit 64）
$ tccutil reset Microphone      com.hyperion.dsh-desktop-bun.__nonexistent__
（同上，exit 64）
```

**两条限制**：

1. **必须先退出应用**，否则旧进程仍持有决定，复位后立刻又写回（Electron 文档 §2.4 印证：改设置后要重启 app）。
2. `tccutil` **不校验 service 名**——`ScreenRecording` 也被接受，所以「服务名写错」不会报错，**不能用报错与否来判断服务名对错**。Apple man page 也**没有**给出服务名清单；`ScreenCapture` 这个名字来自社区通用写法（【二手】StackOverflow 高票答案）。要确认到底是哪个服务，得看系统设置里条目挂在哪个分类下。

### 6.3 ScreenCapture API 直测

【官方】`CGPreflightScreenCaptureAccess()`（macOS 10.15+）/ `CGRequestScreenCaptureAccess()`。

**⚠️ 诚实标注**：Apple 这两个函数页面的 **abstract 与 discussion 都是空的**（实测抓取 `tutorials/data/...json`，`primaryContentSections` 只有声明，`abstract: []`）。**Apple 官方文档没有说明它们与 TCC 的关系、也没有提任何 entitlement。** 网上关于「必须先 preflight 再 request」「返回 false 就是被拒」的描述都是【二手】。它们作为「当前是否已授权」的探针仍然有效（Electron 的 `getMediaAccessStatus('screen')` 底层就是同一个 `CheckSystemScreenCapturePermission()`，走 `CGPreflightScreenCaptureAccess`），但**不要把它当成有 Apple 文档背书的契约**。

### 6.4 系统日志（判定「谁在要权限」的关键手段）

【二手·社区惯例】`tccd` 的日志在 `com.apple.TCC` subsystem 下。实操：

```bash
# 先看有没有权限事件
log stream --style compact --predicate 'subsystem == "com.apple.TCC"'

# 复现时同时在另一窗口看进程树，确认发起方
ps -axo pid,ppid,comm | grep -iE 'bun Helper|Contents/MacOS/bun'
```

**这一步能一次性回答 §8 里所有「未查实」项**：弹窗那一刻 `tccd` 记的 `responsible_pid` / `requesting_pid` 是谁，就能把候选 A/E 区分开。（predicate 字符串本身是社区惯例，Apple 未公开稳定的 subsystem 名。）

### 6.5 读 TCC.db

【官方】`tccutil` 存在本身就意味着 TCC 有个数据库；【实测】本机 shell 读不到：

```
$ sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db "select 1"
Error: unable to open database file: unable to open database file
```

需要给**执行命令的那个 app**（Terminal / iTerm / 编辑器）开 **Full Disk Access**，并且多数情况下需要 `sudo`。**这是最后手段**，而且【二手·未采信】Apple 从未公开 TCC.db 的 schema，字段名随时可能变。

---

## 7. Q6 Electron / CEF 官方与源码口径

### 7.1 Electron 侧的完整 API 面

| API | 支持 mediaType | 源码落点 | 备注 |
|---|---|---|---|
| `systemPreferences.getMediaAccessStatus(t)` | `microphone` / `camera` / `screen` | `electron_api_system_preferences_mac.mm` → `system_permission_settings::CheckSystem*Permission()` | 同步返回状态 |
| `systemPreferences.askForMediaAccess(t)` | **仅** `microphone` / `camera` | 同上 → `[AVCaptureDevice requestAccessForMediaType:]` | 传 `'screen'` → reject `"Invalid media type"`【源码】 |
| `session.setDisplayMediaRequestHandler(h, {useSystemPicker})` | — | `docs/api/session.md` | `useSystemPicker` 标注为 macOS + **Experimental** |
| `desktopCapturer.getSources({types,thumbnailSize})` | — | `docs/api/desktop-capturer.md` | macOS 14.2+ 系统音频需 `NSAudioCaptureUsageDescription` |

### 7.2 Electron 官方对 helper 的口径

【源码】`docs/tutorial/application-distribution.md`「Rebranding with downloaded binaries」明确要求**同时**改两个 plist：

> - `Electron.app/Contents/Info.plist`
> - `Electron.app/Contents/Frameworks/Electron Helper.app/Contents/Info.plist`

> ✅ 这从**上游官方文档**层面确认了：**helper app 在 Electron 的世界模型里是一个独立的 bundle，有自己的 Info.plist 和 CFBundleIdentifier**。

**本仓的 helper 连 Info.plist 都没有** → 与 Electron 的预期形态有结构性差距。这是本报告认为最值得先修的一处。

### 7.3 CEF（Electrobun 实际用的）—— 没有对等的一手文档

【实测】本 app 的 `Contents/Frameworks/` 里是 `Chromium Embedded Framework.framework`，**不是** Electron；主进程是 Bun（Electron 兼容层）而非 Node。

【实测】`desktop-electrobun/src/types/electrobun.d.ts` 中**不存在** `systemPreferences` / `askForMediaAccess` / `setDisplayMediaRequestHandler` / `desktopCapturer` 的等价 API（grep 零命中，§1.5）。

> ⚠️ **因此：上面所有 Electron 结论对本仓只能作为「同源 Chromium 的行为参考」，不能直接照抄成修复方案。** CEF 官方文档几乎不覆盖 TCC / macOS 隐私授权这一层，本次**没有**找到 CEF 侧的一手来源。

---

## 8. 根因候选（按可能性排序）

> 排序依据：与「用户已授权 + 已重启 + 仍反复弹」这一**具体症状**的吻合度，以及本机实测证据的支持强度。

### 候选 A（最高）—— 主 app `Info.plist` 缺 `NSMicrophoneUsageDescription`

- **判定依据**【实测】：§1.1，`Contents/Info.plist` 只有 6 个键，三条 usage description 全缺。【官方】Apple 明说缺键的后果是**终止 app**，与「申请不到权限」高度吻合。
- **能解释**：麦克风那半边（语音输入）。
- **不能解释**：屏幕录制那半边（没有这个键的要求，见 §5.1）。
- **区分方法**：在 `Info.plist` 加上 `NSMicrophoneUsageDescription` 重签重装，跑 `getMediaAccessStatus('microphone')`（或直接观察弹窗文案里是否出现自定义说明文案）。若麦克风恢复正常 → 候选 A 坐实。

### 候选 B（高）—— 「屏幕录制」与「屏幕与系统音频录制」是两个条目，加错了分类

- **判定依据**【官方】：§5.3，Apple 支持页确认二者是独立分类；【源码】：Electron 文档把 CoreAudio Tap 的门控明确叫「System Audio Recording」，与 Screen Recording 是两道门。
- **能解释**：屏幕录制那半边「加了还弹」——**前提是用户加的是另一类**。
- **区分方法**：先只跑 `CGPreflightScreenCaptureAccess()`（§6.3），再打开系统设置看新增条目**挂在哪个分类下**；或在「屏幕与系统音频录制」里也加一遍再复现。

### 候选 C（中高）—— helper 无 `Info.plist` → 无 bundle id / 无 usage description，破坏责任进程判定

- **判定依据**【实测】：§1.3，5 个 helper 全无 `Contents/Info.plist`，identifier 退化为 `bun Helper (GPU)-<hash>`；【源码】：§1.4，`sign-app.mjs` 层②既不传 `--identifier` 也不传 `--entitlements`；【源码】：§7.2，Electron 官方文档确认 helper 本应是带 plist 的独立 bundle；【官方】：TN3179 说明授权按「整个 app」记，而这里的 app 形态本身是残缺的。
- **能解释**：为什么「重启了还是弹」——helper 身份每次重签都变（§4.3），旧的授权条目对不上。
- **区分方法**：给某个 helper 造一份带 `CFBundleIdentifier`（用 `<主 bundle id>.gpu` 之类）+ `NSMicrophoneUsageDescription` 的 `Contents/Info.plist`，重签重装，看弹窗文案里的 app 名和系统设置里的条目**是否变了**。变了 → 这条路径参与了归属判定。
- **风险提示**：这条**同时可能**是 A 的成因而非独立候选（helper 拿不到 usage description 就走终止分支）。修 A 时会顺带暴露 C。

### 候选 D（中低）—— ad-hoc 重签 → CDHash 变化 → 已授决定失效

- **判定依据**【官方】：`codesign(1)` 的 ad-hoc「identifies exactly one instance of code」；【推断】：TCC 可能把 code requirement 纳入校验。
- **反证**：本壳重签只发生在安装时，用户「加权限 → 重启」期间签名未变（§4.2）。**除非**用户的 app 每次启动都被 #132 那条自解压路径覆盖。
- **区分方法**：两次记录 `codesign -dv "$APP/Contents/MacOS/bun" | grep CDHash`，一致即可排除。

### 候选 E（中低）—— 请求根本不是壳发的（responsible process 是外部进程）

- **判定依据**【实测】：§1.5，仓内零媒体相关代码；【源码】：Electron 文档明说「从终端/IDE 启动时，responsible process 是终端/IDE」。
- **能解释**：若截图能力由 DSH 工具链 spawn 的外部进程（例如起独立浏览器、或调用 `/usr/sbin/screencapture`）承担，则要在系统设置里授权的是**那个外部进程**，而不是本 app。
- **区分方法**：`log stream --predicate 'subsystem == "com.apple.TCC"'` 复现一次，看 `requesting_pid`；同时 `ps -axo pid,ppid,comm` 对照进程树。

### 候选 F（低）—— 归属不成立（#115 同款复发）

- **判定依据**【实测】：§1.2，`bun` 与 `launcher` 都已认领 `com.hyperion.dsh-desktop-bun`，`sign-app.mjs` 里还有 `assertMacosAttribution()` 断言。**表面看已修。**
- **但有一个未闭合点**【推断】：外层 `CFBundleExecutable = launcher`，如果 TCC 取的是「**bundle 主可执行体的签名**」而不是「**发起进程自己的签名**」，那么认领 `bun` 就可能不生效——`launcher` 虽然也被 `--identifier` 认领了，但它带的是仓库默认的 4 条 entitlements。
- **区分方法**：查 §6.4 的 `tccd` 日志，看记账用的是哪个 pid / 哪个 identifier。

---

## 9. 未查实 / 需要维护者实机确认

1. **发起请求的到底是哪个进程**（`bun` / `bun Helper (GPU)` / 外部工具）。本报告所有归属推理都缺这一环的现场证据；一次 `log stream --predicate 'subsystem == "com.apple.TCC"'` 就能补上。
2. **CEF（非 Electron）下 macOS 媒体授权的官方口径**。CEF 官方文档不覆盖 TCC，本次未找到任何一手来源；Electron 的结论只能当参考。
3. **ad-hoc 重签是否真的会撤销既有 TCC 决定**。Apple 无公开文档；Apple 文档站上 `CGRequestScreenCaptureAccess` / `CGPreflightScreenCaptureAccess` 的 abstract 与 discussion 均为空，没有关于 TCC 的任何表述。
4. **macOS 27（本机）上「屏幕与系统音频录制」是否仍有周期性再提示**。社区称自 Sequoia 起存在周期性提醒，但无 Apple 一手来源，需实机观察。
5. **`tccutil` 的合法 service 名清单**。`tccutil(1)` 未给出；本机实测 `ScreenCapture` 与 `ScreenRecording` 都被接受，无法据此反推哪个是真名（§6.2）。
6. **Electron 官方 issue tracker 上关于 ad-hoc 签名 / helper 签名与 TCC 的明确结论**。本次未找到被维护者认领的定论，只有社区零散讨论。

---

## 附录：来源清单

### Apple 一手

| 来源 | 用于 |
|---|---|
| [Hardened Runtime — Apple Developer Documentation](https://developer.apple.com/documentation/security/hardened-runtime) | §3.1 Resource Access 全量清单（7 项，无 screen-capture）；「entitlements 只加给可执行体」 |
| [Audio Input Entitlement (`com.apple.security.device.audio-input`)](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input) | §3.2 abstract + Discussion |
| [Requesting Authorization for Media Capture on macOS](https://developer.apple.com/documentation/bundleresources/requesting-authorization-for-media-capture-on-macos) | §3.3 缺 usage description → **系统终止 app** |
| [NSMicrophoneUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nsmicrophoneusagedescription) | §5.1 macOS 10.14+ / required |
| [NSCameraUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nscamerausagedescription) | §5.1 macOS 10.14+ / required |
| [NSAudioCaptureUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nsaudiocaptureusagedescription) | §5.1 macOS 14.2+ |
| [CGRequestScreenCaptureAccess()](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess()) | §6.3 macOS 10.15+；**页面 abstract/discussion 为空** |
| [CGPreflightScreenCaptureAccess()](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()) | §6.3 同上 |
| [TN3179: Understanding local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy) | §2.1 responsible code 定义原文（「授权记给整个 app，而不是那个 helper」） |
| [TN2206: macOS Code Signing In Depth](https://developer.apple.com/library/archive/technotes/tn2206/_index.html) | §1.3 签名 identifier 默认取 Info.plist 的 `CFBundleIdentifier` |
| [TN3120: Expected use cases for Network Extension packet tunnel providers](https://developer.apple.com/documentation/technotes/tn3120-expected-use-cases-for-network-extension-packet-tunnel-providers) | §3.4 **证伪**：TN3120 与 TCC 无关 |
| [Change Privacy & Security settings on Mac — Apple Support](https://support.apple.com/guide/mac-help/change-privacy-security-settings-on-mac-mchl211c911f/mac) | §5.3 「Screen & System Audio Recording」「Microphone」「Remote Desktop」「Speech Recognition」为独立分类 |
| `codesign(1)` man page（本机 `man codesign`） | §1.3 `--identifier` 无 Info.plist 时由文件名派生；§3.4 ad-hoc「identifies exactly one instance of code」 |
| `tccutil(1)` man page（本机 `man tccutil`） | §6.2 `reset <service> [bundle_id]` 的官方形态 |

### Chromium / Electron 一手

| 来源 | 用于 |
|---|---|
| [`chrome/browser/media/webrtc/system_media_capture_permissions_mac.mm`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/media/webrtc/system_media_capture_permissions_mac.mm) | §2.3 屏幕录制 preflight 在 `chrome/browser/`（主进程）；macOS 15 起 SCContentSharingPicker 不需要 TCC |
| [`shell/browser/api/electron_api_system_preferences_mac.mm`](https://github.com/electron/electron/blob/main/shell/browser/api/electron_api_system_preferences_mac.mm) | §2.3 `ParseMediaType` 只支持 camera/microphone；`AskForMediaAccess` 走 `AVCaptureDevice` |
| [`shell/browser/resources/mac/Info.plist`](https://github.com/electron/electron/blob/main/shell/browser/resources/mac/Info.plist) | §5.2 Electron 模板自带 mic/camera/audio-capture 三条，无 screen-capture |
| [Electron `docs/api/system-preferences.md`](https://github.com/electron/electron/blob/main/docs/api/system-preferences.md) | §2.4 `getMediaAccessStatus` 语义；10.14/10.15 版本门槛；改设置后需重启 app |
| [Electron `docs/api/desktop-capturer.md`](https://github.com/electron/electron/blob/main/docs/api/desktop-capturer.md) | §2.2「macOS attributes that permission to the responsible process」；§5.3 CoreAudio Tap 与 `NSAudioCaptureUsageDescription` |
| [Electron `docs/api/session.md`](https://github.com/electron/electron/blob/main/docs/api/session.md) | §7.1 `setDisplayMediaRequestHandler(..., {useSystemPicker})` |
| [Electron `docs/tutorial/application-distribution.md`](https://github.com/electron/electron/blob/main/docs/tutorial/application-distribution.md) | §7.2 helper app 有自己的 `Contents/Info.plist`，rebrand 时必须一并处理 |

### 本仓一手（只读）

| 位置 | 用于 |
|---|---|
| `desktop-electrobun/resources/entitlements.plist` | §1.2 只有 4 条 CEF/V8 豁免 |
| `desktop-electrobun/scripts/sign-app.mjs`（`signAppLayers` / `preservedEntitlements` / `assertMacosAttribution`） | §1.4 层①②③ 的签名参数差异 |
| `/Applications/DeepSeek Harness Desktop BUN.app/Contents/Info.plist` | §1.1 六键、无 usage description |
| 同上 `Contents/MacOS/{bun,launcher}` 的 `codesign -dv` / `-d --entitlements :-` | §1.2 身份与 entitlements |
| 同上 `Contents/Frameworks/bun Helper*.app` 的 `find` / `codesign -dv` / `PlistBuddy` | §1.3 helper 无 Info.plist（核心现场事实） |
| `desktop-electrobun/src/types/electrobun.d.ts` | §1.5 Electrobun 无 Electron 的媒体权限 API |
