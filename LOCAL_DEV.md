# 本地开发指南

> ⚠️ **注意**: 本文档及 `scripts/` 目录下的脚本仅用于**开发调试**，不影响原始业务逻辑。

## 启动开发服务器

```bash
npm run dev
# 或
pnpm dev
```

服务器将在 `http://localhost:8080` 启动。

## 启动虚拟桌面服务

```bash
# 使用 npm 运行（推荐）
npm run start:desktop

# 或直接运行脚本
./scripts/start_desktop.sh

# 自定义提示词
npm run start:desktop -- "你好，帮我完成一个任务"

# 自定义配置
API_HOST=192.168.1.34 API_PORT=8086 USER_ID=my_user npm run start:desktop
```

## 测试地址

### 连接到内网 VNC 服务器

```
http://localhost:8080/vnc.html?host=192.168.1.34&port=8088&path=computer/vnc/user_123/666/websockify&encrypt=0&resize=scale&autoconnect=true
```

### URL 参数说明

| 参数 | 说明 | 示例值 |
|------|------|--------|
| `host` | VNC WebSocket 服务器地址 | `192.168.1.34` |
| `port` | WebSocket 端口 | `8088` |
| `path` | WebSocket 路径 | `computer/vnc/user_123/666/websockify` |
| `encrypt` | 是否加密 (0=ws://, 1=wss://) | `0` |
| `resize` | 缩放模式 (`off`, `scale`, `remote`) | `scale` |
| `autoconnect` | 是否自动连接 | `true` |

### 完整 WebSocket 地址

上述配置对应的 WebSocket 连接地址为：

```
ws://192.168.1.34:8088/computer/vnc/user_123/666/websockify
```

## 配置默认值

可以通过修改 `defaults.json` 来设置默认连接参数：

```json
{
  "host": "192.168.1.34",
  "port": 8088,
  "path": "computer/vnc/user_123/666/websockify",
  "encrypt": false,
  "resize": "scale",
  "autoconnect": true
}
```

> **注意**: URL 参数会覆盖 `defaults.json` 中的配置。
