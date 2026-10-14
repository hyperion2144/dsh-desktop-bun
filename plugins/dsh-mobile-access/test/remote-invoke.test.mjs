// #47 远程命令桥：remoteInvokePatch 生成的 invoke shim 注入面。
// 只验证生成物本身（端点/请求头/协议字形、端口与 token 缺一不下）；真链路
// （壳侧 REMOTE_ALLOWED_COMMANDS 白名单 + /_loopback 转发 + 配对门禁）由
// desktop-electrobun/test/view-grant.test.ts 与实例验收覆盖。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// proxy.mjs 在模块导入时冻结 LOG_PATH 并打开 $DSH_HOME/mobile-access.log（flags:'a'）
// ——先建目录再动态导入，与 apply-rpc.test.mjs 同一守卫。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-remote-'));
const ORIG = process.env.DSH_HOME;
process.env.DSH_HOME = home;
after(() => {
  if (ORIG === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIG;
  fs.rmSync(home, { recursive: true, force: true });
});

const { remoteInvokePatch } = await import('../lib/proxy.mjs');

test('remoteInvokePatch：端口+token 齐全才生成 shim，协议与壳侧 tauri-ipc 对齐', () => {
  const patch = remoteInvokePatch('6391', 'tok-abc');
  assert.ok(typeof patch === 'string' && patch.startsWith('<script data-dsh-mobile-remote-rpc="1">'));
  assert.ok(patch.includes('/_loopback/6391/__shell__/rpc'));
  assert.ok(patch.includes('"x-dsh-shell-view"'));
  assert.ok(patch.includes('JSON.stringify({cmd:String(cmd)'));
  assert.ok(patch.includes('__TAURI_INTERNALS__'));
  assert.ok(patch.includes('__TAURI__'));
  assert.ok(patch.endsWith('</script>'));
  // 数字端口同样收
  assert.equal(typeof remoteInvokePatch(6391, 'tok-abc'), 'string');
});

test('remoteInvokePatch：缺 token / 非法端口返回 null（不注入，维持无桥现状）', () => {
  assert.equal(remoteInvokePatch('6391', undefined), null);
  assert.equal(remoteInvokePatch('6391', ''), null);
  assert.equal(remoteInvokePatch(undefined, 'tok-abc'), null);
  assert.equal(remoteInvokePatch('0', 'tok-abc'), null);
  assert.equal(remoteInvokePatch('70000', 'tok-abc'), null);
  assert.equal(remoteInvokePatch('not-a-port', 'tok-abc'), null);
});
