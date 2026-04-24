# wzxClaw Android

**[中文](#中文) | [English](#english)**

---

<a name="中文"></a>
## 中文

[wzxClaw](https://github.com/wzx011011/wzClaw) AI 编程 IDE 的 Flutter 手机伴侣应用。

### 简介

通过 WebSocket 隧道（ngrok）连接到运行中的 wzxClaw 桌面端，让你随时随地通过手机进行 AI 对话。发送消息、查看 AI 流式响应、监控工具执行过程——一切尽在 Android 端。

### 功能特性

- **实时对话** — 发送消息，逐 Token 流式显示 AI Agent 的回复
- **WebSocket 桥接** — 通过 ngrok 隧道 URL 连接 wzxClaw 桌面端
- **语音输入** — 长按麦克风按钮进行语音转文字（中文设备自动使用中文识别）
- **深色主题** — 自定义 `AppColors` 设计系统，Midnight 深色配色
- **会话管理** — 列出所有对话，支持继续历史会话或新建会话
- **工具执行卡片** — 内联展示 FileRead、FileWrite、Bash 等工具调用的实时过程

### 系统要求

- Android 6.0+（API 23+）
- wzxClaw 桌面端已启动并开启 Mobile Bridge
- 桌面端提供的 ngrok 隧道 URL

### 安装

从 [Releases](../../releases) 下载最新 APK，安装到设备上（如提示需开启「允许安装未知来源应用」）。

#### 从源码构建

```bash
# 前置条件：Flutter 3.x stable，Java 17
flutter pub get
flutter build apk --release
# APK 路径：build/app/outputs/flutter-apk/app-release.apk
```

### 使用方法

1. 启动 wzxClaw 桌面端
2. 在设置 → Mobile 中开启隧道，复制 ngrok URL
3. 打开 wzxClaw Android，将 URL 粘贴到连接页面
4. 点击**连接** — 握手成功后进入对话界面

### 技术栈

| 层级 | 技术 |
|---|---|
| 框架 | Flutter 3（Dart） |
| 状态管理 | Provider + StreamController.broadcast() |
| WebSocket | `web_socket_channel` |
| 语音识别 | `speech_to_text` |
| 权限申请 | `permission_handler` |
| 设计系统 | 自定义 `AppColors` 主题扩展 |

### 项目结构

```
lib/
├── config/            # AppColors、常量配置
├── models/            # ChatMessage、SessionMeta、WsMessage、ConnectionState
├── services/          # WebSocketService、VoiceInputService、ConnectionManager
├── widgets/           # MicButton、ToolCallCard、StreamingText 等
└── screens/           # ConnectionScreen、ChatScreen、SessionListScreen
```

---

<a name="english"></a>
## English

Flutter mobile companion app for the [wzxClaw](https://github.com/wzx011011/wzClaw) AI coding IDE.

### Overview

Connects to a running wzxClaw desktop instance over a WebSocket tunnel (ngrok), giving you full chat access from your phone. Send messages, view streaming AI responses, and monitor tool execution — all from Android.

### Features

- **Real-time Chat** — send messages and see token-by-token streaming from the AI agent
- **WebSocket bridge** — connects to wzxClaw desktop via ngrok tunnel URL
- **Voice input** — long-press mic button for speech-to-text using system locale (Chinese devices get Chinese recognition)
- **Dark theme** — custom `AppColors` design system with a dark Midnight palette
- **Session management** — lists all conversations, resume or start new sessions
- **Tool execution cards** — inline display of FileRead, FileWrite, Bash, and other tool calls as they happen

### Requirements

- Android 6.0+ (API 23+)
- wzxClaw desktop running with the Mobile Bridge enabled (Settings → Mobile)
- ngrok tunnel URL from the desktop app

### Installation

Download the latest APK from [Releases](../../releases), install it on your device (enable "Install from unknown sources" if prompted).

#### Build from source

```bash
# Prerequisites: Flutter 3.x stable, Java 17
flutter pub get
flutter build apk --release
# APK at: build/app/outputs/flutter-apk/app-release.apk
```

### Usage

1. Start wzxClaw on your desktop
2. In Settings → Mobile, enable the tunnel and copy the ngrok URL
3. Open wzxClaw Android, paste the URL on the connection screen
4. Tap **Connect** — the chat panel opens when the handshake succeeds

### Tech Stack

| Layer | Technology |
|---|---|
| Framework | Flutter 3 (Dart) |
| State | Provider + StreamController.broadcast() |
| WebSocket | `web_socket_channel` |
| Voice | `speech_to_text` |
| Permissions | `permission_handler` |
| Design | Custom `AppColors` theme extension |

### Project structure

```
lib/
├── config/            # AppColors, constants
├── models/            # ChatMessage, SessionMeta, WsMessage, ConnectionState
├── services/          # WebSocketService, VoiceInputService, ConnectionManager
├── widgets/           # MicButton, ToolCallCard, StreamingText, …
└── screens/           # ConnectionScreen, ChatScreen, SessionListScreen
```

### License

Personal use. Not open-sourced.
