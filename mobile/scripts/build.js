// ============================================================
// wzxClaw 移动端一键构建 APK 脚本
//
// 流程：
// 1. 检查 JDK 17 环境变量
// 2. 构建 web-ui 前端产物
// 3. Capacitor sync 同步到 Android 项目
// 4. Gradle assembleRelease 构建 release APK
//
// 使用：node scripts/build.js
// 环境要求：JDK 17 + Android SDK
// ============================================================

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = resolve(__dirname, '..');
const WEB_UI_ROOT = resolve(MOBILE_ROOT, '..', 'packages', 'web-ui');
const ANDROID_ROOT = resolve(MOBILE_ROOT, 'android');

// 用户已知的 JDK 17 路径（自动检测回退）
const JDK_FALLBACK_PATHS = [
  'C:/Users/67376/jdk17/jdk-17.0.18+8',
  '/c/Users/67376/jdk17/jdk-17.0.18+8',
];

/**
 * 执行 shell 命令，失败时打印完整错误并退出
 * @param {string} cmd - 要执行的命令
 * @param {string} cwd - 工作目录
 * @param {string} label - 步骤标签（用于日志）
 * @returns {number} 耗时（毫秒）
 */
function run(cmd, cwd, label) {
  console.log(`\n[${label}] ${cmd}`);
  console.log(`  工作目录: ${cwd}`);
  const start = Date.now();
  try {
    execSync(cmd, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env },
    });
    const elapsed = Date.now() - start;
    console.log(`[${label}] 完成 (${(elapsed / 1000).toFixed(1)}s)`);
    return elapsed;
  } catch (err) {
    console.error(`\n[${label}] 失败！`);
    console.error(err.message || err);
    process.exit(1);
  }
}

/**
 * 检测 JDK 17 — 读取 JAVA_HOME 环境变量
 * 不存在时尝试已知的 JDK 安装路径
 */
function checkJdk() {
  if (process.env.JAVA_HOME) {
    console.log(`JAVA_HOME: ${process.env.JAVA_HOME}`);
    return;
  }

  // 尝试已知路径
  for (const candidate of JDK_FALLBACK_PATHS) {
    if (existsSync(candidate)) {
      process.env.JAVA_HOME = candidate;
      console.log(`JAVA_HOME 自动检测: ${candidate}`);
      return;
    }
  }

  // 未找到 JDK
  console.error('错误: JAVA_HOME 未设置，且未在已知路径找到 JDK 17。');
  console.error('  请设置环境变量:');
  console.error('    set JAVA_HOME=C:\\path\\to\\jdk17');
  console.error('  或将 JDK 17 安装到已知路径。');
  process.exit(1);
}

// ---- 主流程 ----

const totalStart = Date.now();

console.log('========================================');
console.log('  wzxClaw 移动端 APK 构建');
console.log('========================================');

// 步骤 0: 检查 JDK
console.log('\n--- 步骤 0/3: 检查 JDK 环境 ---');
checkJdk();

// 步骤 1: 构建 web-ui 前端
console.log('\n--- 步骤 1/3: 构建 web-ui ---');
if (!existsSync(resolve(WEB_UI_ROOT, 'package.json'))) {
  console.error(`错误: web-ui 未找到 (${WEB_UI_ROOT})`);
  process.exit(1);
}
run('npm run build', WEB_UI_ROOT, 'web-ui build');

// 步骤 2: Capacitor sync
console.log('\n--- 步骤 2/3: Capacitor sync ---');
if (!existsSync(resolve(ANDROID_ROOT))) {
  console.error(`错误: Android 项目未找到 (${ANDROID_ROOT})`);
  console.error('  请先运行: npx cap add android');
  process.exit(1);
}
run('npx cap sync android', MOBILE_ROOT, 'cap sync');

// 步骤 3: Gradle 构建 release APK
console.log('\n--- 步骤 3/3: Gradle assembleRelease ---');
const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
if (!existsSync(resolve(ANDROID_ROOT, gradlew))) {
  console.error(`错误: Gradle wrapper 未找到 (${ANDROID_ROOT}/${gradlew})`);
  console.error('  请先运行: npx cap add android');
  process.exit(1);
}
run(`${gradlew} assembleRelease`, ANDROID_ROOT, 'Gradle');

// 输出结果
const totalElapsed = Date.now() - totalStart;
const apkDir = resolve(ANDROID_ROOT, 'app', 'build', 'outputs', 'apk', 'release');
// 未配置签名时输出 app-release-unsigned.apk，配置签名后输出 app-release.apk
const apkSigned = resolve(apkDir, 'app-release.apk');
const apkUnsigned = resolve(apkDir, 'app-release-unsigned.apk');
const apkPath = existsSync(apkSigned) ? apkSigned : apkUnsigned;

if (existsSync(apkPath)) {
  const { statSync } = await import('node:fs');
  const stat = statSync(apkPath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
  const isUnsigned = apkPath === apkUnsigned;
  console.log('\n========================================');
  console.log('  构建成功！');
  console.log(`  APK: ${apkPath}`);
  console.log(`  大小: ${sizeMB} MB`);
  if (isUnsigned) {
    console.log('  注意: APK 未签名（debug 签名，可用于测试安装）');
  }
  console.log(`  总耗时: ${(totalElapsed / 1000).toFixed(1)}s`);
  console.log('========================================');
} else {
  console.warn(`\n警告: APK 文件未在预期位置找到 (${apkDir})`);
  console.warn('  请检查 Gradle 输出中的实际路径。');
}
