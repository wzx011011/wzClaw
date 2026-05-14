# wzxClaw 移动端资源

## 图标和启动画面

当前使用 Capacitor 默认资源。Plan 02 会替换为正式图标和启动画面。

### 所需资源文件

| 文件          | 用途     | 推荐尺寸       | 说明                      |
| ------------- | -------- | -------------- | ------------------------- |
| `icon.png`    | 应用图标 | 1024 x 1024px  | 正方形，无圆角（系统裁剪） |
| `splash.png`  | 启动画面 | 2732 x 2732px  | 居中显示，背景色 #1e1e1e   |

### 替换方法

1. 将 `icon.png` 和 `splash.png` 放入此目录
2. 运行 `npx @capacitor/assets generate` 自动生成各尺寸变体
3. 运行 `npx cap sync android` 同步到 Android 项目
