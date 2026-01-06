/*
 * noVNC: HTML5 VNC client
 * Audio streaming module for remote desktop audio playback
 * 
 * 音频流模块 - 用于播放远程桌面的音频输出
 * 
 * 功能：
 * - 通过 WebSocket 接收 Opus 编码的音频数据
 * - 使用 Web Audio API 解码并播放音频
 * - 支持音量控制和连接状态管理
 */

import * as Log from '../core/util/logging.js';

// 音频管理器类
class AudioManager {
    constructor() {
        // WebSocket 连接
        this.ws = null;
        this.connected = false;
        
        // Web Audio API 组件
        this.audioContext = null;
        this.gainNode = null;
        this.decoder = null;
        
        // 播放调度
        this.nextPlayTime = 0;
        
        // 配置
        this.volume = 0.8;  // 默认音量 80%
        this.sampleRate = 48000;
        this.channels = 2;
        
        // 回调函数
        this.onStatusChange = null;
        
        // OpusDecoder 加载状态
        this.opusDecoderReady = false;
        this._checkOpusDecoder();
    }
    
    /**
     * 检查 OpusDecoder 是否已加载
     * @private
     */
    _checkOpusDecoder() {
        // opus-decoder 库使用 UMD 模式，导出为 window["opus-decoder"].OpusDecoder
        const opusDecoderLib = window["opus-decoder"];
        if (opusDecoderLib && opusDecoderLib.OpusDecoder) {
            window.OpusDecoder = opusDecoderLib.OpusDecoder;
            this.opusDecoderReady = true;
            Log.Info('[Audio] OpusDecoder 加载成功');
        } else {
            Log.Warn('[Audio] OpusDecoder 未加载，音频功能可能无法使用');
            this.opusDecoderReady = false;
        }
    }
    
    /**
     * 构建音频 WebSocket URL
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
            return `${wsUrl}/computer/audio/${userId}/${projectId}/ws`;
        } else {
            return `${wsUrl}/computer/audio/${projectId}/ws`;
        }
    }
    
    /**
     * 连接音频流
     * @param {string} wsUrl - WebSocket URL
     * @returns {Promise<void>}
     */
    async connect(wsUrl) {
        if (this.connected) {
            Log.Warn('[Audio] 已经连接，请先断开');
            return;
        }
        
        // 检查 OpusDecoder
        if (!this.opusDecoderReady) {
            this._checkOpusDecoder();
            if (!this.opusDecoderReady) {
                Log.Error('[Audio] OpusDecoder 未加载，无法启动音频');
                this._updateStatus('error', 'OpusDecoder 未加载');
                return;
            }
        }
        
        try {
            this._updateStatus('connecting', '音频连接中...');
            Log.Info('[Audio] 连接音频流: ' + wsUrl);
            
            // 初始化 Web Audio API
            await this._initAudioContext();
            
            // 连接 WebSocket
            this.ws = new WebSocket(wsUrl);
            this.ws.binaryType = 'arraybuffer';
            
            this.ws.onopen = () => {
                Log.Info('[Audio] WebSocket 已连接');
                this.connected = true;
                this._updateStatus('connected', '音频已连接');
            };
            
            this.ws.onmessage = async (event) => {
                try {
                    const data = new Uint8Array(event.data);
                    // 检查协议头 (0x01 表示 Opus 音频)
                    if (data[0] === 0x01) {
                        const opusData = data.slice(1);
                        await this._playAudioChunk(opusData);
                    }
                } catch (err) {
                    Log.Error('[Audio] 处理音频数据失败: ' + err);
                }
            };
            
            this.ws.onerror = (err) => {
                Log.Error('[Audio] WebSocket 错误: ' + err);
                this._updateStatus('error', '音频连接错误');
            };
            
            this.ws.onclose = () => {
                Log.Info('[Audio] WebSocket 已关闭');
                this.connected = false;
                this._updateStatus('disconnected', '音频已断开');
                this._cleanup();
            };
            
        } catch (err) {
            Log.Error('[Audio] 连接失败: ' + err);
            this._updateStatus('error', '音频启动失败');
            throw err;
        }
    }
    
    /**
     * 断开音频流
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this._cleanup();
        this._updateStatus('disconnected', '音频已停止');
        Log.Info('[Audio] 音频流已断开');
    }
    
    /**
     * 设置音量
     * @param {number} volume - 音量值 (0-1)
     */
    setVolume(volume) {
        this.volume = Math.max(0, Math.min(1, volume));
        if (this.gainNode) {
            this.gainNode.gain.value = this.volume;
        }
        Log.Debug('[Audio] 音量设置为: ' + Math.round(this.volume * 100) + '%');
    }
    
    /**
     * 获取当前音量
     * @returns {number} 音量值 (0-1)
     */
    getVolume() {
        return this.volume;
    }
    
    /**
     * 初始化 Web Audio API
     * @private
     */
    async _initAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.sampleRate,
                latencyHint: 'interactive'
            });
            
            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.value = this.volume;
            this.gainNode.connect(this.audioContext.destination);
            
            this.nextPlayTime = this.audioContext.currentTime + 0.1;
        }
        
        // 恢复 AudioContext（浏览器安全策略）
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
    }
    
    /**
     * 播放音频数据块
     * @param {Uint8Array} opusData - Opus 编码的音频数据
     * @private
     */
    async _playAudioChunk(opusData) {
        try {
            // 初始化或复用 Opus 解码器
            if (!this.decoder) {
                Log.Debug('[Audio] 初始化 OpusDecoder...');
                this.decoder = new window.OpusDecoder({
                    sampleRate: this.sampleRate,
                    channels: this.channels
                });
                await this.decoder.ready;
                Log.Debug('[Audio] OpusDecoder 初始化完成');
            }
            
            // 解码 Opus 数据
            const decoded = this.decoder.decodeFrame(opusData);
            const channels = decoded.channelData;
            const samplesDecoded = decoded.samplesDecoded;
            
            if (!channels || channels.length < 2) {
                Log.Warn('[Audio] 输出声道数据无效');
                return;
            }
            
            const leftChannelData = channels[0];
            const rightChannelData = channels[1];
            
            // 创建 AudioBuffer
            const audioBuffer = this.audioContext.createBuffer(
                2, samplesDecoded, this.sampleRate
            );
            
            // 填充声道数据
            audioBuffer.getChannelData(0).set(leftChannelData);
            audioBuffer.getChannelData(1).set(rightChannelData);
            
            // 调度播放
            const source = this.audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.gainNode);
            
            // 计算播放时间
            const currentTime = this.audioContext.currentTime;
            if (this.nextPlayTime < currentTime) {
                this.nextPlayTime = currentTime + 0.05;  // 50ms 缓冲
            }
            
            source.start(this.nextPlayTime);
            
            // 计算下一个播放时间点
            const duration = samplesDecoded / this.sampleRate;
            this.nextPlayTime += duration;
            
        } catch (err) {
            Log.Error('[Audio] 解码或播放失败: ' + err);
            // 解码失败时重置解码器
            if (this.decoder) {
                try {
                    this.decoder.free();
                } catch (e) {
                    // 忽略释放错误
                }
                this.decoder = null;
            }
        }
    }
    
    /**
     * 清理资源
     * @private
     */
    _cleanup() {
        // 重置播放调度
        this.nextPlayTime = 0;
        
        // 释放解码器
        if (this.decoder) {
            try {
                this.decoder.free();
            } catch (e) {
                // 忽略释放错误
            }
            this.decoder = null;
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
     * 销毁音频管理器
     */
    destroy() {
        this.disconnect();
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.gainNode = null;
    }
}

// 导出单例
const audioManager = new AudioManager();
export default audioManager;

