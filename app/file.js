/*
 * noVNC: HTML5 VNC client
 * File transfer module
 * 
 * 文件传输模块 - 用于在本地和远程桌面之间传输文件
 */

import * as Log from '../core/util/logging.js';

class FileManager {
    constructor() {
        this.ws = null;
        this.connected = false;

        // Configuration
        this.maxRetries = 5;
        this.retryCount = 0;
        this.retryDelay = 2000;
        this.retryTimer = null;
        this.lastWsUrl = null;
        this.autoRetryEnabled = true;

        // Callbacks
        this.onStatusChange = null; // (status, message) => void
    }

    /**
     * Build WebSocket URL for file transfer
     */
    buildWsUrl(baseUrl, projectId, userId = null, debugMode = false) {
        const wsUrl = baseUrl
            .replace(/^http/, 'ws')
            .replace(/\/+$/, '');

        if (debugMode && userId) {
            // Debug mode URL pattern
            return `ws://192.168.1.34:8088/computer/file/${userId}/${projectId}/ws`;
        } else {
            // Production/Standard URL pattern
            return `${wsUrl}/computer/file/${projectId}/ws`;
        }
    }

    /**
     * Connect to file transfer WebSocket
     */
    async connect(wsUrl) {
        if (this.connected) {
            return;
        }

        try {
            this._updateStatus('connecting', 'File transfer connecting...');
            this.lastWsUrl = wsUrl;

            this.ws = new WebSocket(wsUrl);
            this.ws.binaryType = 'arraybuffer';

            this.ws.onopen = () => {
                Log.Info('[File] WebSocket connected');
                this.connected = true;
                this.retryCount = 0;
                this._updateStatus('connected', 'File transfer active');
            };

            this.ws.onmessage = this._handleMessage.bind(this);

            this.ws.onerror = (err) => {
                Log.Error('[File] WebSocket error: ' + err);
                this._updateStatus('error', 'File transfer error');
            };

            this.ws.onclose = () => {
                Log.Info('[File] WebSocket closed');
                this.connected = false;
                this._handleClose();
            };

        } catch (err) {
            Log.Error('[File] Connection failed: ' + err);
            this._updateStatus('error', 'File transfer failed');
        }
    }

    disconnect() {
        this.autoRetryEnabled = false;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this._updateStatus('disconnected', 'File transfer disconnected');
    }

    /**
     * Upload a file to the remote desktop
     * @param {File} file 
     */
    async uploadFile(file) {
        if (!this.connected || !this.ws) {
            Log.Warn('[File] Not connected, cannot upload');
            this._updateStatus('error', 'Not connected');
            return;
        }

        try {
            Log.Info(`[File] Uploading ${file.name} (${file.size} bytes)`);
            this._updateStatus('transferring', `Uploading ${file.name}...`);

            // 1. Send Metadata (JSON)
            // format: { type: 'upload_start', name: 'filename', size: 1234, mime: 'image/png' }
            const metadata = {
                type: 'upload_start',
                name: file.name,
                size: file.size,
                mime: file.type
            };
            this.ws.send(JSON.stringify(metadata));

            // 2. Read and send file data
            // For simplicity, we can send as one blob for small files, or chunk it.
            // Let's send it as a single binary message for now to keep it simple,
            // assuming the backend can handle the next message being binary data.
            // Or we could chunk it if needed. 
            // Better to use ArrayBuffer.

            const buffer = await file.arrayBuffer();
            this.ws.send(buffer);

            Log.Info('[File] Upload completed locally');
            this._updateStatus('success', `Uploaded ${file.name}`);

            // Reset status after a delay
            setTimeout(() => {
                if (this.connected) this._updateStatus('connected', 'File transfer active');
            }, 3000);

        } catch (err) {
            Log.Error('[File] Upload failed: ' + err);
            this._updateStatus('error', 'Upload failed');
        }
    }

    /**
     * Handle incoming messages (e.g. downloads from remote)
     */
    _handleMessage(event) {
        // Implementation for downloading or status updates from server
        // For now, minimal implementation
        if (typeof event.data === 'string') {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'status') {
                    Log.Info('[File] Server status: ' + msg.message);
                }
            } catch (e) {
                // Ignore non-json
            }
        }
    }

    _handleClose() {
        if (this.autoRetryEnabled && this.retryCount < this.maxRetries) {
            this.retryCount++;
            Log.Info(`[File] Retrying connection in ${this.retryDelay}ms (${this.retryCount}/${this.maxRetries})`);
            this.retryTimer = setTimeout(() => {
                if (this.lastWsUrl) this.connect(this.lastWsUrl);
            }, this.retryDelay);
        }
    }

    _updateStatus(status, message) {
        if (this.onStatusChange) {
            this.onStatusChange(status, message);
        }
    }
}

const fileManager = new FileManager();
export default fileManager;
