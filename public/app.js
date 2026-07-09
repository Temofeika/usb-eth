// ==========================================================================
// ⚡ USB-Link Pro — Frontend Application Logic & WebSocket Client
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  let ws;
  let currentState = {
    hostname: '',
    localIp: '',
    driverStatus: {},
    localDevices: [],
    discoveredPeers: [],
    connectedDevices: []
  };

  // Элементы DOM
  const myIpDisplay = document.getElementById('my-ip-display');
  const myHostname = document.getElementById('my-hostname');
  const localCountBadge = document.getElementById('local-count');
  const peerCountBadge = document.getElementById('peer-count');
  const driverBadge = document.getElementById('driver-badge');
  const localDevicesGrid = document.getElementById('local-devices-grid');
  const peersListContainer = document.getElementById('peers-list');
  const activeConnsList = document.getElementById('active-connections-list');
  const radarPeerStat = document.getElementById('radar-peer-stat');
  
  const statusUsbipdChip = document.getElementById('status-usbipd-chip');
  const statusVhciChip = document.getElementById('status-vhci-chip');

  // --- Переключение вкладок навигации ---
  const navTabs = document.querySelectorAll('.nav-tab');
  const tabContents = document.querySelectorAll('.tab-content');

  navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      navTabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.getAttribute('data-tab');
      document.getElementById(targetId).classList.add('active');
    });
  });

  // --- Подключение к WebSocket серверу ---
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[WebSocket] Подключено к серверу USB-Link Pro!');
      showToast('🟢 Соединение с локальным сервисом установлено');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'FULL_STATE') {
          updateAppState(data);
        } else if (data.type === 'KERNEL_LOG') {
          showToast(data.message, !data.success);
        } else if (data.type === 'LOG_MESSAGE') {
          appendLogLine(data.line);
        }
      } catch (e) {
        console.error('[WebSocket Error]:', e);
      }
    };

    ws.onclose = () => {
      console.warn('[WebSocket] Соединение разорвано. Повторное подключение через 3 секунды...');
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (err) => {
      console.error('[WebSocket Error]:', err);
    };
  }

  function sendWsAction(action, payload = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action, ...payload }));
    } else {
      showToast('⚠️ Ошибка соединения с сервером', true);
    }
  }

  // --- Обновление интерфейса на основе данных от сервера ---
  function updateAppState(state) {
    currentState = state;

    myIpDisplay.textContent = state.localIp || '127.0.0.1';
    myHostname.textContent = state.hostname || 'DESKTOP-PC';

    // Бейджи
    localCountBadge.textContent = state.localDevices ? state.localDevices.length : 0;
    peerCountBadge.textContent = state.discoveredPeers ? state.discoveredPeers.length : 0;
    radarPeerStat.textContent = `Найдено компьютеров в сети: ${state.discoveredPeers ? state.discoveredPeers.length : 0}`;

    // Статус драйверов
    if (state.driverStatus) {
      if (state.driverStatus.usbipdInstalled) {
        driverBadge.textContent = `USBIPD v${state.driverStatus.usbipdVersion}`;
        driverBadge.style.background = 'var(--success-green)';
        driverBadge.style.color = '#fff';
        
        statusUsbipdChip.textContent = `Установлен (v${state.driverStatus.usbipdVersion})`;
        statusUsbipdChip.className = 'status-chip chip-ok';
      } else {
        driverBadge.textContent = 'Virtual Mode (Эмуляция)';
        driverBadge.style.background = 'var(--primary-cyan)';
        driverBadge.style.color = '#000';
        
        statusUsbipdChip.textContent = 'Требуется установка (Режим эмуляции)';
        statusUsbipdChip.className = 'status-chip chip-warn';
      }

      if (state.driverStatus.usbipClientInstalled) {
        statusVhciChip.textContent = 'Активен (VHCI Client OK)';
        statusVhciChip.className = 'status-chip chip-ok';
      } else {
        statusVhciChip.textContent = 'Встроенный программный клиент';
        statusVhciChip.className = 'status-chip chip-warn';
      }
    }

    renderLocalDevices();
    renderPeers();
    renderActiveConnections();
  }

  // --- Рендеринг локальных USB устройств ---
  function renderLocalDevices() {
    const searchTerm = (document.getElementById('local-search').value || '').toLowerCase();
    const devices = currentState.localDevices || [];

    const filtered = devices.filter(d => {
      return d.name.toLowerCase().includes(searchTerm) || 
             d.vidPid.toLowerCase().includes(searchTerm) ||
             d.type.toLowerCase().includes(searchTerm);
    });

    if (filtered.length === 0) {
      localDevicesGrid.innerHTML = `
        <div class="empty-state glass-panel">
          <span>🔍</span>
          <p>USB-устройства не найдены. Подключите устройство к USB-порту или нажмите «Обновить PnP».</p>
        </div>
      `;
      return;
    }

    localDevicesGrid.innerHTML = filtered.map(dev => {
      let badgeHtml = `<span class="status-badge badge-available">⚪ Доступно для проброса</span>`;
      let btnHtml = `<button class="btn btn-primary share-btn" data-id="${dev.id}">🚀 Поделиться по сети</button>`;
      
      if (dev.connected) {
        badgeHtml = `<span class="status-badge badge-connected">⚡ Занято клиентом: ${dev.connectedTo || 'Remote PC'}</span>`;
        btnHtml = `<button class="btn btn-secondary unshare-btn" data-id="${dev.id}">🔒 Завершить сеанс</button>`;
      } else if (dev.shared) {
        badgeHtml = `<span class="status-badge badge-shared">🟢 Открыто в сеть (Ждет подключения)</span>`;
        btnHtml = `
          <div style="display: flex; flex-direction: column; gap: 6px; width: 100%;">
            <button class="btn btn-danger unshare-btn" data-id="${dev.id}">❌ Прекратить доступ</button>
            <button class="btn btn-secondary btn-sm force-share-btn" data-id="${dev.id}" style="font-size: 11px; padding: 7px; background: rgba(16,185,129,0.15); border: 1px solid rgba(16,185,129,0.4); color: #10b981; cursor: pointer; font-weight: 700;">⚡ Принудительно открыть в USBIPD (Лог)</button>
          </div>
        `;
      }

      return `
        <div class="device-card glass-card ${dev.shared ? 'shared' : ''} ${dev.connected ? 'connected' : ''}">
          <div class="card-top">
            <div class="device-icon-box">${dev.type.split(' ')[0] || '🔗'}</div>
            <div class="device-badges">
              ${badgeHtml}
            </div>
          </div>
          <div class="device-title">${dev.name}</div>
          <div class="device-specs">
            <span class="spec-item">ID: ${dev.vidPid}</span>
            <span class="spec-item">BUS: ${dev.busId}</span>
          </div>
          <div class="card-actions">
            ${btnHtml}
          </div>
        </div>
      `;
    }).join('');

    // Привязка событий к кнопкам Share/Unshare
    document.querySelectorAll('.share-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        sendWsAction('share_device', { deviceId: id });
        showToast('🚀 Устройство расшарено в локальную сеть!');
      });
    });

    document.querySelectorAll('.unshare-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        sendWsAction('unshare_device', { deviceId: id });
        showToast('🔒 Сетевой доступ к устройству закрыт');
      });
    });

    document.querySelectorAll('.force-share-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        sendWsAction('share_device', { deviceId: id });
        showToast('⚡ Запуск службы usbipd и принудительная привязка (см. Логи)...');
      });
    });
  }

  // --- Рендеринг удаленных компьютеров (Peers) и их устройств ---
  function renderPeers() {
    const peers = currentState.discoveredPeers || [];

    if (peers.length === 0) {
      peersListContainer.innerHTML = `
        <div class="empty-state glass-panel">
          <span>📡</span>
          <p>В локальной сети пока не обнаружено других компьютеров с запущенным USB-Link Pro.<br>Запустите программу на втором ПК или подключитесь вручную по IP-адресу ниже.</p>
        </div>
      `;
      return;
    }

    peersListContainer.innerHTML = peers.map(peer => {
      const sharedDevs = peer.sharedDevices || [];
      let devsHtml = `<p class="text-muted" style="font-size: 13px;">На этом компьютере сейчас нет общих USB-устройств.</p>`;

      if (sharedDevs.length > 0) {
        devsHtml = `
          <div class="peer-devices-grid">
            ${sharedDevs.map(dev => {
              try {
                const isConnectedHere = currentState.connectedDevices && currentState.connectedDevices.some(c => c.originalId === dev.id);
                
                let actionBtn = `
                  <div style="display: flex; flex-direction: column; gap: 6px;">
                    <button class="btn btn-primary btn-sm connect-remote-btn" data-ip="${peer.ip}" data-port="${peer.port}" data-id="${dev.id}">🔌 Подключить устройство</button>
                    <button class="btn btn-secondary btn-sm check-remote-list-btn" data-ip="${peer.ip}" style="font-size: 11px; padding: 6px; background: rgba(56,189,248,0.15); border: 1px solid rgba(56,189,248,0.4); color: #38bdf8; cursor: pointer;">🔍 Проверить порты на сервере (Лог)</button>
                  </div>
                `;
                let statusText = `<span style="color: var(--success-green); font-size: 12px; font-weight: 600;">🟢 Доступно по сети</span>`;

                if (isConnectedHere) {
                  actionBtn = `
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                      <button class="btn btn-danger btn-sm disconnect-remote-btn" data-id="remote-${dev.id}">❌ Отключить от ПК</button>
                      <button class="btn btn-secondary btn-sm manual-kernel-attach-btn" data-ip="${peer.ip}" data-busid="${dev.busId}" style="width: 100%; font-size: 11px; padding: 7px; background: rgba(245,158,11,0.15); border: 1px solid rgba(245,158,11,0.4); color: #f59e0b; cursor: pointer; font-weight: 700;">⚡ Перемонтировать в ядре (Админ + Лог)</button>
                      <div style="display: flex; gap: 6px;">
                        <button class="btn btn-secondary btn-sm open-explorer-btn" style="flex: 1; font-size: 11px; padding: 6px; background: rgba(0,240,255,0.15); border: 1px solid rgba(0,240,255,0.4); color: #00f0ff; cursor: pointer;">📂 Этот ПК</button>
                        <button class="btn btn-secondary btn-sm open-devmgr-btn" style="flex: 1; font-size: 11px; padding: 6px; background: rgba(16,185,129,0.15); border: 1px solid rgba(16,185,129,0.4); color: #10b981; cursor: pointer;">⚙️ Диспетчер</button>
                      </div>
                    </div>
                  `;
                  statusText = `<span style="color: var(--primary-cyan); font-size: 12px; font-weight: 700;">⚡ Смонтировано в ОС</span>`;
                } else if (dev.connected) {
                  actionBtn = `<button class="btn btn-secondary btn-sm" disabled style="opacity: 0.5;">🔒 Занято другим ПК</button>`;
                  statusText = `<span style="color: var(--warning-yellow); font-size: 12px;">Занято: ${dev.connectedTo || 'Клиентом'}</span>`;
                }

                const typeIcon = (dev.type && typeof dev.type === 'string') ? dev.type.split(' ')[0] : '🔗';
                const devName = dev.name || 'USB Устройство';
                const vidPidStr = dev.vidPid || '0000:0000';
                const busIdStr = dev.busId || '1-1';

                return `
                  <div class="device-card glass-card ${isConnectedHere ? 'connected' : ''}" style="padding: 16px;">
                    <div class="card-top" style="margin-bottom: 8px;">
                      <span style="font-size: 20px;">${typeIcon}</span>
                      ${statusText}
                    </div>
                    <div style="font-weight: 700; font-size: 14px; margin-bottom: 6px; color: #fff;">${devName}</div>
                    <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 12px; font-family: monospace;">VID:PID ${vidPidStr} | BUS ${busIdStr}</div>
                    <div>${actionBtn}</div>
                  </div>
                `;
              } catch (err) {
                return '';
              }
            }).join('')}
          </div>
        `;
      }

      return `
        <div class="peer-box glass-panel">
          <div class="peer-header">
            <div class="peer-title">
              <h3><span>🖥️</span> ${peer.hostname}</h3>
              <span class="peer-ip">${peer.ip}</span>
            </div>
            <div class="badge count-badge" style="background: var(--primary-purple); color: #fff;">
              Общих USB: ${peer.sharedCount || sharedDevs.length}
            </div>
          </div>
          <div class="peer-body">
            ${devsHtml}
          </div>
        </div>
      `;
    }).join('');

    // Обработчики подключения к удаленному ПК
    document.querySelectorAll('.connect-remote-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const ip = e.currentTarget.getAttribute('data-ip');
        const port = e.currentTarget.getAttribute('data-port');
        const id = e.currentTarget.getAttribute('data-id');
        
        sendWsAction('connect_remote', { peerIp: ip, peerPort: port, deviceId: id });
        showToast(`🔌 Запрос подключения к ${ip}...`);
      });
    });

    document.querySelectorAll('.disconnect-remote-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        sendWsAction('disconnect_remote', { deviceId: id });
        showToast('❌ Отключение удаленного устройства...');
      });
    });

    document.querySelectorAll('.open-explorer-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        sendWsAction('open_system_tool', { tool: 'explorer' });
        showToast('📂 Открываем Проводник "Этот компьютер"...');
      });
    });

    document.querySelectorAll('.open-devmgr-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        sendWsAction('open_system_tool', { tool: 'devmgmt' });
        showToast('⚙️ Открываем Диспетчер устройств Windows...');
      });
    });

    document.querySelectorAll('.manual-kernel-attach-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const ip = e.currentTarget.getAttribute('data-ip');
        const busId = e.currentTarget.getAttribute('data-busid');
        sendWsAction('manual_kernel_attach', { peerIp: ip, busId: busId });
        showToast(`⚡ Вызов системного драйвера USBIP для BUS ${busId}...`);
      });
    });

    document.querySelectorAll('.check-remote-list-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const ip = e.currentTarget.getAttribute('data-ip');
        sendWsAction('check_remote_list', { peerIp: ip });
        showToast(`🔍 Запрашиваем список расшаренных портов с ${ip} (см. Логи)...`);
      });
    });
  }

  // --- Рендеринг активных удаленных подключений ---
  function renderActiveConnections() {
    const conns = currentState.connectedDevices || [];
    const remoteConns = conns.filter(c => c.isRemote || c.id.startsWith('remote-'));

    if (remoteConns.length === 0) {
      activeConnsList.innerHTML = `
        <div class="empty-state glass-panel" style="padding: 24px;">
          <span>🔌</span>
          <p>Нет подключенных удаленных USB-устройств. Выберите устройство из списка выше и нажмите «Подключить»!</p>
        </div>
      `;
      return;
    }

    activeConnsList.innerHTML = remoteConns.map(conn => {
      return `
        <div class="connection-item glass-card">
          <div class="conn-info">
            <h4>⚡ ${conn.deviceName || 'USB Device'} (${conn.vidPid || ''})</h4>
            <p>Проброшено по сети с сервера <strong>${conn.peerHostname || conn.peerIp}</strong> [IP: ${conn.peerIp}]</p>
          </div>
          <button class="btn btn-danger btn-sm disconnect-remote-btn" data-id="${conn.id}">
            ❌ Отключить
          </button>
        </div>
      `;
    }).join('');

    document.querySelectorAll('.disconnect-remote-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        sendWsAction('disconnect_remote', { deviceId: id });
        showToast('❌ Удаленное устройство отключено');
      });
    });
  }

  // --- Обработчики поиска и кнопок ---
  document.getElementById('local-search').addEventListener('input', renderLocalDevices);

  document.getElementById('refresh-local-btn').addEventListener('click', () => {
    sendWsAction('refresh_devices');
    showToast('🔄 Пересканирование шин и портов USB...');
  });

  document.getElementById('add-ip-btn').addEventListener('click', () => {
    const ip = document.getElementById('manual-ip-input').value.trim();
    if (!ip) {
      showToast('⚠️ Введите IP адрес компьютера', true);
      return;
    }
    // Запрос статуса к указанному IP по HTTP API
    fetch(`http://${ip}:4545/api/status`)
      .then(res => res.json())
      .then(data => {
        showToast(`✅ Найден узел: ${data.hostname} (${ip})`);
        sendWsAction('refresh_devices');
      })
      .catch(err => {
        showToast(`❌ Не удалось связаться с ${ip}:4545. Проверьте сеть и брандмауэр.`, true);
      });
  });

  // --- Копирование команды из терминала в буфер обмена ---
  const copyBtn = document.getElementById('copy-cmd-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const cmd = copyBtn.getAttribute('data-cmd');
      navigator.clipboard.writeText(cmd).then(() => {
        copyBtn.textContent = '✅ Команда скопирована!';
        showToast('📋 Команда winget скопирована в буфер обмена!');
        setTimeout(() => {
          copyBtn.textContent = '📋 Копировать команду';
        }, 3000);
      });
    });
  }

  // --- Автоустановка драйвера в 1 клик (Electron IPC) ---
  const autoInstallBtn = document.getElementById('auto-install-driver-btn');
  if (autoInstallBtn) {
    autoInstallBtn.addEventListener('click', async () => {
      try {
        if (typeof window !== 'undefined' && window.require) {
          const { ipcRenderer } = window.require('electron');
          showToast('🛡️ Запуск установщика службы USBIPD от имени Администратора...');
          autoInstallBtn.disabled = true;
          autoInstallBtn.innerHTML = '<span>⏳</span> Установка сервера USBIPD...';
          
          const res = await ipcRenderer.invoke('install-driver-admin');
          if (res.success) {
            showToast('✅ Установка завершена! Перезапустите приложение.');
            autoInstallBtn.innerHTML = '<span>✅</span> Служба установлена! Перезапустите приложение';
          } else {
            showToast('⚠️ Ошибка установки: ' + res.error, true);
            autoInstallBtn.disabled = false;
            autoInstallBtn.innerHTML = '<span>🛡️</span> Попробовать снова (или используйте терминал)';
          }
        } else {
          showToast('📋 Скопируйте команду ниже и запустите PowerShell от имени Администратора');
        }
      } catch (e) {
        showToast('📋 Скопируйте команду ниже и выполните в PowerShell от Администратора');
      }
    });
  }

  const autoInstallClientBtn = document.getElementById('auto-install-client-btn');
  if (autoInstallClientBtn) {
    autoInstallClientBtn.addEventListener('click', async () => {
      try {
        if (typeof window !== 'undefined' && window.require) {
          const { ipcRenderer } = window.require('electron');
          showToast('🔌 Запуск скачивания и установки клиентского драйвера VHCI с GitHub...');
          autoInstallClientBtn.disabled = true;
          autoInstallClientBtn.innerHTML = '<span>⏳</span> Скачивание и установка VHCI драйвера...';
          
          const res = await ipcRenderer.invoke('install-client-admin');
          if (res.success) {
            showToast('✅ Клиентский драйвер VHCI установлен! Перезапустите программу.');
            autoInstallClientBtn.innerHTML = '<span>✅</span> Драйвер VHCI установлен! Перезапустите приложение';
          } else {
            showToast('⚠️ Ошибка установки: ' + res.error, true);
            autoInstallClientBtn.disabled = false;
            autoInstallClientBtn.innerHTML = '<span>🔌</span> Попробовать снова (или скачайте с GitHub)';
          }
        } else {
          showToast('📋 Откройте страницу релизов vadimgrn/usbip-win2 на GitHub и установите драйвер');
        }
      } catch (e) {
        showToast('📋 Откройте страницу релизов vadimgrn/usbip-win2 на GitHub и установите драйвер');
      }
    });
  }

  // --- Обработка прямых ссылок на GitHub ---
  document.querySelectorAll('.github-link-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const url = btn.getAttribute('data-url');
      if (url) {
        if (typeof window !== 'undefined' && window.require) {
          try {
            const { shell } = window.require('electron');
            shell.openExternal(url);
            showToast('🌐 Открываем официальную страницу релизов GitHub в браузере...');
            return;
          } catch (err) { console.error(err); }
        }
        window.open(url, '_blank');
        showToast('🌐 Открываем страницу релизов GitHub...');
      }
    });
  });

  // --- Система уведомлений Toast ---
  function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    const msgEl = document.getElementById('toast-message');
    const iconEl = document.getElementById('toast-icon');

    msgEl.textContent = message;
    iconEl.textContent = isError ? '⚠️' : '✨';
    toast.style.borderLeftColor = isError ? 'var(--danger-red)' : 'var(--primary-cyan)';

    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 4000);
  }

  // --- Управление просмотром ЛОГОВ ---
  const logsViewer = document.getElementById('logs-viewer');
  function appendLogLine(line) {
    if (!logsViewer) return;
    logsViewer.textContent += line + '\n';
    logsViewer.scrollTop = logsViewer.scrollHeight;
  }

  fetch('/api/logs').then(r => r.json()).then(data => {
    if (logsViewer && data.logs) {
      logsViewer.textContent = data.logs.join('\n') + '\n';
      logsViewer.scrollTop = logsViewer.scrollHeight;
    }
  }).catch(() => {});

  const openLogBtn = document.getElementById('open-log-file-btn');
  if (openLogBtn) {
    openLogBtn.addEventListener('click', () => {
      fetch('/api/open-log-file', { method: 'POST' });
      showToast('📂 Открываем файл лога C:\\Users\\Public\\USB-Link-Pro.log в Блокноте...');
    });
  }

  const clearLogBtn = document.getElementById('clear-logs-btn');
  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', () => {
      if (logsViewer) logsViewer.textContent = '';
      showToast('🧹 Окно логов очищено');
    });
  }

  const fixVhciBtn = document.getElementById('fix-vhci-btn');
  if (fixVhciBtn) {
    fixVhciBtn.addEventListener('click', () => {
      fetch('/api/fix-vhci-duplicates', { method: 'POST' });
      showToast('🛠 Удаляем дубликаты контроллера VHCI в Диспетчере устройств...');
    });
  }

  // Запуск клиента WebSocket
  connectWebSocket();
});
