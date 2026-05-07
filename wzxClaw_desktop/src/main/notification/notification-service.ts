// ============================================================
// NotificationService — Agent 完成时的声音 + 桌面通知
// ============================================================

import { Notification } from 'electron'
import { execFile } from 'child_process'

/**
 * 在 Agent 完成长时间任务时提供反馈：
 *   - 播放系统提示音
 *   - 发送系统桌面通知（仅当窗口不在前台时）
 *
 * 用户可在设置中分别开关声音和桌面通知。
 */
export class NotificationService {
  private soundEnabled: boolean
  private desktopEnabled: boolean

  constructor(opts?: { soundEnabled?: boolean; desktopEnabled?: boolean }) {
    this.soundEnabled = opts?.soundEnabled ?? true
    this.desktopEnabled = opts?.desktopEnabled ?? true
  }

  /** 更新配置 */
  configure(opts: { soundEnabled?: boolean; desktopEnabled?: boolean }): void {
    if (opts.soundEnabled !== undefined) this.soundEnabled = opts.soundEnabled
    if (opts.desktopEnabled !== undefined) this.desktopEnabled = opts.desktopEnabled
  }

  /**
   * 发送 agent 完成通知。
   * @param isWindowFocused 当前窗口是否在前台（前台时不发送桌面通知）
   * @param title 通知标题
   * @param body 通知内容
   */
  notify(isWindowFocused: boolean, title: string, body: string): void {
    // 声音（始终播放，除非用户关闭）
    if (this.soundEnabled) {
      this.playSound()
    }

    // 桌面通知（仅窗口不在前台时）
    if (this.desktopEnabled && !isWindowFocused && Notification.isSupported()) {
      const notification = new Notification({ title, body, silent: true })
      notification.show()
    }
  }

  /** 播放提示音 */
  private playSound(): void {
    try {
      if (process.platform === 'win32') {
        // Windows: 系统蜂鸣
        execFile('powershell', ['-c', '[Console]::Beep(800, 200)'], { timeout: 3000 })
      } else if (process.platform === 'darwin') {
        execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], { timeout: 3000 })
      } else {
        execFile('paplay', ['/usr/share/sounds/freedesktop/stereo/complete.oga'], { timeout: 3000 })
      }
    } catch {
      // 声音播放失败不影响任何功能
    }
  }
}
