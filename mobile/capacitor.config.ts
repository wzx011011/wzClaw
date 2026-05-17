// ============================================================
// Capacitor 配置 — wzxClaw 移动端
//
// webDir 指向 web-ui 的构建产物目录
// Capacitor sync 会将该目录的内容复制到 Android assets 中
// ============================================================

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Android 应用包名
  appId: 'com.wzxclaw.mobile',
  // 应用显示名称
  appName: 'wzxClaw',
  // web-ui 构建产物目录（相对于 mobile/）
  webDir: '../packages/web-ui/dist',
  server: {
    // 使用 https scheme 避免 mixed-content 问题
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1000,
      backgroundColor: '#1e1e1e',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#1e1e1e',
    },
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
    SpeechRecognition: {
      permissions: ['RECORD_AUDIO'],
    },
  },
  android: {
    buildOptions: {
      keystorePath: undefined,
      keystoreAlias: undefined,
    },
    // 允许混合内容（开发时 ws:// + 生产 wss://）
    allowMixedContent: true,
  },
};

export default config;
