/*
 * noVNC: HTML5 VNC client
 * Clipboard management module
 */

import * as Log from '../core/util/logging.js';
import { l10n } from './localization.js';

const _ = l10n.get.bind(l10n);

class ClipboardManager {
    constructor() {
        this.rfb = null;
        this.autoSync = false;
        this.permissionGranted = false;
        this.lastLocalText = null;
        this.syncFocusHandler = null;

        // Callbacks for UI updates
        this.onStatusChange = null; // (status, message) => void
    }

    setRFB(rfb) {
        this.rfb = rfb;
    }

    /**
     * Initialize clipboard state based on permissions
     * 根据权限状态初始化剪贴板自动同步
     * 
     * 注意：默认开启自动同步，因为：
     * 1. 这是更好的用户体验
     * 2. Clipboard API 在用户手势（如点击、焦点切换）时才会真正读取
     * 3. 如果权限被拒绝，会在实际操作时处理
     */
    async init() {
        Log.Info('[Clipboard] Initializing...');
        
        // 检查 Clipboard API 是否可用
        if (!navigator.clipboard) {
            Log.Warn('[Clipboard] Clipboard API not supported');
            this._updateStatus('error', _('Clipboard API not supported'));
            return;
        }

        // 尝试查询权限状态（某些浏览器可能不支持）
        let permissionState = 'unknown';
        
        if (navigator.permissions && navigator.permissions.query) {
            try {
                // 注意：某些浏览器不支持 "clipboard-read" 权限查询
                const result = await navigator.permissions.query({ name: "clipboard-read" });
                permissionState = result.state;
                Log.Info('[Clipboard] Permission query result: ' + permissionState);
            } catch (err) {
                // 权限查询不支持（如 Firefox），这是正常的
                Log.Debug('[Clipboard] Permission query not supported: ' + err.message);
                permissionState = 'unknown';
            }
        }

        // 根据权限状态决定行为
        if (permissionState === 'denied') {
            // 权限明确被拒绝
            Log.Info('[Clipboard] Permission denied, disabling auto sync');
            this.autoSync = false;
            this._updateStatus('inactive', '');
        } else {
            // granted / prompt / unknown 都默认开启
            // 实际权限检查会在用户手势时进行
            Log.Info('[Clipboard] Enabling auto sync (permission: ' + permissionState + ')');
            this.autoSync = true;
            this._startSync(false); // 不立即执行，等待用户手势
            this._updateStatus('active', _('Auto sync enabled'));
        }
    }

    /**
     * Toggle auto-sync state
     * @param {boolean} enable 
     * @returns {Promise<boolean>} resulting state
     */
    async toggleAutoSync(enable) {
        if (enable) {
            const hasPermission = await this._requestPermission();
            if (!hasPermission) {
                this._updateStatus('error', _('Clipboard permission denied'));
                return false;
            }

            this.autoSync = true;
            this._startSync();
            this._updateStatus('active', _('Auto sync enabled'));
            Log.Info('[Clipboard] Auto sync enabled');
        } else {
            this.autoSync = false;
            this._stopSync();
            this._updateStatus('inactive', '');
            Log.Info('[Clipboard] Auto sync disabled');
        }
        return this.autoSync;
    }

    /**
     * Receive text from remote and sync to local if enabled
     * @param {string} text 
     */
    handleRemoteText(text) {
        if (this.autoSync) {
            this.writeLocal(text);
        }
    }

    /**
     * Read from local clipboard manually
     */
    async readLocal() {
        try {
            if (!navigator.clipboard || !navigator.clipboard.readText) {
                this._updateStatus('error', _('Clipboard API not supported'));
                return null;
            }

            const text = await navigator.clipboard.readText();
            this.lastLocalText = text;
            Log.Debug('[Clipboard] Read from local: ' + text.substr(0, 40) + '...');

            this._updateStatus('success', _('Read from local clipboard'));
            this._resetStatus();

            return text;
        } catch (err) {
            Log.Warn('[Clipboard] Failed to read local: ' + err.message);
            this._updateStatus('error', _('Failed to read clipboard'));
            return null;
        }
    }

    /**
     * Write to local clipboard
     * @param {string} text 
     */
    async writeLocal(text) {
        try {
            if (!navigator.clipboard || !navigator.clipboard.writeText) {
                this._updateStatus('error', _('Clipboard API not supported'));
                return;
            }

            await navigator.clipboard.writeText(text);
            this.lastLocalText = text;
            Log.Debug('[Clipboard] Wrote to local: ' + text.substr(0, 40) + '...');

            this._updateStatus('success', _('Copied to local clipboard'));
            this._resetStatus();
        } catch (err) {
            Log.Warn('[Clipboard] Failed to write local: ' + err.message);
            this._updateStatus('error', _('Failed to write clipboard'));
        }
    }

    /**
     * Send text to remote
     * @param {string} text 
     */
    sendToRemote(text) {
        if (this.rfb) {
            this.rfb.clipboardPasteFrom(text);
            Log.Debug('[Clipboard] Sent to remote: ' + text.substr(0, 40) + '...');
        }
    }

    // Private methods

    async _requestPermission() {
        try {
            if (navigator.clipboard && navigator.clipboard.readText) {
                await navigator.clipboard.readText();
                this.permissionGranted = true;
                return true;
            }
            return false;
        } catch (err) {
            if (err.name === 'NotAllowedError') {
                return false;
            }
            // Other errors (like empty clipboard) usually mean we have permission
            return true;
        }
    }

    _startSync(runImmediately = true) {
        this.syncFocusHandler = async () => {
            if (!this.autoSync || !this.rfb) return;

            try {
                // Focus event is a user gesture, so readText should work/prompt
                const text = await navigator.clipboard.readText();
                if (text && text !== this.lastLocalText) {
                    this.lastLocalText = text;
                    this.sendToRemote(text);
                }
            } catch (err) {
                // If it fails (e.g. denied), we might want to turn off autoSync?
                // For now, just log and maybe show status
                Log.Warn('[Clipboard] Auto-sync read failed: ' + err);
                if (err.name === 'NotAllowedError') {
                    this._updateStatus('error', _('Clipboard permission denied'));
                    this.autoSync = false; // Disable if denied
                    // We might want to notify UI to uncheck box
                    // But we don't have a direct way to sync back to checkbox unless we use callback
                    // Current arch: init sets checkbox. toggle sets checkbox.
                    // If we change state here, checkbox might desync.
                    // We can use onStatusChange to signal "error"? Or add onStateChange?
                    // For now, keep simple.
                }
            }
        };

        window.addEventListener('focus', this.syncFocusHandler);
        if (runImmediately) {
            this.syncFocusHandler(); // Initial sync
        }
    }

    _stopSync() {
        if (this.syncFocusHandler) {
            window.removeEventListener('focus', this.syncFocusHandler);
            this.syncFocusHandler = null;
        }
        this.lastLocalText = null;
    }

    _updateStatus(status, message) {
        if (this.onStatusChange) {
            this.onStatusChange(status, message);
        }
    }

    _resetStatus() {
        setTimeout(() => {
            if (this.autoSync) {
                this._updateStatus('active', _('Auto sync enabled'));
            } else {
                this._updateStatus('inactive', '');
            }
        }, 2000);
    }
}

const clipboardManager = new ClipboardManager();
export default clipboardManager;
