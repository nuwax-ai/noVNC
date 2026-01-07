/*
 * noVNC: HTML5 VNC client
 * IME (Input Method Editor) passthrough module
 * 
 * 输入法透传模块 - 用于将本地输入法的输入传送到远程桌面
 * 
 * 功能：
 * - 通过 WebSocket 连接 IME 服务
 * - 监听输入法事件（compositionend）
 * - 将输入的文本发送到远程桌面
 */

import * as Log from '../core/util/logging.js';

// 输入法管理器类
class IMEManager {
    constructor() {
        // WebSocket 连接
        this.ws = null;
        this.connected = false;

        // 隐藏输入框元素
        this.inputElement = null;

        // 回调函数
        this.onStatusChange = null;

        // 绑定事件处理函数（用于移除监听器）
        this._boundCompositionEnd = this._handleCompositionEnd.bind(this);
        this._boundInput = this._handleInput.bind(this);
    }

    /**
     * 构建 IME WebSocket URL
     * @param {string} baseUrl - 基础 URL (如 http://127.0.0.1:8088)
     * @param {string} projectId - 项目 ID
     * @param {string} userId - 用户 ID (可选，调试模式使用)
     * @param {boolean} debugMode - 是否调试模式
     * @returns {string} WebSocket URL
     */
    buildWsUrl(baseUrl, projectId, userId = null, debugMode = false) {
        // 将 http/https 转换为 ws/wss
        const wsUrl = baseUrl
            .replace(/^http/, 'ws')
            .replace(/\/+$/, '');

        // 调试模式：包含 user_id
        // 正式模式：不包含 user_id
        if (debugMode && userId) {
            return `ws://192.168.1.34:8088/computer/ime/${userId}/${projectId}/connect`;
        } else {
            return `${wsUrl}/computer/ime/${projectId}/connect`;
        }
    }

    /**
     * 连接 IME 服务
     * @param {string} wsUrl - WebSocket URL
     * @returns {Promise<void>}
     */
    async connect(wsUrl) {
        if (this.connected) {
            Log.Warn('[IME] 已经连接，请先断开');
            return;
        }

        try {
            this._updateStatus('connecting', 'IME 连接中...');
            Log.Info('[IME] 连接 IME 服务: ' + wsUrl);

            // 创建隐藏输入框
            this._createInputElement();

            // 连接 WebSocket
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                Log.Info('[IME] WebSocket 已连接');
                this.connected = true;
                this._updateStatus('connected', 'IME 已连接');

                // 启用输入监听
                this._enableInputListeners();
            };

            this.ws.onmessage = (event) => {
                try {
                    const response = JSON.parse(event.data);
                    if (response.status === 'ok') {
                        Log.Debug('[IME] 文本发送成功');
                    } else {
                        Log.Warn('[IME] 服务器响应: ' + response.message);
                    }
                } catch (err) {
                    Log.Error('[IME] 响应解析失败: ' + err);
                }
            };

            this.ws.onerror = (err) => {
                Log.Error('[IME] WebSocket 错误: ' + err);
                this._updateStatus('error', 'IME 连接错误');
            };

            this.ws.onclose = () => {
                Log.Info('[IME] WebSocket 已关闭');
                this.connected = false;
                this._updateStatus('disconnected', 'IME 已断开');
                this._disableInputListeners();
            };

        } catch (err) {
            Log.Error('[IME] 连接失败: ' + err);
            this._updateStatus('error', 'IME 启动失败');
            throw err;
        }
    }

    /**
     * 断开 IME 服务
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this._disableInputListeners();
        this._updateStatus('disconnected', 'IME 已停止');
        Log.Info('[IME] IME 服务已断开');
    }

    /**
     * 发送文本到远程桌面
     * @param {string} text - 要发送的文本
     */
    sendText(text) {
        if (!this.connected || !this.ws) {
            Log.Warn('[IME] 未连接，无法发送文本');
            return;
        }

        if (!text || text.length === 0) {
            return;
        }

        const message = JSON.stringify({
            type: 'text',
            text: text,
            method: 'xdotool'  // 使用 xdotool 输入方法
        });

        this.ws.send(message);
        Log.Debug('[IME] 发送文本: ' + text);
    }

    /**
     * 激活输入（聚焦到隐藏输入框）
     * 当用户点击 VNC 画面时调用
     */
    activateInput() {
        if (this.inputElement && this.connected) {
            this.inputElement.focus();
        }
    }

    /**
     * 创建隐藏输入框
     * @private
     */
    _createInputElement() {
        if (this.inputElement) {
            return;
        }

        // 创建隐藏的输入框，用于捕获输入法事件
        this.inputElement = document.createElement('input');
        this.inputElement.type = 'text';
        this.inputElement.id = 'noVNC_ime_input';
        this.inputElement.autocomplete = 'off';
        this.inputElement.autocapitalize = 'off';
        this.inputElement.spellcheck = false;

        // 设置样式 - 隐藏但可聚焦
        this.inputElement.style.cssText = `
            position: fixed;
            top: -9999px;
            left: -9999px;
            opacity: 0;
            pointer-events: none;
            width: 1px;
            height: 1px;
        `;

        document.body.appendChild(this.inputElement);
        Log.Debug('[IME] 隐藏输入框已创建');
    }

    /**
     * 启用输入监听器
     * @private
     */
    _enableInputListeners() {
        if (!this.inputElement) {
            return;
        }

        // 监听输入法完成事件（如选择中文候选词）
        this.inputElement.addEventListener('compositionend', this._boundCompositionEnd);

        // 监听直接输入事件（非输入法输入）
        this.inputElement.addEventListener('input', this._boundInput);

        Log.Debug('[IME] 输入监听器已启用');
    }

    /**
     * 禁用输入监听器
     * @private
     */
    _disableInputListeners() {
        if (!this.inputElement) {
            return;
        }

        this.inputElement.removeEventListener('compositionend', this._boundCompositionEnd);
        this.inputElement.removeEventListener('input', this._boundInput);

        Log.Debug('[IME] 输入监听器已禁用');
    }

    /**
     * 处理输入法完成事件
     * @param {CompositionEvent} event
     * @private
     */
    _handleCompositionEnd(event) {
        const text = event.data;
        if (text && text.length > 0) {
            Log.Debug('[IME] 输入法完成: ' + text);
            this.sendText(text);

            // 清空输入框
            if (this.inputElement) {
                this.inputElement.value = '';
            }
        }
    }

    /**
     * 处理直接输入事件
     * @param {InputEvent} event
     * @private
     */
    _handleInput(event) {
        // 如果正在进行输入法输入，忽略
        if (event.isComposing) {
            return;
        }

        const text = event.target.value;
        if (text && text.length > 0) {
            Log.Debug('[IME] 直接输入: ' + text);
            this.sendText(text);
            event.target.value = '';
        }
    }

    /**
     * 更新状态并触发回调
     * @param {string} status - 状态 (connecting/connected/disconnected/error)
     * @param {string} message - 状态消息
     * @private
     */
    _updateStatus(status, message) {
        if (this.onStatusChange) {
            this.onStatusChange(status, message);
        }
    }

    /**
     * 销毁 IME 管理器
     */
    destroy() {
        this.disconnect();

        if (this.inputElement && this.inputElement.parentNode) {
            this.inputElement.parentNode.removeChild(this.inputElement);
            this.inputElement = null;
        }
    }
}

// 导出单例
const imeManager = new IMEManager();
export default imeManager;

