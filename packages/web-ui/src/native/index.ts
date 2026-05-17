// ============================================================
// native/index.ts — 平台检测 + Capacitor 插件加载
//
// 所有原生模块通过此入口访问，浏览器端 graceful no-op。
// Capacitor 插件延迟加载，不增加 web 端包体积。
// ============================================================

/** 是否运行在 Capacitor 原生平台 */
export function isNativePlatform(): boolean {
  return typeof window !== 'undefined' &&
    !!(window as any).Capacitor?.isNativePlatform?.()
}

/**
 * 动态加载 Capacitor 插件
 * 浏览器端返回 null，不抛异常
 */
export async function loadPlugin<T>(pluginName: string): Promise<T | null> {
  if (!isNativePlatform()) return null
  try {
    // @ts-ignore — Capacitor 插件运行时可用
    const mod = await import(/* @vite-ignore */ `@capacitor-community/${pluginName}`)
    const firstKey = Object.keys(mod)[0]
    return firstKey ? (mod[firstKey] as T) : null
  } catch {
    try {
      // @ts-ignore — Capacitor 插件运行时可用
      const mod = await import(/* @vite-ignore */ `@capacitor/${pluginName}`)
      const firstKey = Object.keys(mod)[0]
      return firstKey ? (mod[firstKey] as T) : null
    } catch {
      return null
    }
  }
}
