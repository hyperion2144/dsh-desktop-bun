window.__ModuleLoader__.load({
  id: "dsh-desktop-bun",
  factory: (require) => {
var module = { exports: {} };
var exports = module.exports;

"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  applyAdvancedShell: () => applyAdvancedShell,
  inject: () => inject,
  parseDesktopClientEnvironment: () => parseDesktopClientEnvironment,
  requestDesktopClientEnvironment: () => requestDesktopClientEnvironment
});
module.exports = __toCommonJS(index_exports);

// ../shared/rpc/core.ts
function createRpcCore(options) {
  const post = options.post;
  const defaultTimeoutMs = options.timeoutMs ?? 15e3;
  const maxId = options.maxId ?? 1e10;
  const scheduleTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle));
  const pending = /* @__PURE__ */ new Map();
  let nextId = 0;
  function settle(packet) {
    const id = typeof packet.id === "number" ? packet.id : NaN;
    const waiter = pending.get(id);
    if (waiter === void 0) return;
    pending.delete(id);
    if (waiter.timer !== void 0) cancelTimeout(waiter.timer);
    if (packet.success === true) waiter.resolve(packet.payload);
    else waiter.reject(new Error(typeof packet.error === "string" ? packet.error : "shell rpc failed"));
  }
  return {
    invoke(method, params, invokeOptions) {
      nextId = nextId < maxId ? nextId + 1 : 1;
      const id = nextId;
      return new Promise((resolve, reject) => {
        const timer = invokeOptions?.noTimeout === true ? void 0 : scheduleTimeout(() => {
          pending.delete(id);
          reject(new Error("RPC request timed out."));
        }, invokeOptions?.timeoutMs ?? defaultTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          post(JSON.stringify({ type: "request", id, method, params: params ?? {} }));
        } catch (error) {
          pending.delete(id);
          if (timer !== void 0) cancelTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    receive(packet) {
      if (!packet || typeof packet !== "object" || packet.type !== "response") return;
      settle(packet);
    }
  };
}
var SHELL_RPC_CORE_SOURCE = createRpcCore.toString();

// src/client/shell/shell-rpc.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function createShellRpc(deps) {
  const readGlobals = deps?.readGlobals ?? (() => globalThis);
  const setTimeoutImpl = deps?.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutImpl = deps?.clearTimeoutImpl ?? ((t) => clearTimeout(t));
  let core = null;
  let receiveAttached = false;
  function officialBridge() {
    const post = readGlobals().__electrobunHostBridge?.postMessage;
    return typeof post === "function" ? post : void 0;
  }
  function rpcCore() {
    if (core === null) {
      const post = officialBridge();
      if (post === void 0) throw new Error("official bridge unavailable");
      core = createRpcCore({ post, setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl });
    }
    return core;
  }
  function ensureReceive() {
    if (typeof readGlobals().__DSH_SHELL_RPC__?.invoke === "function") {
      receiveAttached = true;
      return;
    }
    if (receiveAttached) return;
    const g = readGlobals();
    const eb = g.__electrobun;
    if (!eb) return;
    eb.receiveMessageFromHost = rpcCore().receive;
    receiveAttached = true;
    const queued = g.__electrobunPendingHostMessages;
    if (Array.isArray(queued)) {
      g.__electrobunPendingHostMessages = [];
      for (const packet of queued) rpcCore().receive(packet);
    }
  }
  function officialInvoke(cmd, args, options) {
    const dispatcher = readGlobals().__DSH_SHELL_RPC__;
    if (typeof dispatcher?.invoke === "function") return dispatcher.invoke(cmd, args, options);
    const post = officialBridge();
    if (post === void 0) return Promise.reject(new Error("official bridge unavailable"));
    ensureReceive();
    return rpcCore().invoke(cmd, args, options);
  }
  function relayInvoke(cmd, args) {
    const invoke2 = readGlobals().__DSH_SHELL_RELAY__?.invoke;
    if (typeof invoke2 !== "function") return Promise.reject(new Error("relay bridge unavailable"));
    return invoke2(cmd, args);
  }
  return {
    invoke(cmd, args, options) {
      const rest = isRecord(args) ? args : {};
      if (officialBridge() !== void 0) return officialInvoke(cmd, rest, options);
      if (typeof readGlobals().__DSH_SHELL_RELAY__?.invoke === "function") return relayInvoke(cmd, rest);
      return Promise.reject(new Error("shell rpc unavailable"));
    },
    available() {
      const g = readGlobals();
      return officialBridge() !== void 0 || typeof g.__DSH_SHELL_RELAY__?.invoke === "function" || typeof g.__DSH_SHELL_RPC__?.invoke === "function";
    }
  };
}
var shellRpc = createShellRpc();

// src/client/desktop-settings/rpc.ts
function invoke(cmd, args, options) {
  return shellRpc.invoke(cmd, args, options);
}
function invokeCommand(cmd, args, options) {
  return shellRpc.invoke(cmd, args, options);
}
var nsRpc = null;
function captureNsRpc(ctx) {
  try {
    nsRpc = ctx.connection ?? null;
  } catch {
    nsRpc = null;
  }
}
function hasNsRpc() {
  return nsRpc !== null;
}
async function nsSave(patch) {
  await invokeCommand("save_desktop_settings", { patch });
}
async function nsGet() {
  const d = await invokeCommand("get_desktop_settings_data");
  return d.settings && typeof d.settings === "object" ? d.settings : {};
}

// src/client/bridge/local-chrome.ts
var DARWIN_STRIP_HEIGHT = 28;
var TRAFFIC_LIGHT_BAND = 76;
var FRAME_LAYER_SELECTOR = "[data-shell-overlay]";
function locateLayout() {
  const layer = document.querySelector(FRAME_LAYER_SELECTOR);
  const frame = layer?.parentElement;
  if (frame === null || frame === void 0) return null;
  const children = Array.from(frame.children).filter((el) => el instanceof HTMLElement);
  return { frame, sidebar: children[0] ?? frame, center: children[1] ?? null, rightColumn: children[2] ?? null };
}
function installLocalChrome(platform) {
  const host = document.createElement("div");
  host.className = "dshDesktopChromeHost";
  const strip = document.createElement("div");
  strip.className = "dshDesktopChromeStrip";
  const drag = document.createElement("div");
  drag.className = "dshDesktopChromeDrag";
  drag.classList.add("electrobun-webkit-app-region-drag");
  strip.appendChild(drag);
  if (platform === "darwin") host.appendChild(strip);
  document.body.appendChild(host);
  const STATUS_BAR_HEIGHT = 24;
  const STATUS_TEXT = {
    0: "\u521D\u59CB\u5316",
    1: "\u542F\u52A8\u4E2D",
    2: "\u8FD0\u884C\u4E2D",
    3: "\u590D\u7528\u5916\u90E8\u5B9E\u4F8B",
    4: "\u91CD\u542F\u4E2D",
    5: "\u670D\u52A1\u5F02\u5E38",
    6: "\u670D\u52A1\u4E0B\u7EBF",
    7: "\u8FDC\u7A0B"
  };
  const STATUS_COLOR = {
    0: "#9ca3af",
    1: "#f59e0b",
    2: "#22c55e",
    3: "#22c55e",
    4: "#f59e0b",
    5: "#ef4444",
    6: "#ef4444",
    7: "#3b82f6"
  };
  let raf = 0;
  let attempts = 0;
  let mountTimer = 0;
  let statusTimer = 0;
  let currentStatus = -1;
  let exitMode = "";
  let resizeObserver = null;
  let mutationObserver = null;
  const bar = document.createElement("div");
  bar.className = "dshDesktopStatusBar";
  bar.innerHTML = '<span class="dshDesktopStatusDot" aria-hidden="true"></span><span class="dshDesktopStatusText"></span>';
  host.appendChild(bar);
  const refreshStatus = () => {
    if (!shellRpc.available()) return;
    void invokeCommand("get_dsh_status").then((value) => {
      const s = value.status;
      if (typeof s !== "number") return;
      currentStatus = s;
      if (exitMode !== "") return;
      const dot = bar.querySelector(".dshDesktopStatusDot");
      const text = bar.querySelector(".dshDesktopStatusText");
      const label = STATUS_TEXT[s] ?? `\u72B6\u6001 ${s}`;
      if (dot !== null) dot.style.background = STATUS_COLOR[s] ?? "#9ca3af";
      if (text !== null) text.textContent = label;
      bar.title = `dsh\uFF1A${label}`;
    }).catch(() => {
    });
  };
  const setExitMode = (mode) => {
    exitMode = mode;
    const text = bar.querySelector(".dshDesktopStatusText");
    if (mode === "") {
      delete bar.dataset.dshExitMode;
      if (text !== null) text.textContent = STATUS_TEXT[currentStatus] ?? `\u72B6\u6001 ${currentStatus}`;
      bar.title = `dsh\uFF1A${STATUS_TEXT[currentStatus] ?? ""}`;
      refreshStatus();
      return;
    }
    bar.dataset.dshExitMode = "hover";
    if (text !== null) text.textContent = "\u9000\u51FA";
    bar.title = "\u5B8C\u5168\u9000\u51FA\u672C\u7A97\u53E3\uFF08\u5173\u95ED\u7A97\u53E3 + \u505C\u6B62\u5B9E\u4F8B\uFF09";
  };
  const openExitConfirm = () => {
    document.getElementById("dshDesktopExitConfirm")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "dshDesktopExitConfirm";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;";
    const card = document.createElement("div");
    card.style.cssText = "background:var(--dsw-alias-bg-layer-1,#1e1e1e);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:12px;padding:18px 20px;min-width:320px;max-width:80vw;box-shadow:0 12px 40px rgba(0,0,0,0.4);color:var(--dsw-alias-label-primary,#eee);";
    const titleEl = document.createElement("div");
    titleEl.textContent = "\u5B8C\u5168\u9000\u51FA\u672C\u7A97\u53E3";
    titleEl.style.cssText = "font-size:14px;font-weight:600;margin-bottom:10px;";
    const bodyEl = document.createElement("div");
    bodyEl.textContent = "\u5C06\u5173\u95ED\u672C\u7A97\u53E3\u5E76\u505C\u6B62\u5176 dsh \u5B9E\u4F8B\uFF08\u8FD0\u884C\u4E2D\u7684\u4F1A\u8BDD\u8FDB\u7A0B\u4E00\u5E76\u505C\u6B62\uFF09\u3002\u786E\u8BA4\u7EE7\u7EED\uFF1F";
    bodyEl.style.cssText = "font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#bbb);";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:14px;";
    const close = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      setExitMode("");
    };
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    const mkBtn = (label, primary) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText = primary ? "padding:6px 14px;border-radius:8px;border:none;background:#dc2626;color:#fff;font-size:13px;cursor:default;" : "padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#444);background:transparent;color:var(--dsw-alias-label-primary,#eee);font-size:13px;cursor:default;";
      btn.addEventListener("click", () => {
        if (!primary) {
          close();
          return;
        }
        if (!shellRpc.available()) {
          close();
          return;
        }
        btn.disabled = true;
        void invokeCommand("exit_window_instance").then(() => close()).catch((err) => {
          bodyEl.textContent = `\u9000\u51FA\u5931\u8D25\uFF1A${String(err)}`;
          bodyEl.style.color = "#ef4444";
          btn.disabled = false;
        });
      });
      return btn;
    };
    row.appendChild(mkBtn("\u53D6\u6D88", false));
    row.appendChild(mkBtn("\u786E\u8BA4\u9000\u51FA", true));
    card.appendChild(titleEl);
    card.appendChild(bodyEl);
    card.appendChild(row);
    overlay.appendChild(card);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
  };
  bar.addEventListener("mouseenter", () => {
    if (currentStatus === 2 && exitMode === "") setExitMode("hover");
  });
  bar.addEventListener("mouseleave", () => {
    if (exitMode === "hover") setExitMode("");
  });
  bar.addEventListener("click", () => {
    if (exitMode !== "hover" || currentStatus !== 2) return;
    openExitConfirm();
  });
  refreshStatus();
  statusTimer = window.setInterval(refreshStatus, 5e3);
  const schedule = () => {
    if (raf !== 0) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      sync();
    });
  };
  const SIDEBAR_SCROLL_MARK = "data-dsh-desktop-scroll";
  let scrollRegion = null;
  let scrollRoot = null;
  const minWidthPatched = [];
  const overflowXPatched = [];
  const isScrollableY = (el) => {
    const oy = getComputedStyle(el).overflowY;
    return oy === "auto" || oy === "scroll";
  };
  const ensureSidebarScroll = (sidebar) => {
    let root = null;
    const slot = document.querySelector('[data-slot="sidebar"]');
    if (slot !== null) {
      root = Array.from(slot.children).find((el) => el instanceof HTMLElement) ?? null;
    }
    if (root === null) {
      root = Array.from(sidebar.children).find((el) => el instanceof HTMLElement) ?? null;
    }
    if (root === null) return;
    root.style.flexWrap = "nowrap";
    root.style.width = "100%";
    root.style.maxWidth = "100%";
    root.style.minWidth = "0";
    root.style.overflowX = "auto";
    scrollRoot = root;
    const region = Array.from(root.children).find((el) => {
      return el instanceof HTMLElement && getComputedStyle(el).flexGrow === "1";
    });
    if (region === void 0) return;
    scrollRegion = region;
    minWidthPatched.length = 0;
    const visit = (el) => {
      const style = getComputedStyle(el);
      if (style.display.includes("flex")) {
        el.style.minWidth = "0";
        minWidthPatched.push(el);
      }
      if (isScrollableY(el)) {
        el.style.overflowX = "auto";
        overflowXPatched.push(el);
      }
      for (const child of el.children) {
        if (child instanceof HTMLElement) visit(child);
      }
    };
    for (const child of Array.from(region.children)) {
      if (child instanceof HTMLElement) visit(child);
    }
    if (root.getAttribute(SIDEBAR_SCROLL_MARK) === null) {
      root.setAttribute(SIDEBAR_SCROLL_MARK, "");
    }
  };
  const sync = () => {
    const layout = locateLayout();
    if (layout === null) {
      if (attempts++ < 1200) schedule();
      return;
    }
    attempts = 0;
    const { frame, sidebar } = layout;
    ensureSidebarScroll(sidebar);
    const sidebarWidth = sidebar.offsetWidth;
    sidebar.style.paddingBottom = `${STATUS_BAR_HEIGHT}px`;
    bar.style.cssText = `left:0;bottom:0;width:${sidebarWidth}px;height:${STATUS_BAR_HEIGHT}px;`;
    if (platform === "darwin") {
      const collapsed = frame.hasAttribute("data-sidebar-collapsed");
      frame.style.setProperty("transition", "none", "important");
      if (collapsed) {
        strip.style.cssText = `left:0;top:0;width:${TRAFFIC_LIGHT_BAND}px;height:${DARWIN_STRIP_HEIGHT}px;background:transparent;`;
        drag.style.cssText = "position:absolute;inset:0;";
        sidebar.style.paddingTop = "";
        bar.style.display = "none";
      } else {
        strip.style.cssText = `left:0;top:0;width:${TRAFFIC_LIGHT_BAND}px;height:${DARWIN_STRIP_HEIGHT}px;`;
        drag.style.cssText = "position:absolute;inset:0;";
        bar.style.display = "";
      }
    }
  };
  try {
    resizeObserver = new ResizeObserver(schedule);
    mutationObserver = new MutationObserver(schedule);
  } catch {
    resizeObserver = null;
    mutationObserver = null;
  }
  const attachObservers = () => {
    const layout = locateLayout();
    if (layout === null) return false;
    if (resizeObserver !== null) {
      resizeObserver.observe(layout.frame);
      resizeObserver.observe(layout.sidebar);
      if (layout.center !== null) resizeObserver.observe(layout.center);
      if (layout.rightColumn !== null) resizeObserver.observe(layout.rightColumn);
    }
    if (mutationObserver !== null) {
      mutationObserver.observe(layout.frame, {
        attributes: true,
        attributeFilter: ["data-sidebar-collapsed", "data-details-collapsed", "style"]
      });
    }
    return true;
  };
  if (!attachObservers()) {
    mountTimer = window.setInterval(() => {
      if (attachObservers()) {
        window.clearInterval(mountTimer);
        sync();
      }
    }, 250);
  }
  sync();
  return () => {
    if (raf !== 0) cancelAnimationFrame(raf);
    if (mountTimer !== 0) window.clearInterval(mountTimer);
    if (statusTimer !== 0) window.clearInterval(statusTimer);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    const found = locateLayout();
    if (found !== null) {
      found.sidebar.style.paddingTop = "";
      found.sidebar.style.paddingBottom = "";
      found.sidebar.style.paddingLeft = "";
      found.sidebar.style.paddingRight = "";
      found.sidebar.style.removeProperty("border-right");
      found.frame.style.removeProperty("transition");
      found.frame.style.removeProperty("grid-template-columns");
    }
    for (const el of minWidthPatched) el.style.minWidth = "";
    for (const el of overflowXPatched) el.style.overflowX = "";
    minWidthPatched.length = 0;
    overflowXPatched.length = 0;
    if (scrollRoot !== null) {
      scrollRoot.style.flexWrap = "";
      scrollRoot.style.width = "";
      scrollRoot.style.maxWidth = "";
      scrollRoot.style.minWidth = "";
      scrollRoot.style.overflowX = "";
      scrollRoot.removeAttribute(SIDEBAR_SCROLL_MARK);
      scrollRoot = null;
    }
    if (scrollRegion !== null) {
      scrollRegion = null;
    }
    host.remove();
  };
}

// src/client/ui/styles.ts
var ADVANCED_STYLES = `
.dshDesktopChromeHost { position: fixed; inset: 0; z-index: 45; pointer-events: none; }
.dshDesktopChromeStrip { position: absolute; display: flex; align-items: stretch; pointer-events: auto; }
.dshDesktopChromeDrag { user-select: none; }
.dshDesktopStatusBar { position: absolute; display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 11px; line-height: 1; color: var(--dsw-alias-label-secondary, currentColor); border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); pointer-events: auto; user-select: none; }
.dshDesktopStatusDot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
/* \u8BBE\u7F6E\u5F39\u7A97\u5DE6\u4FA7 tab \u5217\u53EF\u6EDA\u52A8\uFF08dsh \u4E0A\u6E38 navList \u65E0 overflow\uFF0Ctab \u591A\u4E86\u88AB\u622A\u65AD\uFF09\uFF1A
   \u7528\u5F39\u7A97\u7A33\u5B9A\u6807\u8BB0\u5B9A\u4F4D\uFF0C\u4E0D\u4F9D\u8D56 hash \u7C7B\u540D\u3002 */
[role="dialog"][aria-modal="true"] nav { min-height: 0; overflow: hidden; }
[role="dialog"][aria-modal="true"] nav > div:last-child { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
/* \u4FA7\u8FB9\u680F\u5185\u5BB9\u533A\u6EDA\u52A8\uFF08local-chrome.ts ensureSidebarScroll \u6253\u7A33\u5B9A\u6807\u8BB0\uFF1B\u5185\u8054 overflow
   \u5DF2\u8986\u76D6 stock \u7684 hidden\uFF0C\u8FD9\u91CC\u53EA\u505A\u6EDA\u52A8\u6761\u89C2\u611F\u4E0E\u6EDA\u52A8\u94FE\u6536\u655B\uFF09\u3002 */
[data-dsh-desktop-scroll] { overscroll-behavior: contain; scrollbar-width: thin; }
[data-dsh-desktop-scroll]::-webkit-scrollbar { width: 8px; height: 8px; }
[data-dsh-desktop-scroll]::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2, rgba(128,128,128,0.4)); border-radius: 4px; }
[data-dsh-desktop-scroll]::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2, rgba(128,128,128,0.6)); }
/* \u72B6\u6001\u6761\u300C\u9000\u51FA\u300D\uFF08#180\uFF09\uFF1A\u4EC5\u8FD0\u884C\u4E2D\u60AC\u505C/\u786E\u8BA4\u6001\u751F\u6548\uFF0Cdata-* \u7A33\u5B9A\u6807\u8BB0\uFF1B\u6587\u6848\u8D85\u5BBD\u6298\u53E0\u3002 */
.dshDesktopStatusText { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshDesktopStatusBar[data-dsh-exit-mode="hover"] { background: rgba(220, 38, 38, 0.16); color: #ef4444; font-weight: 600; }
.dshDesktopExitBtn { padding: 3px 10px; border-radius: 6px; border: 1px solid rgba(239, 68, 68, 0.55); background: transparent; color: inherit; font-size: 11px; line-height: 1; cursor: default; flex: none; }
.dshDesktopExitBtn:hover { filter: brightness(1.1); }
`;
function installAdvancedStyles() {
  const style = document.createElement("style");
  style.dataset.plugin = "dsh-desktop-tauriapp";
  style.dataset.pluginCss = "dsh-desktop-tauriapp/local-chrome";
  style.textContent = ADVANCED_STYLES;
  document.head.appendChild(style);
  return () => {
    style.remove();
  };
}

// src/client/shell/advanced-shell.ts
function applyAdvancedShell(ctx, environment) {
  ctx.effect(() => {
    document.body.dataset.dshDesktopPlatform = environment.platform;
    document.documentElement.dataset.platform = environment.platform;
    const removeStyles = installAdvancedStyles();
    return () => {
      removeStyles();
      delete document.body.dataset.dshDesktopPlatform;
      delete document.documentElement.dataset.platform;
    };
  }, "desktop: advanced shell styles");
  ctx.effect(() => installLocalChrome(environment.platform), "desktop: local window chrome");
}

// src/client/features/downloads-tab.tsx
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var DownloadIcon = import_dsh_client_ui_primitives.IconDownloadOutline16 ?? import_dsh_client_ui_primitives.IconDownloadOutlineRegular;
var TAB_ID = "dsh-desktop-tauriapp/downloads";
var TAB_KIND = "dsh-desktop-tauriapp/downloads";
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
var STATUS_LABEL = {
  choosing_path: "\u7B49\u5F85\u9009\u62E9\u4F4D\u7F6E",
  queued: "\u6392\u961F\u4E2D",
  downloading: "\u4E0B\u8F7D\u4E2D",
  paused: "\u5DF2\u6682\u505C",
  completed: "\u5DF2\u5B8C\u6210",
  failed: "\u5931\u8D25",
  cancelled: "\u5DF2\u53D6\u6D88"
};
function DownloadsPanel() {
  const [tasks, setTasks] = (0, import_react.useState)([]);
  const [concurrency, setConcurrency] = (0, import_react.useState)(3);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const timerRef = (0, import_react.useRef)(null);
  const tasksRef = (0, import_react.useRef)([]);
  (0, import_react.useEffect)(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const list = await invokeCommand("list_downloads");
        const settings = await invokeCommand("get_download_settings");
        if (!alive) return;
        setTasks(list);
        setConcurrency(settings.concurrency);
      } catch {
      }
    };
    void refresh();
    const tick = () => {
      void refresh();
      const active = tasksRef.current.some((t) => t.status === "downloading" || t.status === "queued" || t.status === "choosing_path");
      timerRef.current = window.setTimeout(tick, active ? 600 : 2500);
    };
    timerRef.current = window.setTimeout(tick, 600);
    return () => {
      alive = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);
  tasksRef.current = tasks;
  const act = async (cmd, args) => {
    setBusy(true);
    try {
      await invokeCommand(cmd, args);
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const finishedCount = tasks.filter((t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled").length;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, fontSize: 12 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08))" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: "var(--dsw-alias-label-secondary, #9aa3af)" }, children: [
        "\u5E76\u53D1 ",
        concurrency
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          disabled: busy || finishedCount === 0,
          onClick: () => void act("clear_finished_downloads", {}),
          style: { padding: "2px 10px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14))", background: "transparent", color: "inherit", cursor: "pointer" },
          children: "\u6E05\u7A7A\u5DF2\u5B8C\u6210"
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 0" }, children: tasks.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { padding: "28px 16px", textAlign: "center", color: "var(--dsw-alias-label-tertiary, #6b7280)" }, children: "\u6682\u65E0\u4E0B\u8F7D\u4EFB\u52A1\u3002\u9875\u9762\u91CC\u7684\u4E0B\u8F7D\uFF08session log\u3001\u6587\u4EF6\u7B49\uFF09\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\u3002" }) : tasks.map((t) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: "8px 10px", borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.05))" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-primary, #e7eaf0)" }, title: t.filename, children: t.filename }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "var(--dsw-alias-label-tertiary, #6b7280)", fontSize: 11 }, children: STATUS_LABEL[t.status] })
      ] }),
      (t.status === "downloading" || t.status === "queued" || t.status === "paused") && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 5 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { height: 4, borderRadius: 2, background: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))", overflow: "hidden" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "div",
          {
            style: {
              height: "100%",
              width: t.total ? `${Math.min(100, t.received / t.total * 100)}%` : "0%",
              background: "var(--dsw-alias-brand-primary-new-color, #4176e6)",
              transition: "width .3s"
            }
          }
        ) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", marginTop: 3, color: "var(--dsw-alias-label-tertiary, #6b7280)", fontSize: 11 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
            fmtBytes(t.received),
            t.total ? ` / ${fmtBytes(t.total)}` : "",
            t.resumed ? " \xB7 \u7EED\u4F20" : ""
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "55%" }, title: t.targetPath, children: t.targetPath })
        ] })
      ] }),
      t.error != null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { marginTop: 3, color: "#f87171", fontSize: 11 }, title: t.error, children: t.error }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 6, marginTop: 5 }, children: [
        (t.status === "downloading" || t.status === "queued") && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextButton, { onClick: () => void act("pause_download", { id: t.id }), children: "\u6682\u505C" }),
        (t.status === "paused" || t.status === "failed") && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextButton, { onClick: () => void act("resume_download", { id: t.id }), children: t.status === "paused" && t.kind === "blob" ? "\u6062\u590D(\u4E0D\u53EF\u7528)" : "\u6062\u590D" }),
        !["completed", "cancelled"].includes(t.status) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextButton, { onClick: () => void act("cancel_download", { id: t.id }), children: "\u53D6\u6D88" }),
        t.status === "completed" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextButton, { onClick: () => void act("reveal_download", { id: t.id }), children: "\u5728\u6587\u4EF6\u7BA1\u7406\u5668\u4E2D\u663E\u793A" })
      ] })
    ] }, t.id)) })
  ] });
}
function TextButton({ children, onClick }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      onClick,
      style: {
        padding: "1px 8px",
        fontSize: 11,
        borderRadius: 6,
        border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14))",
        background: "transparent",
        color: "inherit",
        cursor: "pointer"
      },
      children
    }
  );
}
function DownloadsTabTitle() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DownloadIcon, {}),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { marginLeft: 4 }, children: "\u4E0B\u8F7D" })
  ] });
}
function DownloadsHeaderButton() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    import_dsh_client_ui_primitives.Button,
    {
      variant: "ghost",
      size: "sm",
      icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DownloadIcon, {}),
      title: "\u4E0B\u8F7D\u7BA1\u7406\u5668",
      "aria-label": "\u4E0B\u8F7D\u7BA1\u7406\u5668",
      onClick: () => {
        if (headerOpenAction) headerOpenAction();
      }
    }
  );
}
var headerOpenAction = null;
function registerDownloadsTab(ctx) {
  if (!shellRpc.available()) {
    ctx?.logger?.warn?.("downloads-tab: \u65E0\u58F3\u901A\u9053\uFF08\u7EAF\u6D4F\u89C8\u5668\uFF09\uFF0C\u8DF3\u8FC7\u6CE8\u518C");
    return;
  }
  const root = ctx;
  root.inject(["sidebarRightTabs"], (sub) => {
    const disposers = [];
    const isDisposer = (r) => typeof r === "function";
    const own = (r) => {
      if (isDisposer(r)) disposers.push(r);
    };
    try {
      const tabs = sub.sidebarRightTabs;
      const slots = sub.slots;
      if (tabs === void 0 || typeof tabs.register !== "function") return;
      if (slots === void 0 || typeof slots.register !== "function") return;
      own(tabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => "\u4E0B\u8F7D",
        guide: [
          {
            id: "downloads",
            order: 30,
            title: () => "\u4E0B\u8F7D",
            description: () => "\u684C\u9762\u58F3\u4E0B\u8F7D\u7BA1\u7406\u5668\uFF1A\u8FDB\u5EA6\u3001\u6682\u505C/\u6062\u590D\u3001\u5E76\u884C\u4E0E\u5386\u53F2",
            icon: DownloadIcon
          }
        ]
      }));
      own(slots.inject(
        "sidebar.right.pane.tab",
        () => slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, DownloadsPanel)
      ));
      own(slots.inject(
        "sidebar.right.pane.tab.title",
        () => slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID }, DownloadsTabTitle)
      ));
    } catch {
      for (const dispose of disposers) dispose();
      return;
    }
    return () => {
      for (const dispose of disposers) dispose();
    };
  });
  root.inject(["slots"], (sub) => {
    const slots = sub.slots;
    if (slots === void 0 || typeof slots.register !== "function") return;
    try {
      headerOpenAction = () => {
        const sidebarRight = ctx.get?.("sidebarRight");
        if (sidebarRight && typeof sidebarRight.openTab === "function") {
          sidebarRight.openTab(TAB_KIND);
        }
      };
      const dispose = slots.inject(
        "conversation.session.header.utilities",
        () => slots.register({
          name: "conversation.session.header.utilities",
          id: "dsh-desktop-tauriapp:downloads-button",
          order: 20,
          // better-sidebar 开合钮 order=10，排其后
          registrant: "dsh-desktop-tauriapp"
        }, DownloadsHeaderButton)
      );
      if (typeof dispose === "function") return dispose;
    } catch {
    }
    return void 0;
  });
}

// src/client/bridge/download-intercept.ts
function interceptKind(href, hasDownloadAttr) {
  if (!hasDownloadAttr || href === null) return null;
  const trimmed = href.trim();
  if (trimmed === "") return null;
  if (/^blob:/i.test(trimmed) || /^data:/i.test(trimmed)) return "blob";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:/i.test(trimmed)) return null;
  return "url";
}
function filenameFromAnchor(downloadAttr, href) {
  const fromAttr = (downloadAttr ?? "").trim();
  if (fromAttr !== "") return fromAttr;
  if (/^data:/i.test(href)) return "download";
  try {
    const base = typeof location !== "undefined" ? location.href : void 0;
    const u = new URL(href, base);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ?? "download";
  } catch {
    return "download";
  }
}
var CHUNK_BYTES = 512 * 1024;
function base64Of(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const SEG = 32768;
  for (let i = 0; i < bytes.length; i += SEG) {
    bin += String.fromCharCode(...bytes.subarray(i, i + SEG));
  }
  return btoa(bin);
}
async function waitPathChosen(id, signal) {
  for (let i = 0; i < 600; i++) {
    if (signal.aborted) return false;
    try {
      const tasks = await shellRpc.invoke("list_downloads");
      const t = tasks.find((x) => x.id === id);
      if (t === void 0) return false;
      if (t.status === "downloading") return true;
      if (t.status !== "choosing_path") return false;
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
function installDownloadInterceptor() {
  if (!shellRpc.available()) return;
  if (window.__dshDownloadsIntercept === true) return;
  window.__dshDownloadsIntercept = true;
  document.addEventListener(
    "click",
    (ev) => {
      if (ev.defaultPrevented) return;
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (anchor === null) return;
      const href = anchor.getAttribute("href");
      const kind = interceptKind(href, anchor.hasAttribute("download"));
      if (kind === null) return;
      ev.preventDefault();
      ev.stopPropagation();
      const filename = filenameFromAnchor(anchor.getAttribute("download"), href ?? "");
      if (kind === "blob") {
        void transferBlobToShell(href ?? "", filename);
      } else {
        void transferUrlToShell(href ?? "", filename);
      }
    },
    true
  );
}
async function transferBlobToShell(href, filename) {
  try {
    const resp = await fetch(href);
    if (!resp.ok) throw new Error(`fetch ${href} -> ${resp.status}`);
    const blob = await resp.blob();
    const id = await shellRpc.invoke("start_blob_download", { filename, total: blob.size });
    if (id === null || id === void 0) return;
    const signal = { aborted: false };
    if (!await waitPathChosen(id, signal)) return;
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const chunk = blob.slice(offset, offset + CHUNK_BYTES);
      const b64 = base64Of(await chunk.arrayBuffer());
      const ok = await shellRpc.invoke("save_blob_chunk", { id, chunk: b64 });
      if (!ok) return;
    }
    await shellRpc.invoke("finish_blob_download", { id });
  } catch (err) {
    console.warn("[dsh-desktop] blob \u4E0B\u8F7D\u8F6C\u4EA4\u5931\u8D25\uFF1A", err);
  }
}
async function transferUrlToShell(href, filename) {
  try {
    const url = new URL(href, typeof location !== "undefined" ? location.href : void 0).href;
    await shellRpc.invoke("start_url_download", { url, filename });
  } catch (err) {
    console.warn("[dsh-desktop] URL \u4E0B\u8F7D\u8F6C\u4EA4\u5931\u8D25\uFF1A", err);
  }
}

// src/client/bridge/desktop-browser-bridge.ts
var mirrors = /* @__PURE__ */ new Map();
var openListeners = /* @__PURE__ */ new Map();
var rectSchedulers = /* @__PURE__ */ new Map();
var rectPollTimer;
function ensureRectPoll() {
  if (rectPollTimer !== void 0) return;
  rectPollTimer = window.setInterval(() => {
    for (const [lease, schedule] of rectSchedulers) {
      if (!mirrors.has(lease)) {
        rectSchedulers.delete(lease);
        continue;
      }
      schedule();
    }
  }, 400);
}
function mirrorOf(lease) {
  let m = mirrors.get(lease);
  if (!m) {
    m = {
      url: `about:blank#${lease}`,
      title: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      el: void 0,
      shown: false,
      overlayHidden: false,
      rectPending: false
    };
    mirrors.set(lease, m);
  }
  return m;
}
function makeEvent(type, props) {
  const ev = new Event(type);
  if (props) Object.assign(ev, props);
  return ev;
}
function applyPush(push) {
  const m = mirrors.get(push.lease);
  if (!m) return;
  m.url = push.url;
  m.title = push.title;
  m.loading = push.loading;
  m.canGoBack = push.canGoBack;
  m.canGoForward = push.canGoForward;
  const el = m.el;
  if (!el) return;
  switch (push.kind) {
    case "started":
      el.dispatchEvent(makeEvent("did-start-navigation", { isMainFrame: true }));
      el.dispatchEvent(makeEvent("did-start-loading"));
      break;
    case "finished":
      el.dispatchEvent(makeEvent("did-stop-loading"));
      el.dispatchEvent(makeEvent("did-navigate"));
      break;
    case "failed":
      el.dispatchEvent(makeEvent("did-stop-loading"));
      el.dispatchEvent(makeEvent("did-fail-load", { isMainFrame: true }));
      break;
    case "title":
      el.dispatchEvent(makeEvent("page-title-updated"));
      break;
    case "gone":
      el.dispatchEvent(makeEvent("render-process-gone"));
      break;
    default:
      break;
  }
}
function patchElement(el, lease, m) {
  const fireAndForget = (args) => {
    void invokeCommand("browser_guest_control", args).catch((e) => {
      console.error("[desktop-browser-bridge] browser_guest_control \u5931\u8D25", e);
    });
  };
  el.loadURL = (url) => invokeCommand("browser_guest_navigate", { lease, url }).then(
    () => void 0,
    (e) => {
      throw e;
    }
  );
  el.getURL = () => m.url;
  el.getTitle = () => m.title;
  el.isLoading = () => m.loading;
  el.canGoBack = () => m.canGoBack;
  el.canGoForward = () => m.canGoForward;
  el.goBack = () => fireAndForget({ lease, action: "back" });
  el.goForward = () => fireAndForget({ lease, action: "forward" });
  el.reload = () => fireAndForget({ lease, action: "reload" });
  el.clearHistory = () => {
  };
  el.stop = () => {
  };
}
function rectsIntersect(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
function isWebviewTag(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node;
  return el.tagName.toLowerCase() === "webview" && el.dataset?.sidebarBrowserFrame === "webview" && typeof el.getAttribute("name") === "string";
}
function installTagObserver() {
  const bind = (el) => {
    const lease = el.getAttribute("name");
    const m = mirrorOf(lease);
    if (m.el === el) return;
    m.el = el;
    patchElement(el, lease, m);
    const applyRect = () => {
      m.rectPending = false;
      const r = el.getBoundingClientRect();
      const rectVisible = r.width > 1 && r.height > 1;
      const shouldShow = rectVisible && !m.overlayHidden;
      if (rectVisible) {
        void invokeCommand("browser_guest_set_bounds", {
          lease,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height
        }).catch((error) => {
          console.warn(`[dsh-desktop-tauriapp] guest \u63A7\u5236\u5931\u8D25\uFF08set_bounds\uFF09\uFF1A${String(error)}`);
        });
      }
      if (shouldShow !== m.shown) {
        m.shown = shouldShow;
        void invokeCommand("browser_guest_set_visible", { lease, visible: shouldShow }).catch((error) => {
          console.warn(`[dsh-desktop-tauriapp] guest \u63A7\u5236\u5931\u8D25\uFF08set_visible\uFF09\uFF1A${String(error)}`);
        });
      }
    };
    const scheduleRect = () => {
      if (m.rectPending) return;
      m.rectPending = true;
      requestAnimationFrame(applyRect);
    };
    rectSchedulers.set(lease, scheduleRect);
    ensureRectPoll();
    const recomputeOverlay = () => {
      const el2 = m.el;
      if (!el2) return;
      let hidden = false;
      const r = el2.getBoundingClientRect();
      for (const dlg of document.querySelectorAll("[role=dialog]")) {
        const dr = dlg.getBoundingClientRect();
        if (dr.width > 0 && rectsIntersect(r, dr)) {
          hidden = true;
          break;
        }
      }
      m.overlayHidden = hidden;
      scheduleRect();
    };
    const ro = new ResizeObserver(scheduleRect);
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    window.addEventListener("resize", scheduleRect);
    const dialogMo = new MutationObserver(recomputeOverlay);
    dialogMo.observe(document.body, { childList: true, subtree: true });
    void invokeCommand("browser_guest_state", { lease }).then((snap) => {
      m.url = snap.url;
      m.title = snap.title;
      m.loading = snap.loading;
      m.canGoBack = snap.canGoBack;
      m.canGoForward = snap.canGoForward;
    }).catch((error) => {
      console.warn(`[dsh-desktop-tauriapp] guest \u63A7\u5236\u5931\u8D25\uFF08guest_state\uFF09\uFF1A${String(error)}`);
    }).finally(() => {
      scheduleRect();
      recomputeOverlay();
      el.dispatchEvent(makeEvent("dom-ready"));
    });
  };
  const mo = new MutationObserver((muts) => {
    for (const mu of muts) {
      for (const node of mu.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && isWebviewTag(node)) bind(node);
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}
function installDesktopBrowserBridge() {
  const g = globalThis;
  if (!g.dshDesktop || g.__dshShellBridgeImpl) return;
  const impl = {
    acquire(workspace) {
      const key = typeof workspace === "string" ? workspace : String(workspace ?? "");
      return invokeCommand("browser_guest_acquire", { workspaceKey: key }).then(
        (res) => {
          mirrorOf(res.lease);
          return res;
        }
      );
    },
    release(lease) {
      const m = mirrors.get(lease);
      if (m) {
        m.el = void 0;
        m.shown = false;
        mirrors.delete(lease);
      }
      openListeners.delete(lease);
      return invokeCommand("browser_guest_release", { lease }).then(
        () => void 0,
        (e) => {
          console.error("[desktop-browser-bridge] guest release \u5931\u8D25", e);
        }
      );
    },
    onOpenRequested(lease, listener) {
      openListeners.set(lease, listener);
      return () => {
        if (openListeners.get(lease) === listener) openListeners.delete(lease);
      };
    },
    _receive(push) {
      applyPush(push);
    },
    _openRequested(payload) {
      openListeners.get(payload.lease)?.(payload.url);
    }
  };
  g.__dshShellBridgeImpl = impl;
  installTagObserver();
  window.addEventListener("pagehide", () => {
    void invokeCommand("browser_guest_release_all").catch(() => {
    });
  });
}

// src/client/desktop-settings.tsx
var import_react19 = require("react");

// src/client/desktop-settings/use-panel-data.ts
var import_react2 = require("react");

// src/client/desktop-settings/loopback-aggregation.ts
var LOOPBACK_AGGREGATION_OPTIONS = [
  { value: "full", label: "\u5168\u5F00", detail: "\u5408\u5E76\u5E76\u53D1 GET\uFF0C\u5E76\u6574\u6761\u7F13\u51B2 \u2264256KB \u7684\u54CD\u5E94" },
  // 默认档＝壳侧 DEFAULT_LOOPBACK_AGGREGATION。面板不跨包 import 壳代码，两边各写一份字面量，
  // 所以改默认值必须两边同时改（test-client.mjs 会核对这里与 panel-data.ts 占位值都等于 stream）。
  { value: "stream", label: "\u53EA\u5173\u7F13\u51B2\uFF08\u9ED8\u8BA4\uFF09", detail: "\u4ECD\u5408\u5E76\uFF0C\u4F46\u54CD\u5E94\u8FB9\u5230\u8FB9\u4E0B\u53D1" },
  { value: "none", label: "\u5168\u5173", detail: "\u4E0D\u5408\u5E76\uFF0C\u6BCF\u4E2A\u8BF7\u6C42\u5404\u81EA\u6253\u5BBF\u4E3B" }
];
function loopbackAggregationMode(raw) {
  const hit = LOOPBACK_AGGREGATION_OPTIONS.find((o) => o.value === raw);
  return hit === void 0 ? "stream" : hit.value;
}

// src/client/desktop-settings/panel-data.ts
var PLACEHOLDER = {
  proxy: { proxy_mode: "off", proxy_url: "", no_proxy: "", proxy_user: "", proxy_pass: "" },
  proxyEffective: void 0,
  desktop: { remote_addr: null, remote_list: [], port: 3080, profiles: [] },
  // 壳首回话前的占位值；真实档位随后从 get_desktop_settings_data 回来。回退档＝壳侧 DEFAULT_LOOPBACK_AGGREGATION（stream）。
  loopbackAggregation: "stream",
  forwarderInput: "",
  profilePortInputs: {},
  profileLaneInputs: {},
  profilePageInputs: {},
  migrationSource: "",
  migrationDest: ""
};
function buildSnapshot(ns, p, d) {
  return {
    proxy: {
      proxy_mode: ns.proxy_mode || p.proxy_mode || "off",
      proxy_url: ns.proxy_url || p.proxy_url || "",
      no_proxy: ns.no_proxy || p.no_proxy || "",
      proxy_user: ns.proxy_user || p.proxy_user || "",
      proxy_pass: ns.proxy_pass || p.proxy_pass || ""
    },
    proxyEffective: p.effective,
    // #128：聚合档位从壳回吐的设置快照读（老设置文件没这个键 = undefined ⇒ loopbackAggregationMode 回默认）。
    loopbackAggregation: loopbackAggregationMode(ns.loopback_aggregation),
    // 以 **壳返回的完整对象为基底**，只覆盖三个以 ns 优先的展示字段。
    desktop: {
      ...d,
      remote_addr: ns.remote_addr ?? d.remote_addr ?? null,
      remote_list: ns.remote_list ?? d.remote_list ?? [],
      port: ns.port || d.port || 3080,
      mux_heartbeat_ms: d.mux_heartbeat_ms ?? null,
      desktop_layout_on_phones: d.desktop_layout_on_phones ?? null,
      prevent_sleep: d.prevent_sleep ?? null,
      keep_awake: d.keep_awake ?? null
    },
    forwarderInput: typeof ns.lane_forwarder_port === "number" && ns.lane_forwarder_port > 0 ? String(ns.lane_forwarder_port) : "",
    ...savedPortInputs(ns),
    ...migrationSelectDefaults(d)
  };
}
function createPanelData(deps = {}) {
  const io = {
    nsGet: deps.nsGet ?? nsGet,
    getProxySettings: deps.getProxySettings ?? (() => invokeCommand("get_proxy_settings")),
    getDesktopData: deps.getDesktopData ?? (() => invokeCommand("get_desktop_settings_data")),
    taskStatus: deps.taskStatus ?? (() => invokeCommand("task_status")),
    save: deps.save ?? nsSave
  };
  const pollMs = deps.pollMs ?? 600;
  const setIntervalImpl = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl = deps.clearIntervalImpl ?? ((handle) => clearInterval(handle));
  let state = { snapshot: PLACEHOLDER, loaded: null, task: null };
  const listeners = /* @__PURE__ */ new Set();
  let loadPromise = null;
  let pollHandle = null;
  let disposed = false;
  function setState(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function loadAll(onError) {
    if (loadPromise !== null) return loadPromise;
    loadPromise = (async () => {
      try {
        const [ns, proxy, desktop] = await Promise.all([
          io.nsGet(),
          io.getProxySettings(),
          io.getDesktopData()
        ]);
        if (disposed) return;
        const snapshot = buildSnapshot(ns, proxy, desktop);
        setState({ snapshot, loaded: snapshot });
      } catch (err) {
        if (disposed) return;
        onError?.(`\u8BFB\u53D6\u8BBE\u7F6E\u5931\u8D25\uFF1A${String(err)}`);
      }
    })();
    return loadPromise;
  }
  async function refreshDesktop() {
    try {
      const desktop = await io.getDesktopData();
      if (disposed) return;
      setState({ snapshot: { ...state.snapshot, desktop } });
    } catch {
    }
  }
  function startTaskPolling() {
    if (pollHandle !== null || disposed) return;
    pollHandle = setIntervalImpl(() => {
      void io.taskStatus().then((t) => {
        if (disposed) return;
        if (t.running || t.finished) setState({ task: t });
      }).catch(() => {
      });
    }, pollMs);
  }
  function stopTaskPolling() {
    if (pollHandle === null) return;
    clearIntervalImpl(pollHandle);
    pollHandle = null;
  }
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadAll,
    refreshDesktop,
    save: (patch) => io.save(patch),
    startTaskPolling,
    stopTaskPolling,
    dispose() {
      disposed = true;
      stopTaskPolling();
      listeners.clear();
    }
  };
}
function savedPortInputs(ns) {
  const saved = (key) => {
    const raw = ns[key];
    const out = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, n] of Object.entries(raw)) {
        if (typeof n === "number" && n > 0) out[k] = String(n);
      }
    }
    return out;
  };
  return {
    profilePortInputs: saved("profile_ports"),
    profileLaneInputs: saved("profile_lane_ports"),
    profilePageInputs: saved("profile_page_ports")
  };
}
function migrationSelectDefaults(d) {
  if (d.profiles.length === 0) return { migrationSource: "", migrationDest: "" };
  const first = d.profiles[0];
  if (!first) return { migrationSource: "", migrationDest: "" };
  const other = d.profiles.find((pp) => pp.name !== first.name);
  return { migrationSource: first.name, migrationDest: other ? other.name : "" };
}

// src/client/desktop-settings/use-panel-data.ts
function usePanelData(onLoadError) {
  const panel = (0, import_react2.useMemo)(() => createPanelData(), []);
  const state = (0, import_react2.useSyncExternalStore)(panel.subscribe, panel.getState);
  const onErrorRef = (0, import_react2.useRef)(onLoadError);
  onErrorRef.current = onLoadError;
  (0, import_react2.useEffect)(() => {
    void panel.loadAll((text) => onErrorRef.current(text));
    panel.startTaskPolling();
    return () => {
      panel.stopTaskPolling();
      panel.dispose();
    };
  }, [panel]);
  return { data: state.snapshot, loaded: state.loaded, taskInfo: state.task, refreshData: panel.refreshDesktop };
}

// src/client/desktop-settings/startup-flow.ts
function startupDialogModel(res) {
  if (!res || res.action === "none") return { kind: "none" };
  if (res.action === "profile-selection") return { kind: "select", profiles: res.profiles ?? [] };
  const profile = res.profile ?? "";
  if (!profile) return { kind: "none" };
  const details = res.details;
  const missingDesc = details ? [
    ...details.missing_files,
    ...details.node_modules_exists ? [] : ["node_modules"],
    ...details.dir_exists ? [] : ["profile \u76EE\u5F55"]
  ].join(", ") : "";
  return { kind: "incomplete", profile, missingDesc };
}
function mountStartupDialog(model, hooks) {
  if (model.kind === "none") return;
  if (model.kind === "select") {
    const el2 = document.createElement("div");
    el2.style.cssText = "position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)";
    const card2 = document.createElement("div");
    card2.style.cssText = "background:var(--dsw-alias-bg-base,#16181d);border:1px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:12px;padding:24px;min-width:320px;max-width:400px";
    const title2 = document.createElement("div");
    title2.style.cssText = "font-size:15px;font-weight:600;margin-bottom:16px;color:var(--dsw-alias-label-primary,#e7eaf0)";
    title2.textContent = "\u9009\u62E9\u8981\u542F\u52A8\u7684 Profile";
    card2.appendChild(title2);
    const list = document.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;gap:8px";
    for (const p of model.profiles) {
      const btn = document.createElement("button");
      btn.style.cssText = "padding:10px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);background:transparent;color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;cursor:pointer;text-align:left";
      btn.textContent = p;
      btn.onmouseenter = () => btn.style.background = "var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))";
      btn.onmouseleave = () => btn.style.background = "transparent";
      btn.onclick = () => {
        el2.remove();
        hooks.onSelectProfile(p);
      };
      list.appendChild(btn);
    }
    const input = document.createElement("input");
    input.style.cssText = "margin-top:12px;padding:8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);background:var(--dsw-alias-bg-base,#151517);color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;width:100%;box-sizing:border-box";
    input.placeholder = "\u6216\u8F93\u5165\u65B0 profile \u540D\u79F0";
    const startBtn = document.createElement("button");
    startBtn.style.cssText = "margin-top:8px;padding:8px 14px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary-new-color,#4176e6);color:#fff;font-size:13px;cursor:pointer;width:100%";
    startBtn.textContent = "\u65B0\u5EFA\u5E76\u542F\u52A8";
    startBtn.onclick = () => {
      const name = input.value.trim();
      if (!name) return;
      el2.remove();
      hooks.onCreateProfile(name);
    };
    card2.appendChild(list);
    card2.appendChild(input);
    card2.appendChild(startBtn);
    el2.appendChild(card2);
    document.body.appendChild(el2);
    return;
  }
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)";
  const card = document.createElement("div");
  card.style.cssText = "background:var(--dsw-alias-bg-base,#16181d);border:1px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:12px;padding:24px;min-width:340px;max-width:420px;text-align:center";
  const title = document.createElement("div");
  title.style.cssText = "font-size:15px;font-weight:600;margin-bottom:8px;color:var(--dsw-alias-label-primary,#e7eaf0)";
  title.textContent = `Profile\u300C${model.profile}\u300D\u4E0D\u5B8C\u6574`;
  const desc = document.createElement("div");
  desc.style.cssText = "font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-bottom:20px";
  desc.textContent = `\u7F3A\u5931\uFF1A${model.missingDesc}\u3002\u662F\u5426\u4FEE\u590D\uFF1F`;
  const btns = document.createElement("div");
  btns.style.cssText = "display:flex;gap:10px";
  const noBtn = document.createElement("button");
  noBtn.style.cssText = "flex:1;padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);background:transparent;color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;cursor:pointer";
  noBtn.textContent = "\u76F4\u63A5\u542F\u52A8";
  noBtn.onclick = () => {
    el.remove();
    hooks.onStartProfile(model.profile);
  };
  const yesBtn = document.createElement("button");
  yesBtn.style.cssText = "flex:1;padding:10px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary-new-color,#4176e6);color:#fff;font-size:13px;cursor:pointer";
  yesBtn.textContent = "\u4FEE\u590D\u5E76\u542F\u52A8";
  yesBtn.onclick = () => {
    el.remove();
    hooks.onRepairProfile(model.profile);
  };
  btns.appendChild(noBtn);
  btns.appendChild(yesBtn);
  card.appendChild(title);
  card.appendChild(desc);
  card.appendChild(btns);
  el.appendChild(card);
  document.body.appendChild(el);
}
function runStartupFlow(res, notify) {
  const model = startupDialogModel(res);
  mountStartupDialog(model, {
    onSelectProfile: (p) => {
      notify(`\u6B63\u5728\u542F\u52A8 ${p} profile\u2026`, true);
      void invokeCommand("confirm_startup_profile", { name: p, repair: false }).catch((e) => notify(`\u542F\u52A8\u5931\u8D25\uFF1A${String(e)}`, false));
    },
    onCreateProfile: (name) => {
      notify(`\u6B63\u5728\u521B\u5EFA\u5E76\u542F\u52A8 ${name} profile\u2026`, true);
      void invokeCommand("confirm_startup_profile", { name, repair: true }).catch((e) => notify(`\u521B\u5EFA\u5931\u8D25\uFF1A${String(e)}`, false));
    },
    onStartProfile: (profile) => {
      void invokeCommand("confirm_startup_profile", { name: profile, repair: false }).catch((e) => notify(`\u542F\u52A8\u5931\u8D25\uFF1A${String(e)}`, false));
    },
    onRepairProfile: (profile) => {
      notify(`\u6B63\u5728\u4FEE\u590D ${profile} profile\u2026`, true);
      void invokeCommand("confirm_startup_profile", { name: profile, repair: true }).catch((e) => notify(`\u4FEE\u590D\u5931\u8D25\uFF1A${String(e)}`, false));
    }
  });
}

// src/client/shell/devtools-toggle.ts
function planDevToolsUi(current, next) {
  if (current === next) return { action: "idle" };
  return { action: next ? "confirm-on" : "confirm-off" };
}
function devToolsConfirmCopy() {
  return {
    title: "\u5F00\u542F\u5F00\u53D1\u8005\u5DE5\u5177\uFF1F",
    lines: [
      "\u5F00\u542F\u540E\uFF0C\u684C\u9762\u58F3\u4F1A\u5728\u672C\u673A\u56DE\u73AF\u5730\u5740\u76D1\u542C\u4E00\u4E2A\u8FDC\u7A0B\u8C03\u8BD5\u53E3\uFF1BWindows \u4E0B\u6309 F12 \u6216\u53F3\u952E\u83DC\u5355\u300C\u6253\u5F00 DevTools\u300D\u6253\u5F00\uFF08\u4E0E\u7269\u7406\u6309\u952E\u540C\u8DEF\u5F84\uFF09\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u5F39\u7A97\u3002",
      "\u672C\u673A\u4E0A\u7684\u4EFB\u4F55\u7A0B\u5E8F\u90FD\u80FD\u501F\u8FD9\u4E2A\u53E3\u5728\u9875\u9762\u91CC\u6267\u884C\u4EFB\u610F\u4EE3\u7801\u3001\u8BFB\u53D6\u4F1A\u8BDD\u5185\u5BB9\uFF08\u542B\u767B\u5F55\u51ED\u636E\uFF09\u3002",
      "\u53EA\u5728\u81EA\u5DF1\u9700\u8981\u6392\u67E5\u95EE\u9898\u65F6\u5F00\u542F\uFF1B\u7528\u5B8C\u5728\u8BBE\u7F6E\u91CC\u5173\u6389\u3002"
    ],
    confirm: "\u786E\u8BA4\u5F00\u542F\u5E76\u91CD\u542F",
    cancel: "\u53D6\u6D88"
  };
}
function devToolsDisableCopy() {
  return {
    title: "\u5173\u95ED\u5F00\u53D1\u8005\u5DE5\u5177\uFF1F",
    lines: [
      "\u786E\u8BA4\u540E\u684C\u9762\u58F3\u5C06\u91CD\u542F\uFF1A\u8FDC\u7A0B\u8C03\u8BD5\u53E3\u5173\u95ED\u3001\u53F3\u952E DevTools \u5165\u53E3\u6D88\u5931\u3002",
      "\u91CD\u542F\u671F\u95F4\u5E94\u7528\u4F1A\u77ED\u6682\u9000\u51FA\u518D\u8D77\u6765\uFF0C\u9875\u9762\u77ED\u6682\u4E2D\u65AD\uFF1B\u6258\u76D8\u4F1A\u8DDF\u7740\u6D88\u5931\u51E0\u79D2\u3002"
    ],
    confirm: "\u786E\u8BA4\u5173\u95ED\u5E76\u91CD\u542F",
    cancel: "\u53D6\u6D88"
  };
}
function devToolsSavedNote(on, outcome) {
  if (outcome !== void 0 && outcome !== null && !outcome.ok) {
    return `\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\uFF0C\u4F46\u684C\u9762\u58F3\u6CA1\u80FD\u81EA\u52A8\u91CD\u542F\uFF1A${outcome.message ?? outcome.reason ?? "\u672A\u77E5\u539F\u56E0"}\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\uFF0C\u8C03\u8BD5\u53E3\u8981\u7B49\u624B\u52A8\u91CD\u542F\u684C\u9762\u58F3\u540E\u624D\u751F\u6548\u3002`;
  }
  return on ? "\u5DF2\u5F00\u542F\uFF1A\u6B63\u5728\u91CD\u542F\u684C\u9762\u58F3\uFF0C\u91CD\u542F\u540E\u8C03\u8BD5\u53E3\u4E0E\u53F3\u952E DevTools \u5165\u53E3\u751F\u6548\u3002" : "\u5DF2\u5173\u95ED\uFF1A\u6B63\u5728\u91CD\u542F\u684C\u9762\u58F3\uFF0C\u91CD\u542F\u540E\u8C03\u8BD5\u53E3\u5173\u95ED\u3001\u83DC\u5355\u6D88\u5931\u3002";
}

// src/client/desktop-settings/styles.ts
var PANEL_CSS = `
[data-desktop-settings] .pf-btn { background:var(--dsw-alias-brand-primary-new-color,#4176e6); border:none; color:#fff; border-radius:8px; padding:6px 13px; font-size:12px; cursor:pointer; transition:filter .12s, transform .06s; }
[data-desktop-settings] .pf-btn:hover { filter:brightness(1.12); }
[data-desktop-settings] .pf-btn:active { transform:translateY(1px); }
[data-desktop-settings] .pf-btn.ghost { background:transparent; border:1px solid var(--dsw-alias-border-l2,#ffffff1f); color:var(--dsw-alias-label-primary,#e7eaf0); }
[data-desktop-settings] .pf-btn.ghost:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); filter:none; }
[data-desktop-settings] .pf-btn.ghost:active { background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.12)); transform:translateY(1px); filter:none; }
[data-desktop-settings] .pf-btn.danger { background:transparent; border:1px solid var(--dsw-alias-state-danger-primary,#e5534b); color:var(--dsw-alias-state-danger-primary,#e5534b); }
[data-desktop-settings] .pf-btn.danger:hover { background:rgba(229,83,75,.12); filter:none; }
[data-desktop-settings] .pf-btn:disabled { opacity:.5; cursor:not-allowed; }
[data-desktop-settings] input, [data-desktop-settings] select { padding:6px 8px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2,#ffffff1f); background:var(--dsw-alias-bg-base,#151517); color:inherit; font-size:12px; }
[data-desktop-settings] .pf-label { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); margin-bottom:4px; }
[data-desktop-settings] .pf-input { width:100%; box-sizing:border-box; }
[data-desktop-settings] .pf-title { font-weight:600; font-size:13px; margin-bottom:10px; }
[data-desktop-settings] .pf-row { display:flex; gap:8px; align-items:center; }
[data-desktop-settings] .pf-note { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); margin-top:8px; word-break:break-all; }
`;
var stylesInstalled = false;
function ensureStyles() {
  if (stylesInstalled) return;
  stylesInstalled = true;
  const style = document.createElement("style");
  style.dataset.desktopSettings = "styles";
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
}
var ROOT_STYLE = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  maxWidth: 680,
  fontSize: 13
};
var SECTION_STYLE = {
  border: "1px solid var(--dsw-alias-border-l2,#ffffff1f)",
  borderRadius: 12,
  padding: "14px 16px"
};
var TITLE_STYLE = {
  fontWeight: 600,
  fontSize: 13,
  marginBottom: 10
};
var LABEL_STYLE = {
  fontSize: 11,
  color: "var(--dsw-alias-label-secondary,#9aa4b2)",
  marginBottom: 4
};
var NOTE_STYLE = {
  fontSize: 11,
  color: "var(--dsw-alias-label-secondary,#9aa4b2)",
  marginTop: 8,
  wordBreak: "break-all"
};
var INPUT_BASE_STYLE = {
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid var(--dsw-alias-border-l2,#ffffff1f)",
  background: "var(--dsw-alias-bg-base,#151517)",
  color: "inherit",
  fontSize: 12
};
var INPUT_FULL_STYLE = { ...INPUT_BASE_STYLE, width: "100%", boxSizing: "border-box" };
var ROW_STYLE = { display: "flex", gap: 8, alignItems: "center" };
var RADIO_ROW_STYLE = { display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 0", cursor: "pointer" };
var RADIO_TEXT_STYLE = { fontSize: 12.5, lineHeight: 1.5, color: "var(--dsw-alias-label-primary,#e7eaf0)" };
var FLEX_1_STYLE = { flex: 1 };
var DEV_TOOLS_OVERLAY_STYLE = {
  position: "fixed",
  inset: 0,
  zIndex: 2147483e3,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center"
};
var DEV_TOOLS_MODAL_STYLE = {
  background: "var(--dsw-alias-bg-layer-1,#1e1e1e)",
  border: "1px solid var(--dsw-alias-border-l2,#444)",
  borderRadius: 12,
  padding: "18px 20px",
  minWidth: 320,
  maxWidth: "80vw",
  boxShadow: "0 12px 40px rgba(0,0,0,.4)",
  color: "var(--dsw-alias-label-primary,#eee)"
};
var DEV_TOOLS_TITLE_STYLE = { fontSize: 14, fontWeight: 600, marginBottom: 10 };
var DEV_TOOLS_BODY_STYLE = { fontSize: 12.5, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary,#bbb)" };
var DEV_TOOLS_ACTIONS_STYLE = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 };
var DEV_TOOLS_CONFIRM = devToolsConfirmCopy();
var DEV_TOOLS_DISABLE = devToolsDisableCopy();
var BTN_PRIMARY_STYLE = {
  background: "var(--dsw-alias-brand-primary-new-color,#4176e6)",
  border: "none",
  color: "#fff",
  borderRadius: 8,
  padding: "6px 13px",
  fontSize: 12,
  cursor: "pointer"
};
var BTN_GHOST_STYLE = {
  ...BTN_PRIMARY_STYLE,
  background: "transparent",
  border: "1px solid var(--dsw-alias-border-l2,#ffffff1f)",
  color: "var(--dsw-alias-label-primary,#e7eaf0)"
};
var BTN_DANGER_STYLE = {
  ...BTN_PRIMARY_STYLE,
  background: "transparent",
  border: "1px solid var(--dsw-alias-state-danger-primary,#e5534b)",
  color: "var(--dsw-alias-state-danger-primary,#e5534b)"
};
var DANGER_NOTE_STYLE = {
  ...NOTE_STYLE,
  color: "var(--dsw-alias-state-danger-primary,#e5534b)"
};
var WARN_NOTE_STYLE = {
  ...NOTE_STYLE,
  color: "var(--dsw-alias-state-warn,#e8a33d)"
};

// src/client/desktop-settings/chrome.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
function SectionBox({ title, children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: SECTION_STYLE, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: TITLE_STYLE, children: title }),
    children
  ] });
}
function PfBtn({
  variant = "primary",
  disabled = false,
  onClick,
  children,
  style,
  title,
  testId
}) {
  const baseStyle = variant === "primary" ? BTN_PRIMARY_STYLE : variant === "ghost" ? BTN_GHOST_STYLE : BTN_DANGER_STYLE;
  const cls = variant === "primary" ? "pf-btn" : `pf-btn ${variant}`;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    "button",
    {
      type: "button",
      className: cls,
      disabled,
      title,
      onClick,
      "data-desktop-settings": testId,
      style: { ...baseStyle, ...style ?? {} },
      children
    }
  );
}
function PortCell({
  testId,
  placeholder,
  value,
  onChange,
  onEnter,
  onSave
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "input",
      {
        placeholder,
        style: { ...INPUT_BASE_STYLE, width: 84 },
        "data-desktop-settings": testId,
        value,
        onChange: (e) => onChange(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter") onEnter();
        }
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(PfBtn, { variant: "ghost", style: { marginLeft: 6 }, onClick: onSave, children: "\u4FDD\u5B58" })
  ] });
}
function showToast(text, ok, tone = ok ? "ok" : "error") {
  const palette = tone === "info" ? "background:rgba(96,165,250,.15);border:1px solid rgba(96,165,250,.6);color:#93c5fd" : tone === "ok" ? "background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.6);color:#4ade80" : "background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.6);color:#f87171";
  const el = document.createElement("div");
  el.style.cssText = `position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:500;max-width:480px;box-shadow:0 4px 12px rgba(0,0,0,.4);cursor:pointer;backdrop-filter:blur(8px);${palette}`;
  el.textContent = text;
  el.addEventListener("click", () => el.remove());
  document.body.appendChild(el);
  if (ok) window.setTimeout(() => el.remove(), 5e3);
}

// src/client/desktop-settings/cards/dependencies-card.tsx
var import_react3 = __toESM(require("react"), 1);
var import_jsx_runtime3 = require("react/jsx-runtime");
function DependenciesCard() {
  const [depProfiles, setDepProfiles] = (0, import_react3.useState)(null);
  const [depRebuilding, setDepRebuilding] = (0, import_react3.useState)(null);
  const [depNote, setDepNote] = (0, import_react3.useState)("");
  const [depError, setDepError] = (0, import_react3.useState)(null);
  const refreshDepStatus = (0, import_react3.useCallback)(async () => {
    try {
      const r = await invoke("list_profile_dependency_status");
      setDepProfiles(r?.profiles ?? []);
    } catch (err) {
      console.error("[desktop-settings] list_profile_dependency_status \u5931\u8D25\uFF1A", err);
      setDepError(String(err));
      setDepProfiles(null);
    }
  }, []);
  import_react3.default.useEffect(() => {
    void refreshDepStatus();
  }, [refreshDepStatus]);
  const handleRebuildDeps = (profile) => {
    if (depRebuilding) return;
    setDepRebuilding(profile);
    setDepNote(`${profile}\uFF1A\u4F9D\u8D56\u91CD\u5EFA\u4E2D\uFF08\u7528\u5185\u7F6E pnpm \u91CD\u88C5\uFF0C\u53EF\u80FD\u9700\u8981\u51E0\u5206\u949F\uFF09\u2026`);
    void invoke("rebuild_profile_dependencies", { profile }).then(() => {
      setDepNote(`${profile}\uFF1A\u4F9D\u8D56\u5DF2\u91CD\u5EFA\uFF0C\u91CD\u542F\u8BE5 profile \u540E\u751F\u6548\u3002`);
      return refreshDepStatus();
    }).catch((err) => setDepNote(`${profile}\uFF1A\u91CD\u5EFA\u5931\u8D25 \u2014\u2014 ${String(err)}`)).finally(() => setDepRebuilding(null));
  };
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(SectionBox, { title: "\u4F9D\u8D56\u72B6\u6001\uFF08pnpm store \u4E00\u81F4\u6027\uFF09", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: LABEL_STYLE, children: "dsh \u7684\u63D2\u4EF6\u5B89\u88C5/\u5378\u8F7D\u7531\u5185\u7F6E pnpm \u6267\u884C\uFF1Bprofile \u7684 node_modules \u82E5\u7531\u5176\u5B83 pnpm \u7248\u672C\u88C5\u8FC7\uFF0C store \u5927\u7248\u672C\u4E0D\u4E00\u81F4\u4F1A\u62A5 ERR_PNPM_UNEXPECTED_STORE\u3002\u6B64\u5904\u53EF\u67E5\u770B\u5E76\u91CD\u5EFA\u3002" }),
    depProfiles === null ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: NOTE_STYLE, children: [
      "\u8BFB\u53D6\u5931\u8D25\uFF1A",
      depError ?? "\u672A\u77E5\u539F\u56E0"
    ] }) : depProfiles.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: "\u672A\u53D1\u73B0 profile" }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("table", { style: { width: "100%", fontSize: 12, borderCollapse: "collapse" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("tr", { style: { textAlign: "left", opacity: 0.75 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { style: { padding: "4px 6px" }, children: "Profile" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { style: { padding: "4px 6px" }, children: "\u4F9D\u8D56\u7531 pnpm" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { style: { padding: "4px 6px" }, children: "\u5185\u7F6E pnpm" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { style: { padding: "4px 6px" }, children: "\u72B6\u6001" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { style: { padding: "4px 6px" } })
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("tbody", { children: depProfiles.map((p) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("tr", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { style: { padding: "4px 6px" }, children: p.profile }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { style: { padding: "4px 6px", opacity: 0.85 }, children: p.recordedPnpm ?? "\u672A\u77E5" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { style: { padding: "4px 6px", opacity: 0.85 }, children: p.builtinPnpm ?? "\u672A\u77E5" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { style: { padding: "4px 6px" }, children: !p.needsRebuild ? "\u4E00\u81F4" : p.running ? "\u9700\u91CD\u5EFA\uFF08\u8FD0\u884C\u4E2D\uFF09" : "\u9700\u91CD\u5EFA" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { style: { padding: "4px 6px" }, children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          PfBtn,
          {
            variant: "ghost",
            disabled: !p.needsRebuild || p.running || depRebuilding !== null,
            title: p.running ? "\u8BE5 profile \u6B63\u5728\u8FD0\u884C\uFF1A\u5148\u505C\u6B62\u518D\u91CD\u5EFA" : p.needsRebuild ? "\u7528\u5185\u7F6E pnpm \u91CD\u5EFA\u4F9D\u8D56\uFF08\u8FC1\u79FB store \u5927\u7248\u672C\uFF09" : "\u65E0\u9700\u91CD\u5EFA",
            onClick: () => handleRebuildDeps(p.profile),
            children: depRebuilding === p.profile ? "\u91CD\u5EFA\u4E2D\u2026" : "\u91CD\u5EFA"
          }
        ) })
      ] }, p.profile)) })
    ] }),
    depNote ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: depNote }) : null
  ] });
}

// src/client/desktop-settings/cards/devtools-card.tsx
var import_react4 = require("react");
var import_jsx_runtime4 = require("react/jsx-runtime");
function DevToolsCard({ desktop }) {
  const [devToolsConfirmKind, setDevToolsConfirmKind] = (0, import_react4.useState)(null);
  const [devTools, setDevTools] = (0, import_react4.useState)(false);
  const [devToolsNote, setDevToolsNote] = (0, import_react4.useState)(null);
  (0, import_react4.useEffect)(() => {
    setDevTools(desktop.dev_tools === true);
  }, [desktop]);
  const handleToggleDevTools = (next) => {
    const plan = planDevToolsUi(devTools, next);
    if (plan.action === "idle") return;
    setDevToolsConfirmKind(plan.action === "confirm-on" ? "on" : "off");
  };
  const saveDevToolsSetting = (on) => {
    setDevToolsConfirmKind(null);
    setDevTools(on);
    void nsSave({ dev_tools: on }).then(() => invoke("restart_desktop_app")).then((outcome) => setDevToolsNote(devToolsSavedNote(on, outcome))).catch((e) => {
      if (/failed to fetch|network ?error|load failed|fetch failed|terminated/i.test(String(e))) {
        setDevToolsNote(devToolsSavedNote(on));
        return;
      }
      setDevToolsNote(`\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\uFF0C\u4F46\u91CD\u542F\u684C\u9762\u5E94\u7528\u5931\u8D25\uFF1A${String(e)}`);
    });
  };
  (0, import_react4.useEffect)(() => {
    if (devToolsConfirmKind === null) return;
    const onKey = (e) => {
      if (e.key === "Escape") setDevToolsConfirmKind(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [devToolsConfirmKind]);
  const devToolsActiveConfirm = devToolsConfirmKind === "off" ? DEV_TOOLS_DISABLE : DEV_TOOLS_CONFIRM;
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(SectionBox, { title: "\u5F00\u53D1\u8005\u5DE5\u5177", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: ROW_STYLE, children: /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "input",
        {
          type: "checkbox",
          "data-desktop-settings": "dev-tools",
          checked: devTools,
          onChange: (e) => handleToggleDevTools(e.target.checked)
        }
      ),
      "\u5141\u8BB8\u6253\u5F00 DevTools\uFF08\u6253\u5305\u6001\u9ED8\u8BA4\u5173\uFF1B\u6539\u52A8\u91CD\u542F\u684C\u9762\u58F3\u751F\u6548\uFF09"
    ] }) }),
    devToolsNote && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: NOTE_STYLE, children: devToolsNote }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: NOTE_STYLE, children: "\u5F00\u542F\u540E\u684C\u9762\u58F3\u5728\u672C\u673A\u56DE\u73AF\u5730\u5740\u76D1\u542C\u4E00\u4E2A\u8FDC\u7A0B\u8C03\u8BD5\u53E3\uFF0C\u672C\u673A\u4EFB\u610F\u7A0B\u5E8F\u53EF\u501F\u5B83\u5728\u9875\u9762\u91CC\u6267\u884C\u4EE3\u7801\u3002\u53EA\u5728\u81EA\u5DF1\u6392\u67E5\u95EE\u9898\u65F6\u5F00\u542F\uFF0C\u7528\u5B8C\u8BB0\u5F97\u5173\u6389\u5E76\u91CD\u542F\u3002 Windows \u4E0B\u6309 F12 \u6216\u53F3\u952E\u83DC\u5355\u300C\u6253\u5F00 DevTools\u300D\u6253\u5F00\uFF08\u4E0D\u81EA\u52A8\u5F39\u7A97\uFF09\uFF1Bmac/Linux \u4E3A\u300C\u6253\u5F00 DevTools\u300D\u3002" }),
    devToolsConfirmKind !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: DEV_TOOLS_OVERLAY_STYLE, children: /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { style: DEV_TOOLS_MODAL_STYLE, "data-desktop-settings": "dev-tools-confirm", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: DEV_TOOLS_TITLE_STYLE, children: devToolsActiveConfirm.title }),
      devToolsActiveConfirm.lines.map((line) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: DEV_TOOLS_BODY_STYLE, children: line }, line)),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { style: DEV_TOOLS_ACTIONS_STYLE, children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(PfBtn, { variant: "ghost", onClick: () => setDevToolsConfirmKind(null), children: devToolsActiveConfirm.cancel }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(PfBtn, { variant: "primary", onClick: () => saveDevToolsSetting(devToolsConfirmKind === "on"), children: devToolsActiveConfirm.confirm })
      ] })
    ] }) })
  ] });
}

// src/client/desktop-settings/cards/diagnostics-card.tsx
var import_react7 = require("react");

// src/client/desktop-settings/cards/logging-controls.tsx
var import_react6 = require("react");

// src/client/ui/theme-select.tsx
var import_react5 = require("react");
var import_jsx_runtime5 = require("react/jsx-runtime");
var TRIGGER_STYLE = {
  minWidth: 0,
  width: "100%",
  height: 28,
  color: "var(--dsw-alias-label-secondary)",
  cursor: "pointer",
  background: "transparent",
  border: "none",
  borderRadius: 24,
  outline: "none",
  alignItems: "center",
  gap: 4,
  padding: "0 4px 0 8px",
  fontSize: 13,
  fontWeight: 500,
  lineHeight: "20px",
  display: "flex"
};
var MENU_STYLE = {
  zIndex: 1100,
  background: "var(--dsw-specific-menu)",
  boxShadow: "var(--dsw-elevation-prominent)",
  color: "var(--dsw-alias-label-primary)",
  minWidth: "min(240px, 100%)",
  maxHeight: "min(360px, 60vh)",
  borderRadius: 20,
  padding: 4,
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  right: 0,
  overflowY: "auto",
  overflowX: "hidden"
};
var OPTION_BASE = {
  boxSizing: "border-box",
  width: "100%",
  minHeight: 38,
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
  background: "transparent",
  border: "none",
  borderRadius: 10,
  outline: "none",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  display: "flex",
  fontSize: 13
};
function ThemeSelect({ value, options, onChange, placeholder, style, disabled }) {
  const [open, setOpen] = (0, import_react5.useState)(false);
  const rootRef = (0, import_react5.useRef)(null);
  const listRef = (0, import_react5.useRef)(null);
  (0, import_react5.useEffect)(() => {
    if (!open) return;
    const onDown = (ev) => {
      if (rootRef.current && !rootRef.current.contains(ev.target)) setOpen(false);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  (0, import_react5.useEffect)(() => {
    if (!open || !listRef.current) return;
    const sel = listRef.current.querySelector('[data-selected="1"]');
    sel?.scrollIntoView({ block: "nearest" });
  }, [open]);
  const pick = (0, import_react5.useCallback)(
    (v) => {
      setOpen(false);
      if (v !== value) onChange(v);
    },
    [onChange, value]
  );
  const onMenuKey = (0, import_react5.useCallback)(
    (ev) => {
      const idx = options.findIndex((o) => o.value === value);
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        const next = options[Math.min(idx + 1, options.length - 1)];
        if (next) onChange(next.value);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        const next = options[Math.max(idx - 1, 0)];
        if (next) onChange(next.value);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (value) onChange(value);
      }
    },
    [options, onChange, value]
  );
  const current = options.find((o) => o.value === value);
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { ref: rootRef, style: { minWidth: 0, position: "relative", ...style ?? {} }, onKeyDown: onMenuKey, children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
      "button",
      {
        type: "button",
        "data-theme-select-trigger": "1",
        disabled,
        onClick: () => setOpen((v) => !v),
        style: { ...TRIGGER_STYLE, opacity: disabled ? 0.5 : 1 },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
            "span",
            {
              style: {
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
                overflow: "hidden",
                flex: 1,
                textAlign: "left"
              },
              children: current?.label ?? placeholder ?? ""
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
            "span",
            {
              style: {
                color: "var(--dsw-alias-label-caption)",
                flex: "none",
                transition: "transform .12s",
                transform: open ? "rotate(180deg)" : void 0
              },
              children: "\u25BE"
            }
          )
        ]
      }
    ),
    open && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { ref: listRef, style: MENU_STYLE, role: "listbox", children: [
      options.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { style: { color: "var(--dsw-alias-label-tertiary)", padding: 10, fontSize: 13, lineHeight: "20px" }, children: "\u65E0\u9009\u9879" }),
      options.map((o) => /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
        "button",
        {
          type: "button",
          "data-theme-select-option": "1",
          "data-selected": o.value === value ? "1" : void 0,
          onClick: () => {
            setOpen(false);
            onChange(o.value);
          },
          style: {
            ...OPTION_BASE,
            background: o.value === value ? "var(--dsw-alias-interactive-bg-hover)" : "transparent"
          },
          children: o.label
        },
        o.value
      ))
    ] })
  ] });
}

// src/client/desktop-settings/cards/logging-controls.tsx
var import_jsx_runtime6 = require("react/jsx-runtime");
var LOG_LEVEL_OPTIONS = [
  { value: "debug", label: "\u8C03\u8BD5 debug", detail: "\u6700\u8BE6\u7EC6\uFF0C\u6392\u969C\u65F6\u4E34\u65F6\u5F00" },
  { value: "info", label: "\u4FE1\u606F info", detail: "\u5E38\u89C4\u8FD0\u884C\u8BB0\u5F55\uFF08\u9ED8\u8BA4\uFF09" },
  { value: "warn", label: "\u8B66\u544A warn", detail: "\u53EA\u8BB0\u8B66\u544A\u4E0E\u9519\u8BEF" },
  { value: "error", label: "\u9519\u8BEF error", detail: "\u53EA\u8BB0\u9519\u8BEF" }
];
var EXPORT_PRESETS = [
  { value: "today", label: "\u4ECA\u5929" },
  { value: "7d", label: "\u8FD1 7 \u5929" },
  { value: "30d", label: "\u8FD1 30 \u5929" },
  { value: "all", label: "\u5168\u90E8" },
  { value: "custom", label: "\u81EA\u5B9A\u4E49\u8303\u56F4" }
];
var CONFIRM_AUTO_EXIT_MS = 3e4;
var SUBTITLE_STYLE = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--dsw-alias-label-primary,#e7eaf0)",
  margin: "14px 0 6px"
};
function formatBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
function clampInt(raw, min, max, fallback) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
function LoggingSection() {
  const [level, setLevel] = (0, import_react6.useState)("info");
  const [retentionDays, setRetentionDays] = (0, import_react6.useState)("14");
  const [maxTotalMb, setMaxTotalMb] = (0, import_react6.useState)("200");
  const [retentionNote, setRetentionNote] = (0, import_react6.useState)(null);
  const [snap, setSnap] = (0, import_react6.useState)(null);
  const [preset, setPreset] = (0, import_react6.useState)("7d");
  const [exportFrom, setExportFrom] = (0, import_react6.useState)("");
  const [exportTo, setExportTo] = (0, import_react6.useState)("");
  const [exporting, setExporting] = (0, import_react6.useState)(false);
  const [lastExport, setLastExport] = (0, import_react6.useState)(null);
  const [clearConfirming, setClearConfirming] = (0, import_react6.useState)(false);
  const clearTimerRef = (0, import_react6.useRef)(null);
  const refresh = (0, import_react6.useCallback)(() => {
    void invokeCommand("list_log_files").then((r) => setSnap(r)).catch(
      () => {
      }
    );
  }, []);
  (0, import_react6.useEffect)(() => {
    let cancelled = false;
    void invokeCommand("get_desktop_settings_data").then((r) => {
      if (cancelled) return;
      const s = r.settings ?? {};
      const lv = typeof s.log_level === "string" ? s.log_level : "info";
      if (LOG_LEVEL_OPTIONS.some((o) => o.value === lv)) setLevel(lv);
      if (typeof s.log_retention_days === "number") setRetentionDays(String(s.log_retention_days));
      if (typeof s.log_max_total_mb === "number") setMaxTotalMb(String(s.log_max_total_mb));
    }).catch(
      () => {
      }
    );
    refresh();
    return () => {
      cancelled = true;
    };
  }, [refresh]);
  (0, import_react6.useEffect)(() => {
    if (!clearConfirming) return;
    clearTimerRef.current = setTimeout(() => setClearConfirming(false), CONFIRM_AUTO_EXIT_MS);
    const onKey = (e) => {
      if (e.key === "Escape") setClearConfirming(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
      window.removeEventListener("keydown", onKey);
    };
  }, [clearConfirming]);
  const saveLevel = (next) => {
    const prev = level;
    if (next === prev) return;
    setLevel(next);
    void invokeCommand("save_desktop_settings", { patch: { log_level: next } }).then(() => {
      const label = LOG_LEVEL_OPTIONS.find((o) => o.value === next)?.label ?? next;
      showToast(`\u65E5\u5FD7\u7EA7\u522B\u5DF2\u5207\u5230${label}\uFF08\u7ACB\u5373\u751F\u6548\uFF09`, true);
      refresh();
    }).catch((e) => {
      setLevel(prev);
      showToast(`\u4FDD\u5B58\u5931\u8D25\uFF0C\u5DF2\u56DE\u5230\u539F\u6863\u4F4D\uFF1A${String(e)}`, false);
    });
  };
  const saveRetention = () => {
    const days = clampInt(retentionDays, 1, 365, 14);
    const mb = clampInt(maxTotalMb, 50, 2e3, 200);
    setRetentionDays(String(days));
    setMaxTotalMb(String(mb));
    void invokeCommand("save_desktop_settings", { patch: { log_retention_days: days, log_max_total_mb: mb } }).then((r) => {
      setRetentionNote(
        r.log_cleanup !== void 0 ? `\u5DF2\u4FDD\u5B58\uFF1B\u5E76\u6309\u65B0\u9608\u503C\u6E05\u7406\u4E86 ${r.log_cleanup.removed_files} \u4EFD\u5F52\u6863\u3001\u91CA\u653E ${formatBytes(r.log_cleanup.bytes_freed)}` : "\u5DF2\u4FDD\u5B58"
      );
      refresh();
    }).catch((e) => showToast(`\u4FDD\u5B58\u5931\u8D25\uFF1A${String(e)}`, false));
  };
  const confirmClearLogs = () => {
    setClearConfirming(false);
    void invokeCommand("clear_logs").then((r) => {
      showToast(`\u5DF2\u6E05\u7406 ${r.removed_files} \u4EFD\u5F52\u6863\u3001\u91CA\u653E ${formatBytes(r.bytes_freed)}`, true);
      refresh();
    }).catch((e) => showToast(`\u6E05\u7406\u5931\u8D25\uFF1A${String(e)}`, false));
  };
  const runExport = () => {
    if (exporting) return;
    if (preset === "custom" && exportFrom === "") {
      showToast("\u81EA\u5B9A\u4E49\u8303\u56F4\u9700\u8981\u5148\u9009\u8D77\u59CB\u65E5\u671F", false);
      return;
    }
    setExporting(true);
    const args = preset === "custom" ? { range: "custom", from: exportFrom, ...exportTo === "" ? {} : { to: exportTo } } : { range: preset };
    void invokeCommand("export_log_range", args).then((r) => {
      const approx = r.approximations.length > 0 ? `\uFF08${r.approximations.length} \u4E2A\u6E90\u4E3A\u6574\u6587\u4EF6\u8FD1\u4F3C\uFF09` : "";
      setLastExport(`${r.path}\uFF08${formatBytes(r.bytes)}\uFF09${approx}`);
      showToast(`\u65E5\u5FD7\u5DF2\u5BFC\u51FA\u5230\u6240\u9009\u76EE\u5F55\uFF0C\u5171 ${r.archives_included} \u4EFD\u5F52\u6863\u5165\u5305`, true);
      refresh();
    }).catch((e) => showToast(`\u5BFC\u51FA\u5931\u8D25\uFF1A${String(e)}`, false)).finally(() => setExporting(false));
  };
  const openLogDir = () => {
    void invokeCommand("list_log_files", { reveal: true }).then(() => showToast("\u5DF2\u5728\u6587\u4EF6\u7BA1\u7406\u5668\u6253\u5F00\u65E5\u5FD7\u76EE\u5F55", true, "info")).catch((e) => showToast(`\u6253\u5F00\u5931\u8D25\uFF1A${String(e)}`, false));
  };
  const activeTotal = snap?.active.reduce((sum, f) => sum + f.bytes, 0) ?? 0;
  const archiveTotal = snap?.archives.reduce((sum, a) => sum + a.bytes, 0) ?? 0;
  return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(import_jsx_runtime6.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { style: NOTE_STYLE, "data-desktop-settings": "log-status", children: snap === null ? "\u65E5\u5FD7\u73B0\u72B6\u8BFB\u53D6\u4E2D\u2026" : `\u5F53\u524D\u7EA7\u522B\uFF1A${snap.level} \xB7 \u5F52\u6863 ${snap.archives.length} \u4EFD \xB7 ${formatBytes(archiveTotal)} \xB7 \u6D3B\u8DC3 ${snap.active.length} \u6587\u4EF6 \xB7 ${formatBytes(activeTotal)}` }),
    snap !== null && snap.health.io_error_count > 0 && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { style: DANGER_NOTE_STYLE, "data-desktop-settings": "log-health", children: [
      "\u65E5\u5FD7\u5199\u5165\u5F02\u5E38 ",
      snap.health.io_error_count,
      " \u6B21",
      snap.health.last_io_error !== null ? `\uFF08\u6700\u8FD1\uFF1A${snap.health.last_io_error}\uFF09` : ""
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { style: SUBTITLE_STYLE, children: "\u65E5\u5FD7\u7EA7\u522B" }),
    LOG_LEVEL_OPTIONS.map((opt) => /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("label", { style: RADIO_ROW_STYLE, children: [
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
        "input",
        {
          type: "radio",
          name: "log-level",
          "data-desktop-settings": `log-level-${opt.value}`,
          checked: level === opt.value,
          onChange: () => saveLevel(opt.value)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("span", { style: RADIO_TEXT_STYLE, children: [
        opt.label,
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { style: { color: "var(--dsw-alias-label-secondary,#9aa4b2)", marginLeft: 8 }, children: opt.detail })
      ] })
    ] }, opt.value)),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { style: NOTE_STYLE, children: "\u7EA7\u522B\u53EA\u5F71\u54CD\u5199\u76D8\u8BE6\u7EC6\u7A0B\u5EA6\uFF0C\u5207\u6362\u7ACB\u5373\u751F\u6548\uFF08\u65E0\u9700\u91CD\u542F\uFF09\uFF1B\u8C03\u9AD8\u540E\u4F4E\u7EA7\u522B\u884C\u7ACB\u523B\u4E0D\u518D\u843D\u76D8\uFF0C\u5207\u56DE\u5373\u53EF\u627E\u56DE\u3002" }),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { style: SUBTITLE_STYLE, children: "\u4FDD\u7559\u4E0E\u6E05\u7406" }),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { style: ROW_STYLE, "data-desktop-settings": "log-retention-fields", children: [
      /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("label", { style: ROW_STYLE, children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { style: { fontSize: 12 }, children: "\u4FDD\u7559\u5929\u6570\uFF081\u2013365\uFF09" }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
          "input",
          {
            style: { ...INPUT_BASE_STYLE, width: 72 },
            inputMode: "numeric",
            "data-desktop-settings": "log-retention-days",
            value: retentionDays,
            onChange: (e) => setRetentionDays(e.target.value)
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("label", { style: ROW_STYLE, children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { style: { fontSize: 12 }, children: "\u603B\u5927\u5C0F\u4E0A\u9650 MB\uFF0850\u20132000\uFF09" }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
          "input",
          {
            style: { ...INPUT_BASE_STYLE, width: 72 },
            inputMode: "numeric",
            "data-desktop-settings": "log-max-total-mb",
            value: maxTotalMb,
            onChange: (e) => setMaxTotalMb(e.target.value)
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(PfBtn, { variant: "ghost", onClick: saveRetention, testId: "log-retention-save", children: "\u4FDD\u5B58" })
    ] }),
    retentionNote !== null && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { style: NOTE_STYLE, children: retentionNote }),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { style: { ...ROW_STYLE, marginTop: 8 }, "data-desktop-settings": "log-clear-actions", children: [
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(PfBtn, { variant: "ghost", onClick: openLogDir, testId: "log-open-dir", children: "\u6253\u5F00\u65E5\u5FD7\u76EE\u5F55" }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(PfBtn, { variant: "danger", onClick: () => setClearConfirming(true), testId: "log-clear", children: "\u4E00\u952E\u6E05\u7406\u65E5\u5FD7" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { style: NOTE_STYLE, children: "\u4FDD\u7559\u7B56\u7565\u8D85\u9650\u65F6\u81EA\u52A8\u5220\u6700\u65E7\u5F52\u6863\uFF08\u53EA\u6E05\u5F52\u6863\u76EE\u5F55\uFF0C\u4E0D\u78B0\u6D3B\u8DC3\u6587\u4EF6\uFF09\uFF1B\u300C\u4E00\u952E\u6E05\u7406\u300D\u989D\u5916\u622A\u65AD\u6D3B\u8DC3\u65E5\u5FD7\uFF0C\u9700\u8981\u4E8C\u6B21\u786E\u8BA4\u3002" }),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { style: SUBTITLE_STYLE, children: "\u5BFC\u51FA\u65E5\u5FD7" }),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { style: ROW_STYLE, children: [
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { style: { width: 180 }, "data-desktop-settings": "log-export-preset", children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
        ThemeSelect,
        {
          value: preset,
          options: EXPORT_PRESETS.map((o) => ({ value: o.value, label: o.label })),
          onChange: (v) => setPreset(v)
        }
      ) }),
      preset === "custom" && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(import_jsx_runtime6.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
          "input",
          {
            type: "date",
            style: INPUT_BASE_STYLE,
            "data-desktop-settings": "log-export-from",
            value: exportFrom,
            onChange: (e) => setExportFrom(e.target.value)
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary,#9aa4b2)" }, children: "\u81F3" }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
          "input",
          {
            type: "date",
            style: INPUT_BASE_STYLE,
            "data-desktop-settings": "log-export-to",
            value: exportTo,
            onChange: (e) => setExportTo(e.target.value)
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(PfBtn, { variant: "primary", disabled: exporting, onClick: runExport, testId: "log-export-run", children: exporting ? "\u5BFC\u51FA\u4E2D\u2026" : "\u5BFC\u51FA\u65E5\u5FD7" })
    ] }),
    lastExport !== null && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { style: NOTE_STYLE, "data-desktop-settings": "log-last-export", children: [
      "\u4E0A\u6B21\u65E5\u5FD7\u5BFC\u51FA\uFF1A",
      lastExport
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { style: NOTE_STYLE, children: "\u5BFC\u51FA\u4E3A tar.gz \u5355\u5305\uFF0C\u6309\u6240\u9009\u65F6\u95F4\u8303\u56F4\u6536\u96C6\u5F52\u6863\u4E0E\u6D3B\u8DC3\u65E5\u5FD7\uFF0C\u843D\u5230\u4F60\u9009\u7684\u76EE\u5F55\u540E\u81EA\u52A8\u6253\u5F00\u6240\u5728\u4F4D\u7F6E\u3002\u9875\u9762\u65E5\u5FD7\u65E0\u65F6\u95F4\u6233\uFF0C\u4EE5\u6574\u6587\u4EF6\u65B9\u5F0F\u8FD1\u4F3C\u6536\u5F55\u3002" }),
    clearConfirming && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { style: DEV_TOOLS_OVERLAY_STYLE, children: /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { style: DEV_TOOLS_MODAL_STYLE, "data-desktop-settings": "log-clear-confirm", children: [
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { style: DEV_TOOLS_TITLE_STYLE, children: "\u6E05\u7406\u5168\u90E8\u65E5\u5FD7\uFF1F" }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { style: DEV_TOOLS_BODY_STYLE, children: [
        "\u5C06\u6E05\u7A7A\u5F52\u6863\u76EE\u5F55\u4E2D\u7684\u5168\u90E8 .gz \u5F52\u6863\uFF0C\u5E76\u628A\u4E09\u4E2A\u6D3B\u8DC3\u65E5\u5FD7\u6587\u4EF6\uFF08shell / \u9875\u9762 / relay\uFF09\u622A\u65AD\u4E3A\u7A7A\u3002",
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("br", {}),
        "\u622A\u65AD\u540E\u58F3\u4F1A\u7EE7\u7EED\u5199\u5165\u65B0\u65E5\u5FD7\uFF0C\u4F46\u88AB\u6E05\u6389\u7684\u5185\u5BB9\u4E0D\u53EF\u6062\u590D\u3002\u7EA6 30 \u79D2\u65E0\u64CD\u4F5C\u81EA\u52A8\u53D6\u6D88\u3002"
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { style: DEV_TOOLS_ACTIONS_STYLE, children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(PfBtn, { variant: "ghost", onClick: () => setClearConfirming(false), children: "\u53D6\u6D88" }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(PfBtn, { variant: "danger", onClick: confirmClearLogs, children: "\u786E\u8BA4\u6E05\u7406" })
      ] })
    ] }) })
  ] });
}

// src/client/desktop-settings/cards/diagnostics-card.tsx
var import_jsx_runtime7 = require("react/jsx-runtime");
function DiagnosticsCard() {
  const [diagSummary, setDiagSummary] = (0, import_react7.useState)(null);
  const [diagLogPath, setDiagLogPath] = (0, import_react7.useState)(null);
  const [diagExport, setDiagExport] = (0, import_react7.useState)(null);
  (0, import_react7.useEffect)(() => {
    let cancelled = false;
    void invoke("get_diagnostics").then((r) => {
      if (cancelled) return;
      const summary = r.diagnostics?.summary;
      if (typeof summary === "string" && summary !== "") setDiagSummary(summary);
      const path = r.diagnostics?.logs?.shell?.path;
      if (typeof path === "string" && path !== "") setDiagLogPath(path);
    }).catch((error) => {
      console.warn(`[dsh-desktop-tauriapp] \u8BFB\u53D6\u8BCA\u65AD\u5FEB\u7167\u5931\u8D25\uFF1A${String(error)}`);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(SectionBox, { title: "\u65E5\u5FD7\u4E0E\u8BCA\u65AD", children: [
    /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { style: NOTE_STYLE, children: diagSummary === null ? "\u8BFB\u53D6\u4E2D\u2026" : diagSummary }),
    diagLogPath !== null && /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { style: NOTE_STYLE, children: [
      "\u58F3\u65E5\u5FD7\uFF1A",
      diagLogPath
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { style: { display: "flex", gap: 8, marginTop: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
        PfBtn,
        {
          variant: "ghost",
          onClick: () => {
            void invoke("export_diagnostics").then((r) => {
              setDiagExport(r.path);
              showToast(`\u8BCA\u65AD\u5DF2\u5BFC\u51FA\uFF1A${r.path}`, true);
            }).catch((e) => showToast(`\u5BFC\u51FA\u5931\u8D25\uFF1A${String(e)}`, false));
          },
          children: "\u5BFC\u51FA\u8BCA\u65AD"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
        PfBtn,
        {
          variant: "ghost",
          onClick: () => {
            void invoke("get_diagnostics").then((r) => {
              const path = r.diagnostics?.logs?.shell?.path;
              if (typeof path === "string" && path !== "") showToast(`\u58F3\u65E5\u5FD7\uFF1A${path}`, true);
              else showToast("\u8BCA\u65AD\u91CC\u6CA1\u6709\u65E5\u5FD7\u8DEF\u5F84", false);
            }).catch((e) => showToast(`\u8BFB\u53D6\u5931\u8D25\uFF1A${String(e)}`, false));
          },
          children: "\u663E\u793A\u65E5\u5FD7\u8DEF\u5F84"
        }
      )
    ] }),
    diagExport !== null && /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { style: NOTE_STYLE, children: [
      "\u4E0A\u6B21\u5BFC\u51FA\uFF1A",
      diagExport
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(LoggingSection, {})
  ] });
}

// src/client/desktop-settings/cards/download-card.tsx
var import_react8 = require("react");
var import_jsx_runtime8 = require("react/jsx-runtime");
function DownloadCard({
  note,
  onNote
}) {
  const [concurrencyInput, setConcurrencyInput] = (0, import_react8.useState)("3");
  const concurrencyTouchedRef = (0, import_react8.useRef)(false);
  (0, import_react8.useEffect)(() => {
    invoke("get_download_settings").then((s) => {
      if (!concurrencyTouchedRef.current) setConcurrencyInput(String(s.concurrency));
    }).catch(() => {
    });
  }, []);
  const handleSaveConcurrency = () => {
    const v = Math.max(1, Math.min(32, parseInt(concurrencyInput, 10) || 3));
    void nsSave({ download_concurrency: v }).then(() => invoke("set_download_concurrency", { value: v })).then(() => onNote(`\u5DF2\u4FDD\u5B58\uFF1A\u5E76\u53D1\u4E0A\u9650 ${v}`)).catch(() => onNote("\u4FDD\u5B58\u5931\u8D25\uFF08\u65E0 Tauri IPC\uFF1F\uFF09"));
  };
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(SectionBox, { title: "\u4E0B\u8F7D", children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: ROW_STYLE, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
        "input",
        {
          placeholder: "1-32",
          "data-desktop-settings": "download-concurrency",
          style: { ...INPUT_BASE_STYLE, width: 80 },
          value: concurrencyInput,
          onChange: (e) => {
            concurrencyTouchedRef.current = true;
            setConcurrencyInput(e.target.value);
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(PfBtn, { variant: "ghost", onClick: handleSaveConcurrency, children: "\u4FDD\u5B58" })
    ] }),
    note && /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: NOTE_STYLE, children: note }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: NOTE_STYLE, children: "\u540C\u65F6\u8FDB\u884C\u7684\u4E0B\u8F7D\u6570\u4E0A\u9650\uFF0C\u8D85\u51FA\u6392\u961F\uFF1B\u6539\u52A8\u7ACB\u5373\u751F\u6548\u3002" })
  ] });
}

// src/client/desktop-settings/cards/loopback-aggregation-card.tsx
var import_react9 = require("react");
var import_jsx_runtime9 = require("react/jsx-runtime");
function LoopbackAggregationCard({ value }) {
  const [loopbackAggregation, setLoopbackAggregation] = (0, import_react9.useState)(value);
  const [loopbackAggregationNote, setLoopbackAggregationNote] = (0, import_react9.useState)(null);
  (0, import_react9.useEffect)(() => {
    setLoopbackAggregation(value);
  }, [value]);
  const handleSaveLoopbackAggregation = (next) => {
    const prev = loopbackAggregation;
    if (next === prev) return;
    setLoopbackAggregation(next);
    void nsSave({ loopback_aggregation: next }).then(
      () => setLoopbackAggregationNote(
        `\u5DF2\u4FDD\u5B58\uFF1A${LOOPBACK_AGGREGATION_OPTIONS.find((o) => o.value === next)?.label ?? next}\uFF08\u7ACB\u5373\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\uFF09`
      )
    ).catch((e) => {
      setLoopbackAggregation(prev);
      setLoopbackAggregationNote(`\u4FDD\u5B58\u5931\u8D25\uFF0C\u5DF2\u56DE\u5230\u539F\u6863\u4F4D\uFF1A${String(e)}`);
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(SectionBox, { title: "loopback \u6570\u636E\u9762\u805A\u5408", children: [
    LOOPBACK_AGGREGATION_OPTIONS.map((opt) => /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("label", { style: RADIO_ROW_STYLE, children: [
      /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
        "input",
        {
          type: "radio",
          name: "loopback-aggregation",
          "data-desktop-settings": `loopback-aggregation-${opt.value}`,
          checked: loopbackAggregation === opt.value,
          onChange: () => handleSaveLoopbackAggregation(opt.value)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("span", { style: RADIO_TEXT_STYLE, children: [
        opt.label,
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { style: { color: "var(--dsw-alias-label-secondary,#9aa4b2)", marginLeft: 8 }, children: opt.detail })
      ] })
    ] }, opt.value)),
    loopbackAggregationNote && /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("div", { style: NOTE_STYLE, children: loopbackAggregationNote }),
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("div", { style: NOTE_STYLE, children: "\u684C\u9762\u58F3\u56DE\u73AF\u6570\u636E\u9762\uFF08\u684C\u9762\u9875\u9762\u548C\u624B\u673A\u8FDC\u7A0B\u8BBF\u95EE\u90FD\u8D70\u5B83\uFF09\u5BF9 GET \u8BF7\u6C42\u7684\u5408\u5E76\u4E0E\u7F13\u51B2\u7B56\u7565\u3002\u300C\u53EA\u5173\u7F13\u51B2\u300D\u4FDD\u7559\u5408\u5E76\uFF0C \u53EA\u8BA9\u54CD\u5E94\u8FB9\u5230\u8FB9\u4E0B\u53D1\uFF1B\u300C\u5168\u5173\u300D\u8FDE\u5408\u5E76\u4E5F\u505C\u6389\uFF0C\u6BCF\u4E2A\u8BF7\u6C42\u5404\u81EA\u6253\u4E0A\u6E38\uFF0C\u4E0D\u4F1A\u5173\u6389\u522B\u7684\u529F\u80FD\u3002\u6539\u52A8\u7ACB\u5373\u751F\u6548\uFF0C \u4E0D\u9700\u8981\u91CD\u542F\u3002" })
  ] });
}

// src/client/desktop-settings/cards/migration-card.tsx
var import_react10 = require("react");
var import_jsx_runtime10 = require("react/jsx-runtime");
function MigrationCard({
  profiles,
  loaded,
  notify
}) {
  const [migrationSource, setMigrationSource] = (0, import_react10.useState)("");
  const [migrationDest, setMigrationDest] = (0, import_react10.useState)("");
  const [migrationRunning, setMigrationRunning] = (0, import_react10.useState)(false);
  const [migrationProgress, setMigrationProgress] = (0, import_react10.useState)(null);
  const selectsFilledRef = (0, import_react10.useRef)(false);
  (0, import_react10.useEffect)(() => {
    if (!loaded || selectsFilledRef.current) return;
    selectsFilledRef.current = true;
    setMigrationSource(loaded.migrationSource);
    setMigrationDest(loaded.migrationDest);
  }, [loaded]);
  (0, import_react10.useEffect)(() => {
    if (!migrationRunning) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const st = await invoke("migration_status");
        if (cancelled) return;
        if (st.running) {
          setMigrationProgress({ copied: st.copied, total: st.total });
          window.setTimeout(tick, 300);
        } else {
          window.setTimeout(tick, 300);
        }
      } catch {
      }
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [migrationRunning]);
  const handleMigrate = () => {
    if (!migrationDest) {
      notify({ ok: false, text: "\u6CA1\u6709\u53EF\u9009\u7684\u76EE\u6807 profile\uFF08\u8BF7\u5148\u65B0\u5EFA\u4E00\u4E2A\uFF09" });
      return;
    }
    const start = (overwrite) => {
      setMigrationRunning(true);
      setMigrationProgress({ copied: 0, total: 0 });
      invoke("migrate_profile", { source: migrationSource, dest: migrationDest, overwrite }).then((s) => {
        setMigrationRunning(false);
        setMigrationProgress(null);
        showToast(s, true);
      }).catch((e) => {
        const m = String(e);
        if (!overwrite && m.includes("\u9700\u786E\u8BA4\u8986\u76D6")) {
          console.error("[migrate] \u9700\u786E\u8BA4\u8986\u76D6\uFF0C\u91CD\u8BD5 overwrite=true");
          start(true);
          return;
        }
        setMigrationRunning(false);
        setMigrationProgress(null);
        console.error("[migrate] \u5931\u8D25\uFF1A", m);
        showToast(`\u8FC1\u79FB\u5931\u8D25\uFF1A${m}`, false);
      });
    };
    start(false);
  };
  const migrationDestOptions = profiles.filter((p) => p.name !== migrationSource);
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(SectionBox, { title: "\u8FC1\u79FB Profile", children: [
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("div", { style: LABEL_STYLE, children: "\u6E90 profile \u2192 \u76EE\u6807 profile\uFF08\u5168\u91CF\u590D\u5236\uFF1B\u76EE\u6807\u5DF2\u5B58\u5728\u9700\u8986\u76D6\u786E\u8BA4\uFF09" }),
    /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("div", { style: ROW_STYLE, children: [
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        ThemeSelect,
        {
          style: { flex: 1 },
          value: migrationSource,
          onChange: (v) => {
            setMigrationSource(v);
            const others = profiles.filter((p) => p.name !== v);
            const nextDest = others.find((p) => p.name === migrationDest) ?? others[0];
            if (nextDest) setMigrationDest(nextDest.name);
            else setMigrationDest("");
          },
          options: (profiles ?? []).map((p) => ({ value: p.name, label: p.name }))
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        ThemeSelect,
        {
          style: { flex: 1 },
          value: migrationDest,
          onChange: (v) => setMigrationDest(v),
          options: migrationDestOptions.map((p) => ({ value: p.name, label: p.name }))
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(PfBtn, { variant: "ghost", onClick: handleMigrate, children: "\u8FC1\u79FB\u2026" })
    ] }),
    migrationRunning && /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("div", { style: { marginTop: 10 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        "div",
        {
          style: {
            height: 6,
            borderRadius: 4,
            background: "var(--dsw-alias-bg-base,#111)",
            overflow: "hidden"
          },
          children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
            "div",
            {
              style: {
                height: "100%",
                width: migrationProgress && migrationProgress.total > 0 ? `${Math.min(100, Math.round(migrationProgress.copied / migrationProgress.total * 100))}%` : "0%",
                background: "var(--dsw-alias-state-accent-primary,#3b82f6)",
                transition: "width .2s"
              }
            }
          )
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("div", { style: NOTE_STYLE, children: migrationProgress ? `\u8FC1\u79FB\u4E2D\uFF1A${migrationProgress.copied}/${migrationProgress.total} \u4E2A\u6587\u4EF6\uFF08${migrationProgress.total > 0 ? Math.min(100, Math.round(migrationProgress.copied / migrationProgress.total * 100)) : 0}%\uFF09` : "\u51C6\u5907\u4E2D\u2026" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("div", { style: NOTE_STYLE, children: "\u8FC1\u79FB\u4E3A\u5F53\u524D\u65F6\u70B9\u5FEB\u7167\uFF1A\u4E0D\u505C\u6B62\u3001\u4E0D\u91CD\u542F\u4EFB\u4F55\u8FD0\u884C\u4E2D\u7684\u670D\u52A1\uFF1B\u6E90\u5728\u8FC1\u79FB\u671F\u95F4\u7684\u65B0\u6570\u636E\u4E0D\u5305\u542B\u5728\u526F\u672C\u5185\u3002\u76EE\u6807\u4E3A\u6FC0\u6D3B profile \u65F6\u62D2\u7EDD\u8FC1\u79FB\u3002" })
  ] });
}

// src/client/desktop-settings/cards/mobile-access-card.tsx
var import_react11 = require("react");
var import_jsx_runtime11 = require("react/jsx-runtime");
function MobileAccessCard({
  desktop,
  onNote
}) {
  const [muxHeartbeatInput, setMuxHeartbeatInput] = (0, import_react11.useState)("30000");
  const [desktopLayoutOnPhones, setDesktopLayoutOnPhones] = (0, import_react11.useState)(false);
  const [guardBackoffInput, setGuardBackoffInput] = (0, import_react11.useState)("10000");
  const [guardBackoffNote, setGuardBackoffNote] = (0, import_react11.useState)(null);
  const [mobileLayoutNote, setMobileLayoutNote] = (0, import_react11.useState)(null);
  const muxInputRef = (0, import_react11.useRef)(null);
  const guardInputRef = (0, import_react11.useRef)(null);
  (0, import_react11.useEffect)(() => {
    setDesktopLayoutOnPhones(desktop.desktop_layout_on_phones === true);
  }, [desktop.desktop_layout_on_phones]);
  (0, import_react11.useEffect)(() => {
    if (typeof document !== "undefined" && document.activeElement === muxInputRef.current) return;
    const hb = desktop.mux_heartbeat_ms;
    setMuxHeartbeatInput(typeof hb === "number" ? String(hb) : "30000");
  }, [desktop.mux_heartbeat_ms]);
  (0, import_react11.useEffect)(() => {
    if (typeof document !== "undefined" && document.activeElement === guardInputRef.current) return;
    const v = desktop.mobile_guard_backoff_ms;
    setGuardBackoffInput(typeof v === "number" && v > 0 ? String(v) : "10000");
  }, [desktop.mobile_guard_backoff_ms]);
  const handleSaveMuxHeartbeat = () => {
    const raw = muxHeartbeatInput.trim();
    const parsed = raw === "" ? 3e4 : parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      onNote("\u5FC3\u8DF3\u95F4\u9694\u9700\u4E3A\u6574\u6570\u6BEB\u79D2\uFF080 = \u4E0D\u8986\u76D6\uFF0C\u56DE\u9000 dsh \u9ED8\u8BA4 2s\uFF09");
      return;
    }
    const v = Math.min(6e5, parsed);
    void nsSave({ mux_heartbeat_ms: v }).then(
      () => onNote(
        v === 0 ? "\u5DF2\u4FDD\u5B58\uFF1A\u4E0D\u8986\u76D6\u5FC3\u8DF3\uFF08dsh \u9ED8\u8BA4 2s\uFF09\uFF0C\u91CD\u542F dsh \u751F\u6548\u3002" : `\u5DF2\u4FDD\u5B58\uFF1Amux \u5FC3\u8DF3 ${v}ms\uFF08dsh \u539F\u751F 2s\uFF09\uFF0C\u91CD\u542F dsh \u751F\u6548\u3002`
      )
    ).catch((e) => onNote(`\u4FDD\u5B58\u5931\u8D25\uFF1A${String(e)}`));
  };
  const handleSaveGuardBackoff = () => {
    const raw = guardBackoffInput.trim();
    const parsed = raw === "" ? 1e4 : parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 1e3) {
      setGuardBackoffNote("\u9000\u907F\u57FA\u6570\u9700\u4E3A \u22651000 \u7684\u6574\u6570\u6BEB\u79D2\uFF08\u9ED8\u8BA4 10000\uFF09");
      return;
    }
    const v = Math.min(6e5, parsed);
    void nsSave({ mobile_guard_backoff_ms: v }).then(() => setGuardBackoffNote(`\u5DF2\u4FDD\u5B58\uFF1A\u4F1A\u8BDD\u5B88\u536B\u9000\u907F\u57FA\u6570 ${v}ms\uFF0C\u91CD\u542F dsh \u751F\u6548\u3002`)).catch((e) => setGuardBackoffNote(`\u4FDD\u5B58\u5931\u8D25\uFF1A${String(e)}`));
  };
  const handleToggleMobileLayout = (next) => {
    setDesktopLayoutOnPhones(next);
    void nsSave({ desktop_layout_on_phones: next }).then(
      () => setMobileLayoutNote(
        next ? "\u5DF2\u4FDD\u5B58\uFF1A\u624B\u673A\u4F7F\u7528\u684C\u9762\u5E03\u5C40\uFF08\u4E0D\u52A0\u8F7D\u79FB\u52A8\u5E03\u5C40\u63D2\u4EF6\uFF09\uFF0C\u91CD\u542F dsh \u751F\u6548\u3002" : "\u5DF2\u4FDD\u5B58\uFF1A\u624B\u673A\u4F7F\u7528\u79FB\u52A8\u5E03\u5C40\uFF0C\u91CD\u542F dsh \u751F\u6548\u3002"
      )
    ).catch((e) => {
      setDesktopLayoutOnPhones(!next);
      setMobileLayoutNote(`\u4FDD\u5B58\u5931\u8D25\uFF1A${String(e)}`);
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(SectionBox, { title: "\u624B\u673A\u8BBF\u95EE\uFF08\u8FDC\u7A0B\u8FDE\u63A5\uFF09", children: [
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { style: ROW_STYLE, children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
        "input",
        {
          placeholder: "30000",
          ref: muxInputRef,
          "data-desktop-settings": "mux-heartbeat-ms",
          style: { ...INPUT_BASE_STYLE, width: 100 },
          value: muxHeartbeatInput,
          onChange: (e) => setMuxHeartbeatInput(e.target.value)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(PfBtn, { variant: "ghost", onClick: handleSaveMuxHeartbeat, children: "\u4FDD\u5B58" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { style: NOTE_STYLE, children: [
      "dsh \u7F51\u5173\u5BF9 ",
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("code", { children: "/api/remote.mux" }),
      " \u7684\u5FC3\u8DF3\u95F4\u9694\uFF08\u6BEB\u79D2\uFF09\u3002dsh \u539F\u751F 2s \u4E14\u8FDE\u4E22 2 \u6B21\u5373\u65AD\u5F00\uFF0C \u79FB\u52A8\u7AEF\u5207\u540E\u53F0/\u5F31\u7F51\u4F1A\u88AB\u79D2\u5224\u6B7B\uFF08\u8868\u73B0\u4E3A\u300C\u80FD\u53D1\u6D88\u606F\u3001\u6536\u4E0D\u5230\u65B0\u6D88\u606F\u300D\uFF09\uFF1B\u58F3\u9ED8\u8BA4\u8986\u76D6\u4E3A 30000\u3002 \u586B 0 = \u4E0D\u8986\u76D6\uFF08\u56DE\u9000 dsh \u9ED8\u8BA4\uFF09\uFF0C\u6539\u52A8\u91CD\u542F dsh \u751F\u6548\u3002"
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { style: { ...LABEL_STYLE, marginTop: 12 }, children: "\u79FB\u52A8\u7AEF\u4F1A\u8BDD\u5B88\u536B" }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { style: ROW_STYLE, children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
        "input",
        {
          placeholder: "10000",
          "data-desktop-settings": "mobile-guard-backoff-ms",
          style: { ...INPUT_BASE_STYLE, width: 100 },
          value: guardBackoffInput,
          onChange: (e) => setGuardBackoffInput(e.target.value),
          ref: guardInputRef
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(PfBtn, { variant: "ghost", onClick: handleSaveGuardBackoff, children: "\u4FDD\u5B58" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { style: NOTE_STYLE, children: "\u79FB\u52A8\u7AEF\u58F3\u63A2\u6D4B\u5230\u4F1A\u8BDD\u5931\u6548\u65F6\uFF0C\u7B2C 2 \u6B21\u8D77\u6309\u300C\u57FA\u6570 \xD7 2^(n-2)\u300D\u9000\u907F\u91CD\u8FDE\uFF08\u5C01\u9876 30s\uFF09\u3002\u9ED8\u8BA4 10000ms\uFF1B \u8C03\u5927\u80FD\u51CF\u5C11\u5F31\u7F51\u4E0B\u7684\u300C\u65AD\u2014\u91CD\u8FDE\u300D\u6296\u52A8\uFF0C\u4EE3\u4EF7\u662F\u6062\u590D\u53D8\u6162\u3002\u6539\u52A8\u91CD\u542F dsh \u751F\u6548\u3002" }),
    guardBackoffNote && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { style: NOTE_STYLE, children: guardBackoffNote }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { style: { ...LABEL_STYLE, marginTop: 12 }, children: "\u79FB\u52A8\u7AEF\u5E03\u5C40" }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { style: ROW_STYLE, children: /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
        "input",
        {
          type: "checkbox",
          "data-desktop-settings": "desktop-layout-on-phones",
          checked: desktopLayoutOnPhones,
          onChange: (e) => handleToggleMobileLayout(e.target.checked)
        }
      ),
      "\u624B\u673A\u7AEF\u6539\u7528\u684C\u9762\u5E03\u5C40\uFF08\u4E0D\u52A0\u8F7D\u79FB\u52A8\u5E03\u5C40\u63D2\u4EF6\uFF09"
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { style: NOTE_STYLE, children: "\u624B\u673A\u4E0A\u7684\u5361\u987F\u6765\u81EA\u5BBF\u4E3B\u524D\u7AEF\uFF08\u4F1A\u8BDD\u6574\u6BB5\u6302\u8F7D + \u9010\u5757\u4EE3\u7801\u9AD8\u4EAE\uFF09\uFF0C\u4E0D\u662F\u7F51\u7EDC\u3002\u52FE\u9009\u540E\u624B\u673A\u8D70\u4E0E iPad \u76F8\u540C\u7684\u684C\u9762\u5E03\u5C40\uFF1A\u660E\u663E\u66F4\u6D41\u7545\uFF0C\u4EE3\u4EF7\u662F\u6392\u7248\u66F4\u6324\uFF08\u53EF\u6A2A\u5C4F\u7F13\u89E3\uFF09\u3002\u4E0D\u52FE\u9009 = \u79FB\u52A8\u5E03\u5C40\u3002\u6539\u52A8\u91CD\u542F dsh \u751F\u6548\u3002" }),
    mobileLayoutNote && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { style: NOTE_STYLE, children: mobileLayoutNote })
  ] });
}

// src/client/desktop-settings/cards/power-card.tsx
var import_react12 = require("react");

// src/client/features/keep-awake-note.ts
var NOTE_TAIL = "\u76F4\u5230\u4F1A\u8BDD\u8DD1\u5B8C\u3001dsh \u5B9E\u4F8B\u505C\u6B62\u6216\u9000\u51FA\u58F3\u3002\u5C4F\u5E55\u8BE5\u5173\u8FD8\u662F\u7167\u5173\uFF0C\u53EA\u662F\u4E0D\u8BA9\u6574\u673A\u7761\u8FC7\u53BB\uFF1B\u5408\u76D6\u4ECD\u7136\u4F1A\u7761\u3002\u6539\u52A8\u7ACB\u5373\u751F\u6548\u3002";
var GENERIC_HEAD = "\u7184\u5C4F\u540E\u82E5\u8FD8\u6709\u4F1A\u8BDD\u5728\u8DD1\uFF0C\u58F3\u4F1A\u6301\u6709\u7CFB\u7EDF\u9632\u4F11\u7720\u65AD\u8A00\uFF08macOS \u8D70 IOKit\u3001Windows \u8D70\u7EBF\u7A0B\u6267\u884C\u72B6\u6001\u3001Linux \u8D70 logind/GNOME \u4F1A\u8BDD\u6291\u5236\uFF09";
var BACKEND_HEAD = /* @__PURE__ */ new Map([
  ["caffeinate", "\u7184\u5C4F\u540E\u82E5\u8FD8\u6709\u4F1A\u8BDD\u5728\u8DD1\uFF0C\u58F3\u4F1A\u6301\u6709\u7CFB\u7EDF\u9632\u4F11\u7720\u65AD\u8A00\uFF08macOS \u8D70 IOKit / caffeinate\uFF09"],
  ["execution-state", "\u7184\u5C4F\u540E\u82E5\u8FD8\u6709\u4F1A\u8BDD\u5728\u8DD1\uFF0C\u58F3\u4F1A\u6301\u6709\u7CFB\u7EDF\u9632\u4F11\u7720\u65AD\u8A00\uFF08Windows \u8D70\u7EBF\u7A0B\u6267\u884C\u72B6\u6001\uFF09"],
  ["systemd-inhibit", "\u7184\u5C4F\u540E\u82E5\u8FD8\u6709\u4F1A\u8BDD\u5728\u8DD1\uFF0C\u58F3\u4F1A\u6301\u6709\u7CFB\u7EDF\u9632\u4F11\u7720\u65AD\u8A00\uFF08Linux \u8D70 logind \u6291\u5236\u9501\uFF0Csystemd-inhibit\uFF09"],
  [
    "gnome-session-inhibit",
    "\u7184\u5C4F\u540E\u82E5\u8FD8\u6709\u4F1A\u8BDD\u5728\u8DD1\uFF0C\u58F3\u4F1A\u6301\u6709\u7CFB\u7EDF\u9632\u4F11\u7720\u65AD\u8A00\uFF08Linux \u8D70 GNOME \u4F1A\u8BDD\u6291\u5236\uFF0Cgnome-session-inhibit\uFF09"
  ]
]);
function reasonText(reason) {
  return typeof reason === "string" && reason.trim() !== "" ? reason.trim() : "\u539F\u56E0\u672A\u77E5";
}
function keepAwakeNote(capability) {
  const cap = capability ?? {};
  if (cap.available === false) {
    return {
      tone: "warn",
      text: `\u672C\u73AF\u5883\u62FF\u4E0D\u5230\u9632\u4F11\u7720\u901A\u9053\uFF1A${reasonText(cap.reason)}\u3002\u5F00\u5173\u5C31\u7B97\u5F00\u7740\uFF0C\u8DD1\u4F1A\u8BDD\u671F\u95F4\u7CFB\u7EDF\u4ECD\u53EF\u80FD\u7A7A\u95F2\u4F11\u7720\uFF1B${NOTE_TAIL}`
    };
  }
  if (cap.available === true) {
    return { tone: "info", text: `${BACKEND_HEAD.get(cap.backend ?? "") ?? GENERIC_HEAD}\uFF0C${NOTE_TAIL}` };
  }
  return { tone: "info", text: `${GENERIC_HEAD}\uFF0C${NOTE_TAIL}` };
}

// src/client/desktop-settings/cards/power-card.tsx
var import_jsx_runtime12 = require("react/jsx-runtime");
function PowerCard({ desktop }) {
  const [preventSleep, setPreventSleep] = (0, import_react12.useState)(true);
  const [preventSleepNote, setPreventSleepNote] = (0, import_react12.useState)(null);
  (0, import_react12.useEffect)(() => {
    setPreventSleep(desktop.prevent_sleep !== false);
  }, [desktop]);
  const handleTogglePreventSleep = (next) => {
    setPreventSleep(next);
    void nsSave({ prevent_sleep: next }).then(
      () => setPreventSleepNote(
        next ? "\u5DF2\u4FDD\u5B58\uFF1A\u6709\u4F1A\u8BDD\u5728\u8DD1\u65F6\u963B\u6B62\u7CFB\u7EDF\u4F11\u7720\uFF08\u5C4F\u5E55\u4ECD\u4F1A\u7167\u5E38\u7184\u706D\uFF09\u3002" : "\u5DF2\u4FDD\u5B58\uFF1A\u4E0D\u518D\u963B\u6B62\u7CFB\u7EDF\u4F11\u7720\u3002"
      )
    ).catch((e) => setPreventSleepNote(`\u4FDD\u5B58\u5931\u8D25\uFF1A${String(e)}`));
  };
  return /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(SectionBox, { title: "\u7535\u6E90", children: [
    /* @__PURE__ */ (0, import_jsx_runtime12.jsx)("div", { style: ROW_STYLE, children: /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(
        "input",
        {
          type: "checkbox",
          "data-desktop-settings": "prevent-sleep",
          checked: preventSleep,
          onChange: (e) => handleTogglePreventSleep(e.target.checked)
        }
      ),
      "\u6709\u4F1A\u8BDD\u5728\u8DD1\u65F6\u963B\u6B62\u7CFB\u7EDF\u4F11\u7720\uFF08\u7F3A\u7701\u5F00\uFF09"
    ] }) }),
    preventSleepNote && /* @__PURE__ */ (0, import_jsx_runtime12.jsx)("div", { style: NOTE_STYLE, children: preventSleepNote }),
    (() => {
      const note = keepAwakeNote(desktop.keep_awake);
      return /* @__PURE__ */ (0, import_jsx_runtime12.jsx)("div", { style: note.tone === "warn" ? WARN_NOTE_STYLE : NOTE_STYLE, children: note.text });
    })()
  ] });
}

// src/client/desktop-settings/cards/profile-card.tsx
var import_jsx_runtime13 = require("react/jsx-runtime");
function ProfileCard({
  desktop,
  notify
}) {
  const activeProfile = desktop.profiles.find((p) => p.active);
  const profileSelectValue = activeProfile?.name ?? desktop.profiles[0]?.name ?? "";
  const handleSwitchProfile = (name) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      notify({ ok: false, text: "Profile \u540D\u4E0D\u5408\u6CD5" });
      return;
    }
    void (async () => {
      try {
        await nsSave({ active_profile: name });
        await invoke("restart_dsh_service");
        notify({ ok: true, text: `\u5DF2\u5207\u6362\u5230 Profile\u300C${name}\u300D\uFF0C\u6B63\u5728\u91CD\u542F\u2026` });
      } catch (err) {
        notify({ ok: false, text: `\u5207\u6362 Profile \u5931\u8D25\uFF1A${String(err)}` });
      }
    })();
  };
  return /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)(SectionBox, { title: "Profile", children: [
    /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(
      ThemeSelect,
      {
        style: { marginBottom: 8 },
        value: profileSelectValue,
        onChange: handleSwitchProfile,
        options: (desktop.profiles ?? []).map((p) => ({
          value: p.name,
          label: p.active ? `\u2713 ${p.name}` : p.name
        }))
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("div", { style: NOTE_STYLE, children: "\u5207\u6362 Profile \u4F1A\u4EE5\u76EE\u6807 profile \u91CD\u542F dsh web\u3002" })
  ] });
}

// src/client/desktop-settings/cards/profile-ports-card.tsx
var import_react13 = require("react");
var import_jsx_runtime14 = require("react/jsx-runtime");
function ProfilePortsCard({ loaded }) {
  const [profilePorts, setProfilePorts] = (0, import_react13.useState)([]);
  const [profilePortsStatus, setProfilePortsStatus] = (0, import_react13.useState)({ state: "loading", text: "\u52A0\u8F7D\u4E2D\u2026" });
  const [profilePortInputs, setProfilePortInputs] = (0, import_react13.useState)({});
  const [profileLaneInputs, setProfileLaneInputs] = (0, import_react13.useState)({});
  const [profilePageInputs, setProfilePageInputs] = (0, import_react13.useState)({});
  const [forwarderInput, setForwarderInput] = (0, import_react13.useState)("");
  const [profilePortBoxNote, setProfilePortBoxNote] = (0, import_react13.useState)(null);
  const inputsFilledRef = (0, import_react13.useRef)(false);
  (0, import_react13.useEffect)(() => {
    if (!loaded || inputsFilledRef.current) return;
    inputsFilledRef.current = true;
    setForwarderInput(loaded.forwarderInput);
    setProfilePortInputs(loaded.profilePortInputs);
    setProfileLaneInputs(loaded.profileLaneInputs);
    setProfilePageInputs(loaded.profilePageInputs);
  }, [loaded]);
  (0, import_react13.useEffect)(() => {
    let cancelled = false;
    let attempt = 0;
    const load = () => {
      invoke("list_profile_ports").then((rows) => {
        if (cancelled) return;
        setProfilePorts(rows);
        setProfilePortsStatus({ state: "ok" });
      }).catch((err) => {
        if (cancelled) return;
        if (attempt < 2) {
          attempt += 1;
          setProfilePortsStatus({ state: "loading", text: `\u52A0\u8F7D\u5931\u8D25\uFF0C\u91CD\u8BD5\u4E2D\uFF08${attempt}/2\uFF09\u2026` });
          window.setTimeout(load, 800);
        } else {
          setProfilePortsStatus({
            state: "error",
            text: `\u7AEF\u53E3\u8868\u52A0\u8F7D\u5931\u8D25\uFF1A${String(err)}\uFF08\u8BF7\u91CD\u542F dsh \u540E\u91CD\u8BD5\uFF09`
          });
        }
      });
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);
  const parsePortInput = (raw) => {
    const v = Number(raw);
    return !raw || Number.isNaN(v) || v < 1 || v > 65535 ? null : v;
  };
  const savePortSetting = (key, v, note) => {
    void nsSave({ [key]: v }).then(() => setProfilePortBoxNote(note)).catch((e) => setProfilePortBoxNote(`\u4FDD\u5B58\u5931\u8D25\uFF1A${String(e)}`));
  };
  const handleSaveProfilePort = (profile) => {
    const v = parsePortInput(profilePortInputs[profile] ?? "");
    if (v === null) return;
    savePortSetting(`profile_ports.${profile}`, v, `${profile} \u4E0A\u6E38\u7AEF\u53E3\u5DF2\u6539\u4E3A ${v}\uFF1B\u91CD\u542F\u8BE5 profile \u751F\u6548\u3002`);
  };
  const handleSaveProfileLanePort = (profile) => {
    const v = parsePortInput(profileLaneInputs[profile] ?? "");
    if (v === null) return;
    savePortSetting(`profile_lane_ports.${profile}`, v, `${profile} lane \u7AEF\u53E3\u5DF2\u6539\u4E3A ${v}\uFF1B\u91CD\u542F\u8BE5 profile \u751F\u6548\u3002`);
  };
  const handleSaveProfilePagePort = (profile) => {
    const v = parsePortInput(profilePageInputs[profile] ?? "");
    if (v === null) return;
    const ok = window.confirm(
      `${profile} \u9875\u9762\u53E3\u5C06\u6539\u4E3A ${v}\uFF1A\u6362\u53E3\uFF1D\u6362\u6D4F\u89C8\u5668\u672C\u5730\u5B58\u50A8\uFF08localStorage/IndexedDB \u7559\u5728\u65E7\u53E3\uFF09\u3002\u786E\u8BA4\u4FEE\u6539\uFF1F`
    );
    if (!ok) return;
    savePortSetting(`profile_page_ports.${profile}`, v, `${profile} \u9875\u9762\u53E3\u5DF2\u6539\u4E3A ${v}\uFF1B\u91CD\u542F\u8BE5 profile \u751F\u6548\u3002`);
  };
  const handleSaveForwarderPort = () => {
    const v = parsePortInput(forwarderInput.trim());
    if (v === null) return;
    savePortSetting("lane_forwarder_port", v, `lane \u8F6C\u53D1\u5668\u7AEF\u53E3\u5DF2\u6539\u4E3A ${v}\uFF1B\u91CD\u542F\u58F3\u751F\u6548\u3002`);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime14.jsxs)(SectionBox, { title: "Profile \u7AEF\u53E3", children: [
    /* @__PURE__ */ (0, import_jsx_runtime14.jsxs)("div", { style: { ...ROW_STYLE, marginBottom: 10 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("span", { style: LABEL_STYLE, children: "\u58F3 lane \u8F6C\u53D1\u5668\u53E3\uFF08\u91CD\u542F\u58F3\u751F\u6548\uFF09" }),
      /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(
        "input",
        {
          style: { ...INPUT_BASE_STYLE, width: 84 },
          "data-desktop-settings": "lane-forwarder-port",
          placeholder: "3091",
          value: forwarderInput,
          onChange: (e) => setForwarderInput(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter") handleSaveForwarderPort();
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(PfBtn, { variant: "ghost", onClick: handleSaveForwarderPort, children: "\u4FDD\u5B58" })
    ] }),
    profilePortsStatus.state === "ok" ? /* @__PURE__ */ (0, import_jsx_runtime14.jsxs)("table", { style: { width: "100%", fontSize: 12, borderCollapse: "collapse" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("tr", { children: ["Profile", "dsh \u7AEF\u53E3\uFF08\u4E0A\u6E38\uFF09", "\u9875\u9762\u53E3\uFF08loopback\uFF09", "Lane \u7AEF\u53E3", "\u72B6\u6001", ""].map((h) => /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("th", { style: { textAlign: "left" }, children: h }, h)) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("tbody", { children: profilePorts.map((r) => /* @__PURE__ */ (0, import_jsx_runtime14.jsxs)("tr", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("td", { children: r.profile }),
        /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(
          PortCell,
          {
            testId: `profile-port-${r.profile}`,
            placeholder: String(r.upstream_port),
            value: profilePortInputs[r.profile] ?? "",
            onChange: (v) => setProfilePortInputs((prev) => ({ ...prev, [r.profile]: v })),
            onEnter: () => handleSaveProfilePort(r.profile),
            onSave: () => handleSaveProfilePort(r.profile)
          }
        ) }),
        /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(
          PortCell,
          {
            testId: `profile-page-port-${r.profile}`,
            placeholder: r.page_port > 0 ? String(r.page_port) : "\u542F\u52A8\u65F6\u5206\u914D",
            value: profilePageInputs[r.profile] ?? "",
            onChange: (v) => setProfilePageInputs((prev) => ({ ...prev, [r.profile]: v })),
            onEnter: () => handleSaveProfilePagePort(r.profile),
            onSave: () => handleSaveProfilePagePort(r.profile)
          }
        ) }),
        /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(
          PortCell,
          {
            testId: `profile-lane-port-${r.profile}`,
            placeholder: String(r.lane_port),
            value: profileLaneInputs[r.profile] ?? "",
            onChange: (v) => setProfileLaneInputs((prev) => ({ ...prev, [r.profile]: v })),
            onEnter: () => handleSaveProfileLanePort(r.profile),
            onSave: () => handleSaveProfileLanePort(r.profile)
          }
        ) }),
        /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(
          "td",
          {
            style: {
              color: r.running ? "var(--dsw-alias-state-success-primary,#2fbf71)" : "var(--dsw-alias-label-secondary,#9aa4b2)"
            },
            children: r.running ? "\u25CF \u8FD0\u884C\u4E2D" : "\u672A\u8FD0\u884C"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("td", {})
      ] }, r.profile)) })
    ] }) : profilePortsStatus.state === "error" ? /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("div", { style: DANGER_NOTE_STYLE, children: profilePortsStatus.text }) : /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("div", { style: NOTE_STYLE, children: profilePortsStatus.text ?? "\u52A0\u8F7D\u4E2D\u2026" }),
    profilePortBoxNote && /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("div", { style: NOTE_STYLE, children: profilePortBoxNote }),
    /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("div", { style: NOTE_STYLE, children: "\u4E0A\u6E38\uFF08dsh \u5B9E\u4F8B\uFF09\uFF1Aweb 3080 \xB7 desktop 3081 \xB7 \u5176\u4F59 3082 \u8D77\u6563\u5217\u907F\u8BA9\uFF1Blane\uFF08\u624B\u673A\u4EE3\u7406\uFF09\uFF1Aweb 3092 \xB7 desktop 3093 \xB7 \u5176\u4F59 3094 \u8D77\u6563\u5217\uFF1B\u9875\u9762\u53E3\uFF08loopback origin\uFF09\uFF1A6390 \u8D77 40 \u4E2A\u987A\u5EF6\u3002\u6539\u52A8\u540E\u91CD\u542F\u8BE5 profile \u751F\u6548\uFF1B \u8F93\u5165\u6846\u663E\u793A\u7684\u662F\u5DF2\u4FDD\u5B58\u7684\u671F\u671B\u503C\uFF0C\u7070\u5B57 placeholder \u662F\u5F53\u524D\u5B9E\u9645\u503C\u3002" }),
    /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("div", { style: DANGER_NOTE_STYLE, children: "\u26A0\uFE0F \u6539\u9875\u9762\u53E3\uFF1D\u6362\u6D4F\u89C8\u5668\u672C\u5730\u5B58\u50A8\uFF1AlocalStorage / IndexedDB / \u767B\u5F55\u6001\u7559\u5728\u65E7\u7AEF\u53E3\uFF0C\u4E0D\u4F1A\u8DDF\u968F\u5230\u65B0\u53E3\uFF1B\u8F6C\u53D1\u5668\u53E3\u6539\u52A8\u9700\u91CD\u542F\u58F3\u3002" })
  ] });
}

// src/client/desktop-settings/cards/proxy-card.tsx
var import_react14 = require("react");
var import_jsx_runtime15 = require("react/jsx-runtime");
function ProxyCard({
  proxy,
  proxyEffective,
  loaded,
  notify
}) {
  const [draft, setDraft] = (0, import_react14.useState)(proxy);
  const [busy, setBusy] = (0, import_react14.useState)(false);
  const [testResult, setTestResult] = (0, import_react14.useState)(null);
  const [testBusy, setTestBusy] = (0, import_react14.useState)(false);
  const filledRef = (0, import_react14.useRef)(false);
  (0, import_react14.useEffect)(() => {
    if (!loaded || filledRef.current) return;
    filledRef.current = true;
    setDraft(loaded.proxy);
  }, [loaded]);
  const set = (key, value) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };
  const handleSaveProxy = () => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        await nsSave({
          proxy_mode: draft.proxy_mode,
          proxy_url: draft.proxy_url,
          no_proxy: draft.no_proxy,
          proxy_user: draft.proxy_user,
          proxy_pass: draft.proxy_pass
        });
        notify({ ok: true, text: "\u4EE3\u7406\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\uFF1B\u4E0B\u6B21 dsh \u91CD\u542F\u540E\u751F\u6548\u3002" });
      } catch (err) {
        notify({ ok: false, text: `\u4FDD\u5B58\u5931\u8D25\uFF1A${String(err)}` });
      } finally {
        setBusy(false);
      }
    })();
  };
  const handleTestProxy = () => {
    if (testBusy) return;
    setTestBusy(true);
    setTestResult(null);
    void (async () => {
      try {
        const ms = await invoke("test_proxy_connectivity", { url: draft.proxy_url });
        setTestResult(`\u8FDE\u63A5\u6210\u529F\uFF08${ms}ms\uFF09`);
      } catch (err) {
        setTestResult(`\u8FDE\u63A5\u5931\u8D25\uFF1A${String(err)}`);
      } finally {
        setTestBusy(false);
      }
    })();
  };
  return /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(SectionBox, { title: "\u4EE3\u7406\u8BBE\u7F6E", children: [
    /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { style: LABEL_STYLE, children: "\u4EE3\u7406\u6A21\u5F0F" }),
    /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
      ThemeSelect,
      {
        style: { marginBottom: 10 },
        value: draft.proxy_mode,
        onChange: (v) => set("proxy_mode", v),
        options: [
          { value: "off", label: "\u4E0D\u4F7F\u7528\u4EE3\u7406" },
          { value: "system", label: "\u8DDF\u968F\u7CFB\u7EDF\u4EE3\u7406" },
          { value: "manual", label: "\u624B\u52A8\u6307\u5B9A\u4EE3\u7406" }
        ]
      }
    ),
    draft.proxy_mode === "manual" && /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(import_jsx_runtime15.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { style: LABEL_STYLE, children: "\u4EE3\u7406 URL" }),
      /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
        "input",
        {
          placeholder: "http/https/socks5://host:port",
          value: draft.proxy_url,
          className: "pf-input",
          style: INPUT_FULL_STYLE,
          "data-desktop-settings": "proxy-url",
          onChange: (e) => set("proxy_url", e.target.value.trim())
        }
      )
    ] }),
    (draft.proxy_mode === "manual" || draft.proxy_mode === "system") && /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(import_jsx_runtime15.Fragment, { children: [
      draft.proxy_mode === "manual" && /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(import_jsx_runtime15.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { style: LABEL_STYLE, children: "NO_PROXY\uFF08\u4E0D\u8D70\u4EE3\u7406\u7684\u5730\u5740\uFF0C\u9017\u53F7\u5206\u9694\uFF09" }),
        /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
          "input",
          {
            placeholder: "localhost,127.0.0.1,*.internal",
            value: draft.no_proxy,
            className: "pf-input",
            style: INPUT_FULL_STYLE,
            "data-desktop-settings": "no-proxy",
            onChange: (e) => set("no_proxy", e.target.value.trim())
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { style: { display: "flex", gap: 8, marginTop: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { style: FLEX_1_STYLE, children: [
          /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { style: LABEL_STYLE, children: "\u7528\u6237\u540D\uFF08\u53EF\u9009\uFF09" }),
          /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
            "input",
            {
              value: draft.proxy_user,
              className: "pf-input",
              style: INPUT_FULL_STYLE,
              "data-desktop-settings": "proxy-user",
              onChange: (e) => set("proxy_user", e.target.value)
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { style: FLEX_1_STYLE, children: [
          /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { style: LABEL_STYLE, children: "\u5BC6\u7801\uFF08\u53EF\u9009\uFF09" }),
          /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
            "input",
            {
              type: "password",
              value: draft.proxy_pass,
              className: "pf-input",
              style: INPUT_FULL_STYLE,
              "data-desktop-settings": "proxy-pass",
              onChange: (e) => set("proxy_pass", e.target.value)
            }
          )
        ] })
      ] })
    ] }),
    proxyEffective && /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { style: NOTE_STYLE, children: [
      "\u5F53\u524D\u751F\u6548\uFF1A",
      JSON.stringify(proxyEffective)
    ] }),
    draft.proxy_mode === "system" && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { style: NOTE_STYLE, children: "\u7CFB\u7EDF\u4EE3\u7406\u6A21\u5F0F\u4E0B\uFF0C\u4EE3\u7406\u5730\u5740\u4E0E NO_PROXY \u6765\u81EA\u7CFB\u7EDF\u8BBE\u7F6E\uFF08\u5982 Windows \u6CE8\u518C\u8868 ProxyOverride\uFF09\uFF1B\u7528\u6237\u540D/\u5BC6\u7801\u4ECD\u53D6\u81EA\u8BBE\u7F6E\u5E76\u62FC\u5165\u4EE3\u7406\u5730\u5740\u3002" }),
    draft.proxy_mode === "manual" && draft.proxy_url && /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(import_jsx_runtime15.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { style: { marginTop: 8 }, children: /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(PfBtn, { variant: "ghost", onClick: handleTestProxy, children: testBusy ? "\u6D4B\u8BD5\u4E2D\u2026" : "\u6D4B\u8BD5\u8FDE\u63A5" }) }),
      testResult && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { style: NOTE_STYLE, children: testResult })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { style: { marginTop: 10 }, children: /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(PfBtn, { variant: "primary", disabled: busy, onClick: handleSaveProxy, children: busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58\u4EE3\u7406\u8BBE\u7F6E" }) })
  ] });
}

// src/client/desktop-settings/cards/runtime-card.tsx
var import_react15 = require("react");

// src/client/features/runtime-download-ui.ts
var IDLE = { progress: null, entry: null, toast: null };
function stripDownloadErrorPrefix(text) {
  return text.replace(/^下载失败[:：]\s*/, "").trim();
}
function present(version) {
  return version !== null && version !== void 0 && version !== "";
}
function decideRuntimeDownload(s, sawActive) {
  if (s.active) return {
    progress: { version: s.version, resolved: s.resolved, downloaded: s.downloaded, added: s.added },
    entry: { version: s.version, value: "downloading" },
    toast: null
  };
  if (!present(s.version)) return IDLE;
  const cancelled = s.cancelled === true;
  const failed = s.error !== "";
  if (!cancelled && !failed) {
    return sawActive ? { progress: null, entry: { version: s.version, remove: true }, toast: { text: `dsh ${s.version} \u4E0B\u8F7D\u5B8C\u6210`, tone: "ok" } } : IDLE;
  }
  const reason = stripDownloadErrorPrefix(s.error);
  const entry = cancelled ? { cancelled: true } : { failed: reason === "" ? "\u672A\u77E5\u9519\u8BEF" : reason };
  const text = cancelled ? `dsh ${s.version} \u4E0B\u8F7D\u5DF2\u53D6\u6D88` : `dsh ${s.version} \u4E0B\u8F7D\u5931\u8D25\uFF1A${reason === "" ? "\u672A\u77E5\u9519\u8BEF" : reason}`;
  return {
    progress: null,
    entry: { version: s.version, value: entry },
    toast: sawActive ? { text, tone: cancelled ? "info" : "error" } : null
  };
}
function sameDownloadEntry(a, b) {
  if (a === void 0) return false;
  if (typeof a === "string" || typeof b === "string") return a === b;
  if ("failed" in a && "failed" in b) return a.failed === b.failed;
  if ("cancelled" in a && "cancelled" in b) return true;
  return false;
}
function currentRuntimeLine(input) {
  const builtin = input.builtin ?? null;
  const selected = input.selected ?? null;
  const runningVersion = input.running?.version ?? null;
  const kind = input.running?.kind ?? "";
  if (present(runningVersion)) {
    const builtinRun = present(builtin) && runningVersion === builtin;
    const head = builtinRun ? `\u5F53\u524D\u4F7F\u7528\uFF1A\u5185\u7F6E dsh ${builtin}\uFF08\u515C\u5E95\uFF09` : `\u5F53\u524D\u4F7F\u7528\uFF1A\u8FD0\u884C\u65F6 ${runningVersion}${kind === "" ? "" : `\uFF08${kind}\uFF09`}`;
    if (present(selected) && selected !== runningVersion) return `${head}\uFF08\u5DF2\u9009\u62E9 ${selected}\uFF0C\u91CD\u542F\u540E\u751F\u6548\uFF09`;
    return head;
  }
  if (present(selected)) return `\u5F53\u524D\u4F7F\u7528\uFF1A\u8FD0\u884C\u65F6 ${selected}${present(builtin) ? `\uFF08\u5185\u7F6E\u515C\u5E95 ${builtin}\uFF09` : ""}`;
  if (present(builtin)) return `\u5F53\u524D\u4F7F\u7528\uFF1A\u5185\u7F6E dsh ${builtin}\uFF08\u515C\u5E95\uFF09`;
  return "\u5F53\u524D\u65E0\u53EF\u7528 dsh";
}
function isRuntimeInUse(input, version) {
  const runningVersion = input.running?.version ?? null;
  if (present(runningVersion)) return runningVersion === version;
  const builtin = input.builtin ?? null;
  return present(builtin) && builtin === version;
}
function runtimeDownloadButtonLabel(entry) {
  if (entry === "downloading") return "\u4E0B\u8F7D\u4E2D\u2026";
  if (entry === "downloaded") return "\u5DF2\u4E0B\u8F7D";
  if (entry !== void 0 && typeof entry === "object") {
    return "cancelled" in entry ? "\u5DF2\u53D6\u6D88 \xB7 \u91CD\u8BD5\u4E0B\u8F7D" : "\u91CD\u8BD5\u4E0B\u8F7D";
  }
  return "\u4E0B\u8F7D";
}
function runtimeDownloadHint(entry) {
  if (entry === void 0 || typeof entry === "string") return "";
  return "cancelled" in entry ? "\u4E0B\u8F7D\u5DF2\u53D6\u6D88" : entry.failed;
}

// src/client/desktop-settings/cards/runtime-card.tsx
var import_jsx_runtime16 = require("react/jsx-runtime");
function RuntimeCard({ notify }) {
  const [runtimeSource, setRuntimeSource] = (0, import_react15.useState)("github");
  const [runtimeStatus, setRuntimeStatus] = (0, import_react15.useState)({ state: "loading", text: "\u8BFB\u53D6\u4E2D\u2026" });
  const [runtimeCatalog, setRuntimeCatalog] = (0, import_react15.useState)(null);
  const [runtimeDownloading, setRuntimeDownloading] = (0, import_react15.useState)({});
  const [dlProgress, setDlProgress] = (0, import_react15.useState)(null);
  const [runtimeExpanded, setRuntimeExpanded] = (0, import_react15.useState)(false);
  const [removingVersion, setRemovingVersion] = (0, import_react15.useState)(null);
  const refreshRuntimes = (0, import_react15.useCallback)(async () => {
    setRuntimeStatus({ state: "loading", text: "\u8BFB\u53D6\u7248\u672C\u76EE\u5F55\u4E2D\u2026" });
    try {
      const s = await invoke("list_runtime_catalog", { source: runtimeSource });
      setRuntimeCatalog(s);
      setRuntimeStatus(
        s.error ? { state: "error", text: `\u76EE\u5F55\u62C9\u53D6\u5931\u8D25\uFF1A${s.error}\uFF08\u4EC5\u663E\u793A\u5DF2\u4E0B\u8F7D\u7248\u672C\uFF09` } : { state: "ok" }
      );
      setRuntimeDownloading({});
    } catch (err) {
      setRuntimeStatus({ state: "error", text: `\u7248\u672C\u76EE\u5F55\u8BFB\u53D6\u5931\u8D25\uFF1A${String(err)}` });
    }
  }, [runtimeSource]);
  (0, import_react15.useEffect)(() => {
    void invoke("runtime_download_status").then((s) => {
      if (s.active && s.version) {
        setRuntimeDownloading((prev) => ({ ...prev, [s.version]: "downloading" }));
      }
    }).catch(() => {
    });
  }, []);
  (0, import_react15.useEffect)(() => {
    void refreshRuntimes();
  }, [refreshRuntimes]);
  const handleDownloadRuntime = (version) => {
    setRuntimeDownloading((prev) => ({ ...prev, [version]: "downloading" }));
    void invoke("download_runtime", { source: runtimeSource, version }, { noTimeout: true }).then(() => {
      void refreshRuntimes();
    }).catch((err) => {
      const text = String(err);
      if (text.includes("\u5DF2\u6709\u8FD0\u884C\u65F6\u4E0B\u8F7D\u4EFB\u52A1")) {
        setRuntimeDownloading((prev) => {
          const next = { ...prev };
          delete next[version];
          return next;
        });
        return;
      }
      const reason = stripDownloadErrorPrefix(text);
      setRuntimeDownloading((prev) => ({ ...prev, [version]: { failed: reason || "\u672A\u77E5\u9519\u8BEF" } }));
      showToast(`dsh ${version} \u4E0B\u8F7D\u5931\u8D25\uFF1A${reason || "\u672A\u77E5\u9519\u8BEF"}`, false);
    });
  };
  const handleCancelRuntimeDownload = (version) => {
    void invoke("cancel_runtime_download", {}, { noTimeout: true }).then((r) => {
      if (r.cancelled) showToast(`\u6B63\u5728\u53D6\u6D88 dsh ${version} \u4E0B\u8F7D\u2026`, true, "info");
    }).catch((err) => showToast(`\u53D6\u6D88\u5931\u8D25\uFF1A${String(err)}`, false));
  };
  (0, import_react15.useEffect)(() => {
    let sawActive = false;
    const timer = setInterval(() => {
      void invoke("runtime_download_status").then((s) => {
        const decision = decideRuntimeDownload(s, sawActive);
        if (s.active) sawActive = true;
        else if (sawActive) sawActive = false;
        setDlProgress(decision.progress);
        const entry = decision.entry;
        if (entry !== null) {
          const version = entry.version;
          if ("remove" in entry) {
            setRuntimeDownloading((prev) => {
              if (prev[version] === void 0) return prev;
              const next = { ...prev };
              delete next[version];
              return next;
            });
          } else {
            const value = entry.value;
            setRuntimeDownloading(
              (prev) => (
                // 同值不重写：否则每 600ms 一拍会把终态反复重置，失败原因闪一下就没
                sameDownloadEntry(prev[version], value) ? prev : { ...prev, [version]: value }
              )
            );
          }
        }
        const toast = decision.toast;
        if (toast !== null) {
          showToast(toast.text, toast.tone === "ok", toast.tone === "info" ? "info" : void 0);
          void refreshRuntimes();
        }
      }).catch(() => {
      });
    }, 600);
    return () => clearInterval(timer);
  }, [refreshRuntimes]);
  const handleSwitchRuntime = (version) => {
    void nsSave({ dsh_runtime: version, dsh_mode: "builtin" }).then(() => invoke("restart_dsh_service")).then(() => {
      notify({ ok: true, text: `\u5DF2\u5207\u6362\u5230 dsh ${version}\uFF0C\u6B63\u5728\u91CD\u542F\u2026` });
      void refreshRuntimes();
    }).catch((err) => notify({ ok: false, text: `\u5207\u6362\u5931\u8D25\uFF1A${String(err)}` }));
  };
  const handleRemoveRuntime = (version) => {
    if (removingVersion) return;
    if (!window.confirm(`\u5378\u8F7D\u8FD0\u884C\u65F6 dsh ${version}\uFF1F\u5C06\u5220\u9664\u672C\u5730\u5DF2\u4E0B\u8F7D\u6587\u4EF6\uFF0C\u4E0D\u53EF\u6062\u590D\u3002`)) return;
    setRemovingVersion(version);
    invoke("remove_runtime", { version }).then(() => {
      notify({ ok: true, text: `\u5DF2\u5378\u8F7D\u8FD0\u884C\u65F6 dsh ${version}` });
      void refreshRuntimes();
    }).catch((err) => notify({ ok: false, text: `\u5378\u8F7D\u5931\u8D25\uFF1A${String(err)}` })).finally(() => setRemovingVersion(null));
  };
  return /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(SectionBox, { title: "dsh \u8FD0\u884C\u65F6\uFF08\u7248\u672C\u4E0B\u8F7D / \u5207\u6362\uFF09", children: [
    /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(
      ThemeSelect,
      {
        style: { marginBottom: 8 },
        value: runtimeSource,
        onChange: (v) => setRuntimeSource(v),
        options: [
          { value: "github", label: "\u4E0B\u8F7D\u6E90\uFF1AGitHub Releases" },
          { value: "npm", label: "\u4E0B\u8F7D\u6E90\uFF1Anpm registry" }
        ]
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(PfBtn, { variant: "ghost", onClick: () => void refreshRuntimes(), children: "\u5237\u65B0\u7248\u672C\u76EE\u5F55" }),
    /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("div", { style: { marginTop: 8 }, children: [
      runtimeStatus.state === "error" && runtimeStatus.text && /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("div", { style: DANGER_NOTE_STYLE, children: runtimeStatus.text }),
      runtimeCatalog && /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(import_jsx_runtime16.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("div", { style: { marginBottom: 6 }, children: currentRuntimeLine({
          selected: runtimeCatalog.selected,
          builtin: runtimeCatalog.builtin,
          running: runtimeCatalog.running
        }) }),
        runtimeCatalog.note && /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("div", { style: { ...DANGER_NOTE_STYLE, marginBottom: 6, whiteSpace: "pre-wrap" }, children: `\u26A0 ${runtimeCatalog.note}` }),
        (() => {
          const all = runtimeCatalog.candidates;
          const seen = /* @__PURE__ */ new Set();
          const remoteRows = all.filter((c) => c.source === "remote");
          const heads = [];
          for (const ch of ["latest", "alpha", "rc"]) {
            const e = remoteRows.find((c) => c.channel === ch);
            if (e && !seen.has(e.version)) {
              seen.add(e.version);
              heads.push(e);
            }
          }
          const localRows = all.filter((c) => c.local && !seen.has(c.version));
          const rest = all.filter((c) => !seen.has(c.version) && !c.local);
          const visible = runtimeExpanded ? all : [...heads, ...localRows];
          return /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(import_jsx_runtime16.Fragment, { children: [
            visible.map((c) => {
              const installed = runtimeCatalog.installed.some((i) => i.version === c.version);
              const isBuiltin = runtimeCatalog.builtin === c.version;
              const isRunning = runtimeCatalog.running?.version !== null && runtimeCatalog.running?.version !== void 0 && runtimeCatalog.running.version === c.version;
              const available = installed || isBuiltin || isRunning;
              const isCurrent = isRuntimeInUse(
                {
                  selected: runtimeCatalog.selected,
                  builtin: runtimeCatalog.builtin,
                  running: runtimeCatalog.running
                },
                c.version
              );
              const tags = [];
              if (c.channel) tags.push(c.channel);
              if (isBuiltin) tags.push("\u5185\u7F6E");
              else if (installed) tags.push("\u5DF2\u4E0B\u8F7D");
              if (isRunning) tags.push("\u8FD0\u884C\u4E2D");
              const downloadState = runtimeDownloading[c.version];
              const failedReason = runtimeDownloadHint(downloadState);
              const pct = dlProgress && dlProgress.version === c.version && dlProgress.resolved > 0 ? Math.min(100, Math.round(dlProgress.downloaded / dlProgress.resolved * 100)) : 0;
              return /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("div", { style: { margin: "4px 0" }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(
                  "div",
                  {
                    style: {
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center"
                    },
                    children: [
                      /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("span", { children: `${c.version}${tags.length ? "\uFF08" + tags.join(" \xB7 ") + "\uFF09" : ""}` }),
                      !available ? /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("div", { style: { display: "flex", gap: 6, alignItems: "center" }, children: [
                        /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(
                          PfBtn,
                          {
                            variant: "ghost",
                            disabled: downloadState === "downloading",
                            onClick: () => handleDownloadRuntime(c.version),
                            children: runtimeDownloadButtonLabel(downloadState)
                          }
                        ),
                        downloadState === "downloading" && /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(PfBtn, { variant: "ghost", onClick: () => handleCancelRuntimeDownload(c.version), children: "\u53D6\u6D88" })
                      ] }) : /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("div", { style: { display: "flex", gap: 6, alignItems: "center" }, children: [
                        /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(
                          PfBtn,
                          {
                            variant: "ghost",
                            disabled: isCurrent,
                            onClick: () => handleSwitchRuntime(c.version),
                            children: isCurrent ? "\u4F7F\u7528\u4E2D" : "\u5207\u6362\u5230\u6B64\u7248\u672C"
                          }
                        ),
                        !isBuiltin && /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(
                          PfBtn,
                          {
                            variant: "danger",
                            disabled: removingVersion !== null || isRunning || runtimeCatalog.selected === c.version,
                            title: isRunning ? "\u6B63\u5728\u8FD0\u884C\u7684\u7248\u672C\u4E0D\u53EF\u5378\u8F7D" : runtimeCatalog.selected === c.version ? "\u4F7F\u7528\u4E2D\u7684\u7248\u672C\u4E0D\u53EF\u5378\u8F7D\uFF0C\u8BF7\u5148\u5207\u6362" : "\u5220\u9664\u672C\u5730\u5DF2\u4E0B\u8F7D\u7684\u8FD0\u884C\u65F6",
                            onClick: () => handleRemoveRuntime(c.version),
                            children: removingVersion === c.version ? "\u5378\u8F7D\u4E2D\u2026" : "\u5378\u8F7D"
                          }
                        )
                      ] })
                    ]
                  }
                ),
                downloadState === "downloading" && /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("div", { style: { marginTop: 4 }, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(
                    "div",
                    {
                      style: {
                        height: 6,
                        borderRadius: 4,
                        background: "var(--dsw-alias-bg-base,#111)",
                        overflow: "hidden"
                      },
                      children: /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(
                        "div",
                        {
                          style: {
                            height: "100%",
                            width: `${pct}%`,
                            background: "var(--dsw-alias-state-accent-primary,#3b82f6)",
                            transition: "width .3s"
                          }
                        }
                      )
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("div", { style: NOTE_STYLE, children: dlProgress && dlProgress.version === c.version ? `\u5B89\u88C5\u4F9D\u8D56\uFF1A\u5DF2\u4E0B\u8F7D ${dlProgress.downloaded} / ${dlProgress.resolved || "\u2026"} \u4E2A\u5305${dlProgress.resolved > 0 ? `\uFF08${pct}%\uFF09` : ""}` : "\u51C6\u5907\u4E2D\u2026" })
                ] }),
                failedReason && /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(
                  "div",
                  {
                    style: {
                      // #97：取消是中性终态，不能穿红色警告色、也不能顶着「下载失败：」的前缀
                      ...downloadState !== void 0 && typeof downloadState === "object" && "cancelled" in downloadState ? NOTE_STYLE : DANGER_NOTE_STYLE,
                      marginTop: 4,
                      whiteSpace: "pre-wrap"
                    },
                    children: failedReason
                  }
                )
              ] }, c.version);
            }),
            rest.length > 0 && !runtimeExpanded && /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(PfBtn, { variant: "ghost", style: { marginTop: 4 }, onClick: () => setRuntimeExpanded(true), children: [
              "\u5C55\u5F00\u5168\u90E8 ",
              all.length,
              " \u4E2A\u7248\u672C \u25BE"
            ] }),
            runtimeExpanded && /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(PfBtn, { variant: "ghost", style: { marginTop: 4 }, onClick: () => setRuntimeExpanded(false), children: "\u6536\u8D77\u7248\u672C\u5217\u8868 \u25B4" })
          ] });
        })()
      ] })
    ] })
  ] });
}

// src/client/desktop-settings/cards/service-address-card.tsx
var import_react16 = require("react");

// src/client/desktop-settings/format.ts
function fmtBytes2(bytes) {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function normalizeRemote(input) {
  const t = input.trim();
  if (!t) return null;
  if (/^https?:\/\//.test(t)) return t;
  if (/^socks5:\/\//.test(t)) return t;
  if (/^[A-Za-z0-9.-]+(:\d+)?$/.test(t)) return `https://${t}`;
  return null;
}

// src/client/desktop-settings/cards/service-address-card.tsx
var import_jsx_runtime17 = require("react/jsx-runtime");
function ServiceAddressCard({
  desktop,
  refreshData,
  notify
}) {
  const [newRemoteUrl, setNewRemoteUrl] = (0, import_react16.useState)("");
  const handleSelectRemote = (addr) => {
    void (async () => {
      try {
        await nsSave({ remote_addr: addr });
        await invoke("restart_dsh_service");
        notify({ ok: true, text: "\u5DF2\u5207\u6362 dsh \u670D\u52A1\u6765\u6E90\uFF0C\u6B63\u5728\u91CD\u542F\u2026" });
      } catch (err) {
        notify({ ok: false, text: `\u5207\u6362\u5931\u8D25\uFF1A${String(err)}` });
      }
    })();
  };
  const handleAddRemote = () => {
    const addr = normalizeRemote(newRemoteUrl);
    if (!addr) {
      notify({ ok: false, text: "\u5730\u5740\u975E\u6CD5\uFF1A\u9700 dsh web \u5B8C\u6574 URL\uFF08\u542B token\uFF09\u6216 host[:port]" });
      return;
    }
    void (async () => {
      try {
        const list = Array.isArray(desktop.remote_list) ? [...desktop.remote_list] : [];
        if (!list.includes(addr)) list.push(addr);
        await nsSave({ remote_list: list });
        setNewRemoteUrl("");
        notify({ ok: true, text: `\u5DF2\u65B0\u589E\u5730\u5740\uFF1A${addr}\uFF08\u672A\u5207\u6362\uFF0C\u8BF7\u5728\u4E0B\u62C9\u6846\u9009\u62E9\uFF09` });
        await refreshData();
      } catch (err) {
        notify({ ok: false, text: `\u65B0\u589E\u5931\u8D25\uFF1A${String(err)}` });
      }
    })();
  };
  const handleRemoveRemote = (addr) => {
    void (async () => {
      try {
        const list = (desktop.remote_list ?? []).filter((a) => a !== addr);
        const patch = { remote_list: list };
        if (desktop.remote_addr === addr) patch.remote_addr = null;
        await nsSave(patch);
        notify({ ok: true, text: `\u5DF2\u5220\u9664\uFF1A${addr}` });
      } catch (err) {
        notify({ ok: false, text: `\u5220\u9664\u5931\u8D25\uFF1A${String(err)}` });
      }
      await refreshData();
    })();
  };
  return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(SectionBox, { title: "dsh \u670D\u52A1\u5730\u5740", children: [
    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
      ThemeSelect,
      {
        style: { marginBottom: 8 },
        value: desktop.remote_addr ?? "",
        onChange: (v) => handleSelectRemote(v || null),
        options: [
          { value: "", label: "\u672C\u5730\uFF08127.0.0.1\uFF09" },
          ...(desktop.remote_list ?? []).map((addr) => ({ value: addr, label: addr }))
        ]
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { style: ROW_STYLE, children: [
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
        "input",
        {
          placeholder: "\u65B0\u589E\uFF1Adsh web \u6253\u5370\u7684\u5B8C\u6574 URL\uFF08\u542B token\uFF09\u6216 host[:port]",
          className: "pf-input",
          style: FLEX_1_STYLE,
          "data-desktop-settings": "remote-add",
          value: newRemoteUrl,
          onChange: (e) => setNewRemoteUrl(e.target.value.trim())
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(PfBtn, { variant: "ghost", onClick: handleAddRemote, children: "\u65B0\u589E" })
    ] }),
    desktop.remote_list.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }, children: desktop.remote_list.map((addr) => /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
      PfBtn,
      {
        variant: "danger",
        style: { fontSize: 11 },
        onClick: () => handleRemoveRemote(addr),
        children: [
          "\u5220\u9664\uFF1A",
          addr
        ]
      },
      addr
    )) }),
    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { style: NOTE_STYLE, children: "\u9009\u62E9\u8FDC\u7A0B\u5730\u5740\u540E\u7ACB\u5373\u6309\u5F53\u524D\u6A21\u5F0F\u91CD\u542F dsh\uFF1B\u65B0\u589E/\u5220\u9664\u4EC5\u6539\u5217\u8868\uFF0C\u91CD\u542F\u540E\u751F\u6548\u3002" }),
    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { style: NOTE_STYLE, children: "\u6B64\u5904\u7684\u5730\u5740\u662F\u684C\u9762\u58F3\u8FDE\u63A5\u7684 dsh \u670D\u52A1\u6765\u6E90\uFF08\u58F3\u5C06\u76F4\u8FDE\u8BE5\u5730\u5740\uFF0C\u4E0D\u518D\u62C9\u8D77\u672C\u5730\u670D\u52A1\uFF09\uFF1B\u82E5\u8981\u7ED9\u624B\u673A/\u5176\u5B83\u8BBE\u5907\u8FDE\u63A5\u672C\u673A\uFF0C\u8BF7\u7528\u300C\u624B\u673A\u8BBF\u95EE \u2192 \u8FDC\u7A0B\u8BBF\u95EE\u300D\u3002" })
  ] });
}

// src/client/desktop-settings/cards/source-card.tsx
var import_react17 = require("react");
var import_jsx_runtime18 = require("react/jsx-runtime");
function SourceCard() {
  const [sourceState, setSourceState] = (0, import_react17.useState)(null);
  const [sourceError, setSourceError] = (0, import_react17.useState)(null);
  const refreshSource = (0, import_react17.useCallback)(async () => {
    setSourceError(null);
    try {
      const s = await invoke("get_dsh_source");
      setSourceState(s);
    } catch (err) {
      setSourceError(String(err));
    }
  }, []);
  (0, import_react17.useEffect)(() => {
    void refreshSource();
  }, [refreshSource]);
  const sourceInfoText = (() => {
    if (!sourceState) return "";
    const parts = [];
    if (sourceState.running) {
      const runVer = sourceState.running.version || (sourceState.builtin?.dsh_version ?? "");
      const origin = sourceState.running.origin === "shell" ? "\u672C\u58F3 spawn" : "\u590D\u7528\u63A5\u5165";
      parts.push(`\u5F53\u524D\u8FD0\u884C\uFF1A\u5185\u7F6E dsh ${runVer}\uFF08${origin} \xB7 port ${sourceState.running.port}\uFF09`);
    } else {
      parts.push("\u5F53\u524D\u65E0\u8FD0\u884C\u4E2D\u7684 dsh \u5B9E\u4F8B\uFF1B\u4E0B\u6B21\u542F\u52A8\u5C06\u4F7F\u7528\u5185\u7F6E\u6811");
    }
    if (sourceState.builtin) parts.push(`\u5185\u7F6E\u53EF\u7528\uFF1Adsh ${sourceState.builtin.dsh_version}`);
    return parts.join(" \xB7 ");
  })();
  return /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(SectionBox, { title: "dsh \u6765\u6E90", children: [
    sourceState ? /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("div", { style: NOTE_STYLE, children: sourceInfoText }) : sourceError ? /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)("div", { style: DANGER_NOTE_STYLE, children: [
      "\u68C0\u6D4B\u5931\u8D25\uFF1A",
      sourceError
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("div", { style: NOTE_STYLE, children: "\u68C0\u6D4B\u4E2D\u2026" }),
    /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("div", { style: { marginTop: 8 }, children: /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(PfBtn, { variant: "ghost", onClick: () => void refreshSource(), children: "\u91CD\u65B0\u68C0\u6D4B" }) }),
    /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("div", { style: NOTE_STYLE, children: "\u5185\u7F6E\uFF1A\u968F\u5E94\u7528\u5206\u53D1\u7684 dsh \u4F9D\u8D56\u6811 + Node\uFF0C\u76F4\u8C03\u5185\u90E8\u542F\u52A8\u63A5\u53E3\uFF08\u4E0D\u4F9D\u8D56\u7CFB\u7EDF\u73AF\u5883\uFF09\u3002" })
  ] });
}

// src/client/desktop-settings/cards/update-card.tsx
var import_react18 = require("react");

// src/client/features/update-notice-settings.ts
var KIND_LABELS = {
  shell: "\u684C\u9762\u58F3",
  runtime: "DSH \u8FD0\u884C\u65F6"
};
var isRecord2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var versionOrNull = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : null;
function parseUpdateNoticeState(raw) {
  if (!isRecord2(raw)) return null;
  const ignored = Array.isArray(raw.ignored) ? [...new Set(raw.ignored.filter((v) => typeof v === "string" && v.trim() !== "").map((v) => v.trim()))] : [];
  const last = isRecord2(raw.lastNotified) ? raw.lastNotified : {};
  return {
    enabled: raw.enabled !== false,
    ignored,
    lastNotified: { shell: versionOrNull(last.shell), runtime: versionOrNull(last.runtime) }
  };
}
function parseIgnoredKey(key) {
  const at = key.indexOf(":");
  if (at <= 0) return { kind: null, version: key };
  const prefix = key.slice(0, at);
  const version = key.slice(at + 1).trim();
  if (version === "") return { kind: null, version: key };
  return prefix === "shell" || prefix === "runtime" ? { kind: prefix, version } : { kind: null, version: key };
}
function ignoredRows(ignored) {
  const rows = [...new Set(ignored)].map((key) => {
    const { kind, version } = parseIgnoredKey(key);
    return { key, kind, version, label: kind === null ? key : `${KIND_LABELS[kind]} ${version}` };
  });
  const rank = (row) => row.kind === "shell" ? 0 : row.kind === "runtime" ? 1 : 2;
  return rows.sort((a, b) => rank(a) - rank(b) || b.version.localeCompare(a.version, void 0, { numeric: true }));
}
function updateNoticeEnabledHint(enabled) {
  return enabled ? "\u5E94\u7528\u542F\u52A8\u540E\u4F1A\u68C0\u67E5\u684C\u9762\u58F3\u4E0E DSH \u8FD0\u884C\u65F6\u7248\u672C\uFF0C\u6709\u65B0\u7248\u672C\u65F6\u5728\u5E94\u7528\u5185\u5F39\u7A97\u63D0\u9192\uFF08\u540C\u4E00\u7248\u672C\u53EA\u63D0\u9192\u4E00\u6B21\uFF0C\u51FA\u73B0\u66F4\u9AD8\u7248\u672C\u624D\u518D\u5F39\uFF09\u3002\u6258\u76D8\u91CC\u7684\u300C\u68C0\u67E5\u66F4\u65B0\u300D\u968F\u65F6\u53EF\u7528\u3002" : "\u5173\u6389\u540E\u542F\u52A8\u4E0D\u518D\u5F39\u63D0\u9192\u3002\u6258\u76D8\u91CC\u7684\u300C\u68C0\u67E5\u66F4\u65B0\u300D\u968F\u65F6\u53EF\u7528\u2014\u2014\u624B\u52A8\u68C0\u67E5\u4E0D\u53D7\u8FD9\u4E2A\u5F00\u5173\u7EA6\u675F\u3002";
}
function ignoredEmptyHint() {
  return "\u6CA1\u6709\u88AB\u5FFD\u7565\u7684\u7248\u672C\u3002";
}

// src/client/desktop-settings/cards/update-card.tsx
var import_jsx_runtime19 = require("react/jsx-runtime");
function UpdateCard() {
  const [updateState, setUpdateState] = (0, import_react18.useState)(null);
  const updateBusy = updateState !== null && (updateState.view.phase === "checking" || updateState.view.phase === "downloading" || updateState.view.phase === "preparing");
  const runUpdate = (cmd) => {
    void invoke(cmd).then((snapshot) => {
      setUpdateState(snapshot);
      showToast(snapshot.view.label, snapshot.view.phase !== "error");
    }).catch((e) => showToast(`\u66F4\u65B0\u5931\u8D25\uFF1A${String(e)}`, false));
  };
  (0, import_react18.useEffect)(() => {
    let cancelled = false;
    void invoke("get_update_state").then((snapshot) => {
      if (!cancelled) setUpdateState(snapshot);
    }).catch(() => {
    });
    return () => {
      cancelled = true;
    };
  }, []);
  (0, import_react18.useEffect)(() => {
    if (!updateBusy) return;
    const timer = setInterval(() => {
      void invoke("get_update_state").then(setUpdateState).catch(() => {
      });
    }, 1e3);
    return () => clearInterval(timer);
  }, [updateBusy]);
  const [updateNotice, setUpdateNotice] = (0, import_react18.useState)(null);
  const [updateNoticeError, setUpdateNoticeError] = (0, import_react18.useState)(null);
  const refreshUpdateNotice = () => {
    void invoke("get_update_notice_state").then((raw) => {
      setUpdateNotice(parseUpdateNoticeState(raw));
      setUpdateNoticeError(null);
    }).catch((e) => setUpdateNoticeError(String(e)));
  };
  (0, import_react18.useEffect)(() => {
    refreshUpdateNotice();
  }, []);
  const afterUpdateNoticeWrite = (raw) => {
    setUpdateNotice(parseUpdateNoticeState(raw));
    setUpdateNoticeError(null);
  };
  const failUpdateNoticeWrite = (e) => setUpdateNoticeError(String(e));
  const handleToggleUpdateNotice = (enabled) => {
    setUpdateNotice((prev) => prev === null ? prev : { ...prev, enabled });
    void invoke("set_update_notice_enabled", { enabled }).then(afterUpdateNoticeWrite).catch((e) => {
      failUpdateNoticeWrite(e);
      refreshUpdateNotice();
    });
  };
  const handleRestoreIgnored = (row) => {
    if (row.kind === null) return;
    void invoke("restore_update_notice", {
      targets: [{ kind: row.kind, version: row.version }]
    }).then(afterUpdateNoticeWrite).catch(failUpdateNoticeWrite);
  };
  const handleClearIgnored = () => {
    void invoke("clear_update_notice_ignored").then(afterUpdateNoticeWrite).catch(failUpdateNoticeWrite);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(SectionBox, { title: "\u5E94\u7528\u66F4\u65B0", children: [
    /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { style: NOTE_STYLE, children: updateState === null ? "\u8BFB\u53D6\u4E2D\u2026" : `\u5F53\u524D\u7248\u672C ${updateState.view.current || "\u672A\u77E5"}${updateState.view.channel ? `\uFF08${updateState.view.channel}\uFF09` : ""} \xB7 ${updateState.view.label}` }),
    updateState !== null && updateState.view.message !== "" && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { style: NOTE_STYLE, children: updateState.view.message }),
    updateState !== null && updateState.actions.hint !== "" && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { style: NOTE_STYLE, children: updateState.actions.hint }),
    updateState !== null && !updateState.available && updateState.reason !== "" && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { style: NOTE_STYLE, children: updateState.reason }),
    updateState !== null && updateState.view.error !== "" && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { style: DANGER_NOTE_STYLE, children: updateState.view.error }),
    updateBusy && updateState !== null && updateState.view.progress !== null && /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { style: NOTE_STYLE, children: [
      "\u8FDB\u5EA6 ",
      updateState.view.progress,
      "%",
      updateState.view.totalBytes !== null ? `\uFF08${fmtBytes2(updateState.view.bytesDownloaded)} / ${fmtBytes2(updateState.view.totalBytes)}\uFF09` : ""
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { style: { display: "flex", gap: 8, marginTop: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
        PfBtn,
        {
          variant: "ghost",
          disabled: updateState === null || !updateState.actions.canCheck,
          onClick: () => runUpdate("check_update"),
          children: "\u68C0\u67E5\u66F4\u65B0"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
        PfBtn,
        {
          variant: "ghost",
          disabled: updateState === null || !updateState.actions.canDownload,
          onClick: () => runUpdate("download_update"),
          children: "\u4E0B\u8F7D\u66F4\u65B0"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
        PfBtn,
        {
          variant: "ghost",
          disabled: updateState === null || !updateState.actions.canApply,
          onClick: () => runUpdate("apply_update"),
          children: "\u91CD\u542F\u5E76\u5B89\u88C5"
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { style: { ...ROW_STYLE, marginTop: 16 }, children: /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
        "input",
        {
          type: "checkbox",
          "data-desktop-settings": "update-notice-enabled",
          checked: updateNotice?.enabled ?? false,
          disabled: updateNotice === null,
          onChange: (e) => handleToggleUpdateNotice(e.target.checked)
        }
      ),
      "\u542F\u52A8\u65F6\u6709\u65B0\u7248\u672C\u5C31\u63D0\u9192\uFF08\u7F3A\u7701\u5F00\uFF09"
    ] }) }),
    updateNoticeError !== null && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { style: DANGER_NOTE_STYLE, children: updateNoticeError }),
    updateNotice !== null && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { style: NOTE_STYLE, children: updateNoticeEnabledHint(updateNotice.enabled) }),
    updateNotice !== null && /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { style: { marginTop: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { style: { fontWeight: 600, marginBottom: 4 }, children: "\u5DF2\u5FFD\u7565\u7684\u7248\u672C" }),
      (() => {
        const rows = ignoredRows(updateNotice.ignored);
        if (rows.length === 0) return /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { style: NOTE_STYLE, children: ignoredEmptyHint() });
        return /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { children: [
          rows.map((row) => /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { style: { ...ROW_STYLE, marginBottom: 4 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { style: FLEX_1_STYLE, children: row.label }),
            /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
              PfBtn,
              {
                variant: "ghost",
                disabled: row.kind === null,
                onClick: () => handleRestoreIgnored(row),
                children: "\u6062\u590D"
              }
            )
          ] }, row.key)),
          /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { style: NOTE_STYLE, children: "\u6807\u300C\u672A\u77E5\u6765\u6E90\u300D\u7684\u6761\u76EE\u662F\u65E9\u671F\u683C\u5F0F\u5199\u7684\uFF0C\u6CA1\u6CD5\u5355\u72EC\u6062\u590D\uFF0C\u7528\u300C\u6E05\u7A7A\u5168\u90E8\u300D\u4E00\u5E76\u6E05\u6389\u3002" }),
          /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { style: { marginTop: 4 }, children: /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(PfBtn, { variant: "ghost", onClick: handleClearIgnored, children: "\u6E05\u7A7A\u5168\u90E8" }) })
        ] });
      })()
    ] })
  ] });
}

// src/client/desktop-settings.tsx
var import_jsx_runtime20 = require("react/jsx-runtime");
function DesktopSettingsPanel() {
  const [msg, setMsg] = (0, import_react19.useState)(null);
  const notify = (0, import_react19.useCallback)((m) => setMsg(m), []);
  (0, import_react19.useEffect)(() => {
    if (msg && msg.ok) {
      const t = window.setTimeout(() => setMsg(null), 4e3);
      return () => window.clearTimeout(t);
    }
  }, [msg]);
  const [downloadBoxNote, setDownloadBoxNote] = (0, import_react19.useState)(null);
  (0, import_react19.useEffect)(() => {
    ensureStyles();
  }, []);
  const { data, loaded, refreshData, taskInfo } = usePanelData((text) => notify({ ok: false, text }));
  const { desktop, proxy, proxyEffective, loopbackAggregation } = data;
  return /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)("div", { "data-desktop-settings": "", style: ROOT_STYLE, children: [
    taskInfo && /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(
      "div",
      {
        style: {
          padding: "8px 12px",
          borderRadius: 8,
          marginBottom: 10,
          fontSize: 12,
          background: "var(--dsw-alias-bg-base,#16181d)",
          border: taskInfo.finished ? taskInfo.error ? "1px solid rgba(239,68,68,.6)" : "1px solid rgba(34,197,94,.5)" : "1px solid var(--dsw-alias-border-neutral,#2a2e37)"
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)("div", { style: { fontWeight: 600, marginBottom: 4 }, children: [
            taskInfo.running ? "\u23F3 " : taskInfo.error ? "\u2717 " : "\u2713 ",
            taskInfo.title
          ] }),
          taskInfo.running && /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(import_jsx_runtime20.Fragment, { children: [
            /* @__PURE__ */ (0, import_jsx_runtime20.jsx)("div", { style: { opacity: 0.8 }, children: taskInfo.stage || "\u51C6\u5907\u4E2D\u2026" }),
            taskInfo.total > 0 && /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(import_jsx_runtime20.Fragment, { children: [
              /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
                "div",
                {
                  style: {
                    height: 5,
                    borderRadius: 3,
                    marginTop: 6,
                    overflow: "hidden",
                    background: "rgba(127,127,127,.25)"
                  },
                  children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
                    "div",
                    {
                      style: {
                        height: "100%",
                        width: `${Math.min(100, Math.round(taskInfo.done / taskInfo.total * 100))}%`,
                        background: "var(--dsw-alias-state-accent-primary,#3b82f6)",
                        transition: "width .3s"
                      }
                    }
                  )
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)("div", { style: { opacity: 0.6, marginTop: 3 }, children: [
                taskInfo.done,
                "/",
                taskInfo.total
              ] })
            ] })
          ] }),
          taskInfo.finished && taskInfo.error && /* @__PURE__ */ (0, import_jsx_runtime20.jsx)("div", { style: { color: "#f87171", whiteSpace: "pre-wrap" }, children: taskInfo.error }),
          taskInfo.finished && !taskInfo.error && taskInfo.result && /* @__PURE__ */ (0, import_jsx_runtime20.jsx)("div", { style: { opacity: 0.85 }, children: taskInfo.result })
        ]
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(SourceCard, {}),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(ServiceAddressCard, { desktop, refreshData, notify }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(ProfileCard, { desktop, notify }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(ProfilePortsCard, { loaded }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(MigrationCard, { profiles: desktop.profiles, loaded, notify }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(DiagnosticsCard, {}),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(UpdateCard, {}),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(RuntimeCard, { notify }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(DependenciesCard, {}),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(DownloadCard, { note: downloadBoxNote, onNote: setDownloadBoxNote }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(MobileAccessCard, { desktop, onNote: setDownloadBoxNote }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(LoopbackAggregationCard, { value: loopbackAggregation }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(PowerCard, { desktop }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(DevToolsCard, { desktop }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
      ProxyCard,
      {
        proxy,
        proxyEffective,
        loaded,
        notify
      }
    ),
    msg && /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
      "div",
      {
        style: {
          position: "fixed",
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 99999,
          padding: "10px 20px",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 500,
          maxWidth: 480,
          boxShadow: "0 4px 12px rgba(0,0,0,.4)",
          cursor: "pointer",
          background: msg.ok ? "rgba(34,197,94,.15)" : "rgba(239,68,68,.15)",
          border: `1px solid ${msg.ok ? "rgba(34,197,94,.6)" : "rgba(239,68,68,.6)"}`,
          color: msg.ok ? "#4ade80" : "#f87171",
          backdropFilter: "blur(8px)"
        },
        onClick: () => setMsg(null),
        children: msg.text
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
      "div",
      {
        style: {
          ...NOTE_STYLE,
          marginTop: 2,
          paddingTop: 10,
          borderTop: "1px solid var(--dsw-alias-border-l2, #ffffff1f)"
        },
        children: "\u670D\u52A1\u5730\u5740/Profile \u5207\u6362\u4F1A\u7ACB\u5373\u91CD\u542F dsh\uFF1B\u7AEF\u53E3\u4E0E\u4EE3\u7406\u5728\u4E0B\u6B21\u91CD\u542F\u540E\u751F\u6548\u3002"
      }
    )
  ] });
}
function registerDesktopSettings(ctx) {
  if (!shellRpc.available()) return;
  captureNsRpc(ctx);
  const slots = ctx.slots;
  if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return;
  slots.inject(
    "settings.section",
    () => slots.register(
      { name: "settings.section", id: "dsh-desktop-settings", order: 40, label: () => "\u684C\u9762\u8BBE\u7F6E" },
      DesktopSettingsPanel
    )
  );
  void invokeCommand("get_pending_active_profile").then((profile) => {
    if (profile && hasNsRpc()) {
      void nsSave({ active_profile: profile }).catch(() => {
      });
    }
  }).catch(() => {
  });
  void invokeCommand("check_startup_needed").then((res) => runStartupFlow(res, showToast)).catch(() => {
  });
}

// src/client/features/notifications-tab.tsx
var import_react20 = require("react");

// src/client/features/notification-focus-hint.ts
function focusSuppressHint() {
  return "\u5E94\u7528\u7A97\u53E3\u5728\u524D\u53F0\u805A\u7126\u65F6\u4E0D\u5F39\u901A\u77E5\uFF08\u5931\u7126\u3001\u6700\u5C0F\u5316\u540E\u7167\u5E38\uFF09\uFF0C\u8BE5\u7B56\u7565\u56FA\u5B9A\u4E0D\u53EF\u914D\u7F6E\u3002";
}

// src/client/features/notification-sound-ui.ts
var SOUND_EXTENSIONS = ["wav", "mp3", "ogg"];
var CUSTOM_PREFIX = "custom:";
var FALLBACK_REASON = "\u672C\u673A\u6CA1\u6709\u8BE5\u683C\u5F0F\u7684\u64AD\u653E\u540E\u7AEF";
function soundExtension(name) {
  if (typeof name !== "string") return null;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return SOUND_EXTENSIONS.includes(extension) ? extension : null;
}
function customSoundName(value) {
  if (typeof value !== "string" || !value.startsWith(CUSTOM_PREFIX)) return null;
  const name = value.slice(CUSTOM_PREFIX.length);
  return name === "" ? null : name;
}
function soundOptionState(capability, value) {
  const name = customSoundName(value);
  if (name === null) return { ok: true, reason: null, extension: null };
  const extension = soundExtension(name);
  if (extension === null) return { ok: true, reason: null, extension: null };
  const support = capability?.formats?.[extension];
  if (support === void 0 || support === null || typeof support.ok !== "boolean") {
    return { ok: true, reason: null, extension };
  }
  if (support.ok) return { ok: true, reason: null, extension };
  const reason = typeof support.reason === "string" && support.reason.trim() !== "" ? support.reason : null;
  return { ok: false, reason: reason ?? FALLBACK_REASON, extension };
}
function soundUnavailableReason(capability, value) {
  const state = soundOptionState(capability, value);
  return state.ok ? null : state.reason;
}
function customSoundOptions(names, capability) {
  if (!Array.isArray(names)) return [];
  return names.map((name) => {
    const value = `${CUSTOM_PREFIX}${name}`;
    const reason = soundUnavailableReason(capability, value);
    if (reason === null) return { value, label: name, disabled: false, title: void 0 };
    return { value, label: `${name}\uFF08\u672C\u673A\u65E0\u6CD5\u64AD\u653E\uFF1A${reason}\uFF09`, disabled: true, title: reason };
  });
}
function capabilityHint(capability) {
  const hint = capability?.hint;
  return typeof hint === "string" && hint.trim() !== "" ? hint : null;
}
function configuredSoundWarning(capability, sound) {
  const reason = soundUnavailableReason(capability, sound);
  if (reason === null) return null;
  const name = customSoundName(sound);
  return name === null ? `\u672C\u673A\u65E0\u6CD5\u64AD\u653E\uFF1A${reason}` : `\u672C\u673A\u65E0\u6CD5\u64AD\u653E\u300C${name}\u300D\uFF1A${reason}`;
}
function previewFailure(result) {
  if (typeof result !== "object" || result === null) return null;
  const { played, audible } = result;
  if (typeof played !== "string" || played === "") return null;
  if (audible !== false) return null;
  const target = played.startsWith(CUSTOM_PREFIX) ? played.slice(CUSTOM_PREFIX.length) : played;
  return target === "default" ? "\u8BD5\u542C\u6CA1\u6709\u51FA\u58F0\uFF1A\u672C\u673A\u6CA1\u6709\u53EF\u7528\u7684\u64AD\u653E\u540E\u7AEF" : `\u8BD5\u542C\u6CA1\u6709\u51FA\u58F0\uFF1A\u672C\u673A\u65E0\u6CD5\u64AD\u653E\u300C${target}\u300D`;
}
var UNAVAILABLE_MACOS_TEXT = "\u5F53\u524D\u73AF\u5883\u65E0\u6CD5\u67E5\u8BE2\u7CFB\u7EDF\u901A\u77E5\u6743\u9650\uFF08dev \u88F8\u4E8C\u8FDB\u5236\u6216\u5E73\u53F0\u4E0D\u652F\u6301\uFF09\uFF1B\u9A8C\u6536\u8BF7\u4F7F\u7528\u6253\u5305\u540E\u7684 .app\u3002";
var UNAVAILABLE_CHIP = "\u6743\u9650\u4E0D\u53EF\u7528";
function permissionUnavailableCopy(platform) {
  if (platform === "win32" || platform === "linux") {
    const name = platform === "win32" ? "Windows" : "Linux";
    return {
      chip: null,
      neutral: true,
      text: `${name} \u7684\u901A\u77E5\u7531\u7CFB\u7EDF\u901A\u77E5\u4E2D\u5FC3\u8D1F\u8D23\uFF0C\u672C\u5E94\u7528\u4E0D\u67E5\u8BE2\u6388\u6743\u72B6\u6001\uFF1B\u80FD\u5426\u5F39\u51FA\u4EE5\u7CFB\u7EDF\u8BBE\u7F6E\u4E3A\u51C6\u3002`
    };
  }
  return { chip: UNAVAILABLE_CHIP, neutral: false, text: UNAVAILABLE_MACOS_TEXT };
}
function deniedPermissionCopy(platform, bundleId) {
  const base = "\u901A\u77E5\u6A2A\u5E45\u4E0D\u4F1A\u663E\u793A\u3002\u53EF\u5728\u7CFB\u7EDF\u8BBE\u7F6E\u4E2D\u624B\u52A8\u5F00\u542F\u3002";
  if (platform !== "darwin" || typeof bundleId !== "string" || bundleId.trim() === "") return base;
  return `${base}\u5F00\u53D1\u671F\u53EF\u6267\u884C tccutil reset Notifications ${bundleId} \u540E\u91CD\u8BD5\u3002`;
}

// src/client/features/notifications-tab.tsx
var import_jsx_runtime21 = require("react/jsx-runtime");
var SYS_PREFS = "x-apple.systempreferences:com.apple.Preference.Notifications";
var PANEL_CSS2 = `
[data-notification-settings] { font-size: 13px; }
[data-notification-settings] .n-card { border:1px solid var(--dsw-alias-border-l2,#ffffff1f); border-radius:12px; padding:12px 16px; margin-bottom:10px; }
[data-notification-settings] .n-banner { display:flex; gap:10px; align-items:center; border:1px solid var(--dsw-alias-border-l2,#ffffff1f); border-left:3px solid var(--dsw-alias-state-warn,#e8a33d); background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); border-radius:8px; padding:9px 12px; font-size:12.5px; margin-bottom:10px; }
[data-notification-settings] .n-banner.granted { border-left-color:var(--dsw-alias-state-success,#2fbf71); }
[data-notification-settings] .n-banner.denied { border-left-color:var(--dsw-alias-state-danger,#e5534b); }
[data-notification-settings] .n-banner.neutral { border-left-color:var(--dsw-alias-border-l2,#ffffff1f); }
[data-notification-settings] .n-banner .grow { flex:1; min-width:0; }
[data-notification-settings] .n-chip { display:inline-block; font-size:11px; border:1px solid var(--dsw-alias-border-l2,#ffffff1f); border-radius:6px; padding:1px 7px; color:var(--dsw-alias-label-secondary,#9aa4b2); white-space:nowrap; }
[data-notification-settings] .n-chip.ok { color:var(--dsw-alias-state-success,#2fbf71); border-color:var(--dsw-alias-state-success,#2fbf71); }
[data-notification-settings] .n-chip.warn { color:var(--dsw-alias-state-warn,#e8a33d); border-color:var(--dsw-alias-state-warn,#e8a33d); }
[data-notification-settings] .n-chip.danger { color:var(--dsw-alias-state-danger,#e5534b); border-color:var(--dsw-alias-state-danger,#e5534b); }
[data-notification-settings] .n-btn { background:var(--dsw-alias-brand-primary-new-color,#4176e6); border:none; color:#fff; border-radius:8px; padding:5px 12px; font-size:12px; cursor:pointer; }
[data-notification-settings] .n-btn:hover { filter:brightness(1.12); }
[data-notification-settings] .n-btn.ghost { background:transparent; border:1px solid var(--dsw-alias-border-l2,#ffffff1f); color:var(--dsw-alias-label-primary,#e7eaf0); }
[data-notification-settings] .n-btn.ghost:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); filter:none; }
[data-notification-settings] .n-btn.mini { padding:2px 9px; font-size:11px; }
[data-notification-settings] .n-btn:disabled { opacity:.45; cursor:default; filter:none; }
[data-notification-settings] .n-switch { position:relative; width:34px; height:19px; border-radius:999px; background:var(--dsw-alias-border-l2,#ffffff1f); cursor:pointer; flex:none; transition:background .15s; display:inline-block; vertical-align:middle; }
[data-notification-settings] .n-switch.on { background:var(--dsw-alias-state-success,#2fbf71); }
[data-notification-settings] .n-switch::after { content:""; position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:var(--dsw-alias-bg-base,#151517); transition:left .15s; }
[data-notification-settings] .n-switch.on::after { left:17px; }
[data-notification-settings] .n-setrow { display:flex; justify-content:space-between; align-items:center; gap:10px; font-size:12.5px; }
[data-notification-settings] .n-srow { display:flex; align-items:center; gap:10px; padding:7px 0; border-bottom:1px solid var(--dsw-alias-border-l2,#ffffff1f); }
[data-notification-settings] .n-grp:last-child .n-srow:last-child { border-bottom:none; }
[data-notification-settings] .n-sinfo { flex:1; min-width:0; }
[data-notification-settings] .n-sinfo b { font-size:12.5px; font-weight:600; }
[data-notification-settings] .n-mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10.5px; color:var(--dsw-alias-label-secondary,#9aa4b2); }
[data-notification-settings] .n-gname { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); letter-spacing:.4px; margin:10px 0 2px; }
[data-notification-settings] .n-select, [data-notification-settings] .n-time { font:inherit; font-size:12px; color:inherit; background:transparent; border:1px solid var(--dsw-alias-border-l2,#ffffff1f); border-radius:8px; padding:3px 7px; }
[data-notification-settings] .n-note { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); margin-top:8px; }
[data-notification-settings] .n-mastoff .n-srow .n-switch, [data-notification-settings] .n-mastoff .n-srow select, [data-notification-settings] .n-mastoff .n-srow button { opacity:.4; pointer-events:none; }
[data-notification-settings] input[type="time"] { color-scheme: inherit; }
`;
var stylesInstalled2 = false;
function ensureStyles2() {
  if (stylesInstalled2) return;
  stylesInstalled2 = true;
  const style = document.createElement("style");
  style.textContent = PANEL_CSS2;
  document.head.appendChild(style);
}
function NotificationSettingsPanel() {
  const [data, setData] = (0, import_react20.useState)(null);
  const [busy, setBusy] = (0, import_react20.useState)(false);
  const [previewNote, setPreviewNote] = (0, import_react20.useState)(null);
  const [loadFailed, setLoadFailed] = (0, import_react20.useState)(false);
  const refresh = (0, import_react20.useCallback)(() => {
    invokeCommand("get_notifications_state").then((res) => {
      setLoadFailed(false);
      setData(res);
    }).catch((e) => {
      logFail(e);
      setLoadFailed(true);
    });
  }, []);
  (0, import_react20.useEffect)(() => {
    refresh();
  }, [refresh]);
  const refetched = (0, import_react20.useRef)(false);
  (0, import_react20.useEffect)(() => {
    if (data === null || refetched.current) return;
    refetched.current = true;
    const timer = setTimeout(() => {
      refresh();
    }, 700);
    return () => clearTimeout(timer);
  }, [data, refresh]);
  const save = (0, import_react20.useCallback)((next) => {
    setBusy(true);
    invokeCommand("set_notifications_config", { config: next }).catch((e) => {
      logFail(e);
    }).finally(() => setBusy(false));
  }, []);
  const logFail = (e) => {
    console.warn("[notifications] \u4FDD\u5B58\u5931\u8D25", e);
  };
  const patch = (0, import_react20.useCallback)((fn) => {
    setData((prev) => {
      if (prev === null) return prev;
      const next = {
        enabled: prev.config.enabled,
        dnd: { ...prev.config.dnd },
        scenarios: Object.fromEntries(
          Object.entries(prev.config.scenarios).map(([k, v]) => [k, { ...v }])
        )
      };
      fn(next);
      save(next);
      return { ...prev, config: next };
    });
  }, [save]);
  if (data === null) {
    return /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("div", { "data-notification-settings": true, className: "n-note", children: loadFailed ? "\u901A\u77E5\u8BBE\u7F6E\u8BFB\u53D6\u5931\u8D25\uFF1A\u684C\u9762\u58F3\u6CA1\u6709\u54CD\u5E94\uFF08\u8BE6\u89C1\u63A7\u5236\u53F0\uFF09" : "\u52A0\u8F7D\u4E2D\u2026" });
  }
  const requestPerm = () => {
    setBusy(true);
    invokeCommand("request_notification_permission_cmd").then(() => refresh()).catch((error) => {
      console.warn(`[notifications] \u901A\u77E5\u6743\u9650\u7533\u8BF7\u5931\u8D25\uFF1A${String(error)}`);
    }).finally(() => setBusy(false));
  };
  const openSysPrefs = () => {
    void invokeCommand("open_external", { url: SYS_PREFS }).catch(() => {
    });
  };
  const chooseSound = () => {
    invokeCommand("choose_notification_sound").then((path) => {
      if (path === null || path === void 0 || path === "") return;
      return invokeCommand("import_notification_sound", { path }).then((name) => {
        refresh();
        return name;
      });
    }).catch((e) => console.warn("[notifications] \u5BFC\u5165\u97F3\u6548\u5931\u8D25", e));
  };
  const previewSound = (id, sound) => {
    invokeCommand("preview_notification_sound", { sound }).then((res) => {
      const failure = previewFailure(res);
      setPreviewNote(failure === null ? null : { id, text: failure });
    }).catch((e) => {
      logFail(e);
      setPreviewNote({ id, text: "\u8BD5\u542C\u5931\u8D25\uFF1A\u684C\u9762\u58F3\u6CA1\u6709\u54CD\u5E94\uFF08\u8BE6\u89C1\u63A7\u5236\u53F0\uFF09" });
    });
  };
  const groupLabel = (gid) => data.groups.find(([g]) => g === gid)?.[1] ?? gid;
  const grouped = data.groups.map(([gid]) => ({
    gid,
    rows: data.scenarios.filter((s) => s.group === gid)
  }));
  const capability = data.capability ?? null;
  const soundHint = capabilityHint(capability);
  const soundChoices = customSoundOptions(data.sounds, capability);
  const permissionUnavailable = permissionUnavailableCopy(capability?.platform);
  return /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { "data-notification-settings": true, className: data.config.enabled ? "" : "n-mastoff", children: [
    data.permission === "granted" ? /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { className: "n-banner granted", children: [
      /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("span", { className: "n-chip ok", children: "\u5DF2\u6388\u4E88" }),
      /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("span", { className: "grow", children: "\u7CFB\u7EDF\u5141\u8BB8\u672C\u5E94\u7528\u53D1\u9001\u901A\u77E5\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("button", { className: "n-btn ghost mini", onClick: openSysPrefs, children: "\u6253\u5F00\u7CFB\u7EDF\u8BBE\u7F6E" })
    ] }) : data.permission === "denied" ? /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { className: "n-banner denied", children: [
      /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("span", { className: "n-chip danger", children: "\u88AB\u62D2\u7EDD" }),
      /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("span", { className: "grow", children: deniedPermissionCopy(capability?.platform, data.bundleId) }),
      /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("button", { className: "n-btn ghost mini", onClick: openSysPrefs, children: "\u6253\u5F00\u7CFB\u7EDF\u8BBE\u7F6E" }),
      /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("button", { className: "n-btn mini", onClick: requestPerm, disabled: busy, children: "\u7533\u8BF7\u6743\u9650" })
    ] }) : data.permission === "unavailable" ? /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { className: `n-banner${permissionUnavailable.neutral ? " neutral" : ""}`, children: [
      permissionUnavailable.chip !== null && /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("span", { className: "n-chip", children: permissionUnavailable.chip }),
      /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("span", { className: "grow", children: permissionUnavailable.text })
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { className: "n-banner", children: [
      /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("span", { className: "n-chip warn", children: "\u672A\u51B3\u5B9A" }),
      /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("span", { className: "grow", children: "\u5C1A\u672A\u5411\u7CFB\u7EDF\u7533\u8BF7\u901A\u77E5\u6743\u9650\uFF0C\u9996\u6B21\u7533\u8BF7\u4F1A\u5F39\u7CFB\u7EDF\u6388\u6743\u7A97\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("button", { className: "n-btn mini", onClick: requestPerm, disabled: busy, children: "\u7533\u8BF7\u6743\u9650" }),
      /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("button", { className: "n-btn ghost mini", onClick: openSysPrefs, children: "\u6253\u5F00\u7CFB\u7EDF\u8BBE\u7F6E" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("div", { className: "n-card", children: /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { className: "n-setrow", children: [
      /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("b", { children: "\u542F\u7528\u684C\u9762\u901A\u77E5" }),
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("div", { className: "n-note", children: "\u603B\u5F00\u5173\uFF1A\u5173\u95ED\u540E\u6240\u6709\u573A\u666F\u4E00\u5F8B\u9759\u9ED8\uFF08\u573A\u666F\u5F00\u5173\u4FDD\u7559\uFF0C\u91CD\u65B0\u5F00\u542F\u5373\u6062\u590D\uFF09" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
        "span",
        {
          className: `n-switch ${data.config.enabled ? "on" : ""}`,
          onClick: () => patch((c) => {
            c.enabled = !c.enabled;
          })
        }
      )
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { className: "n-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { className: "n-setrow", style: { marginBottom: 10 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("b", { children: "\u514D\u6253\u6270\u65F6\u6BB5" }),
          /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("div", { className: "n-note", children: "\u65F6\u6BB5\u5185\u901A\u77E5\u9759\u9ED8\uFF08\u4ECD\u8FDB\u7CFB\u7EDF\u901A\u77E5\u4E2D\u5FC3\uFF09" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
          "span",
          {
            className: `n-switch ${data.config.dnd.on ? "on" : ""}`,
            onClick: () => patch((c) => {
              c.dnd.on = !c.dnd.on;
            })
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 10, opacity: data.config.dnd.on ? 1 : 0.45 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("span", { className: "n-note", style: { margin: 0 }, children: "\u4ECE" }),
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
          "input",
          {
            className: "n-time",
            type: "time",
            value: data.config.dnd.from,
            disabled: !data.config.dnd.on,
            onChange: (e) => patch((c) => {
              c.dnd.from = e.target.value;
            })
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("span", { className: "n-note", style: { margin: 0 }, children: "\u5230" }),
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
          "input",
          {
            className: "n-time",
            type: "time",
            value: data.config.dnd.to,
            disabled: !data.config.dnd.on,
            onChange: (e) => patch((c) => {
              c.dnd.to = e.target.value;
            })
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { className: "n-setrow", children: [
        /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("b", { children: "\u5168\u5C4F\u65F6\u9759\u9ED8" }),
          /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("div", { className: "n-note", children: "\u672C\u5E94\u7528\u7A97\u53E3\u5168\u5C4F\u65F6\u4E0D\u5F39\u6A2A\u5E45" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
          "span",
          {
            className: `n-switch ${data.config.dnd.suppressFullscreen ? "on" : ""}`,
            onClick: () => patch((c) => {
              c.dnd.suppressFullscreen = !c.dnd.suppressFullscreen;
            })
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("div", { className: "n-note", children: focusSuppressHint() })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { className: "n-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("b", { style: { fontSize: 13 }, children: "\u573A\u666F" }),
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("span", { className: "n-note", children: "\u6BCF\u4E2A\u573A\u666F\u72EC\u7ACB\u5F00\u5173\u4E0E\u97F3\u6548" })
      ] }),
      grouped.map(({ gid, rows }) => /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { className: "n-grp", children: [
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("div", { className: "n-gname", children: groupLabel(gid) }),
        rows.map((s) => {
          const conf = data.config.scenarios[s.id] ?? { enabled: s.defaultOn, sound: "default" };
          const soundWarning = configuredSoundWarning(capability, conf.sound);
          const failureNote = previewNote !== null && previewNote.id === s.id ? previewNote.text : null;
          return /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { className: "n-srow", children: [
            /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { className: "n-sinfo", children: [
              /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("b", { children: s.name }),
              /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("span", { className: "n-mono", style: { display: "block" }, children: [
                s.id,
                " \xB7 ",
                s.desc
              ] }),
              soundWarning !== null && /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("div", { className: "n-note", style: { color: "var(--dsw-alias-state-warn,#e8a33d)" }, children: soundWarning }),
              failureNote !== null && /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("div", { className: "n-note", style: { color: "var(--dsw-alias-state-danger,#e5534b)" }, children: failureNote })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
              "span",
              {
                className: `n-switch ${conf.enabled ? "on" : ""}`,
                onClick: () => patch((c) => {
                  const cur = c.scenarios[s.id] ?? { enabled: s.defaultOn, sound: "default" };
                  c.scenarios[s.id] = { ...cur, enabled: !cur.enabled };
                })
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(
              "select",
              {
                className: "n-select",
                style: { minWidth: 126 },
                value: conf.sound,
                onChange: (e) => {
                  const v = e.target.value;
                  setPreviewNote(null);
                  if (v === "__choose") chooseSound();
                  else patch((c) => {
                    const cur = c.scenarios[s.id] ?? { enabled: s.defaultOn, sound: "default" };
                    c.scenarios[s.id] = { ...cur, sound: v === "__default" ? "default" : v };
                  });
                },
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("option", { value: "default", children: "\u7CFB\u7EDF\u9ED8\u8BA4" }),
                  /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("option", { value: "none", children: "\u65E0\u58F0" }),
                  soundChoices.map((opt) => /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("option", { value: opt.value, disabled: opt.disabled, title: opt.title, children: opt.label }, opt.value)),
                  /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("option", { value: "__choose", children: "\u81EA\u5B9A\u4E49\u6587\u4EF6\u2026" })
                ]
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
              "button",
              {
                className: "n-btn ghost mini",
                title: "\u8BD5\u542C",
                onClick: () => previewSound(s.id, conf.sound),
                children: "\u25B6"
              }
            )
          ] }, s.id);
        })
      ] }, gid)),
      /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { className: "n-note", children: [
        "\u81EA\u5B9A\u4E49\u97F3\u6548\u6587\u4EF6\uFF08wav / mp3 / ogg\uFF0C\u22645MB\uFF09\u5BFC\u5165\u540E\u5B58\u653E\u4E8E\u6570\u636E\u76EE\u5F55 sounds/\uFF0C\u53EF\u968F\u65F6\u5728\u4E0B\u62C9\u4E2D\u5207\u6362\u6216\u8986\u76D6\u3002",
        busy ? " \xB7 \u4FDD\u5B58\u4E2D\u2026" : ""
      ] }),
      soundHint !== null && /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)("div", { className: "n-banner", style: { marginTop: 10, marginBottom: 0 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("span", { className: "n-chip warn", children: "\u97F3\u6548" }),
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)("span", { className: "grow", children: soundHint })
      ] })
    ] })
  ] });
}
function registerNotificationsTab(ctx) {
  ensureStyles2();
  const slots = ctx.slots;
  if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return;
  slots.inject(
    "settings.section",
    () => slots.register(
      { name: "settings.section", id: "dsh-notification-settings", order: 41, label: () => "\u684C\u9762\u901A\u77E5" },
      NotificationSettingsPanel
    )
  );
}

// src/client/features/environment.ts
var PLATFORMS = /* @__PURE__ */ new Set(["darwin", "win32", "linux"]);
function parseDesktopClientEnvironment(search) {
  const params = new URLSearchParams(search);
  const platform = params.get("dsh-desktop-tauriapp-platform");
  if (platform === null) return void 0;
  if (!PLATFORMS.has(platform)) {
    throw new Error(`dsh-desktop-tauriapp: invalid or missing dsh-desktop-tauriapp-platform ${JSON.stringify(platform)}`);
  }
  return { platform };
}
async function requestDesktopClientEnvironment() {
  if (!shellRpc.available()) return void 0;
  let raw;
  try {
    raw = await invokeCommand("get_desktop_client_environment");
  } catch {
    return void 0;
  }
  const env = raw;
  if (!env) return void 0;
  if (env.platform !== "darwin" && env.platform !== "win32" && env.platform !== "linux") return void 0;
  return {
    platform: env.platform,
    profile: typeof env.profile === "string" ? env.profile : void 0
  };
}

// src/client/bridge/platform-keyboard.ts
var SHORTCUT_SCHEMA_VERSION = 2;
var MODIFIER_CODES = /* @__PURE__ */ new Set([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight"
]);
var MODIFIER_ORDER = ["control", "alt", "shift", "meta"];
function isModifierCode(code) {
  return MODIFIER_CODES.has(code);
}
function gestureModifiers(gesture) {
  const modifiers = [];
  if (gesture.control) modifiers.push("control");
  if (gesture.alt) modifiers.push("alt");
  if (gesture.shift) modifiers.push("shift");
  if (gesture.meta) modifiers.push("meta");
  return modifiers;
}
function sameSet(a, b) {
  if (a.length !== b.length) return false;
  return a.every((item) => b.includes(item));
}
function matchBinding(row, gesture) {
  const binding = row.binding;
  if (!binding || typeof binding.code !== "string" || binding.code === "") return false;
  if (row.issue) return false;
  if (row.conflicts && row.conflicts.length > 0) return false;
  const want = Array.isArray(binding.modifiers) ? binding.modifiers : [];
  if (!sameSet(want, gestureModifiers(gesture))) return false;
  const wantCodes = binding.secondCode ? [binding.code, binding.secondCode] : [binding.code];
  const gotCodes = gesture.secondCode ? [gesture.code, gesture.secondCode] : [gesture.code];
  return sameSet(wantCodes, gotCodes);
}
function isConsumable(row) {
  const modifiers = row.binding?.modifiers;
  return Array.isArray(modifiers) && modifiers.length > 0;
}
function matchCatalog(catalog, gesture) {
  for (const row of catalog) {
    if (matchBinding(row, gesture) && isConsumable(row)) return row;
  }
  return void 0;
}
function emptyShortcutDocument() {
  return { schemaVersion: 1, profiles: {} };
}
function parseShortcutDocument(raw) {
  if (raw === null || raw.trim() === "") {
    return { document: emptyShortcutDocument(), status: "ready", error: null, usingDefaults: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { document: emptyShortcutDocument(), status: "unreadable", error: "invalid", usingDefaults: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { document: emptyShortcutDocument(), status: "unreadable", error: "invalid", usingDefaults: false };
  }
  const candidate = parsed;
  const version = candidate.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { document: emptyShortcutDocument(), status: "unreadable", error: "invalid", usingDefaults: false };
  }
  if (version > SHORTCUT_SCHEMA_VERSION) {
    return { document: emptyShortcutDocument(), status: "unreadable", error: "future", usingDefaults: false };
  }
  const profiles = typeof candidate.profiles === "object" && candidate.profiles !== null && !Array.isArray(candidate.profiles) ? candidate.profiles : {};
  return {
    document: { ...parsed, schemaVersion: version, profiles },
    status: "ready",
    error: null,
    usingDefaults: false
  };
}
function sanitizeBinding(binding) {
  if (typeof binding !== "object" || binding === null) return null;
  const raw = binding;
  if (typeof raw.code !== "string" || raw.code === "") return null;
  const declared = Array.isArray(raw.modifiers) ? raw.modifiers : [];
  const modifiers = MODIFIER_ORDER.filter((modifier) => declared.includes(modifier));
  const out = { code: raw.code, modifiers };
  if (typeof raw.secondCode === "string" && raw.secondCode !== "") out.secondCode = raw.secondCode;
  return out;
}
function applyShortcutEdit(document2, edit, profile) {
  const profiles = { ...document2.profiles ?? {} };
  if (edit.type === "reset-all") {
    profiles[profile] = {};
  } else if (edit.type === "reset") {
    if (typeof edit.id !== "string" || edit.id === "") return { ok: false, document: document2 };
    const current = { ...profiles[profile] ?? {} };
    delete current[edit.id];
    profiles[profile] = current;
  } else if (edit.type === "set") {
    if (typeof edit.id !== "string" || edit.id === "") return { ok: false, document: document2 };
    const binding = sanitizeBinding(edit.binding);
    if (!binding) return { ok: false, document: document2 };
    const current = { ...profiles[profile] ?? {} };
    current[edit.id] = binding;
    profiles[profile] = current;
  } else {
    return { ok: false, document: document2 };
  }
  return { ok: true, document: { ...document2, schemaVersion: SHORTCUT_SCHEMA_VERSION, profiles } };
}
function tauriInvoke(cmd, args) {
  return shellRpc.invoke(cmd, args);
}
function newRevision() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
var KeyboardEmitter = class {
  constructor(revisionOf, catalogOf) {
    this.revisionOf = revisionOf;
    this.catalogOf = catalogOf;
  }
  held = /* @__PURE__ */ new Set();
  order = [];
  listeners = /* @__PURE__ */ new Set();
  attached = false;
  recording = false;
  attach() {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.onReset, true);
    document.addEventListener("visibilitychange", this.onVisibility, true);
    console.info("[desktop] \u684C\u9762\u6863\u5FEB\u6377\u952E\u6865\u5DF2\u88C5\uFF1A\u6309\u952E\u8D70 window \u6355\u83B7\u5C42\u8F6C\u53D1\u7ED9 dsh");
  }
  setRecording(active) {
    this.recording = active;
    if (active) this.clear();
  }
  subscribe(listener) {
    this.listeners.add(listener);
    console.debug("[desktop][probe] dsh \u8BA2\u9605\u4E86\u539F\u751F\u6309\u952E\u8F93\u5165");
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** dsh 注册了几个原生按键监听者（自检日志用）。 */
  listenerCount() {
    return this.listeners.size;
  }
  clear() {
    this.held.clear();
    this.order.length = 0;
  }
  onReset = () => this.clear();
  onVisibility = () => {
    if (document.visibilityState !== "visible") this.clear();
  };
  onKeyUp = (event) => {
    const code = event.code;
    if (!code) return;
    if (!this.held.delete(code)) return;
    const index = this.order.indexOf(code);
    if (index >= 0) this.order.splice(index, 1);
  };
  onKeyDown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    const code = event.code;
    if (!code || this.held.has(code)) return;
    this.held.add(code);
    this.order.push(code);
    if (isModifierCode(code)) return;
    if (this.recording) return;
    if (event.defaultPrevented) return;
    const gesture = this.gestureFor(code);
    if (!matchCatalog(this.catalogOf(), gesture)) return;
    const revision = this.revisionOf();
    if (revision === null) return;
    event.preventDefault();
    event.stopPropagation();
    const input = {
      revision,
      kind: "keyboard",
      frameName: "",
      code: gesture.code,
      control: gesture.control,
      alt: gesture.alt,
      shift: gesture.shift,
      meta: gesture.meta,
      repeat: false
    };
    if (gesture.secondCode) input.secondCode = gesture.secondCode;
    for (const listener of [...this.listeners]) {
      try {
        listener(input);
      } catch (error) {
        console.error("[desktop] \u5FEB\u6377\u952E\u76D1\u542C\u8005\u629B\u9519", error);
      }
    }
  };
  /** 组装「当前按住的整组键」的 gesture：code/secondCode 按 dsh 的规范化顺序（字典序）排列。 */
  gestureFor(code) {
    const others = this.order.filter((item) => item !== code && !isModifierCode(item));
    const codes = [code, ...others].sort();
    const modifiers = new Set(this.order.filter((item) => isModifierCode(item)));
    const gesture = {
      code: codes[0],
      control: modifiers.has("ControlLeft") || modifiers.has("ControlRight"),
      alt: modifiers.has("AltLeft") || modifiers.has("AltRight"),
      shift: modifiers.has("ShiftLeft") || modifiers.has("ShiftRight"),
      meta: modifiers.has("MetaLeft") || modifiers.has("MetaRight"),
      repeat: false
    };
    if (codes.length > 1) gesture.secondCode = codes[1];
    return gesture;
  }
};
var KeybindingAdapter = class {
  constructor(profile) {
    this.profile = profile;
  }
  document = emptyShortcutDocument();
  status = "loading";
  error = null;
  usingDefaults = true;
  sequence = 0;
  revision = newRevision();
  loading = null;
  listeners = /* @__PURE__ */ new Set();
  snapshot() {
    return {
      revision: this.revision,
      sequence: this.sequence,
      document: this.document,
      status: this.status,
      error: this.error,
      usingDefaults: this.usingDefaults
    };
  }
  /** 首次读取：读盘 → 解析 → 广播。读盘失败按 unreadable/read 降级（dsh 显示只读默认绑定）。 */
  load() {
    if (!this.loading) this.loading = this.readFile();
    return this.loading;
  }
  async readFile() {
    try {
      const raw = await tauriInvoke("read_desktop_keybindings");
      const text = typeof raw === "string" ? raw : null;
      const parsed = parseShortcutDocument(text);
      this.document = parsed.document;
      this.status = parsed.status;
      this.error = parsed.error;
      this.usingDefaults = parsed.usingDefaults;
    } catch (error) {
      console.warn("[desktop] \u5FEB\u6377\u952E\u504F\u597D\u8BFB\u53D6\u5931\u8D25\uFF0C\u56DE\u843D\u53EA\u8BFB\u9ED8\u8BA4\u7ED1\u5B9A", error);
      this.status = "unreadable";
      this.error = "read";
      this.usingDefaults = true;
    }
    this.publish();
  }
  publish() {
    this.sequence += 1;
    this.revision = newRevision();
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("[desktop] \u5FEB\u6377\u952E\u504F\u597D\u8BA2\u9605\u8005\u629B\u9519", error);
      }
    }
  }
  async get() {
    await this.load();
    return this.snapshot();
  }
  async edit(edit, revision) {
    await this.load();
    if (this.status === "unreadable") return { status: "unreadable", snapshot: this.snapshot() };
    if (revision !== this.revision) return { status: "stale", snapshot: this.snapshot() };
    const applied = applyShortcutEdit(this.document, edit, this.profile);
    if (!applied.ok) return { status: "not-ready", snapshot: this.snapshot() };
    const raw = `${JSON.stringify(applied.document, null, 2)}
`;
    try {
      await tauriInvoke("write_desktop_keybindings", { raw });
    } catch (error) {
      console.error("[desktop] \u5FEB\u6377\u952E\u504F\u597D\u5199\u5165\u5931\u8D25", error);
      return { status: "write-failed", snapshot: this.snapshot() };
    }
    this.document = applied.document;
    this.status = "ready";
    this.error = null;
    this.usingDefaults = false;
    this.publish();
    return { status: "saved", snapshot: this.snapshot() };
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
};
function readService(ctx) {
  if (!ctx) return void 0;
  const holder = ctx;
  let service;
  try {
    service = typeof holder.get === "function" ? holder.get("shortcuts") : holder.shortcuts;
  } catch {
    return void 0;
  }
  if (!service || typeof service !== "object") return void 0;
  return service;
}
function currentRevision(service) {
  const snapshot = service?.config?.getSnapshot?.();
  return snapshot && typeof snapshot.revision === "string" ? snapshot.revision : null;
}
function currentCatalog(service) {
  const catalog = service?.catalog?.getSnapshot?.();
  return Array.isArray(catalog) ? catalog : [];
}
function detectPlatform() {
  const device = navigator.userAgent;
  if (/mac/i.test(device)) return "macos";
  if (/win/i.test(device)) return "windows";
  return "linux";
}
function installDesktopPlatformBridge(ctx) {
  const w = window;
  if (!w.dshDesktop || !w.dshDesktop.keyboard) return;
  if (w.__dshShellKeyboardInstalled) return;
  w.__dshShellKeyboardInstalled = true;
  let service = readService(ctx);
  if (!service) {
    const inject2 = ctx.inject;
    if (typeof inject2 === "function") {
      ;
      inject2.call(ctx, ["shortcuts"], (scoped) => {
        service = readService(scoped);
      });
    }
  }
  const runtime = typeof service?.runtime === "string" ? service.runtime : "desktop";
  const platform = typeof service?.platform === "string" ? service.platform : detectPlatform();
  const profile = `${runtime}:${platform}`;
  const adapter = new KeybindingAdapter(profile);
  const emitter = new KeyboardEmitter(
    () => currentRevision(service),
    () => currentCatalog(service)
  );
  emitter.attach();
  w.__dshShellKeyboardImpl = {
    subscribeInput: (listener) => emitter.subscribe(listener),
    closeWindow: async (revision) => {
      if (currentRevision(service) !== revision) return;
      await tauriInvoke("close_current_window");
    },
    get: () => adapter.get(),
    edit: (edit, revision) => adapter.edit(edit, revision),
    subscribeConfig: (listener) => adapter.subscribe(listener),
    recording: async (active) => {
      emitter.setRecording(active);
    }
  };
  console.info(`[desktop] platform \u952E\u76D8\u6865\u5B9E\u73B0\u5DF2\u5C31\u7EEA\uFF08profile=${profile}\uFF09`);
  setTimeout(() => {
    const catalog = currentCatalog(service);
    console.debug(
      "[desktop] \u5FEB\u6377\u952E\u6865\u81EA\u68C0\uFF1A" + JSON.stringify({
        service: service ? `${service.runtime ?? "?"}:${service.platform ?? "?"}` : null,
        catalog: catalog.length,
        revision: currentRevision(service) !== null,
        listeners: emitter.listenerCount()
      })
    );
  }, 3e3);
}

// src/client/ui/composer-input-guard.ts
var ALLOWED_CONTROL = /* @__PURE__ */ new Set([9, 10, 13]);
function isDisallowed(code) {
  if (code > 31 && code !== 127) return false;
  return !ALLOWED_CONTROL.has(code);
}
function hasDisallowedControl(text) {
  if (typeof text !== "string" || text === "") return false;
  for (const char of text) {
    if (isDisallowed(char.codePointAt(0) ?? 0)) return true;
  }
  return false;
}
function removeDisallowedControl(text) {
  if (typeof text !== "string" || text === "") return "";
  let out = "";
  for (const char of text) {
    if (isDisallowed(char.codePointAt(0) ?? 0)) continue;
    out += char;
  }
  return out;
}
function describeControlChars(text) {
  if (typeof text !== "string" || text === "") return "";
  const parts = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (!isDisallowed(code)) continue;
    parts.push(`U+${code.toString(16).toUpperCase().padStart(4, "0")}@${index}`);
  }
  return parts.join(",");
}
function describeTarget(node) {
  const el = isElement(node) ? node : document.activeElement;
  if (el === null) return "none";
  const tag = (el.tagName ?? "").toLowerCase();
  const editable = el.isContentEditable ? "+contenteditable" : "";
  const composer = typeof el.closest === "function" && el.closest("[data-composer-composing]") !== null ? "+composer" : "";
  return `${tag}${editable}${composer}`;
}
function isElement(node) {
  return node instanceof HTMLElement;
}
function isFieldElement(el) {
  return el.tagName === "TEXTAREA" || el.tagName === "INPUT";
}
function editableRootOf(node) {
  if (isElement(node)) return node.isContentEditable || isFieldElement(node) ? node : null;
  if (node !== null && node.nodeType === 3) {
    const parent = node.parentElement;
    if (parent === null) return null;
    return parent.isContentEditable || isFieldElement(parent) ? parent : null;
  }
  const active = document.activeElement;
  if (active === null) return null;
  return active.isContentEditable || isFieldElement(active) ? active : null;
}
function trace(kind, payload) {
  try {
    console.debug(`[input-guard] ${kind} ${JSON.stringify(payload)}`);
  } catch {
  }
}
function stackOf() {
  try {
    return (new Error().stack ?? "").split("\n").slice(1, 5).join(" | ");
  } catch {
    return "";
  }
}
function textNodesOf(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.nodeType === 3) {
      out.push(node);
      continue;
    }
    const children = node.childNodes;
    if (children === void 0 || children === null) continue;
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return out;
}
function sanitizeEditable(root) {
  if (root === null) return "";
  let removed = "";
  for (const node of textNodesOf(root)) {
    if (!hasDisallowedControl(node.data)) continue;
    removed += describeControlChars(node.data);
    node.data = removeDisallowedControl(node.data);
  }
  if (removed !== "") return removed;
  const tag = (root.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "INPUT") {
    const field = root;
    const value = typeof field.value === "string" ? field.value : "";
    if (hasDisallowedControl(value)) {
      removed = describeControlChars(value);
      field.value = removeDisallowedControl(value);
    }
  }
  return removed;
}
function installComposerInputGuard() {
  const w = globalThis;
  if (w.__dshComposerInputGuardInstalled) return;
  w.__dshComposerInputGuardInstalled = true;
  const MAX_BLOCKED_LOGS = 3;
  let blockedLogs = 0;
  const onBeforeInput = (event) => {
    const input = event;
    if (editableRootOf(event.target) === null) return;
    const data = typeof input.data === "string" ? input.data : null;
    let transfer = null;
    try {
      transfer = input.dataTransfer?.getData("text/plain") ?? null;
    } catch {
      transfer = null;
    }
    const offending = hasDisallowedControl(data) ? data : hasDisallowedControl(transfer) ? transfer : null;
    if (offending === null) return;
    if (blockedLogs < MAX_BLOCKED_LOGS) {
      blockedLogs += 1;
      trace("blocked", {
        inputType: input.inputType,
        control: describeControlChars(offending),
        target: describeTarget(event.target),
        stack: stackOf()
      });
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  document.addEventListener("beforeinput", onBeforeInput, true);
  const onLateInput = (event) => {
    const root = editableRootOf(event.target);
    const removed = sanitizeEditable(root);
    if (removed === "") return;
    trace("sanitized", {
      via: event.type,
      control: removed,
      target: describeTarget(event.target),
      stack: stackOf()
    });
  };
  document.addEventListener("input", onLateInput, true);
  document.addEventListener("compositionend", onLateInput, true);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target;
      const root = editableRootOf(target);
      if (root === null) continue;
      const removed = sanitizeEditable(root);
      if (removed === "") continue;
      trace("sanitized", {
        via: `mutation:${record.type}`,
        control: removed,
        target: describeTarget(root)
      });
    }
  });
  observer.observe(document.documentElement ?? document, {
    subtree: true,
    childList: true,
    characterData: true
  });
}

// src/client/shell/console-batch.ts
function createConsoleBatch(options) {
  const maxItems = options.maxItems ?? 20;
  const maxChars = options.maxChars ?? 16384;
  const flushMs = options.flushMs ?? 100;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  });
  let items = [];
  let chars = 0;
  let oldestAt = null;
  let cancelTimer = null;
  const dispatch = () => {
    if (cancelTimer !== null) {
      cancelTimer();
      cancelTimer = null;
    }
    if (items.length === 0) return;
    const batch = items;
    items = [];
    chars = 0;
    oldestAt = null;
    try {
      options.send(batch);
    } catch {
    }
  };
  return {
    push(item) {
      items.push(item);
      chars += item.msg.length + item.pageUrl.length + item.level.length + 16;
      if (oldestAt === null) {
        oldestAt = now();
        cancelTimer = schedule(dispatch, flushMs);
      }
      if (items.length >= maxItems || chars >= maxChars) dispatch();
    },
    flush: dispatch
  };
}

// src/client/index.ts
var inject = [
  "slots",
  "sessions",
  "theme",
  "workspaces",
  "connection"
];
function installWebviewConsoleMirror() {
  const invoke2 = (cmd, args) => {
    void shellRpc.invoke(cmd, args).catch((error) => {
      console.warn(`[dsh-desktop-tauriapp] \u9875\u9762\u65E5\u5FD7\u955C\u50CF\u901A\u9053\u4E0D\u53EF\u7528\uFF1A${String(error)}`);
    });
  };
  let batchSupported = true;
  const consoleBatch = createConsoleBatch({
    send: (items) => {
      const send = (cmd, args) => {
        if (!shellRpc.available()) return null;
        return shellRpc.invoke(cmd, args);
      };
      const batched = batchSupported ? send("log_console_batch", { items }) : null;
      if (batched !== null) {
        batched.then(
          () => {
          },
          () => {
            batchSupported = false;
            for (const item of items) invoke2("log_console", item);
          }
        );
        return;
      }
      for (const item of items) invoke2("log_console", item);
    }
  });
  const fwd = (level, args) => {
    try {
      const msg = args.map((a) => {
        if (a instanceof Error) return a.stack ? `${a.message}
${a.stack}` : a.message;
        if (typeof a === "object") {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      }).join(" ");
      const url = typeof location !== "undefined" && location.href || "?";
      consoleBatch.push({ level, msg, pageUrl: url });
    } catch {
    }
  };
  const levels = ["log", "info", "warn", "error", "debug"];
  for (const lvl of levels) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...a) => {
      fwd(lvl, a);
      orig.apply(console, a);
    };
  }
  window.addEventListener("error", (e) => {
    const err = e.error;
    const text = err?.message ? `${err.message}${err.stack ? `
${err.stack}` : ""}` : err?.stack || e.message || "Uncaught error";
    fwd("error", [text]);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    fwd("error", [`Unhandled rejection: ${r?.message || String(e.reason)}`, r?.stack || ""]);
  });
}
function installNoRubberBand() {
  try {
    const style = document.createElement("style");
    style.dataset.dshDesktopNoBounce = "1";
    style.textContent = "html{overscroll-behavior:none;-webkit-overflow-scrolling:touch;} body{overscroll-behavior:none;}";
    (document.head || document.documentElement).appendChild(style);
  } catch {
  }
}
function apply(ctx) {
  let step = "\u672A\u5F00\u59CB";
  try {
    step = "console \u955C\u50CF";
    installWebviewConsoleMirror();
    step = "\u6A61\u76AE\u7B4B\u6EDA\u52A8";
    installNoRubberBand();
    step = "\u8F93\u5165\u6846\u63A7\u5236\u5B57\u7B26\u5B88\u62A4";
    installComposerInputGuard();
    step = "\u4E0B\u8F7D\u7BA1\u7406\u5668 tab";
    registerDownloadsTab(ctx);
    step = "\u4E0B\u8F7D\u62E6\u622A";
    installDownloadInterceptor();
    step = "\u6D4F\u89C8\u5668 guest \u6865";
    installDesktopBrowserBridge();
    step = "\u684C\u9762\u6863\u5FEB\u6377\u952E\u6865";
    installDesktopPlatformBridge(ctx);
    step = "\u684C\u9762\u8BBE\u7F6E tab";
    registerDesktopSettings(ctx);
    step = "\u901A\u77E5\u8BBE\u7F6E tab";
    registerNotificationsTab(ctx);
    step = "\u9AD8\u7EA7\u5E03\u5C40";
    void requestDesktopClientEnvironment().then((environment) => {
      if (environment !== void 0) applyAdvancedShell(ctx, environment);
    }).catch((error) => {
      console.warn(`[dsh-desktop-tauriapp] \u63D2\u4EF6\u6FC0\u6D3B\u6B65\u9AA4\u5931\u8D25\uFF08${step}\uFF09\uFF1A${String(error)}`);
    });
  } catch (error) {
    console.error(`[dsh-desktop-tauriapp] \u63D2\u4EF6\u6FC0\u6D3B\u5931\u8D25\u4E8E\u300C${step}\u300D`, error);
    throw error;
  }
}
return module.exports;
  }
});

//# sourceMappingURL=client.js.map
