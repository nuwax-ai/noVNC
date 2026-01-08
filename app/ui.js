/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2019 The noVNC authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

import * as Log from '../core/util/logging.js';
import _, { l10n } from './localization.js';
import {
    isTouchDevice, isMac, isIOS, isAndroid, isChromeOS, isSafari,
    hasScrollbarGutter, dragThreshold
}
    from '../core/util/browser.js';
import { setCapture, getPointerEvent } from '../core/util/events.js';
import KeyTable from "../core/input/keysym.js";
import keysyms from "../core/input/keysymdef.js";
import Keyboard from "../core/input/keyboard.js";
import RFB from "../core/rfb.js";
import * as WebUtil from "./webutil.js";

// 音频和输入法模块
import audioManager from "./audio.js";
import imeManager from "./ime.js";
import clipboardManager from "./clipboard.js";
import fileManager from "./file.js";

const PAGE_TITLE = "noVNC";

const LINGUAS = ["cs", "de", "el", "es", "fr", "it", "ja", "ko", "nl", "pl", "pt_BR", "ru", "sv", "tr", "zh_CN", "zh_TW"];

const UI = {

    customSettings: {},

    connected: false,
    desktopName: "",

    statusTimeout: null,
    hideKeyboardTimeout: null,
    idleControlbarTimeout: null,
    closeControlbarTimeout: null,

    controlbarGrabbed: false,
    controlbarDrag: false,
    controlbarMouseDownClientY: 0,
    controlbarMouseDownOffsetY: 0,

    lastKeyboardinput: null,
    defaultKeyboardinputLen: 100,

    inhibitReconnect: true,
    reconnectCallback: null,
    reconnectPassword: null,

    // 心跳保活定时器
    keepaliveInterval: null,
    keepaliveIntervalMs: 60000, // 60秒发送一次心跳

    // 音频和输入法状态
    audioEnabled: false,
    imeEnabled: false,
    // 从 URL 参数获取的用户信息
    userId: null,
    projectId: null,
    baseUrl: null,
    debugMode: false,  // 调试模式（包含 user_id）

    debugMode: false,  // 调试模式（包含 user_id）

    async start(options = {}) {
        UI.customSettings = options.settings || {};
        if (UI.customSettings.defaults === undefined) {
            UI.customSettings.defaults = {};
        }
        if (UI.customSettings.mandatory === undefined) {
            UI.customSettings.mandatory = {};
        }

        // Set up translations
        try {
            await l10n.setup(LINGUAS, "app/locale/");
        } catch (err) {
            Log.Error("Failed to load translations: " + err);
        }

        // Initialize setting storage
        await WebUtil.initSettings();

        // Wait for the page to load
        if (document.readyState !== "interactive" && document.readyState !== "complete") {
            await new Promise((resolve, reject) => {
                document.addEventListener('DOMContentLoaded', resolve);
            });
        }

        UI.initSettings();

        // Translate the DOM
        l10n.translateDOM();

        // We rely on modern APIs which might not be available in an
        // insecure context
        if (!window.isSecureContext) {
            // FIXME: This gets hidden when connecting
            UI.showStatus(_("Running without HTTPS is not recommended, crashes or other issues are likely."), 'error');
        }

        // Try to fetch version number
        try {
            let response = await fetch('./package.json');
            if (!response.ok) {
                throw Error("" + response.status + " " + response.statusText);
            }

            let packageInfo = await response.json();
            Array.from(document.getElementsByClassName('noVNC_version')).forEach(el => el.innerText = packageInfo.version);
        } catch (err) {
            Log.Error("Couldn't fetch package.json: " + err);
            Array.from(document.getElementsByClassName('noVNC_version_wrapper'))
                .concat(Array.from(document.getElementsByClassName('noVNC_version_separator')))
                .forEach(el => el.style.display = 'none');
        }

        // Adapt the interface for touch screen devices
        if (isTouchDevice) {
            // Remove the address bar
            setTimeout(() => window.scrollTo(0, 1), 100);
        }

        // Restore control bar position
        if (WebUtil.readSetting('controlbar_pos') === 'right') {
            UI.toggleControlbarSide();
        }

        UI.initFullscreen();

        // Setup event handlers
        UI.addControlbarHandlers();
        UI.addTouchSpecificHandlers();
        UI.addExtraKeysHandlers();
        UI.addMachineHandlers();
        UI.addConnectionControlHandlers();
        await UI.addClipboardHandlers();  // 需要 await 等待剪贴板初始化完成
        UI.addFileHandlers();             // 添加文件拖拽处理器
        UI.addSettingsHandlers();
        UI.addAudioHandlers();
        // UI.addIMEHandlers();
        document.getElementById("noVNC_status")
            .addEventListener('click', UI.hideStatus);

        // 初始化音频和输入法参数
        UI.initAudioIMEParams();

        // Bootstrap fallback input handler
        UI.keyboardinputReset();

        UI.openControlbar();

        UI.updateVisualState('init');

        document.documentElement.classList.remove("noVNC_loading");

        let autoconnect = UI.getSetting('autoconnect');
        if (autoconnect === 'true' || autoconnect == '1') {
            autoconnect = true;
            UI.connect();
        } else {
            autoconnect = false;
            // Show the connect panel on first load unless autoconnecting
            UI.openConnectPanel();
        }
    },

    initFullscreen() {
        // Only show the button if fullscreen is properly supported
        // * Safari doesn't support alphanumerical input while in fullscreen
        if (!isSafari() &&
            (document.documentElement.requestFullscreen ||
                document.documentElement.mozRequestFullScreen ||
                document.documentElement.webkitRequestFullscreen ||
                document.body.msRequestFullscreen)) {
            document.getElementById('noVNC_fullscreen_button')
                .classList.remove("noVNC_hidden");
            UI.addFullscreenHandlers();
        }
    },

    initSettings() {
        // Logging selection dropdown
        const llevels = ['error', 'warn', 'info', 'debug'];
        for (let i = 0; i < llevels.length; i += 1) {
            UI.addOption(document.getElementById('noVNC_setting_logging'), llevels[i], llevels[i]);
        }

        // Settings with immediate effects
        UI.initSetting('logging', 'warn');
        UI.updateLogging();

        UI.setupSettingLabels();

        /* Populate the controls if defaults are provided in the URL */
        UI.initSetting('host', '');
        UI.initSetting('port', 0);
        UI.initSetting('encrypt', (window.location.protocol === "https:"));
        UI.initSetting('password');
        UI.initSetting('autoconnect', false);
        UI.initSetting('view_clip', false);
        UI.initSetting('resize', 'off');
        UI.initSetting('quality', 6);
        UI.initSetting('compression', 2);
        UI.initSetting('shared', true);
        UI.initSetting('bell', 'on');
        UI.initSetting('view_only', false);
        UI.initSetting('show_dot', false);
        UI.initSetting('path', 'websockify');
        UI.initSetting('repeaterID', '');
        UI.initSetting('reconnect', false);
        UI.initSetting('reconnect_delay', 5000);
    },
    // Adds a link to the label elements on the corresponding input elements
    setupSettingLabels() {
        const labels = document.getElementsByTagName('LABEL');
        for (let i = 0; i < labels.length; i++) {
            const htmlFor = labels[i].htmlFor;
            if (htmlFor != '') {
                const elem = document.getElementById(htmlFor);
                if (elem) elem.label = labels[i];
            } else {
                // If 'for' isn't set, use the first input element child
                const children = labels[i].children;
                for (let j = 0; j < children.length; j++) {
                    if (children[j].form !== undefined) {
                        children[j].label = labels[i];
                        break;
                    }
                }
            }
        }
    },

    /* ------^-------
    *     /INIT
    * ==============
    * EVENT HANDLERS
    * ------v------*/

    addControlbarHandlers() {
        document.getElementById("noVNC_control_bar")
            .addEventListener('mousemove', UI.activateControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('mouseup', UI.activateControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('mousedown', UI.activateControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('keydown', UI.activateControlbar);

        document.getElementById("noVNC_control_bar")
            .addEventListener('mousedown', UI.keepControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('keydown', UI.keepControlbar);

        document.getElementById("noVNC_view_drag_button")
            .addEventListener('click', UI.toggleViewDrag);

        document.getElementById("noVNC_control_bar_handle")
            .addEventListener('mousedown', UI.controlbarHandleMouseDown);
        document.getElementById("noVNC_control_bar_handle")
            .addEventListener('mouseup', UI.controlbarHandleMouseUp);
        document.getElementById("noVNC_control_bar_handle")
            .addEventListener('mousemove', UI.dragControlbarHandle);
        // resize events aren't available for elements
        window.addEventListener('resize', UI.updateControlbarHandle);

        const exps = document.getElementsByClassName("noVNC_expander");
        for (let i = 0; i < exps.length; i++) {
            exps[i].addEventListener('click', UI.toggleExpander);
        }
    },

    addTouchSpecificHandlers() {
        document.getElementById("noVNC_keyboard_button")
            .addEventListener('click', UI.toggleVirtualKeyboard);

        UI.touchKeyboard = new Keyboard(document.getElementById('noVNC_keyboardinput'));
        UI.touchKeyboard.onkeyevent = UI.keyEvent;
        UI.touchKeyboard.grab();
        document.getElementById("noVNC_keyboardinput")
            .addEventListener('input', UI.keyInput);
        document.getElementById("noVNC_keyboardinput")
            .addEventListener('focus', UI.onfocusVirtualKeyboard);
        document.getElementById("noVNC_keyboardinput")
            .addEventListener('blur', UI.onblurVirtualKeyboard);
        document.getElementById("noVNC_keyboardinput")
            .addEventListener('submit', () => false);

        document.documentElement
            .addEventListener('mousedown', UI.keepVirtualKeyboard, true);

        document.getElementById("noVNC_control_bar")
            .addEventListener('touchstart', UI.activateControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('touchmove', UI.activateControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('touchend', UI.activateControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('input', UI.activateControlbar);

        document.getElementById("noVNC_control_bar")
            .addEventListener('touchstart', UI.keepControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('input', UI.keepControlbar);

        document.getElementById("noVNC_control_bar_handle")
            .addEventListener('touchstart', UI.controlbarHandleMouseDown);
        document.getElementById("noVNC_control_bar_handle")
            .addEventListener('touchend', UI.controlbarHandleMouseUp);
        document.getElementById("noVNC_control_bar_handle")
            .addEventListener('touchmove', UI.dragControlbarHandle);
    },

    addExtraKeysHandlers() {
        document.getElementById("noVNC_toggle_extra_keys_button")
            .addEventListener('click', UI.toggleExtraKeys);
        document.getElementById("noVNC_toggle_ctrl_button")
            .addEventListener('click', UI.toggleCtrl);
        document.getElementById("noVNC_toggle_windows_button")
            .addEventListener('click', UI.toggleWindows);
        document.getElementById("noVNC_toggle_alt_button")
            .addEventListener('click', UI.toggleAlt);
        document.getElementById("noVNC_send_tab_button")
            .addEventListener('click', UI.sendTab);
        document.getElementById("noVNC_send_esc_button")
            .addEventListener('click', UI.sendEsc);
        document.getElementById("noVNC_send_ctrl_alt_del_button")
            .addEventListener('click', UI.sendCtrlAltDel);
    },

    addMachineHandlers() {
        document.getElementById("noVNC_shutdown_button")
            .addEventListener('click', () => UI.rfb.machineShutdown());
        document.getElementById("noVNC_reboot_button")
            .addEventListener('click', () => UI.rfb.machineReboot());
        document.getElementById("noVNC_reset_button")
            .addEventListener('click', () => UI.rfb.machineReset());
        document.getElementById("noVNC_power_button")
            .addEventListener('click', UI.togglePowerPanel);
    },

    addConnectionControlHandlers() {
        document.getElementById("noVNC_disconnect_button")
            .addEventListener('click', UI.disconnect);
        document.getElementById("noVNC_connect_button")
            .addEventListener('click', UI.connect);
        document.getElementById("noVNC_cancel_reconnect_button")
            .addEventListener('click', UI.cancelReconnect);

        document.getElementById("noVNC_approve_server_button")
            .addEventListener('click', UI.approveServer);
        document.getElementById("noVNC_reject_server_button")
            .addEventListener('click', UI.rejectServer);
        document.getElementById("noVNC_credentials_button")
            .addEventListener('click', UI.setCredentials);
    },

    async addClipboardHandlers() {
        // 剪贴板面板按钮
        document.getElementById("noVNC_clipboard_button")
            .addEventListener('click', UI.toggleClipboardPanel);
        // 文本框内容变化时发送到远程
        document.getElementById("noVNC_clipboard_text")
            .addEventListener('change', UI.clipboardSend);

        // 自动同步开关
        document.getElementById("noVNC_clipboard_auto_sync")
            .addEventListener('change', UI.toggleClipboardAutoSync);

        // 快捷按钮
        document.getElementById("noVNC_clipboard_read_local")
            .addEventListener('click', async () => {
                const text = await clipboardManager.readLocal();
                if (text !== null) {
                    document.getElementById("noVNC_clipboard_text").value = text;
                }
            });
        document.getElementById("noVNC_clipboard_send_remote")
            .addEventListener('click', UI.clipboardSend);
        document.getElementById("noVNC_clipboard_copy_local")
            .addEventListener('click', UI.clipboardCopyToLocal);

        // 设置剪贴板状态回调
        clipboardManager.onStatusChange = UI.updateClipboardSyncStatus;

        // 初始化剪贴板状态（根据权限）- 必须 await 等待完成
        await UI.initClipboard();
    },

    // 文件拖拽处理器
    addFileHandlers() {
        const target = document.getElementById('noVNC_container');

        target.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            target.classList.add('noVNC_dragging');
        });

        target.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            target.classList.remove('noVNC_dragging');
        });

        target.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            target.classList.remove('noVNC_dragging');

            const files = e.dataTransfer.files;
            if (files.length > 0) {
                // 目前只处理第一个文件，或者循环处理
                for (let i = 0; i < files.length; i++) {
                    await fileManager.uploadFile(files[i]);
                }
            }
        });

        // 粘贴事件监听 (图片粘贴)
        document.addEventListener('paste', async (e) => {
            // 只有当焦点不在输入框时才处理（避免干扰正常文本粘贴）
            const activeTag = document.activeElement.tagName;
            if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

            const items = e.clipboardData.items;
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') !== -1) {
                    const file = items[i].getAsFile();
                    if (file) {
                        Log.Info('[UI] Detected image paste, uploading...');
                        await fileManager.uploadFile(file);
                    }
                }
            }
        });
    },

    // 音频事件处理器
    addAudioHandlers() {
        document.getElementById("noVNC_audio_button")
            .addEventListener('click', UI.toggleAudioPanel);
        document.getElementById("noVNC_audio_volume")
            .addEventListener('input', UI.onAudioVolumeChange);
        document.getElementById("noVNC_audio_toggle")
            .addEventListener('click', UI.toggleAudio);

        // 设置音频状态回调
        audioManager.onStatusChange = UI.onAudioStatusChange;
    },

    // 输入法事件处理器
    addIMEHandlers() {
        document.getElementById("noVNC_ime_button")
            .addEventListener('click', UI.toggleIMEPanel);

        // 设置输入法状态回调
        imeManager.onStatusChange = UI.onIMEStatusChange;
    },

    // Add a call to save settings when the element changes,
    // unless the optional parameter changeFunc is used instead.
    addSettingChangeHandler(name, changeFunc) {
        const settingElem = document.getElementById("noVNC_setting_" + name);
        if (changeFunc === undefined) {
            changeFunc = () => UI.saveSetting(name);
        }
        settingElem.addEventListener('change', changeFunc);
    },

    addSettingsHandlers() {
        document.getElementById("noVNC_settings_button")
            .addEventListener('click', UI.toggleSettingsPanel);

        UI.addSettingChangeHandler('encrypt');
        UI.addSettingChangeHandler('resize');
        UI.addSettingChangeHandler('resize', UI.applyResizeMode);
        UI.addSettingChangeHandler('resize', UI.updateViewClip);
        UI.addSettingChangeHandler('quality');
        UI.addSettingChangeHandler('quality', UI.updateQuality);
        UI.addSettingChangeHandler('compression');
        UI.addSettingChangeHandler('compression', UI.updateCompression);
        UI.addSettingChangeHandler('view_clip');
        UI.addSettingChangeHandler('view_clip', UI.updateViewClip);
        UI.addSettingChangeHandler('shared');
        UI.addSettingChangeHandler('view_only');
        UI.addSettingChangeHandler('view_only', UI.updateViewOnly);
        UI.addSettingChangeHandler('show_dot');
        UI.addSettingChangeHandler('show_dot', UI.updateShowDotCursor);
        UI.addSettingChangeHandler('host');
        UI.addSettingChangeHandler('port');
        UI.addSettingChangeHandler('path');
        UI.addSettingChangeHandler('repeaterID');
        UI.addSettingChangeHandler('logging');
        UI.addSettingChangeHandler('logging', UI.updateLogging);
        UI.addSettingChangeHandler('reconnect');
        UI.addSettingChangeHandler('reconnect_delay');
    },

    addFullscreenHandlers() {
        document.getElementById("noVNC_fullscreen_button")
            .addEventListener('click', UI.toggleFullscreen);

        window.addEventListener('fullscreenchange', UI.updateFullscreenButton);
        window.addEventListener('mozfullscreenchange', UI.updateFullscreenButton);
        window.addEventListener('webkitfullscreenchange', UI.updateFullscreenButton);
        window.addEventListener('msfullscreenchange', UI.updateFullscreenButton);
    },

    /* ------^-------
     * /EVENT HANDLERS
     * ==============
     *     VISUAL
     * ------v------*/

    // Disable/enable controls depending on connection state
    updateVisualState(state) {

        document.documentElement.classList.remove("noVNC_connecting");
        document.documentElement.classList.remove("noVNC_connected");
        document.documentElement.classList.remove("noVNC_disconnecting");
        document.documentElement.classList.remove("noVNC_reconnecting");

        const transitionElem = document.getElementById("noVNC_transition_text");
        switch (state) {
            case 'init':
                break;
            case 'connecting':
                transitionElem.textContent = _("Connecting...");
                document.documentElement.classList.add("noVNC_connecting");
                break;
            case 'connected':
                document.documentElement.classList.add("noVNC_connected");
                break;
            case 'disconnecting':
                transitionElem.textContent = _("Disconnecting...");
                document.documentElement.classList.add("noVNC_disconnecting");
                break;
            case 'disconnected':
                break;
            case 'reconnecting':
                transitionElem.textContent = _("Reconnecting...");
                document.documentElement.classList.add("noVNC_reconnecting");
                break;
            default:
                Log.Error("Invalid visual state: " + state);
                UI.showStatus(_("Internal error"), 'error');
                return;
        }

        if (UI.connected) {
            UI.updateViewClip();

            UI.disableSetting('encrypt');
            UI.disableSetting('shared');
            UI.disableSetting('host');
            UI.disableSetting('port');
            UI.disableSetting('path');
            UI.disableSetting('repeaterID');

            // Hide the controlbar after 2 seconds
            UI.closeControlbarTimeout = setTimeout(UI.closeControlbar, 2000);
        } else {
            UI.enableSetting('encrypt');
            UI.enableSetting('shared');
            UI.enableSetting('host');
            UI.enableSetting('port');
            UI.enableSetting('path');
            UI.enableSetting('repeaterID');
            UI.updatePowerButton();
            UI.keepControlbar();
        }

        // State change closes dialogs as they may not be relevant
        // anymore
        UI.closeAllPanels();
        document.getElementById('noVNC_verify_server_dlg')
            .classList.remove('noVNC_open');
        document.getElementById('noVNC_credentials_dlg')
            .classList.remove('noVNC_open');
    },

    showStatus(text, statusType, time) {
        const statusElem = document.getElementById('noVNC_status');

        if (typeof statusType === 'undefined') {
            statusType = 'normal';
        }

        // Don't overwrite more severe visible statuses and never
        // errors. Only shows the first error.
        if (statusElem.classList.contains("noVNC_open")) {
            if (statusElem.classList.contains("noVNC_status_error")) {
                return;
            }
            if (statusElem.classList.contains("noVNC_status_warn") &&
                statusType === 'normal') {
                return;
            }
        }

        clearTimeout(UI.statusTimeout);

        switch (statusType) {
            case 'error':
                statusElem.classList.remove("noVNC_status_warn");
                statusElem.classList.remove("noVNC_status_normal");
                statusElem.classList.add("noVNC_status_error");
                break;
            case 'warning':
            case 'warn':
                statusElem.classList.remove("noVNC_status_error");
                statusElem.classList.remove("noVNC_status_normal");
                statusElem.classList.add("noVNC_status_warn");
                break;
            case 'normal':
            case 'info':
            default:
                statusElem.classList.remove("noVNC_status_error");
                statusElem.classList.remove("noVNC_status_warn");
                statusElem.classList.add("noVNC_status_normal");
                break;
        }

        statusElem.textContent = text;
        statusElem.classList.add("noVNC_open");

        // If no time was specified, show the status for 1.5 seconds
        if (typeof time === 'undefined') {
            time = 1500;
        }

        // Error messages do not timeout
        if (statusType !== 'error') {
            UI.statusTimeout = window.setTimeout(UI.hideStatus, time);
        }
    },

    hideStatus() {
        clearTimeout(UI.statusTimeout);
        document.getElementById('noVNC_status').classList.remove("noVNC_open");
    },

    activateControlbar(event) {
        clearTimeout(UI.idleControlbarTimeout);
        // We manipulate the anchor instead of the actual control
        // bar in order to avoid creating new a stacking group
        document.getElementById('noVNC_control_bar_anchor')
            .classList.remove("noVNC_idle");
        UI.idleControlbarTimeout = window.setTimeout(UI.idleControlbar, 2000);
    },

    idleControlbar() {
        // Don't fade if a child of the control bar has focus
        if (document.getElementById('noVNC_control_bar')
            .contains(document.activeElement) && document.hasFocus()) {
            UI.activateControlbar();
            return;
        }

        document.getElementById('noVNC_control_bar_anchor')
            .classList.add("noVNC_idle");
    },

    keepControlbar() {
        clearTimeout(UI.closeControlbarTimeout);
    },

    openControlbar() {
        document.getElementById('noVNC_control_bar')
            .classList.add("noVNC_open");
    },

    closeControlbar() {
        UI.closeAllPanels();
        document.getElementById('noVNC_control_bar')
            .classList.remove("noVNC_open");
        UI.rfb.focus();
    },

    toggleControlbar() {
        if (document.getElementById('noVNC_control_bar')
            .classList.contains("noVNC_open")) {
            UI.closeControlbar();
        } else {
            UI.openControlbar();
        }
    },

    toggleControlbarSide() {
        // Temporarily disable animation, if bar is displayed, to avoid weird
        // movement. The transitionend-event will not fire when display=none.
        const bar = document.getElementById('noVNC_control_bar');
        const barDisplayStyle = window.getComputedStyle(bar).display;
        if (barDisplayStyle !== 'none') {
            bar.style.transitionDuration = '0s';
            bar.addEventListener('transitionend', () => bar.style.transitionDuration = '');
        }

        const anchor = document.getElementById('noVNC_control_bar_anchor');
        if (anchor.classList.contains("noVNC_right")) {
            WebUtil.writeSetting('controlbar_pos', 'left');
            anchor.classList.remove("noVNC_right");
        } else {
            WebUtil.writeSetting('controlbar_pos', 'right');
            anchor.classList.add("noVNC_right");
        }

        // Consider this a movement of the handle
        UI.controlbarDrag = true;

        // The user has "followed" hint, let's hide it until the next drag
        UI.showControlbarHint(false, false);
    },

    showControlbarHint(show, animate = true) {
        const hint = document.getElementById('noVNC_control_bar_hint');

        if (animate) {
            hint.classList.remove("noVNC_notransition");
        } else {
            hint.classList.add("noVNC_notransition");
        }

        if (show) {
            hint.classList.add("noVNC_active");
        } else {
            hint.classList.remove("noVNC_active");
        }
    },

    dragControlbarHandle(e) {
        if (!UI.controlbarGrabbed) return;

        const ptr = getPointerEvent(e);

        const anchor = document.getElementById('noVNC_control_bar_anchor');
        if (ptr.clientX < (window.innerWidth * 0.1)) {
            if (anchor.classList.contains("noVNC_right")) {
                UI.toggleControlbarSide();
            }
        } else if (ptr.clientX > (window.innerWidth * 0.9)) {
            if (!anchor.classList.contains("noVNC_right")) {
                UI.toggleControlbarSide();
            }
        }

        if (!UI.controlbarDrag) {
            const dragDistance = Math.abs(ptr.clientY - UI.controlbarMouseDownClientY);

            if (dragDistance < dragThreshold) return;

            UI.controlbarDrag = true;
        }

        const eventY = ptr.clientY - UI.controlbarMouseDownOffsetY;

        UI.moveControlbarHandle(eventY);

        e.preventDefault();
        e.stopPropagation();
        UI.keepControlbar();
        UI.activateControlbar();
    },

    // Move the handle but don't allow any position outside the bounds
    moveControlbarHandle(viewportRelativeY) {
        const handle = document.getElementById("noVNC_control_bar_handle");
        const handleHeight = handle.getBoundingClientRect().height;
        const controlbarBounds = document.getElementById("noVNC_control_bar")
            .getBoundingClientRect();
        const margin = 10;

        // These heights need to be non-zero for the below logic to work
        if (handleHeight === 0 || controlbarBounds.height === 0) {
            return;
        }

        let newY = viewportRelativeY;

        // Check if the coordinates are outside the control bar
        if (newY < controlbarBounds.top + margin) {
            // Force coordinates to be below the top of the control bar
            newY = controlbarBounds.top + margin;

        } else if (newY > controlbarBounds.top +
            controlbarBounds.height - handleHeight - margin) {
            // Force coordinates to be above the bottom of the control bar
            newY = controlbarBounds.top +
                controlbarBounds.height - handleHeight - margin;
        }

        // Corner case: control bar too small for stable position
        if (controlbarBounds.height < (handleHeight + margin * 2)) {
            newY = controlbarBounds.top +
                (controlbarBounds.height - handleHeight) / 2;
        }

        // The transform needs coordinates that are relative to the parent
        const parentRelativeY = newY - controlbarBounds.top;
        handle.style.transform = "translateY(" + parentRelativeY + "px)";
    },

    updateControlbarHandle() {
        // Since the control bar is fixed on the viewport and not the page,
        // the move function expects coordinates relative the the viewport.
        const handle = document.getElementById("noVNC_control_bar_handle");
        const handleBounds = handle.getBoundingClientRect();
        UI.moveControlbarHandle(handleBounds.top);
    },

    controlbarHandleMouseUp(e) {
        if ((e.type == "mouseup") && (e.button != 0)) return;

        // mouseup and mousedown on the same place toggles the controlbar
        if (UI.controlbarGrabbed && !UI.controlbarDrag) {
            UI.toggleControlbar();
            e.preventDefault();
            e.stopPropagation();
            UI.keepControlbar();
            UI.activateControlbar();
        }
        UI.controlbarGrabbed = false;
        UI.showControlbarHint(false);
    },

    controlbarHandleMouseDown(e) {
        if ((e.type == "mousedown") && (e.button != 0)) return;

        const ptr = getPointerEvent(e);

        const handle = document.getElementById("noVNC_control_bar_handle");
        const bounds = handle.getBoundingClientRect();

        // Touch events have implicit capture
        if (e.type === "mousedown") {
            setCapture(handle);
        }

        UI.controlbarGrabbed = true;
        UI.controlbarDrag = false;

        UI.showControlbarHint(true);

        UI.controlbarMouseDownClientY = ptr.clientY;
        UI.controlbarMouseDownOffsetY = ptr.clientY - bounds.top;
        e.preventDefault();
        e.stopPropagation();
        UI.keepControlbar();
        UI.activateControlbar();
    },

    toggleExpander(e) {
        if (this.classList.contains("noVNC_open")) {
            this.classList.remove("noVNC_open");
        } else {
            this.classList.add("noVNC_open");
        }
    },

    /* ------^-------
     *    /VISUAL
     * ==============
     *    SETTINGS
     * ------v------*/

    // Initial page load read/initialization of settings
    initSetting(name, defVal) {
        // Has the user overridden the default value?
        if (name in UI.customSettings.defaults) {
            defVal = UI.customSettings.defaults[name];
        }
        // Check Query string followed by cookie
        let val = WebUtil.getConfigVar(name);
        if (val === null) {
            val = WebUtil.readSetting(name, defVal);
        }
        WebUtil.setSetting(name, val);
        UI.updateSetting(name);
        // Has the user forced a value?
        if (name in UI.customSettings.mandatory) {
            val = UI.customSettings.mandatory[name];
            UI.forceSetting(name, val);
        }
        return val;
    },

    // Set the new value, update and disable form control setting
    forceSetting(name, val) {
        WebUtil.setSetting(name, val);
        UI.updateSetting(name);
        UI.disableSetting(name);
    },

    // Update cookie and form control setting. If value is not set, then
    // updates from control to current cookie setting.
    updateSetting(name) {

        // Update the settings control
        let value = UI.getSetting(name);

        const ctrl = document.getElementById('noVNC_setting_' + name);
        if (ctrl === null) {
            return;
        }

        if (ctrl.type === 'checkbox') {
            ctrl.checked = value;
        } else if (typeof ctrl.options !== 'undefined') {
            for (let i = 0; i < ctrl.options.length; i += 1) {
                if (ctrl.options[i].value === value) {
                    ctrl.selectedIndex = i;
                    break;
                }
            }
        } else {
            ctrl.value = value;
        }
    },

    // Save control setting to cookie
    saveSetting(name) {
        const ctrl = document.getElementById('noVNC_setting_' + name);
        let val;
        if (ctrl.type === 'checkbox') {
            val = ctrl.checked;
        } else if (typeof ctrl.options !== 'undefined') {
            val = ctrl.options[ctrl.selectedIndex].value;
        } else {
            val = ctrl.value;
        }
        WebUtil.writeSetting(name, val);
        //Log.Debug("Setting saved '" + name + "=" + val + "'");
        return val;
    },

    // Read form control compatible setting from cookie
    getSetting(name) {
        const ctrl = document.getElementById('noVNC_setting_' + name);
        let val = WebUtil.readSetting(name);
        if (typeof val !== 'undefined' && val !== null &&
            ctrl !== null && ctrl.type === 'checkbox') {
            if (val.toString().toLowerCase() in { '0': 1, 'no': 1, 'false': 1 }) {
                val = false;
            } else {
                val = true;
            }
        }
        return val;
    },

    // These helpers compensate for the lack of parent-selectors and
    // previous-sibling-selectors in CSS which are needed when we want to
    // disable the labels that belong to disabled input elements.
    disableSetting(name) {
        const ctrl = document.getElementById('noVNC_setting_' + name);
        if (ctrl !== null) {
            ctrl.disabled = true;
            if (ctrl.label !== undefined) {
                ctrl.label.classList.add('noVNC_disabled');
            }
        }
    },

    enableSetting(name) {
        const ctrl = document.getElementById('noVNC_setting_' + name);
        if (ctrl !== null) {
            ctrl.disabled = false;
            if (ctrl.label !== undefined) {
                ctrl.label.classList.remove('noVNC_disabled');
            }
        }
    },

    /* ------^-------
     *   /SETTINGS
     * ==============
     *    PANELS
     * ------v------*/

    closeAllPanels() {
        UI.closeSettingsPanel();
        UI.closePowerPanel();
        UI.closeClipboardPanel();
        UI.closeExtraKeys();
        UI.closeAudioPanel();
        UI.closeIMEPanel();
    },

    /* ------^-------
     *   /PANELS
     * ==============
     * SETTINGS (panel)
     * ------v------*/

    openSettingsPanel() {
        UI.closeAllPanels();
        UI.openControlbar();

        // Refresh UI elements from saved cookies
        UI.updateSetting('encrypt');
        UI.updateSetting('view_clip');
        UI.updateSetting('resize');
        UI.updateSetting('quality');
        UI.updateSetting('compression');
        UI.updateSetting('shared');
        UI.updateSetting('view_only');
        UI.updateSetting('path');
        UI.updateSetting('repeaterID');
        UI.updateSetting('logging');
        UI.updateSetting('reconnect');
        UI.updateSetting('reconnect_delay');

        document.getElementById('noVNC_settings')
            .classList.add("noVNC_open");
        document.getElementById('noVNC_settings_button')
            .classList.add("noVNC_selected");
    },

    closeSettingsPanel() {
        document.getElementById('noVNC_settings')
            .classList.remove("noVNC_open");
        document.getElementById('noVNC_settings_button')
            .classList.remove("noVNC_selected");
    },

    toggleSettingsPanel() {
        if (document.getElementById('noVNC_settings')
            .classList.contains("noVNC_open")) {
            UI.closeSettingsPanel();
        } else {
            UI.openSettingsPanel();
        }
    },

    /* ------^-------
     *   /SETTINGS
     * ==============
     *     POWER
     * ------v------*/

    openPowerPanel() {
        UI.closeAllPanels();
        UI.openControlbar();

        document.getElementById('noVNC_power')
            .classList.add("noVNC_open");
        document.getElementById('noVNC_power_button')
            .classList.add("noVNC_selected");
    },

    closePowerPanel() {
        document.getElementById('noVNC_power')
            .classList.remove("noVNC_open");
        document.getElementById('noVNC_power_button')
            .classList.remove("noVNC_selected");
    },

    togglePowerPanel() {
        if (document.getElementById('noVNC_power')
            .classList.contains("noVNC_open")) {
            UI.closePowerPanel();
        } else {
            UI.openPowerPanel();
        }
    },

    // Disable/enable power button
    updatePowerButton() {
        if (UI.connected &&
            UI.rfb.capabilities.power &&
            !UI.rfb.viewOnly) {
            document.getElementById('noVNC_power_button')
                .classList.remove("noVNC_hidden");
        } else {
            document.getElementById('noVNC_power_button')
                .classList.add("noVNC_hidden");
            // Close power panel if open
            UI.closePowerPanel();
        }
    },

    /* ------^-------
     *    /POWER
     * ==============
     *   CLIPBOARD
     * ------v------*/

    openClipboardPanel() {
        UI.closeAllPanels();
        UI.openControlbar();

        document.getElementById('noVNC_clipboard')
            .classList.add("noVNC_open");
        document.getElementById('noVNC_clipboard_button')
            .classList.add("noVNC_selected");
    },

    closeClipboardPanel() {
        document.getElementById('noVNC_clipboard')
            .classList.remove("noVNC_open");
        document.getElementById('noVNC_clipboard_button')
            .classList.remove("noVNC_selected");
    },

    toggleClipboardPanel() {
        if (document.getElementById('noVNC_clipboard')
            .classList.contains("noVNC_open")) {
            UI.closeClipboardPanel();
        } else {
            UI.openClipboardPanel();
        }
    },

    /**
     * 接收远程剪贴板内容
     * 当远程桌面剪贴板变化时触发
     */
    clipboardReceive(e) {
        Log.Debug(">> UI.clipboardReceive: " + e.detail.text.substr(0, 40) + "...");
        document.getElementById('noVNC_clipboard_text').value = e.detail.text;

        // 如果开启了自动同步，将远程内容同步到本地剪贴板
        clipboardManager.handleRemoteText(e.detail.text);

        Log.Debug("<< UI.clipboardReceive");
    },

    /**
     * 发送剪贴板内容到远程
     */
    clipboardSend() {
        const text = document.getElementById('noVNC_clipboard_text').value;
        Log.Debug(">> UI.clipboardSend: " + text.substr(0, 40) + "...");
        clipboardManager.sendToRemote(text);
        Log.Debug("<< UI.clipboardSend");
    },

    /**
     * 切换剪贴板自动同步
     */
    async toggleClipboardAutoSync() {
        const checkbox = document.getElementById('noVNC_clipboard_auto_sync');
        const enabled = checkbox.checked;

        // 调用管理器切换状态
        const finalState = await clipboardManager.toggleAutoSync(enabled);

        // 确保 UI 状态与实际状态一致
        if (checkbox.checked !== finalState) {
            checkbox.checked = finalState;
        }
    },

    /**
     * 根据权限初始化剪贴板自动同步
     */
    async initClipboard() {
        const checkbox = document.getElementById('noVNC_clipboard_auto_sync');
        await clipboardManager.init();
        checkbox.checked = clipboardManager.autoSync;
    },

    /**
     * 开始剪贴板同步
     * 监听页面焦点事件，当页面获得焦点时检查本地剪贴板
     */
    async clipboardCopyToLocal() {
        const text = document.getElementById('noVNC_clipboard_text').value;
        await clipboardManager.writeLocal(text);
    },

    /**
     * 更新剪贴板同步状态显示
     * @param {string} status 状态类型: 'active', 'inactive', 'success', 'error'
     * @param {string} message 状态消息
     */
    updateClipboardSyncStatus(status, message) {
        const statusElement = document.getElementById('noVNC_clipboard_sync_status');
        const dotElement = statusElement.querySelector('.noVNC_sync_status_dot');
        const textElement = statusElement.querySelector('.noVNC_sync_status_text');

        // 移除所有状态类
        dotElement.classList.remove('active', 'inactive', 'success', 'error');

        // 添加新状态类
        dotElement.classList.add(status);
        textElement.textContent = message;

        // 根据状态显示或隐藏
        if (message) {
            statusElement.style.display = 'flex';
        } else {
            statusElement.style.display = 'none';
        }
    },

    /* ------^-------
     *  /CLIPBOARD
     * ==============
     *  CONNECTION
     * ------v------*/

    openConnectPanel() {
        document.getElementById('noVNC_connect_dlg')
            .classList.add("noVNC_open");
    },

    closeConnectPanel() {
        document.getElementById('noVNC_connect_dlg')
            .classList.remove("noVNC_open");
    },

    connect(event, password) {

        // Ignore when rfb already exists
        if (typeof UI.rfb !== 'undefined') {
            return;
        }

        const host = UI.getSetting('host');
        const port = UI.getSetting('port');
        const path = UI.getSetting('path');

        if (typeof password === 'undefined') {
            password = UI.getSetting('password');
            UI.reconnectPassword = password;
        }

        if (password === null) {
            password = undefined;
        }

        UI.hideStatus();

        UI.closeConnectPanel();

        UI.updateVisualState('connecting');

        let url;

        if (host) {
            url = new URL("https://" + host);

            url.protocol = UI.getSetting('encrypt') ? 'wss:' : 'ws:';
            if (port) {
                url.port = port;
            }

            // "./" is needed to force URL() to interpret the path-variable as
            // a path and not as an URL. This is relevant if for example path
            // starts with more than one "/", in which case it would be
            // interpreted as a host name instead.
            url = new URL("./" + path, url);
        } else {
            // Current (May 2024) browsers support relative WebSocket
            // URLs natively, but we need to support older browsers for
            // some time.
            url = new URL(path, location.href);
            url.protocol = (window.location.protocol === "https:") ? 'wss:' : 'ws:';
        }

        try {
            UI.rfb = new RFB(document.getElementById('noVNC_container'),
                url.href,
                {
                    shared: UI.getSetting('shared'),
                    repeaterID: UI.getSetting('repeaterID'),
                    credentials: { password: password }
                });
        } catch (exc) {
            Log.Error("Failed to connect to server: " + exc);
            UI.updateVisualState('disconnected');
            UI.showStatus(_("Failed to connect to server: ") + exc, 'error');
            // 通知父级 iframe 连接失败
            window.parent.postMessage({ type: 'vnc_connection_failed', msg: 'Failed to connect to server: ' + exc }, '*');
            return;
        }

        // 设置 RFB 实例到剪贴板管理器
        clipboardManager.setRFB(UI.rfb);

        UI.rfb.addEventListener("connect", UI.connectFinished);
        UI.rfb.addEventListener("disconnect", UI.disconnectFinished);
        UI.rfb.addEventListener("audioiconclick", UI.toggleAudio);
        UI.rfb.addEventListener("serververification", UI.serverVerify);
        UI.rfb.addEventListener("credentialsrequired", UI.credentials);
        UI.rfb.addEventListener("securityfailure", UI.securityFailed);
        UI.rfb.addEventListener("clippingviewport", UI.updateViewDrag);
        UI.rfb.addEventListener("capabilities", UI.updatePowerButton);
        UI.rfb.addEventListener("clipboard", UI.clipboardReceive);
        UI.rfb.addEventListener("bell", UI.bell);
        UI.rfb.addEventListener("desktopname", UI.updateDesktopName);
        UI.rfb.clipViewport = UI.getSetting('view_clip');
        UI.rfb.scaleViewport = UI.getSetting('resize') === 'scale';
        UI.rfb.resizeSession = UI.getSetting('resize') === 'remote';
        UI.rfb.qualityLevel = parseInt(UI.getSetting('quality'));
        UI.rfb.compressionLevel = parseInt(UI.getSetting('compression'));
        UI.rfb.showDotCursor = UI.getSetting('show_dot');

        UI.updateViewOnly(); // requires UI.rfb
    },

    disconnect() {
        UI.rfb.disconnect();

        UI.connected = false;

        // Disable automatic reconnecting
        UI.inhibitReconnect = true;

        UI.updateVisualState('disconnecting');

        // Don't display the connection settings until we're actually disconnected
    },

    reconnect() {
        UI.reconnectCallback = null;

        // if reconnect has been disabled in the meantime, do nothing.
        if (UI.inhibitReconnect) {
            return;
        }

        UI.connect(null, UI.reconnectPassword);
    },

    cancelReconnect() {
        if (UI.reconnectCallback !== null) {
            clearTimeout(UI.reconnectCallback);
            UI.reconnectCallback = null;
        }

        UI.updateVisualState('disconnected');

        UI.openControlbar();
        UI.openConnectPanel();
    },

    connectFinished(e) {
        UI.connected = true;
        UI.inhibitReconnect = false;

        // let msg;
        // if (UI.getSetting('encrypt')) {
        //     msg = _("Connected (encrypted) to ") + UI.desktopName;
        // } else {
        //     msg = _("Connected (unencrypted) to ") + UI.desktopName;
        // }
        // UI.showStatus(msg);
        UI.updateVisualState('connected');

        // 通知父级 iframe 连接成功
        window.parent.postMessage({ type: 'vnc_connected', msg: 'Connected to server' }, '*');

        // 启动心跳保活定时器
        UI.startKeepalive();

        // 自动启动音频和输入法
        UI.autoStartAudioIME();

        // 自动启动文件传输
        UI.autoStartFileTransfer();

        // 如果剪贴板自动同步开关是开启的，恢复同步
        // clipboardManager 已自动处理


        // Do this last because it can only be used on rendered elements
        UI.rfb.focus();
    },

    // 启动心跳保活
    startKeepalive() {
        UI.stopKeepalive();
        UI.keepaliveInterval = setInterval(() => {
            if (UI.rfb && UI.connected) {
                // 发送一个 FramebufferUpdateRequest 来保持连接
                // 这不会影响远程桌面，但会保持 WebSocket 连接活跃
                Log.Info('[VNC] Sending keepalive...');
                try {
                    // 使用 Websock 的正确 API 发送数据
                    if (UI.rfb._sock && UI.rfb._sock.readyState === 'open') {
                        // FramebufferUpdateRequest: msgType=3, incremental=1, x=0, y=0, w=1, h=1
                        // 请求一个 1x1 像素的增量更新作为保活
                        UI.rfb._sock.sQpush8(3);     // message type: FramebufferUpdateRequest
                        UI.rfb._sock.sQpush8(1);     // incremental
                        UI.rfb._sock.sQpush16(0);    // x-position
                        UI.rfb._sock.sQpush16(0);    // y-position
                        UI.rfb._sock.sQpush16(1);    // width
                        UI.rfb._sock.sQpush16(1);    // height
                        UI.rfb._sock.flush();
                        Log.Info('[VNC] Keepalive sent successfully');
                    } else {
                        Log.Info('[VNC] Socket not open, readyState:', UI.rfb._sock?.readyState);
                    }
                } catch (err) {
                    Log.Warn('[VNC] Keepalive failed:', err);
                }
            }
        }, UI.keepaliveIntervalMs);
        Log.Info('[VNC] Keepalive started, interval:', UI.keepaliveIntervalMs, 'ms');
    },

    // 停止心跳保活
    stopKeepalive() {
        if (UI.keepaliveInterval) {
            clearInterval(UI.keepaliveInterval);
            UI.keepaliveInterval = null;
            Log.Info('[VNC] Keepalive stopped');
        }
    },

    disconnectFinished(e) {
        if (e.detail.reason === 'Share expired') {
            window.parent.postMessage({ type: 'vnc_share_expired', msg: 'Share expired' }, '*');
        }

        const wasConnected = UI.connected;

        // 停止心跳保活
        UI.stopKeepalive();

        // 停止音频和输入法
        UI.stopAudioIME();

        // 停止文件传输
        fileManager.disconnect();

        // 停止剪贴板同步（但保留开关状态，重连时会自动恢复）
        clipboardManager.setRFB(null);

        // This variable is ideally set when disconnection starts, but
        // when the disconnection isn't clean or if it is initiated by
        // the server, we need to do it here as well since
        // UI.disconnect() won't be used in those cases.
        UI.connected = false;

        UI.rfb = undefined;

        if (!e.detail.clean) {
            UI.updateVisualState('disconnected');
            if (wasConnected) {
                UI.showStatus(_("Something went wrong, connection is closed"),
                    'error');
                // 通知父级 iframe 连接断开
                window.parent.postMessage({ type: 'vnc_connection_closed', msg: 'Something went wrong, connection is closed' }, '*');
            } else {
                UI.showStatus(_("Failed to connect to server"), 'error');
                // 通知父级 iframe 连接失败
                window.parent.postMessage({ type: 'vnc_connection_failed', msg: 'Failed to connect to server' }, '*');
            }
        }
        // If reconnecting is allowed process it now
        if (UI.getSetting('reconnect', false) === true && !UI.inhibitReconnect) {
            UI.updateVisualState('reconnecting');

            const delay = parseInt(UI.getSetting('reconnect_delay'));
            UI.reconnectCallback = setTimeout(UI.reconnect, delay);
            return;
        } else {
            UI.updateVisualState('disconnected');
            UI.showStatus(_("Disconnected"), 'normal');
        }

        document.title = PAGE_TITLE;

        UI.openControlbar();
        UI.openConnectPanel();
    },

    securityFailed(e) {
        let msg = "";
        // On security failures we might get a string with a reason
        // directly from the server. Note that we can't control if
        // this string is translated or not.
        if ('reason' in e.detail) {
            msg = _("New connection has been rejected with reason: ") +
                e.detail.reason;
        } else {
            msg = _("New connection has been rejected");
        }
        UI.showStatus(msg, 'error');
    },

    /* ------^-------
     *  /CONNECTION
     * ==============
     * SERVER VERIFY
     * ------v------*/

    async serverVerify(e) {
        const type = e.detail.type;
        if (type === 'RSA') {
            const publickey = e.detail.publickey;
            let fingerprint = await window.crypto.subtle.digest("SHA-1", publickey);
            // The same fingerprint format as RealVNC
            fingerprint = Array.from(new Uint8Array(fingerprint).slice(0, 8)).map(
                x => x.toString(16).padStart(2, '0')).join('-');
            document.getElementById('noVNC_verify_server_dlg').classList.add('noVNC_open');
            document.getElementById('noVNC_fingerprint').innerHTML = fingerprint;
        }
    },

    approveServer(e) {
        e.preventDefault();
        document.getElementById('noVNC_verify_server_dlg').classList.remove('noVNC_open');
        UI.rfb.approveServer();
    },

    rejectServer(e) {
        e.preventDefault();
        document.getElementById('noVNC_verify_server_dlg').classList.remove('noVNC_open');
        UI.disconnect();
    },

    /* ------^-------
     * /SERVER VERIFY
     * ==============
     *   PASSWORD
     * ------v------*/

    credentials(e) {
        // FIXME: handle more types

        document.getElementById("noVNC_username_block").classList.remove("noVNC_hidden");
        document.getElementById("noVNC_password_block").classList.remove("noVNC_hidden");

        let inputFocus = "none";
        if (e.detail.types.indexOf("username") === -1) {
            document.getElementById("noVNC_username_block").classList.add("noVNC_hidden");
        } else {
            inputFocus = inputFocus === "none" ? "noVNC_username_input" : inputFocus;
        }
        if (e.detail.types.indexOf("password") === -1) {
            document.getElementById("noVNC_password_block").classList.add("noVNC_hidden");
        } else {
            inputFocus = inputFocus === "none" ? "noVNC_password_input" : inputFocus;
        }
        document.getElementById('noVNC_credentials_dlg')
            .classList.add('noVNC_open');

        setTimeout(() => document
            .getElementById(inputFocus).focus(), 100);

        Log.Warn("Server asked for credentials");
        UI.showStatus(_("Credentials are required"), "warning");
    },

    setCredentials(e) {
        // Prevent actually submitting the form
        e.preventDefault();

        let inputElemUsername = document.getElementById('noVNC_username_input');
        const username = inputElemUsername.value;

        let inputElemPassword = document.getElementById('noVNC_password_input');
        const password = inputElemPassword.value;
        // Clear the input after reading the password
        inputElemPassword.value = "";

        UI.rfb.sendCredentials({ username: username, password: password });
        UI.reconnectPassword = password;
        document.getElementById('noVNC_credentials_dlg')
            .classList.remove('noVNC_open');
    },

    /* ------^-------
     *  /PASSWORD
     * ==============
     *   FULLSCREEN
     * ------v------*/

    toggleFullscreen() {
        if (document.fullscreenElement || // alternative standard method
            document.mozFullScreenElement || // currently working methods
            document.webkitFullscreenElement ||
            document.msFullscreenElement) {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.mozCancelFullScreen) {
                document.mozCancelFullScreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }
        } else {
            if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen();
            } else if (document.documentElement.mozRequestFullScreen) {
                document.documentElement.mozRequestFullScreen();
            } else if (document.documentElement.webkitRequestFullscreen) {
                document.documentElement.webkitRequestFullscreen(Element.ALLOW_KEYBOARD_INPUT);
            } else if (document.body.msRequestFullscreen) {
                document.body.msRequestFullscreen();
            }
        }
        UI.updateFullscreenButton();
    },

    updateFullscreenButton() {
        if (document.fullscreenElement || // alternative standard method
            document.mozFullScreenElement || // currently working methods
            document.webkitFullscreenElement ||
            document.msFullscreenElement) {
            document.getElementById('noVNC_fullscreen_button')
                .classList.add("noVNC_selected");
        } else {
            document.getElementById('noVNC_fullscreen_button')
                .classList.remove("noVNC_selected");
        }
    },

    /* ------^-------
     *  /FULLSCREEN
     * ==============
     *     RESIZE
     * ------v------*/

    // Apply remote resizing or local scaling
    applyResizeMode() {
        if (!UI.rfb) return;

        UI.rfb.scaleViewport = UI.getSetting('resize') === 'scale';
        UI.rfb.resizeSession = UI.getSetting('resize') === 'remote';
    },

    /* ------^-------
     *    /RESIZE
     * ==============
     * VIEW CLIPPING
     * ------v------*/

    // Update viewport clipping property for the connection. The normal
    // case is to get the value from the setting. There are special cases
    // for when the viewport is scaled or when a touch device is used.
    updateViewClip() {
        if (!UI.rfb) return;

        const scaling = UI.getSetting('resize') === 'scale';

        // Some platforms have overlay scrollbars that are difficult
        // to use in our case, which means we have to force panning
        // FIXME: Working scrollbars can still be annoying to use with
        //        touch, so we should ideally be able to have both
        //        panning and scrollbars at the same time

        let brokenScrollbars = false;

        if (!hasScrollbarGutter) {
            if (isIOS() || isAndroid() || isMac() || isChromeOS()) {
                brokenScrollbars = true;
            }
        }

        if (scaling) {
            // Can't be clipping if viewport is scaled to fit
            UI.forceSetting('view_clip', false);
            UI.rfb.clipViewport = false;
        } else if (brokenScrollbars) {
            UI.forceSetting('view_clip', true);
            UI.rfb.clipViewport = true;
        } else {
            UI.enableSetting('view_clip');
            UI.rfb.clipViewport = UI.getSetting('view_clip');
        }

        // Changing the viewport may change the state of
        // the dragging button
        UI.updateViewDrag();
    },

    /* ------^-------
     * /VIEW CLIPPING
     * ==============
     *    VIEWDRAG
     * ------v------*/

    toggleViewDrag() {
        if (!UI.rfb) return;

        UI.rfb.dragViewport = !UI.rfb.dragViewport;
        UI.updateViewDrag();
    },

    updateViewDrag() {
        if (!UI.connected) return;

        const viewDragButton = document.getElementById('noVNC_view_drag_button');

        if ((!UI.rfb.clipViewport || !UI.rfb.clippingViewport) &&
            UI.rfb.dragViewport) {
            // We are no longer clipping the viewport. Make sure
            // viewport drag isn't active when it can't be used.
            UI.rfb.dragViewport = false;
        }

        if (UI.rfb.dragViewport) {
            viewDragButton.classList.add("noVNC_selected");
        } else {
            viewDragButton.classList.remove("noVNC_selected");
        }

        if (UI.rfb.clipViewport) {
            viewDragButton.classList.remove("noVNC_hidden");
        } else {
            viewDragButton.classList.add("noVNC_hidden");
        }

        viewDragButton.disabled = !UI.rfb.clippingViewport;
    },

    /* ------^-------
     *   /VIEWDRAG
     * ==============
     *    QUALITY
     * ------v------*/

    updateQuality() {
        if (!UI.rfb) return;

        UI.rfb.qualityLevel = parseInt(UI.getSetting('quality'));
    },

    /* ------^-------
     *   /QUALITY
     * ==============
     *  COMPRESSION
     * ------v------*/

    updateCompression() {
        if (!UI.rfb) return;

        UI.rfb.compressionLevel = parseInt(UI.getSetting('compression'));
    },

    /* ------^-------
     *  /COMPRESSION
     * ==============
     *    KEYBOARD
     * ------v------*/

    showVirtualKeyboard() {
        if (!isTouchDevice) return;

        const input = document.getElementById('noVNC_keyboardinput');

        if (document.activeElement == input) return;

        input.focus();

        try {
            const l = input.value.length;
            // Move the caret to the end
            input.setSelectionRange(l, l);
        } catch (err) {
            // setSelectionRange is undefined in Google Chrome
        }
    },

    hideVirtualKeyboard() {
        if (!isTouchDevice) return;

        const input = document.getElementById('noVNC_keyboardinput');

        if (document.activeElement != input) return;

        input.blur();
    },

    toggleVirtualKeyboard() {
        if (document.getElementById('noVNC_keyboard_button')
            .classList.contains("noVNC_selected")) {
            UI.hideVirtualKeyboard();
        } else {
            UI.showVirtualKeyboard();
        }
    },

    onfocusVirtualKeyboard(event) {
        document.getElementById('noVNC_keyboard_button')
            .classList.add("noVNC_selected");
        if (UI.rfb) {
            UI.rfb.focusOnClick = false;
        }
    },

    onblurVirtualKeyboard(event) {
        document.getElementById('noVNC_keyboard_button')
            .classList.remove("noVNC_selected");
        if (UI.rfb) {
            UI.rfb.focusOnClick = true;
        }
    },

    keepVirtualKeyboard(event) {
        const input = document.getElementById('noVNC_keyboardinput');

        // Only prevent focus change if the virtual keyboard is active
        if (document.activeElement != input) {
            return;
        }

        // Only allow focus to move to other elements that need
        // focus to function properly
        if (event.target.form !== undefined) {
            switch (event.target.type) {
                case 'text':
                case 'email':
                case 'search':
                case 'password':
                case 'tel':
                case 'url':
                case 'textarea':
                case 'select-one':
                case 'select-multiple':
                    return;
            }
        }

        event.preventDefault();
    },

    keyboardinputReset() {
        const kbi = document.getElementById('noVNC_keyboardinput');
        kbi.value = new Array(UI.defaultKeyboardinputLen).join("_");
        UI.lastKeyboardinput = kbi.value;
    },

    keyEvent(keysym, code, down) {
        if (!UI.rfb) return;

        UI.rfb.sendKey(keysym, code, down);
    },

    // When normal keyboard events are left uncought, use the input events from
    // the keyboardinput element instead and generate the corresponding key events.
    // This code is required since some browsers on Android are inconsistent in
    // sending keyCodes in the normal keyboard events when using on screen keyboards.
    keyInput(event) {

        if (!UI.rfb) return;

        const newValue = event.target.value;

        if (!UI.lastKeyboardinput) {
            UI.keyboardinputReset();
        }
        const oldValue = UI.lastKeyboardinput;

        let newLen;
        try {
            // Try to check caret position since whitespace at the end
            // will not be considered by value.length in some browsers
            newLen = Math.max(event.target.selectionStart, newValue.length);
        } catch (err) {
            // selectionStart is undefined in Google Chrome
            newLen = newValue.length;
        }
        const oldLen = oldValue.length;

        let inputs = newLen - oldLen;
        let backspaces = inputs < 0 ? -inputs : 0;

        // Compare the old string with the new to account for
        // text-corrections or other input that modify existing text
        for (let i = 0; i < Math.min(oldLen, newLen); i++) {
            if (newValue.charAt(i) != oldValue.charAt(i)) {
                inputs = newLen - i;
                backspaces = oldLen - i;
                break;
            }
        }

        // Send the key events
        for (let i = 0; i < backspaces; i++) {
            UI.rfb.sendKey(KeyTable.XK_BackSpace, "Backspace");
        }
        for (let i = newLen - inputs; i < newLen; i++) {
            UI.rfb.sendKey(keysyms.lookup(newValue.charCodeAt(i)));
        }

        // Control the text content length in the keyboardinput element
        if (newLen > 2 * UI.defaultKeyboardinputLen) {
            UI.keyboardinputReset();
        } else if (newLen < 1) {
            // There always have to be some text in the keyboardinput
            // element with which backspace can interact.
            UI.keyboardinputReset();
            // This sometimes causes the keyboard to disappear for a second
            // but it is required for the android keyboard to recognize that
            // text has been added to the field
            event.target.blur();
            // This has to be ran outside of the input handler in order to work
            setTimeout(event.target.focus.bind(event.target), 0);
        } else {
            UI.lastKeyboardinput = newValue;
        }
    },

    /* ------^-------
     *   /KEYBOARD
     * ==============
     *   EXTRA KEYS
     * ------v------*/

    openExtraKeys() {
        UI.closeAllPanels();
        UI.openControlbar();

        document.getElementById('noVNC_modifiers')
            .classList.add("noVNC_open");
        document.getElementById('noVNC_toggle_extra_keys_button')
            .classList.add("noVNC_selected");
    },

    closeExtraKeys() {
        document.getElementById('noVNC_modifiers')
            .classList.remove("noVNC_open");
        document.getElementById('noVNC_toggle_extra_keys_button')
            .classList.remove("noVNC_selected");
    },

    toggleExtraKeys() {
        if (document.getElementById('noVNC_modifiers')
            .classList.contains("noVNC_open")) {
            UI.closeExtraKeys();
        } else {
            UI.openExtraKeys();
        }
    },

    sendEsc() {
        UI.sendKey(KeyTable.XK_Escape, "Escape");
    },

    sendTab() {
        UI.sendKey(KeyTable.XK_Tab, "Tab");
    },

    toggleCtrl() {
        const btn = document.getElementById('noVNC_toggle_ctrl_button');
        if (btn.classList.contains("noVNC_selected")) {
            UI.sendKey(KeyTable.XK_Control_L, "ControlLeft", false);
            btn.classList.remove("noVNC_selected");
        } else {
            UI.sendKey(KeyTable.XK_Control_L, "ControlLeft", true);
            btn.classList.add("noVNC_selected");
        }
    },

    toggleWindows() {
        const btn = document.getElementById('noVNC_toggle_windows_button');
        if (btn.classList.contains("noVNC_selected")) {
            UI.sendKey(KeyTable.XK_Super_L, "MetaLeft", false);
            btn.classList.remove("noVNC_selected");
        } else {
            UI.sendKey(KeyTable.XK_Super_L, "MetaLeft", true);
            btn.classList.add("noVNC_selected");
        }
    },

    toggleAlt() {
        const btn = document.getElementById('noVNC_toggle_alt_button');
        if (btn.classList.contains("noVNC_selected")) {
            UI.sendKey(KeyTable.XK_Alt_L, "AltLeft", false);
            btn.classList.remove("noVNC_selected");
        } else {
            UI.sendKey(KeyTable.XK_Alt_L, "AltLeft", true);
            btn.classList.add("noVNC_selected");
        }
    },

    sendCtrlAltDel() {
        UI.rfb.sendCtrlAltDel();
        // See below
        UI.rfb.focus();
        UI.idleControlbar();
    },

    sendKey(keysym, code, down) {
        UI.rfb.sendKey(keysym, code, down);

        // Move focus to the screen in order to be able to use the
        // keyboard right after these extra keys.
        // The exception is when a virtual keyboard is used, because
        // if we focus the screen the virtual keyboard would be closed.
        // In this case we focus our special virtual keyboard input
        // element instead.
        if (document.getElementById('noVNC_keyboard_button')
            .classList.contains("noVNC_selected")) {
            document.getElementById('noVNC_keyboardinput').focus();
        } else {
            UI.rfb.focus();
        }
        // fade out the controlbar to highlight that
        // the focus has been moved to the screen
        UI.idleControlbar();
    },

    /* ------^-------
     *   /EXTRA KEYS
     * ==============
     *     MISC
     * ------v------*/

    updateViewOnly() {
        if (!UI.rfb) return;
        UI.rfb.viewOnly = UI.getSetting('view_only');

        // Hide input related buttons in view only mode
        if (UI.rfb.viewOnly) {
            document.getElementById('noVNC_keyboard_button')
                .classList.add('noVNC_hidden');
            document.getElementById('noVNC_toggle_extra_keys_button')
                .classList.add('noVNC_hidden');
            document.getElementById('noVNC_clipboard_button')
                .classList.add('noVNC_hidden');
        } else {
            document.getElementById('noVNC_keyboard_button')
                .classList.remove('noVNC_hidden');
            document.getElementById('noVNC_toggle_extra_keys_button')
                .classList.remove('noVNC_hidden');
            document.getElementById('noVNC_clipboard_button')
                .classList.remove('noVNC_hidden');
        }
    },

    updateShowDotCursor() {
        if (!UI.rfb) return;
        UI.rfb.showDotCursor = UI.getSetting('show_dot');
    },

    updateLogging() {
        WebUtil.initLogging(UI.getSetting('logging'));
    },

    updateDesktopName(e) {
        UI.desktopName = e.detail.name;
        // Display the desktop name in the document title
        document.title = e.detail.name + " - " + PAGE_TITLE;
    },

    bell(e) {
        if (UI.getSetting('bell') === 'on') {
            const promise = document.getElementById('noVNC_bell').play();
            // The standards disagree on the return value here
            if (promise) {
                promise.catch((e) => {
                    if (e.name === "NotAllowedError") {
                        // Ignore when the browser doesn't let us play audio.
                        // It is common that the browsers require audio to be
                        // initiated from a user action.
                    } else {
                        Log.Error("Unable to play bell: " + e);
                    }
                });
            }
        }
    },

    //Helper to add options to dropdown.
    addOption(selectbox, text, value) {
        const optn = document.createElement("OPTION");
        optn.text = text;
        optn.value = value;
        selectbox.options.add(optn);
    },

    /* ------^-------
     *    /MISC
     * ==============
     *  AUDIO & IME
     * ------v------*/

    /**
     * 初始化音频和输入法参数
     * 从 URL 参数中获取 user_id, project_id, base_url
     * 
     * 正式模式: /computer/audio/{project_id}/ws
     * 调试模式: /computer/audio/{user_id}/{project_id}/ws (需要 debug=true 或 user_id 参数)
     */
    initAudioIMEParams() {
        // 从 URL 参数获取
        UI.userId = WebUtil.getConfigVar('user_id');
        UI.projectId = WebUtil.getConfigVar('project_id');

        // 检测调试模式：URL 参数 debug=true 或者明确传递了 user_id
        const debugParam = WebUtil.getConfigVar('debug');
        UI.debugMode = (debugParam === 'true' || debugParam === '1') || !!UI.userId;

        // 计算基础 URL（从当前页面 URL 推断）
        const currentUrl = new URL(window.location.href);
        // 如果路径包含 /computer/vnc/，则提取基础 URL
        const pathMatch = currentUrl.pathname.match(/^(.*?)\/computer\/vnc\//);
        if (pathMatch) {
            UI.baseUrl = `${currentUrl.protocol}//${currentUrl.host}${pathMatch[1] || ''}`;

            // 从路径中提取 project_id（如果 URL 参数未提供）
            // 路径格式: /computer/vnc/{user_id}/{project_id}/vnc.html 或 /computer/vnc/{project_id}/vnc.html
            if (!UI.projectId) {
                const pathParts = currentUrl.pathname.replace(pathMatch[0], '').split('/');
                if (pathParts.length >= 2 && pathParts[1]) {
                    // 调试模式路径: {user_id}/{project_id}/vnc.html
                    UI.projectId = pathParts[1];
                    if (!UI.userId) {
                        UI.userId = pathParts[0];
                        UI.debugMode = true;
                    }
                } else if (pathParts.length >= 1 && pathParts[0]) {
                    // 正式模式路径: {project_id}/vnc.html
                    UI.projectId = pathParts[0];
                }
            }
        } else {
            // 尝试从 URL 参数获取
            UI.baseUrl = WebUtil.getConfigVar('base_url') || `${currentUrl.protocol}//${currentUrl.host}`;
        }

        // 尝试从 path 参数中提取 project_id 和 user_id (针对 LOCAL_DEV 场景)
        if (!UI.projectId) {
            const path = WebUtil.getConfigVar('path');
            if (path) {
                const match = path.match(/computer\/vnc\/([^\/]+)\/([^\/]+)\/websockify/);
                if (match) {
                    // match[1] 是 userId
                    // match[2] 是 projectId

                    if (!UI.userId) {
                        UI.userId = match[1];
                    }

                    // 特殊逻辑：如果提取到的 projectId 是 "666" (硬编码占位符)，
                    // 并且我们有 userId，则使用 userId 作为 projectId
                    const extractedProjectId = match[2];
                    if (extractedProjectId === '666' && UI.userId) {
                        UI.projectId = UI.userId;
                    } else {
                        UI.projectId = extractedProjectId;
                    }

                    // 如果提取到了 user_id，确保启用调试模式
                    if (UI.userId) {
                        UI.debugMode = true;
                    }
                }
            }
        }

        Log.Info('[Audio/IME] 参数初始化: projectId=' + UI.projectId + ', userId=' + UI.userId + ', baseUrl=' + UI.baseUrl + ', debugMode=' + UI.debugMode);

        // 如果有 project_id，显示音频和输入法按钮
        if (UI.projectId) {
            document.getElementById('noVNC_audio_button').classList.remove('noVNC_hidden');
            // document.getElementById('noVNC_ime_button').classList.remove('noVNC_hidden');
        }
    },

    /**
     * 自动启动音频和输入法（VNC 连接成功后调用）
     */
    async autoStartAudioIME() {
        if (!UI.projectId || !UI.baseUrl) {
            Log.Warn('[Audio/IME] 缺少必要参数 (projectId/baseUrl)，无法自动启动');
            return;
        }

        Log.Info('[Audio/IME] 自动启动音频和输入法... (debugMode=' + UI.debugMode + ')');

        // 启动音频（自动重试）
        // 启动音频（自动重试）
        // try {
        //     const audioWsUrl = audioManager.buildWsUrl(UI.baseUrl, UI.projectId, UI.userId, UI.debugMode);
        //     Log.Info('[Audio] WebSocket URL: ' + audioWsUrl);

        //     // 设置达到最大重试次数的回调
        //     audioManager.onMaxRetriesReached = () => {
        //         Log.Warn('[Audio] 自动连接失败，请手动点击音频按钮重试');
        //         document.getElementById('noVNC_audio_button').classList.remove('noVNC_audio_active');
        //     };

        //     // 启用自动重试
        //     audioManager.autoRetryEnabled = true;
        //     audioManager.retryCount = 0;

        //     await audioManager.connect(audioWsUrl);
        //     UI.audioEnabled = true;
        //     document.getElementById('noVNC_audio_button').classList.add('noVNC_audio_active');

        //     // 添加用户交互监听以恢复音频上下文
        //     const resumeAudio = () => {
        //         audioManager.resume();
        //         document.removeEventListener('click', resumeAudio);
        //         document.removeEventListener('keydown', resumeAudio);
        //         document.removeEventListener('touchstart', resumeAudio);
        //     };
        //     document.addEventListener('click', resumeAudio);
        //     document.addEventListener('keydown', resumeAudio);
        //     document.addEventListener('touchstart', resumeAudio);

        // } catch (err) {
        //     Log.Error('[Audio] 自动启动失败: ' + err);
        // }

        // 启动输入法
        // try {
        //     const imeWsUrl = imeManager.buildWsUrl(UI.baseUrl, UI.projectId, UI.userId, UI.debugMode);
        //     Log.Info('[IME] WebSocket URL: ' + imeWsUrl);
        //     await imeManager.connect(imeWsUrl);
        //     UI.imeEnabled = true;
        //     document.getElementById('noVNC_ime_button').classList.add('noVNC_ime_active');
        // } catch (err) {
        //     Log.Error('[IME] 自动启动失败: ' + err);
        // }
    },

    /**
     * 停止音频和输入法（VNC 断开时调用）
     */
    stopAudioIME() {
        audioManager.disconnect();
        imeManager.disconnect();
        fileManager.disconnect();

        if (UI.audioEnabled) {
            UI.audioEnabled = false;
            document.getElementById('noVNC_audio_button').classList.remove('noVNC_audio_active');
        }
        if (UI.imeEnabled) {
            UI.imeEnabled = false;
            document.getElementById('noVNC_ime_button').classList.remove('noVNC_ime_active');
        }
    },

    autoStartFileTransfer() {
        const host = UI.getSetting('host');
        // const port = UI.getSetting('port');
        const path = UI.getSetting('path'); // "websockify"

        let baseUrl;
        if (host) {
            baseUrl = (UI.getSetting('encrypt') ? 'https://' : 'http://') + host; //+ ":" + port;
        } else {
            baseUrl = window.location.origin;
        }

        let projectId = '666'; // fallback
        if (UI.currProjectId) {
            projectId = UI.currProjectId;
        } else {
            // 临时解析逻辑，应与 initAudioIMEParams 保持一致
            const parts = path.split('/');
            if (parts.length >= 2) {
                projectId = parts[parts.length - 2];
            }
        }

        const debugMode = UI.debugMode;

        const wsUrl = fileManager.buildWsUrl(baseUrl, projectId, null, debugMode);
        fileManager.connect(wsUrl);
    },

    /* ------^-------
     * /AUDIO & IME
     * ==============
     *  AUDIO PANEL
     * ------v------*/

    openAudioPanel() {
        UI.closeAllPanels();
        UI.openControlbar();

        document.getElementById('noVNC_audio')
            .classList.add("noVNC_open");
        document.getElementById('noVNC_audio_button')
            .classList.add("noVNC_selected");
    },

    closeAudioPanel() {
        document.getElementById('noVNC_audio')
            .classList.remove("noVNC_open");
        document.getElementById('noVNC_audio_button')
            .classList.remove("noVNC_selected");
    },

    toggleAudioPanel() {
        if (document.getElementById('noVNC_audio')
            .classList.contains("noVNC_open")) {
            UI.closeAudioPanel();
        } else {
            UI.openAudioPanel();
        }
    },

    /**
     * 音量变化处理
     */
    onAudioVolumeChange() {
        const volumeSlider = document.getElementById('noVNC_audio_volume');
        const volumeValue = document.getElementById('noVNC_audio_volume_value');
        const volume = parseInt(volumeSlider.value);

        volumeValue.textContent = volume + '%';
        audioManager.setVolume(volume / 100);
    },

    /**
     * 音频状态变化回调
     */
    onAudioStatusChange(status, message) {
        const statusEl = document.getElementById('noVNC_audio_status');
        const statusText = statusEl.querySelector('.noVNC_status_text');

        statusEl.className = 'noVNC_audio_status ' + status;
        statusText.textContent = message;

        // 更新按钮状态
        const btn = document.getElementById('noVNC_audio_button');
        const toggleBtn = document.getElementById('noVNC_audio_toggle');
        if (status === 'connected') {
            btn.classList.add('noVNC_audio_active');
            toggleBtn.textContent = '🔇 关闭音频';
            toggleBtn.classList.add('active');
            UI.audioEnabled = true;
        } else if (status === 'disconnected' || status === 'error') {
            btn.classList.remove('noVNC_audio_active');
            toggleBtn.textContent = '🔊 开启音频';
            toggleBtn.classList.remove('active');
            UI.audioEnabled = false;
        }
    },

    /**
     * 切换音频连接
     */
    async toggleAudio() {
        if (UI.audioEnabled) {
            audioManager.disconnect();
        } else {
            if (!UI.projectId || !UI.baseUrl) {
                Log.Warn('[Audio] 缺少必要参数');
                return;
            }
            const wsUrl = audioManager.buildWsUrl(UI.baseUrl, UI.projectId, UI.userId, UI.debugMode);

            // 手动开启时，启用自动重试
            audioManager.autoRetryEnabled = true;
            audioManager.retryCount = 0;

            await audioManager.connect(wsUrl);
        }
    },

    /* ------^-------
     * /AUDIO PANEL
     * ==============
     *   IME PANEL
     * ------v------*/

    openIMEPanel() {
        if (!document.getElementById('noVNC_ime')) return;
        UI.closeAllPanels();
        UI.openControlbar();

        document.getElementById('noVNC_ime')
            .classList.add("noVNC_open");
        document.getElementById('noVNC_ime_button')
            .classList.add("noVNC_selected");
    },

    closeIMEPanel() {
        if (!document.getElementById('noVNC_ime')) return;
        document.getElementById('noVNC_ime')
            .classList.remove("noVNC_open");
        document.getElementById('noVNC_ime_button')
            .classList.remove("noVNC_selected");
    },

    toggleIMEPanel() {
        if (!document.getElementById('noVNC_ime')) return;
        if (document.getElementById('noVNC_ime')
            .classList.contains("noVNC_open")) {
            UI.closeIMEPanel();
        } else {
            UI.openIMEPanel();
        }
    },

    /**
     * 输入法状态变化回调
     */
    onIMEStatusChange(status, message) {
        const statusEl = document.getElementById('noVNC_ime_status');
        const statusText = statusEl.querySelector('.noVNC_status_text');

        statusEl.className = 'noVNC_ime_status ' + status;
        statusText.textContent = message;

        // 更新按钮状态
        const btn = document.getElementById('noVNC_ime_button');
        if (status === 'connected') {
            btn.classList.add('noVNC_ime_active');
            UI.imeEnabled = true;
        } else if (status === 'disconnected' || status === 'error') {
            btn.classList.remove('noVNC_ime_active');
            UI.imeEnabled = false;
        }
    },

    /**
     * 切换输入法连接
     */
    async toggleIME() {
        if (UI.imeEnabled) {
            imeManager.disconnect();
        } else {
            if (!UI.projectId || !UI.baseUrl) {
                Log.Warn('[IME] 缺少必要参数');
                return;
            }
            const wsUrl = imeManager.buildWsUrl(UI.baseUrl, UI.projectId, UI.userId, UI.debugMode);
            await imeManager.connect(wsUrl);
        }
    },

    /* ------^-------
     *  /IME PANEL
     * ==============
     */
};

export default UI;
