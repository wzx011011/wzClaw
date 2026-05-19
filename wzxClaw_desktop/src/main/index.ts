import { config as dotenvConfig } from 'dotenv'
import path from 'path'
// Explicitly resolve .env from project root (cwd is unreliable in packaged Electron)
const _envResult = dotenvConfig({ path: path.resolve(__dirname, '../../.env') })
if (_envResult.error) {
  console.warn('[dotenv] .env not loaded:', _envResult.error.message)
} else {
  console.log('[dotenv] loaded, LANGFUSE_PUBLIC_KEY=', process.env.LANGFUSE_PUBLIC_KEY?.slice(0, 10) + '...')
}

import { app } from 'electron'

// ���� Windows ��ק�����޸� ��������������������������������������������������������������������������������������������������
// ������ app.whenReady() ǰ���ã�������Ч
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,HardwareMediaKeyHandling')

// ���� EPIPE ���󣨸������˳�ʱ��־д������� EPIPE��
process.stdout.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err })
process.stderr.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err })

import { initServices } from './bootstrap/init-services'
import { createCoreManagers } from './bootstrap/create-core-managers'
import { registerAllTools } from './bootstrap/register-all-tools'
import { wireAllIpcHandlers } from './bootstrap/wire-all-ipc-handlers'
import { setupAppLifecycle } from './bootstrap/setup-app-lifecycle'

const _t0 = Date.now()
const logStartup = (label: string) => console.log(`[STARTUP] +${Date.now() - _t0}ms  ${label}`)
const is = { dev: !app.isPackaged }

// NOTE: Single-instance lock REMOVED �� suspected cause of "Not Responding" freeze.

app.whenReady().then(async () => {
  logStartup('app.whenReady fired')
  if (is.dev) { app.setAppUserModelId(process.execPath) }
  else { app.setAppUserModelId('com.wzxclaw') }

  const services = await initServices(logStartup)
  const managers = await createCoreManagers(services, logStartup)
  await registerAllTools({ ...managers, ...services })
  wireAllIpcHandlers({ ...managers, ...services }, logStartup)
  setupAppLifecycle({ ...managers, ...services, logStartup })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
