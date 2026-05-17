// ============================================================
// MicButton — 语音输入按钮
//
// 原生端：长按录音 → speech-to-text → 填入输入框
// 浏览器端：显示提示 "语音输入仅在手机端可用"
// ============================================================

import React, { useState, useRef, useCallback } from 'react'
import { isNativePlatform } from '../../native/index'

interface MicButtonProps {
  onTranscript: (text: string) => void
}

export default function MicButton({ onTranscript }: MicButtonProps): React.ReactElement {
  const [recording, setRecording] = useState(false)
  const [showTooltip, setShowTooltip] = useState(false)
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const handlePointerDown = useCallback(async () => {
    if (!isNativePlatform()) {
      setShowTooltip(true)
      clearTimeout(tooltipTimer.current)
      tooltipTimer.current = setTimeout(() => setShowTooltip(false), 2000)
      return
    }

    try {
      // @ts-ignore — Capacitor 插件运行时可用
      const { SpeechRecognition } = await import('@capacitor-community/speech-recognition')
      // @ts-ignore
      const available = await SpeechRecognition.available()
      if (!available.available) return

      await SpeechRecognition.requestPermissions()
      await SpeechRecognition.start({ language: 'zh-CN', popup: false })
      setRecording(true)
    } catch {
      /* 录音启动失败，静默 */
    }
  }, [onTranscript])

  const handlePointerUp = useCallback(async () => {
    if (!isNativePlatform() || !recording) return

    try {
      // @ts-ignore — Capacitor 插件运行时可用
      const { SpeechRecognition } = await import('@capacitor-community/speech-recognition')
      await SpeechRecognition.stop()

      const result: any = await new Promise((resolve) => {
        SpeechRecognition.addListener('partialResults', (data: any) => {
          resolve(data)
        })
        // 超时 5 秒
        setTimeout(() => resolve(null), 5000)
      })

      if (result?.matches?.length > 0) {
        onTranscript(result.matches[0])
      }
    } catch {
      /* 识别失败，静默 */
    } finally {
      setRecording(false)
    }
  }, [recording, onTranscript])

  return (
    <button
      className={`mic-button${recording ? ' mic-button-recording' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => recording && handlePointerUp()}
      title="语音输入"
      style={{ touchAction: 'manipulation' }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
      {showTooltip && (
        <span className="mic-tooltip">语音输入仅在手机端可用</span>
      )}
    </button>
  )
}
