/**
 * 构建 dsh-desktop-bun 的 client bundle（== 参考项目 dsh-plugin-desktop 的 client 构建）。
 * 产物 lib/client.js 包裹在 `window.__ModuleLoader__.load({ id, factory })` 中，
 * React / cordis / dsh client 运行时走 loader 注入的 require（external），
 * 其余按需内联。浏览器端由 dsh web 以 /plugins/dsh-desktop-bun/client.js 加载；注册 id 必须与宿主挂载名一致
 * （plugin-staging.ts 的 DESKTOP_PLUGIN_PACKAGE），否则模块系统激活不到工厂、重复执行 bundle（#19）。
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// bundle 工厂 id = 宿主挂载名：模块系统按 entries[].id 找工厂，旧名会让页面卡「Loading plugins」（#19）。
const PACKAGE_NAME = 'dsh-desktop-bun'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const result = await build({
  entryPoints: [join(root, 'src/client/index.ts')],
  outfile: join(root, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-runtime/client',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-web-react',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  banner: {
    js: `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(PACKAGE_NAME)},\n  factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;\n`,
  },
  footer: {
    js: 'return module.exports;\n  }\n});\n',
  },
})
if (result.errors.length > 0) process.exit(1)
