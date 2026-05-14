// ============================================================
// 一键构建 APK 脚本
//
// 流程：
// 1. 构建 web-ui 前端产物
// 2. Capacitor sync 同步到 Android 项目
// 3. Gradle assembleRelease 构建 release APK
//
// 使用：node scripts/build.js
// 环境要求：JDK 17, Android SDK
// ============================================================

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = resolve(__dirname, '..');
const WEB_UI_ROOT = resolve(MOBILE_ROOT, '..', 'packages', 'web-ui');
const ANDROID_ROOT = resolve(MOBILE_ROOT, 'android');

/**
 * 执行 shell 命令，失败时打印完整错误并退出
 * @param {string} cmd - 要执行的命令
 * @param {string} cwd - 工作目录
 * @param {string} label - 步骤标签（用于日志）
 */
function run(cmd, cwd, label) {
  console.log(`\n[${label}] ${cmd}`);
  console.log(`  工作目录: ${cwd}`);
  try {
    execSync(cmd, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env },
    });
    console.log(`[${label}] 完成`);
  } catch (err) {
    console.error(`\n[${label}] 失败！`);
    console.error(err.message || err);
    process.exit(1);
  }
}

/**
 * 检测 JDK 17 — 读取 JAVA_HOME 环境变量
 * 不存在时打印警告，让 Gradle 自行检测
 */
function checkJdk() {
  const javaHome = process.env.JAVA_HOME;
  if (javaHome) {
    console.log(`JAVA_HOME: ${javaHome}`);
  } else {
    console.warn('警告: JAVA_HOME 未设置。Gradle 将尝试自动检测 JDK。');
    console.warn('  如果构建失败，请设置 JAVA_HOME 指向 JDK 17 安装目录。');
  }
}

// ---- 主流程 ----

console.log('========================================');
console.log('  wzxClaw 移动端 APK 构建');
console.log('========================================');

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

// 输出 APK 路径
const apkPath = resolve(
  ANDROID_ROOT,
  'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'
);
if (existsSync(apkPath)) {
  console.log('\n========================================');
  console.log('  构建成功！');
  console.log(`  APK: ${apkPath}`);
  console.log('========================================');
} else {
  console.warn(`\n警告: APK 文件未在预期位置找到 (${apkPath})`);
  console.warn('  请检查 Gradle 输出中的实际路径。');
}
