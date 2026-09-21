// 从 third_party/zcode（官方开源仓，Apache-2.0）构建 companion 用的协议契约层
// bundle。产物 vendor/zcode-protocol.cjs 提交入库，运行时零 submodule 依赖。
//
// 升级流程（取代盲探）：
//   1. cd third_party/zcode && git fetch && git checkout <新提交>
//   2. git diff <旧>..<新> -- packages/shared/src/zcode-protocol*  审阅契约变化
//   3. node scripts/build-zcode-protocol.mjs
//   4. npm test（含 vendor 契约测试）+ probe-surface-0169 对真实引擎交叉验证
//   5. 同步更新 APP-SERVER.md 实测记录与 SUPPORTED_RUNTIME_PREFIXES
//
// esbuild 通过 alias 把 workspace 包名映射进 submodule 源码；zod 用 relay 本地
// 依赖（官方钉 4.6.5，升级 zod 必须对照 third_party/zcode/packages/shared）。
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const relayDir = path.resolve(here, '..');
const upstream = path.resolve(relayDir, '../../third_party/zcode');
const zodEntry = require.resolve('zod', { paths: [relayDir] });

await build({
  entryPoints: [path.join(relayDir, 'vendor-src/entry.ts')],
  outfile: path.join(relayDir, 'vendor/zcode-protocol.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: false,
  legalComments: 'inline',
  banner: {
    js: [
      '/*! zcode-protocol vendor bundle',
      ' * 源码: https://github.com/wzx011011/ZCode (Apache-2.0)',
      ' * 由 relay/zcode/scripts/build-zcode-protocol.mjs 生成，勿手改。',
      ' */',
    ].join('\n'),
  },
  alias: {
    '@zcode/shared': path.join(upstream, 'packages/shared/src/index.ts'),
    '@zcode/shared/zcode-protocol-v4': path.join(
      upstream, 'packages/shared/src/zcode-protocol-v4/index.ts'),
    '@zcode/shared/runtime-env': path.join(upstream, 'packages/shared/src/runtimeEnv.ts'),
    '@zcode/model-option-map': path.join(upstream, 'packages/model-option-map/src/index.ts'),
    '@zcode/rpc': path.join(upstream, 'packages/rpc/src/index.ts'),
    zod: zodEntry,
  },
  // services 包内部用 package imports（"#src/..."）互引；入口不在该包上下文，
  // esbuild 的 alias 不吃 # 前缀，这里用 onResolve 显式映射。
  plugins: [{
    name: 'resolve-services-hash-imports',
    setup(build) {
      const servicesSrc = path.join(upstream, 'packages/services/src');
      build.onResolve({ filter: /^#src\// }, (args) => {
        const rel = path.relative('#src', args.path);
        const base = path.join(servicesSrc, rel);
        // 源码按 TS ESM 惯例写 .js 后缀，实际落盘是 .ts
        for (const candidate of [`${base.slice(0, -3)}.ts`, path.join(base.slice(0, -3), 'index.ts')]) {
          if (existsSync(candidate)) return { path: candidate };
        }
        return { path: base };
      });
    },
  }],
});

console.log('vendor/zcode-protocol.cjs 构建完成');
