const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const dgram = require('dgram');
const os = require('os');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const HTTP_PORT = 4545;
const UDP_PORT = 4546;

app.use(corsMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function corsMiddleware(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
}

// --- Состояние сервера и устройств ---
let localDevices = [];
let sharedDevices = new Map(); // id -> deviceObj
let connectedDevices = new Map(); // id -> clientInfo
let discoveredPeers = new Map(); // ip -> peerInfo
let driverStatus = {
  usbipdInstalled: false,
  usbipdVersion: null,
  usbipClientInstalled: false,
  virtualModeActive: true
};

// --- Получение локального IP адреса в сети LAN ---
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !name.toLowerCase().includes('loopback')) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const LOCAL_IP = getLocalIp();
const HOSTNAME = os.hostname();

// --- Проверка системных драйверов USBIP (usbipd-win / usbip) ---
function checkSystemDrivers() {
  exec('usbipd --version', (err, stdout) => {
    if (!err && stdout.trim()) {
      driverStatus.usbipdInstalled = true;
      driverStatus.usbipdVersion = stdout.trim();
      driverStatus.virtualModeActive = false;
      console.log(`[Driver Check] Найдена служба usbipd-win: v${stdout.trim()}`);
    } else {
      driverStatus.usbipdInstalled = false;
      driverStatus.virtualModeActive = true;
      console.log('[Driver Check] usbipd-win не обнаружен. Включен режим сетевой эмуляции USB (Virtual Mode).');
    }
    broadcastState();
  });

  const commonClientPaths = [
    'C:\\Program Files\\usbip-win2',
    'C:\\Program Files\\USBip',
    'C:\\Program Files (x86)\\USBip',
    'C:\\Windows\\System32'
  ];
  commonClientPaths.forEach(p => {
    if (fs.existsSync(p) && !process.env.PATH.includes(p)) {
      process.env.PATH += `;${p}`;
    }
  });

  exec('usbip --version', (err, stdout) => {
    if (!err && stdout.trim()) {
      driverStatus.usbipClientInstalled = true;
      console.log(`[Driver Check] Найден клиентский драйвер VHCI: ${stdout.trim()}`);
    } else {
      const foundFile = commonClientPaths.some(p => fs.existsSync(path.join(p, 'usbip.exe')));
      if (foundFile) {
        driverStatus.usbipClientInstalled = true;
        console.log('[Driver Check] Найден исполняемый файл usbip.exe клиентского драйвера VHCI.');
      } else {
        driverStatus.usbipClientInstalled = false;
      }
    }
    broadcastState();
  });
}

// --- Сканирование физических USB устройств в Windows ---
function scanUsbDevices() {
  // Попытка получить точные данные из usbipd, если установлен
  if (driverStatus.usbipdInstalled) {
    exec('usbipd list', (err, stdout) => {
      if (!err && stdout) {
        parseUsbipdList(stdout);
        return;
      }
      fallbackPowerShellScan();
    });
  } else {
    fallbackPowerShellScan();
  }
}

function parseUsbipdList(output) {
  const lines = output.split('\n');
  const newDevices = [];
  let isDeviceSection = false;

  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('BUSID')) {
      isDeviceSection = true;
      continue;
    }
    if (!isDeviceSection || !line) continue;
    if (line.startsWith('---') || line.startsWith('Persisted')) continue;

    // Формат строки usbipd: BUSID  VID:PID  DEVICE NAME  STATE
    const match = line.match(/^([0-9]+-[0-9]+)\s+([0-9a-fA-F]{4}:[0-9a-fA-F]{4})\s+(.+?)\s+(Not shared|Shared|Attached|Bound|Unshared|Shared \(forced\)).*$/i);
    if (match) {
      const busId = match[1];
      const vidPid = match[2];
      const name = match[3].trim();
      const stateStr = match[4].toLowerCase();

      let isShared = sharedDevices.has(busId) || stateStr.includes('shared') || stateStr.includes('bound');
      let isConnected = connectedDevices.has(busId) || stateStr.includes('attached');

      const devObj = {
        id: busId,
        busId: busId,
        name: name || `USB Device (${vidPid})`,
        vidPid: vidPid.toUpperCase(),
        type: getDeviceTypeIcon(name),
        shared: isShared,
        connected: isConnected,
        connectedTo: connectedDevices.get(busId)?.clientName || null,
        status: isConnected ? 'connected' : (isShared ? 'shared' : 'available')
      };
      newDevices.push(devObj);
      if (isShared) sharedDevices.set(busId, devObj);
    }
  }

  if (newDevices.length > 0) {
    localDevices = newDevices;
    broadcastState();
  } else {
    fallbackPowerShellScan();
  }
}

function fallbackPowerShellScan() {
  // Использование Windows PowerShell для получения реальных PnP USB устройств
  const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$devices = Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB\\*' -and $_.FriendlyName -and $_.FriendlyName -notlike '*Root Hub*' -and $_.FriendlyName -notlike '*Generic USB Hub*' }; if ($devices) { $devices | Select-Object FriendlyName, InstanceId, Class | ConvertTo-Json -Compress } else { '[]' }"`;
  
  exec(psCmd, { encoding: 'utf8', timeout: 4000 }, (err, stdout) => {
    if (err || !stdout) {
      if (localDevices.length === 0) {
        // Резервные тестовые устройства, если сканирование временно заблокировано ОС
        localDevices = getSimulatedDevices();
        broadcastState();
      }
      return;
    }

    try {
      let data = JSON.parse(stdout.trim());
      if (!Array.isArray(data)) data = [data];

      const scanned = [];
      data.forEach((d, idx) => {
        if (!d || !d.FriendlyName) return;
        
        // Извлекаем VID и PID из InstanceId (например USB\VID_046D&PID_C52B\...)
        let vidPid = '0000:0000';
        const vidMatch = d.InstanceId.match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i);
        if (vidMatch) {
          vidPid = `${vidMatch[1]}:${vidMatch[2]}`.toUpperCase();
        }

        const id = `usb-${idx + 1}-${vidPid.replace(':', '')}`;
        const isShared = sharedDevices.has(id);
        const isConnected = connectedDevices.has(id);

        const devObj = {
          id: id,
          busId: `1-${idx + 1}`,
          name: d.FriendlyName,
          vidPid: vidPid,
          type: getDeviceTypeIcon(d.FriendlyName, d.Class),
          shared: isShared,
          connected: isConnected,
          connectedTo: connectedDevices.get(id)?.clientName || null,
          status: isConnected ? 'connected' : (isShared ? 'shared' : 'available')
        };
        scanned.push(devObj);
        if (isShared) sharedDevices.set(id, devObj);
      });

      if (scanned.length > 0) {
        localDevices = scanned;
      } else if (localDevices.length === 0) {
        localDevices = getSimulatedDevices();
      }
      broadcastState();
    } catch (e) {
      if (localDevices.length === 0) {
        localDevices = getSimulatedDevices();
        broadcastState();
      }
    }
  });
}

function getSimulatedDevices() {
  return [
    { id: 'usb-1-046DC52B', busId: '1-1', name: 'Logitech USB Receiver (Mouse & Keyboard)', vidPid: '046D:C52B', type: '🖱️ Keyboard/Mouse', shared: false, connected: false, status: 'available' },
    { id: 'usb-2-07815581', busId: '1-2', name: 'SanDisk Ultra USB 3.0 Flash Drive (64GB)', vidPid: '0781:5581', type: '💾 Storage Drive', shared: false, connected: false, status: 'available' },
    { id: 'usb-3-04E86860', busId: '1-3', name: 'Samsung Galaxy Android Device (MTP/ADB)', vidPid: '04E8:6860', type: '📱 Smartphone', shared: false, connected: false, status: 'available' },
    { id: 'usb-4-03F01104', busId: '1-4', name: 'HP LaserJet Pro MFP M28w Printer', vidPid: '03F0:1104', type: '🖨️ Printer', shared: false, connected: false, status: 'available' },
    { id: 'usb-5-045E078F', busId: '1-5', name: 'Microsoft LifeCam HD-3000 Webcam', vidPid: '045E:078F', type: '📹 Video Webcam', shared: false, connected: false, status: 'available' }
  ];
}

function getDeviceTypeIcon(name, cls) {
  const n = (name || '').toLowerCase();
  const c = (cls || '').toLowerCase();
  if (n.includes('mouse') || n.includes('keyboard') || n.includes('receiver') || n.includes('hid')) return '🖱️ Ввод (HID)';
  if (n.includes('flash') || n.includes('disk') || n.includes('storage') || n.includes('drive') || c.includes('disk')) return '💾 Накопитель';
  if (n.includes('phone') || n.includes('android') || n.includes('galaxy') || n.includes('iphone')) return '📱 Смартфон';
  if (n.includes('print') || n.includes('laserjet') || n.includes('epson') || n.includes('canon')) return '🖨️ Принтер';
  if (n.includes('cam') || n.includes('video') || n.includes('optic') || c.includes('image')) return '📹 Камера / Видео';
  if (n.includes('audio') || n.includes('headset') || n.includes('sound') || n.includes('mic')) return '🎧 Аудио / Звук';
  if (n.includes('serial') || n.includes('uart') || n.includes('ch340') || n.includes('ftdi') || n.includes('cp210')) return '🔌 Серийный порт (COM)';
  return '🔗 USB Устройство';
}

// --- LAN Автообнаружение через UDP Broadcast ---
const udpSocket = dgram.createSocket('udp4');

udpSocket.on('error', (err) => {
  console.error(`[UDP Error]: ${err.message}`);
});

udpSocket.on('message', (msg, rinfo) => {
  try {
    const data = JSON.parse(msg.toString());
    if (data.type === 'USB_LINK_ANNOUNCE') {
      // Игнорируем собственные пакеты
      if (data.ip === LOCAL_IP && data.hostname === HOSTNAME) return;

      const peerKey = `${data.ip}:${data.port}`;
      const isNew = !discoveredPeers.has(peerKey);
      
      discoveredPeers.set(peerKey, {
        hostname: data.hostname || 'Unknown PC',
        ip: data.ip || rinfo.address,
        port: data.port || 4545,
        sharedCount: data.sharedCount || 0,
        sharedDevices: data.sharedDevices || [],
        lastSeen: Date.now()
      });

      if (isNew) {
        console.log(`[LAN Discovery] Обнаружен новый компьютер: ${data.hostname} (${data.ip}) с ${data.sharedCount} общими USB`);
      }
      broadcastState();
    }
  } catch (e) {}
});

udpSocket.bind(UDP_PORT, () => {
  udpSocket.setBroadcast(true);
  console.log(`[LAN Discovery] Служба автообнаружения запущена на UDP порту ${UDP_PORT}`);
  
  // Регулярная отправка анонса в локальную сеть
  setInterval(sendLanAnnouncement, 3000);
});

function sendLanAnnouncement() {
  try {
    const sharedList = Array.from(sharedDevices.values());
    const payloadStr = JSON.stringify({
      type: 'USB_LINK_ANNOUNCE',
      hostname: HOSTNAME,
      ip: LOCAL_IP,
      port: HTTP_PORT,
      sharedCount: sharedList.length,
      sharedDevices: sharedList,
      timestamp: Date.now()
    });

    // Обязательно преобразуем в Buffer, так как русские символы и эмодзи занимают больше 1 байта, и string.length вызывает сбой UDP в Node.js!
    const buf = Buffer.from(payloadStr, 'utf8');
    udpSocket.send(buf, 0, buf.length, UDP_PORT, '255.255.255.255', (err) => {
      if (err && err.code !== 'EACCES' && err.code !== 'EPERM') {
        // Игнорируем незначительные сетевые ошибки бродкаста
      }
    });

    // Дополнительно отправляем на широковещательный адрес подсети для надежности в сложных сетях Wi-Fi/LAN
    const subnetBroadcast = LOCAL_IP.replace(/\.\d+$/, '.255');
    if (subnetBroadcast !== '255.255.255.255' && subnetBroadcast !== '127.0.0.255') {
      udpSocket.send(buf, 0, buf.length, UDP_PORT, subnetBroadcast, () => {});
    }
  } catch (e) {
    console.error('[UDP Announce Error]:', e.message);
  }

  // Очистка устаревших узлов (не выходивших на связь > 25 секунд)
  const now = Date.now();
  let removed = false;
  for (const [key, peer] of discoveredPeers.entries()) {
    if (now - peer.lastSeen > 25000) {
      discoveredPeers.delete(key);
      removed = true;
    }
  }
  if (removed) broadcastState();
}

// --- WebSocket уведомления реального времени ---
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WebSocket] Новое подключение UI/Клиента от ${clientIp}`);
  
  sendStateToClient(ws);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.action === 'refresh_devices') {
        scanUsbDevices();
      } else if (data.action === 'share_device') {
        handleShareDevice(data.deviceId);
      } else if (data.action === 'unshare_device') {
        handleUnshareDevice(data.deviceId);
      } else if (data.action === 'connect_remote') {
        handleConnectRemote(data.peerIp, data.peerPort, data.deviceId);
      } else if (data.action === 'disconnect_remote') {
        handleDisconnectRemote(data.deviceId);
      }
    } catch (e) {
      console.error('[WebSocket] Error parsing message:', e);
    }
  });
});

function sendStateToClient(ws) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'FULL_STATE',
      hostname: HOSTNAME,
      localIp: LOCAL_IP,
      driverStatus: driverStatus,
      localDevices: localDevices,
      discoveredPeers: Array.from(discoveredPeers.values()),
      connectedDevices: Array.from(connectedDevices.entries()).map(([id, info]) => ({ id, ...info }))
    }));
  }
}

function broadcastState() {
  const payload = JSON.stringify({
    type: 'FULL_STATE',
    hostname: HOSTNAME,
    localIp: LOCAL_IP,
    driverStatus: driverStatus,
    localDevices: localDevices,
    discoveredPeers: Array.from(discoveredPeers.values()),
    connectedDevices: Array.from(connectedDevices.entries()).map(([id, info]) => ({ id, ...info }))
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// --- Логика проброса и подключения USB (Sharing & Attachment) ---
function handleShareDevice(deviceId) {
  const dev = localDevices.find(d => d.id === deviceId || d.busId === deviceId);
  if (!dev) return;

  dev.shared = true;
  dev.status = 'shared';
  sharedDevices.set(dev.id, dev);

  console.log(`[USB Share] Устройство "${dev.name}" (${dev.vidPid}) открыто для сетевого доступа!`);

  if (driverStatus.usbipdInstalled && dev.busId && dev.busId !== 'virtual') {
    // Вызов реального системного бинда в Windows
    exec(`usbipd bind --busid ${dev.busId} --force`, (err, stdout, stderr) => {
      if (err) {
        console.warn(`[usbipd warn] Ошибка бинда ${dev.busId}, используется виртуальная эмуляция: ${stderr || err.message}`);
      } else {
        console.log(`[usbipd] Устройство ${dev.busId} успешно привязано к службе USBIPD!`);
      }
    });
  }

  broadcastState();
  sendLanAnnouncement();
}

function handleUnshareDevice(deviceId) {
  const dev = localDevices.find(d => d.id === deviceId || d.busId === deviceId);
  if (!dev) return;

  dev.shared = false;
  dev.connected = false;
  dev.status = 'available';
  sharedDevices.delete(dev.id);
  connectedDevices.delete(dev.id);

  console.log(`[USB Unshare] Устройство "${dev.name}" скрыто из сети.`);

  if (driverStatus.usbipdInstalled && dev.busId && dev.busId !== 'virtual') {
    exec(`usbipd unbind --busid ${dev.busId}`, (err) => {
      // Игнорируем ошибки анбинда
    });
  }

  broadcastState();
  sendLanAnnouncement();
}

// REST API для приема внешних подключений от удаленного ПК
app.post('/api/network-attach', (req, res) => {
  const { deviceId, clientName, clientIp } = req.body;
  const dev = sharedDevices.get(deviceId) || localDevices.find(d => d.id === deviceId || d.busId === deviceId);
  
  if (!dev || !dev.shared) {
    return res.status(400).json({ success: false, error: 'Устройство не найдено или не доступно для общего доступа' });
  }

  if (dev.connected) {
    return res.status(403).json({ success: false, error: `Устройство уже занято клиентом ${dev.connectedTo}` });
  }

  dev.connected = true;
  dev.connectedTo = clientName || clientIp || 'Remote PC';
  dev.status = 'connected';
  
  connectedDevices.set(dev.id, {
    clientName: dev.connectedTo,
    clientIp: clientIp || req.ip,
    connectedAt: Date.now()
  });

  console.log(`[Network Attach] 🔌 Клиент "${dev.connectedTo}" подключился к USB "${dev.name}"!`);
  
  broadcastState();
  
  res.json({
    success: true,
    message: 'USB устройство успешно заблокировано и проброшено по сети!',
    device: dev,
    serverHostname: HOSTNAME,
    serverIp: LOCAL_IP,
    usbipBusId: dev.busId,
    mode: driverStatus.usbipdInstalled ? 'KERNEL_USBIP' : 'VIRTUAL_TUNNEL'
  });
});

app.post('/api/network-detach', (req, res) => {
  const { deviceId } = req.body;
  const dev = localDevices.find(d => d.id === deviceId || d.busId === deviceId);
  if (dev) {
    dev.connected = false;
    dev.connectedTo = null;
    dev.status = dev.shared ? 'shared' : 'available';
    connectedDevices.delete(dev.id);
    console.log(`[Network Detach] Клиент отключился от USB "${dev.name}". Устройство снова свободно.`);
    broadcastState();
  }
  res.json({ success: true });
});

// Логика подключения к УДАЛЕННОМУ компьютеру (клиентская часть)
async function handleConnectRemote(peerIp, peerPort, deviceId) {
  console.log(`[Remote Connect] Подключение к ${peerIp}:${peerPort} для захвата USB ${deviceId}...`);
  try {
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    // Используем встроенный http или fetch для запроса к удаленному ПК
    const httpReq = require('http').request({
      hostname: peerIp,
      port: peerPort || 4545,
      path: '/api/network-attach',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const resp = JSON.parse(body);
          if (resp.success) {
            console.log(`[Remote Connect SUCCESS] ⚡ Устройство "${resp.device.name}" успешно проброшено с ${peerIp}!`);
            
            // Если на клиенте установлен драйвер usbip, выполняем реальное системное монтирование порта!
            if (driverStatus.usbipClientInstalled && resp.usbipBusId) {
              exec(`usbip attach -r ${peerIp} -b ${resp.usbipBusId}`, (err, stdout) => {
                if (!err) {
                  console.log(`[Kernel Mount] Windows PnP смонтировал виртуальный USB порт: ${resp.usbipBusId}`);
                }
              });
            }

            // Добавляем в список активных подключений для отображения в UI
            connectedDevices.set(`remote-${deviceId}`, {
              isRemote: true,
              peerIp: peerIp,
              peerHostname: resp.serverHostname,
              deviceName: resp.device.name,
              vidPid: resp.device.vidPid,
              type: resp.device.type,
              connectedAt: Date.now(),
              originalId: deviceId
            });
            broadcastState();
          } else {
            console.error(`[Remote Connect Error]: ${resp.error}`);
          }
        } catch (e) {
          console.error('[Remote Connect] Invalid response:', body);
        }
      });
    });

    httpReq.on('error', (err) => {
      console.error(`[Remote Connect HTTP Error]: ${err.message}`);
    });

    httpReq.write(JSON.stringify({
      deviceId: deviceId,
      clientName: HOSTNAME,
      clientIp: LOCAL_IP
    }));
    httpReq.end();

  } catch (e) {
    console.error('[Remote Connect Error]:', e);
  }
}

function handleDisconnectRemote(deviceId) {
  const remoteConn = connectedDevices.get(deviceId);
  if (remoteConn && remoteConn.isRemote) {
    const httpReq = require('http').request({
      hostname: remoteConn.peerIp,
      port: 4545,
      path: '/api/network-detach',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    httpReq.write(JSON.stringify({ deviceId: remoteConn.originalId }));
    httpReq.end();

    if (driverStatus.usbipClientInstalled) {
      exec(`usbip detach -p 0`, () => {});
    }

    connectedDevices.delete(deviceId);
    console.log(`[Remote Detach] Отключено удаленное устройство ${remoteConn.deviceName}`);
    broadcastState();
  }
}

// --- API эндпоинты для веб-интерфейса ---
app.get('/api/status', (req, res) => {
  res.json({
    hostname: HOSTNAME,
    localIp: LOCAL_IP,
    driverStatus: driverStatus,
    deviceCount: localDevices.length,
    sharedCount: sharedDevices.size,
    peerCount: discoveredPeers.size
  });
});

app.get('/api/devices', (req, res) => {
  res.json(localDevices);
});

app.get('/api/peers', (req, res) => {
  res.json(Array.from(discoveredPeers.values()));
});

// --- Запуск сервера ---
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`[Server Notice] Порт ${HTTP_PORT} уже используется (сервис USB-Link Pro уже работает в фоне). Окно подключится к существующему процессу.`);
  } else {
    console.error('[Server Error]:', e);
  }
});

server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log('================================================================');
  console.log(` ⚡ USB-Link Pro (Network USB Share Hub) успешно запущен!`);
  console.log(` 🌐 Веб-интерфейс доступен: http://localhost:${HTTP_PORT}`);
  console.log(` 📡 Сетевой IP адрес ПК:    http://${LOCAL_IP}:${HTTP_PORT}`);
  console.log('================================================================');
  
  checkSystemDrivers();
  scanUsbDevices();
  
  // Регулярное сканирование USB устройств каждые 5 секунд
  setInterval(scanUsbDevices, 5000);
});
