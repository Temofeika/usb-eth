const { app, BrowserWindow, Tray, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const { exec } = require('child_process');

// Защита от повторного запуска: если программа уже работает в трее, разворачиваем существующее окно
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// Запуск встроенного локального сервера USB-Link Pro только в основном экземпляре
require('./server');

let mainWindow = null;
let tray = null;
const HTTP_PORT = 4545;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: '⚡ USB-Link Pro — Сетевой проброс USB',
    backgroundColor: '#0b0f19',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Ожидаем старта Express сервера и загружаем веб-интерфейс
  setTimeout(() => {
    mainWindow.loadURL(`http://localhost:${HTTP_PORT}`);
  }, 500);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Открытие внешних ссылок в браузере по умолчанию
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });
}

function createTray() {
  const { nativeImage } = require('electron');
  // Создаем системную иконку из встроенного буфера или файла, чтобы исключить ошибки на любых ПК
  let iconData = nativeImage.createEmpty();
  try {
    const iconPath = path.join(__dirname, 'public', 'favicon.ico');
    if (require('fs').existsSync(iconPath)) {
      iconData = nativeImage.createFromPath(iconPath);
    }
  } catch (e) {}

  tray = new Tray(iconData);

  const contextMenu = Menu.buildFromTemplate([
    { label: '⚡ USB-Link Pro', enabled: false },
    { type: 'separator' },
    { label: '🖥️ Открыть главное окно', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: '🌐 Открыть в веб-браузере', click: () => { shell.openExternal(`http://localhost:${HTTP_PORT}`); } },
    { type: 'separator' },
    { label: '❌ Выход и остановка проброса', click: () => {
        app.isQuiting = true;
        app.quit();
      } 
    }
  ]);

  tray.setToolTip('⚡ USB-Link Pro — Работает в фоновом режиме');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

// Запуск приложения
app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // В Windows не выходим при закрытии окна, оставляем работать в трее для поддержания сетевых соединений
  }
});

app.on('before-quit', () => {
  app.isQuiting = true;
  try {
    const http = require('http');
    const req = http.request({ hostname: '127.0.0.1', port: 4545, path: '/api/cleanup-all', method: 'POST' });
    req.end();
  } catch (e) {}
});

// IPC Обработчик для установки драйвера с правами Администратора в один клик
ipcMain.handle('install-driver-admin', async () => {
  return new Promise((resolve) => {
    const fs = require('fs');
    const os = require('os');
    const tmpScript = path.join(os.tmpdir(), 'install_usbipd.ps1');
    const scriptContent = `
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Clear-Host
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " ⚡ USB-Link Pro — Установка системного драйвера USBIP" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Запуск установки официального драйвера usbipd-win через winget..." -ForegroundColor Yellow
try {
    winget install --id dorssel.usbipd-win -e --source winget
    Write-Host ""
    Write-Host "✅ Установка успешно завершена!" -ForegroundColor Green
    Write-Host "Пожалуйста, перезапустите USB-Link Pro для активации аппаратного режима." -ForegroundColor Green
} catch {
    Write-Host "❌ Ошибка установки. Попробуйте установить вручную с сайта github.com/dorssel/usbipd-win" -ForegroundColor Red
}
Write-Host ""
Read-Host "Нажмите Enter для закрытия окна..."
`;
    try {
      fs.writeFileSync(tmpScript, scriptContent, 'utf8');
      // Запускаем powershell.exe, который элевирует выполнение временного скрипта
      const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"${tmpScript}\\"' -Wait"`;
      exec(cmd, (err) => {
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          resolve({ success: true });
        }
      });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
});

// IPC Обработчик для автоматического скачивания и установки клиентского драйвера VHCI (usbip-win2) с правами Администратора
ipcMain.handle('install-client-admin', async () => {
  return new Promise((resolve) => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpScript = path.join(os.tmpdir(), 'install_vhci.ps1');
    const scriptContent = `
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Clear-Host
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " ⚡ USB-Link Pro — Установка клиентского драйвера VHCI" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Запрос информации о последнем релизе usbip-win2 с GitHub..." -ForegroundColor Yellow
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/vadimgrn/usbip-win2/releases/latest'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -match "ARM") { "arm64" } else { "x64" }
    $asset = $release.assets | Where-Object { $_.name -match $arch -and $_.name -match "\\.exe$" } | Select-Object -First 1
    if (-not $asset) {
        throw "Не найден установочный файл для архитектуры $arch"
    }
    $url = $asset.browser_download_url
    $installer = "$env:TEMP\\" + $asset.name
    Write-Host "Скачивание драйвера ($($asset.name)) из $url..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
    Write-Host "Запуск инсталлятора драйвера ядра VHCI..." -ForegroundColor Green
    Start-Process -FilePath $installer -ArgumentList "/SILENT /NORESTART" -Wait
    Write-Host ""
    Write-Host "✅ Клиентский драйвер VHCI (usbip-win2) успешно установлен!" -ForegroundColor Green
    Write-Host "Пожалуйста, перезапустите USB-Link Pro для активации аппаратного приема устройств." -ForegroundColor Green
} catch {
    Write-Host "❌ Ошибка установки: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Попробуйте скачать и установить вручную: github.com/vadimgrn/usbip-win2/releases" -ForegroundColor Yellow
}
Write-Host ""
Read-Host "Нажмите Enter для закрытия окна..."
`;
    try {
      fs.writeFileSync(tmpScript, scriptContent, 'utf8');
      const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"${tmpScript}\\"' -Wait"`;
      exec(cmd, (err) => {
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          resolve({ success: true });
        }
      });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
});

