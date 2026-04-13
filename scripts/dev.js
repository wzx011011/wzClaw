// Dev launcher — clears ELECTRON_RUN_AS_NODE before spawning electron-vite.
// When running inside an Electron-based IDE (VSCode/Cursor), the terminal
// inherits ELECTRON_RUN_AS_NODE=1 which breaks electron-vite's Electron subprocess.
delete process.env.ELECTRON_RUN_AS_NODE

const { spawn } = require('child_process')
const shell = process.platform === 'win32'

const child = shell
  ? spawn('npx', ['electron-vite', 'dev'], { stdio: 'inherit', env: process.env, shell: true })
  : spawn('npx', ['electron-vite', 'dev'], { stdio: 'inherit', env: process.env })

child.on('close', (code) => process.exit(code))
child.on('error', (err) => {
  console.error('Failed to start electron-vite:', err)
  process.exit(1)
})
