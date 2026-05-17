// Headless test: load web-ui standalone build
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 800, height: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  })

  // Inject error handler
  win.webContents.on('did-start-loading', () => {
    win.webContents.executeJavaScript(`
      window.__capturedErrors = [];
      window.addEventListener('error', function(e) {
        window.__capturedErrors.push({
          message: e.message,
          filename: e.filename,
          lineno: e.lineno,
          stack: e.error ? e.error.stack : 'no stack'
        });
      });
    `).catch(() => {})
  })

  // Load web-ui standalone build
  const htmlPath = path.join(__dirname, '..', '..', 'packages', 'web-ui', 'dist', 'index.html')
  console.log(`Loading web-ui build: ${htmlPath}`)
  win.loadFile(htmlPath)

  setTimeout(() => {
    win.webContents.executeJavaScript('JSON.stringify(window.__capturedErrors || [])')
      .then(result => {
        const captured = JSON.parse(result)
        console.log('\n=== ERRORS ===')
        if (captured.length === 0) {
          console.log('No errors! Web-ui works standalone.')
        } else {
          captured.forEach((e, i) => {
            console.log(`\n--- Error ${i+1} ---`)
            console.log('Message:', e.message)
            console.log('Location:', e.filename, 'line', e.lineno)
            console.log('Stack:', e.stack)
          })
        }
        return win.webContents.executeJavaScript('document.getElementById("root").innerHTML.substring(0, 300)')
      })
      .then(html => {
        console.log('\n=== ROOT ===')
        console.log(html || '(empty)')
      })
      .finally(() => app.quit())
  }, 5000)
})

app.on('window-all-closed', () => app.quit())
