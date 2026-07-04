const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const { startServer } = require("./server");

let mainWindow = null;
let backend = null;

async function createMainWindow() {
  if (!backend) {
    backend = await startServer({
      host: "127.0.0.1",
      port: 0,
      log: false
    });
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 980,
    minHeight: 720,
    title: "字词练习生成器",
    backgroundColor: "#f6f7f9",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", event => {
    const targetUrl = event.url;
    if (!targetUrl.startsWith(backend.url)) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(backend.url);
}

function installMenu() {
  const template = [
    {
      label: "字词练习生成器",
      submenu: [
        { role: "about", label: "关于字词练习生成器" },
        { type: "separator" },
        { role: "hide", label: "隐藏" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "显示全部" },
        { type: "separator" },
        { role: "quit", label: "退出" }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新载入" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "进入全屏" }
      ]
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        { type: "separator" },
        { role: "front", label: "前置全部窗口" }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function stopBackend() {
  if (!backend?.server) return;
  await new Promise(resolve => backend.server.close(resolve));
  backend = null;
}

app.whenReady().then(async () => {
  app.setName("字词练习生成器");
  installMenu();
  try {
    await createMainWindow();
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "启动失败",
      message: "字词练习生成器启动失败",
      detail: error.message || String(error)
    });
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow().catch(error => {
        dialog.showErrorBox("启动失败", error.message || String(error));
      });
    }
  });
});

app.on("before-quit", event => {
  if (!backend?.server) return;
  event.preventDefault();
  stopBackend().finally(() => app.exit(0));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
