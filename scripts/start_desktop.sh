#!/bin/bash

# 虚拟桌面服务启动脚本
# 用于调用 computer/chat API 启动云端桌面环境

# 配置参数
API_HOST="${API_HOST:-192.168.1.34}"
API_PORT="${API_PORT:-8086}"
USER_ID="${USER_ID:-1746495851}"
REQUEST_ID="${REQUEST_ID:-req_$(date +%s)}"

# 默认提示词
DEFAULT_PROMPT="${1:-帮我写个酷炫的网页扫雷游戏}"

# API 密钥配置
ZHIPU_API_KEY="${ZHIPU_API_KEY:-3d18bae265264c3eb3789bcbbb0ac35b.qOG2QK2xCpC4ZC1R}"

echo "🚀 启动虚拟桌面服务..."
echo "   API 地址: http://${API_HOST}:${API_PORT}/computer/chat"
echo "   用户 ID: ${USER_ID}"
echo "   请求 ID: ${REQUEST_ID}"
echo "   提示词: ${DEFAULT_PROMPT}"
echo ""

curl --location --request POST "http://${API_HOST}:${API_PORT}/computer/chat" \
--header 'User-Agent: Apifox/1.0.0 (https://apifox.com)' \
--header 'Content-Type: application/json' \
--header 'Accept: */*' \
--header "Host: ${API_HOST}:${API_PORT}" \
--header 'Connection: keep-alive' \
--data-raw '{
    "user_id": "'"${USER_ID}"'",
    "prompt": "'"${DEFAULT_PROMPT}"'",
    "request_id": "'"${REQUEST_ID}"'",
    "attachments": [
        {
            "type": "Text",
            "content": {
                "id": "attachment_001",
                "source": {
                    "source_type": "Base64",
                    "data": {
                        "data": "SGVsbG8sIOS4lueVjCEg5L2g5aW9IHRoaXMgaXMgYSB0ZXN0IHRleHQgYXR0YWNobWVudC4=",
                        "mime_type": "text/plain"
                    }
                },
                "filename": "hello.txt",
                "description": "测试文本附件"
            }
        }
    ],
    "data_source_attachments": [
        "https://api.github.com/repos/owner/repo/issues",
        "postgres://user:pass@localhost:5432/dbname"
    ],
    "model_provider": {
        "id": "zhipu-glm-4.6",
        "name": "zhipu-glm-4.6",
        "base_url": "https://open.bigmodel.cn/api/anthropic",
        "api_key": "'"${ZHIPU_API_KEY}"'",
        "default_model": "glm-4.6",
        "requires_openai_auth": true,
        "api_protocol": "anthropic"
    },
    "system_prompt": "你是一个专业的 DevOps 工程师，擅长容器化部署和资源管理。请使用中文回答。",
    "user_prompt": "请详细分析以下需求并提供解决方案：{user_prompt}",
    "agent_config": {
        "agent_server": {
            "agent_id": "claude-code-acp",
            "command": "claude-code-acp",
            "args": [
                "--debug"
            ],
            "env": {
                "RUST_LOG": "debug",
                "ANTHROPIC_API_KEY": "{MODEL_PROVIDER_API_KEY}",
                "ANTHROPIC_MODEL": "{MODEL_PROVIDER_DEFAULT_MODEL}",
                "ANTHROPIC_BASE_URL": "{MODEL_PROVIDER_BASE_URL}",
                "CUSTOM_VAR": "custom_value"
            },
            "metadata": {
                "version": "1.0.0",
                "description": "自定义 Agent 配置"
            }
        },
        "context_servers": {
            "chrome-devtools": {
                "source": "custom",
                "enabled": true,
                "command": "npx",
                "args": [
                    "-y",
                    "chrome-devtools-mcp@latest",
                    "--userDataDir=/home/user/.config/chromium",
                    "--executablePath=/usr/local/bin/chromium-for-mcp",
                    "--chromeArg=--no-sandbox",
                    "--chromeArg=--no-zygote",
                    "--chromeArg=--disable-dev-shm-usage",
                    "--chromeArg=--disable-gpu",
                    "--chromeArg=--remote-debugging-port=9222"
                ],
                "env": {
                    "CHROMIUM_USER_DATA_DIR": "/home/user/.config/chromium",
                    "DISPLAY": ":0",
                    "GTK_IM_MODULE": "fcitx5",
                    "QT_IM_MODULE": "fcitx5",
                    "XMODIFIERS": "@im=fcitx5",
                    "INPUT_METHOD": "fcitx5",
                    "SDL_IM_MODULE": "fcitx5",
                    "GLFW_IM_MODULE": "fcitx5",
                    "LANG": "C.UTF-8",
                    "LC_ALL": "C.UTF-8",
                    "LC_CTYPE": "C.UTF-8"
                },
                "metadata": {
                    "description": "Chrome DevTools MCP - Browser automation via Chrome DevTools Protocol",
                    "note": "MCP will launch and manage Chromium automatically with container-friendly settings and fcitx5 Chinese input method support",
                    "capabilities": [
                        "browser_automation",
                        "page_navigation",
                        "dom_manipulation",
                        "screenshot",
                        "chinese_input_method"
                    ],
                    "input_method": {
                        "framework": "fcitx5",
                        "toggle_key": "Ctrl+Space",
                        "supported_languages": [
                            "zh_CN",
                            "ja",
                            "ko"
                        ]
                    }
                }
            },
            "context7": {
                "source": "custom",
                "enabled": true,
                "command": "bunx",
                "args": [
                    "-y",
                    "@upstash/context7-mcp"
                ],
                "env": {}
            },
            "internet-search": {
                "source": "custom",
                "enabled": true,
                "command": "mcp-proxy",
                "args": [
                    "convert",
                    "https://mcp-sse-api.nuwax.com/?ts=785c26a9affc49c99d6d13f8be5836bc&id=search-services"
                ]
            }
        },
        "resource_limits": {
            "memory_limit": 2147483648,
            "cpu_limit": 2.0,
            "swap_limit": 4294967296
        }
    }
}'

echo ""
echo "✅ 请求已发送"
