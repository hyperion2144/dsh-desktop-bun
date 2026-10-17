// F12：壳注入到页面里的确认弹窗（旧壳 register/mod.rs confirm_modal_js 的等价物）。
// 旧壳用 Tauri IPC `ui_input_confirm` 回填；新壳页面没有 Tauri，#128 起改调官方 RPC
// 显式方法 `ui_input_confirm`（commands.ts，同名命令在命令表里已经在了）。
// 本模块只产 JS 文本与方法名常量（纯逻辑，可单测）。

/** 确认回填的 HTTP 端点（壳侧路由保留，见 shell-server.ts）；#128 起注入脚本改走官方 RPC 显式方法。 */
export const INPUT_CONFIRM_ENDPOINT = '/__shell__/input-confirm'

export interface ConfirmModalSpec {
  /** 回填的流标识（旧壳 register 用固定 flow 判别） */
  flow: string
  title: string
  body: string
  /** 确认按钮文案（旧壳「仍要注册（覆盖）」） */
  okLabel?: string
  cancelLabel?: string
}

/** 确认回填走的官方 RPC 方法名（commands.ts 的 ui_input_confirm；同名命令在命令表里已存在）。 */
export const INPUT_CONFIRM_METHOD = 'ui_input_confirm'

/** 确认弹窗 JS：确认回填 value='force'，取消/ESC 回填空串；RPC 发出后自移除。 */
export function confirmModalScript(spec: ConfirmModalSpec): string {
  const flow = JSON.stringify(spec.flow)
  const title = JSON.stringify(spec.title)
  const body = JSON.stringify(spec.body)
  const okLabel = JSON.stringify(spec.okLabel ?? '仍要注册（覆盖）')
  const cancelLabel = JSON.stringify(spec.cancelLabel ?? '取消')
  const method = JSON.stringify(INPUT_CONFIRM_METHOD)
  return `(function(){
  var key = 'dshDesktopConfirmModal';
  var old = document.getElementById(key);
  if (old) old.remove();
  var overlay = document.createElement('div');
  overlay.id = key;
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';
  var card = document.createElement('div');
  card.style.cssText = 'background:var(--dsw-alias-bg-layer-1,#1e1e1e);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:12px;padding:18px 20px;min-width:360px;max-width:80vw;box-shadow:0 12px 40px rgba(0,0,0,0.4);color:var(--dsw-alias-label-primary,#eee);';
  var titleEl = document.createElement('div');
  titleEl.textContent = ${title};
  titleEl.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:10px;';
  var bodyEl = document.createElement('div');
  bodyEl.textContent = ${body};
  bodyEl.style.cssText = 'font-size:12.5px;line-height:1.6;white-space:pre-wrap;color:var(--dsw-alias-label-secondary,#bbb);word-break:break-all;';
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;';
  var cancel = document.createElement('button');
  cancel.textContent = ${cancelLabel};
  cancel.style.cssText = 'padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#444);background:transparent;color:var(--dsw-alias-label-primary,#eee);font-size:13px;cursor:default;';
  var ok = document.createElement('button');
  ok.textContent = ${okLabel};
  ok.style.cssText = 'padding:6px 14px;border-radius:8px;border:none;background:var(--dsw-alias-state-accent-primary,#3b82f6);color:#fff;font-size:13px;cursor:default;';
  var done = false;
  function submit(value) {
    if (done) return;
    done = true;
    // #128：官方 RPC 分发器（preload 最早期装）。永远返回 Promise，桥缺失时 reject 不抛同步异常。
    // 分发器缺席必须报出来：之前是 \`if (rpc.request)\` 守卫，缺席时按钮点了没反应也不留痕，
    // 与另外三处注入脚本的 \`?? Promise.reject(...)\` 口径不一致（#128 复核）。
    var rpc = globalThis.__DSH_SHELL_RPC__ || {};
    var sent = typeof rpc.request === 'function'
      ? rpc.request(${method}, { flow: ${flow}, value: value })
      : Promise.reject(new Error('shell rpc unavailable'));
    sent['catch'](function (err) { console.error('[shell] ui_input_confirm 发送失败', err); });
    overlay.remove();
  }
  ok.addEventListener('click', function(){ submit('force') });
  cancel.addEventListener('click', function(){ submit('') });
  overlay.addEventListener('keydown', function(e){ if (e.key === 'Escape') submit('') });
  row.appendChild(cancel);
  row.appendChild(ok);
  card.appendChild(titleEl);
  card.appendChild(bodyEl);
  card.appendChild(row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  ok.focus();
})()`
}
