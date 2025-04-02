import { extension_settings, loadExtensionSettings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced as globalSaveSettingsDebounced, eventSource, event_types, getRequestHeaders } from "../../../../script.js"; // Renamed global save

const extensionName = "hide-helper";
const defaultSettings = {
    enabled: true
};

// 缓存上下文
let cachedContext = null;

// DOM元素缓存
const domCache = {
    hideLastNInput: null,
    saveBtn: null,
    currentValueDisplay: null,
    hideHelperToggle: null, // Added for easier access
    popup: null, // Added for easier access
    unhideBtn: null, // Added
    popupCloseBtn: null, // Added
    wandBtn: null, // Added
    // 初始化缓存
    init() {
        this.hideLastNInput = document.getElementById('hide-last-n');
        this.saveBtn = document.getElementById('hide-save-settings-btn');
        this.currentValueDisplay = document.getElementById('hide-current-value');
        this.hideHelperToggle = document.getElementById('hide-helper-toggle');
        this.popup = document.getElementById('hide-helper-popup');
        this.unhideBtn = document.getElementById('hide-unhide-all-btn');
        this.popupCloseBtn = document.getElementById('hide-helper-popup-close');
        this.wandBtn = document.getElementById('hide-helper-wand-button');
    }
};

// 获取优化的上下文
function getContextOptimized() {
    // 强制刷新缓存，因为聊天内容可能已在后台更新
    cachedContext = getContext();
    return cachedContext;
    // if (!cachedContext) {
    //     cachedContext = getContext();
    // }
    // return cachedContext;
}


// 初始化扩展设置 (仅包含全局启用状态)
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0 || typeof extension_settings[extensionName].enabled === 'undefined') {
        Object.assign(extension_settings[extensionName], defaultSettings); // Use assign for potentially more defaults later
    }
}

// --- Debounce Utility ---
function debounce(fn, delay) {
    let timer;
    const debounced = function(...args) {
        const context = this; // Capture context
        clearTimeout(timer);
        timer = setTimeout(() => {
            fn.apply(context, args); // Apply captured context and args
        }, delay);
        debounced._timer = timer; // Expose timer ID for potential cancellation
    };
    // Add a cancel method
    debounced.cancel = function() {
        clearTimeout(timer);
    };
    return debounced;
}

// --- API Interaction ---

// 获取当前角色/群组的隐藏设置 (从角色/群组数据读取)
function getCurrentHideSettings() {
    const context = getContextOptimized(); // Use optimized/cached context first
    if (!context) return null;

    const isGroup = !!context.groupId;
    let targetData = null;

    if (isGroup) {
        const group = context.groups?.find(x => x.id == context.groupId);
        targetData = group?.data?.hideHelperSettings;
    } else {
        if (context.characters && context.characterId !== undefined && context.characterId < context.characters.length) {
           const character = context.characters[context.characterId];
           targetData = character?.data?.extensions?.hideHelperSettings;
        }
    }

    // Ensure default structure if settings exist but lack properties
    if (targetData) {
        return {
            hideLastN: targetData.hideLastN || 0,
            lastProcessedLength: targetData.lastProcessedLength || 0,
            userConfigured: targetData.userConfigured === true // Ensure boolean
        };
    }

    return null; // Return null if no settings found at all
}

// 保存当前角色/群组的隐藏设置 (通过API持久化) - Raw save function
async function saveCurrentHideSettings(hideLastN) {
    const context = getContextOptimized(); // Get fresh context for saving
    if (!context) {
        console.error(`[${extensionName}] Cannot save settings: Context not available.`);
        return false;
    }
    const isGroup = !!context.groupId;
    // Get chat length *now* as it's part of the state to save
    const currentChatLength = context.chat?.length || 0;

    // Ensure hideLastN is a non-negative number
    const finalHideLastN = Math.max(0, Number(hideLastN) || 0);

    const settingsToSave = {
        hideLastN: finalHideLastN,
        lastProcessedLength: currentChatLength, // Save the length at the time of saving
        userConfigured: true // Explicitly set to true when saving via UI or logic
    };

    let apiUrl = '';
    let payload = {};
    let targetId = ''; // For logging/error messages

    try {
        if (isGroup) {
            apiUrl = '/api/groups/edit';
            const groupId = context.groupId;
            targetId = `Group ${groupId}`;
            const group = context.groups?.find(x => x.id == groupId);
            if (!group) {
                 console.error(`[${extensionName}] Cannot save settings: ${targetId} not found in context.`);
                 return false;
            }
            // Merge settings into existing group data
            payload = {
                ...group,
                data: {
                    ...(group.data || {}),
                    hideHelperSettings: settingsToSave
                }
            };
            // Update context immediately for responsiveness (API is source of truth)
            group.data = payload.data;

        } else { // Is character
            apiUrl = '/api/characters/merge-attributes';
            if (!context.characters || context.characterId === undefined || context.characterId >= context.characters.length) {
                 console.error(`[${extensionName}] Cannot save settings: Character context is invalid.`);
                 return false;
            }
            const character = context.characters[context.characterId];
             if (!character || !character.avatar) {
                console.error(`[${extensionName}] Cannot save settings: Character or character avatar not found at index ${context.characterId}.`);
                return false;
            }
            const avatarFileName = character.avatar;
            targetId = `Character ${avatarFileName}`;
            // Construct partial payload for merge-attributes
            payload = {
                avatar: avatarFileName,
                data: {
                    extensions: { // Merge within extensions
                        hideHelperSettings: settingsToSave
                    }
                }
            };
            // Update context immediately
            character.data = character.data || {};
            character.data.extensions = character.data.extensions || {};
            character.data.extensions.hideHelperSettings = settingsToSave;
        }

        console.log(`[${extensionName}] Saving settings for ${targetId}:`, settingsToSave); // Log the settings being saved
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[${extensionName}] Failed to save settings for ${targetId}: ${response.status} ${errorText}`, payload);
            toastr.error(`保存 ${isGroup ? '群组' : '角色'} 设置失败: ${errorText}`);
            return false;
        }
        console.log(`[${extensionName}] Settings saved successfully for ${targetId}`);
        return true;

    } catch (error) {
        console.error(`[${extensionName}] Error during fetch to save settings for ${targetId}:`, error);
        toastr.error(`保存 ${isGroup ? '群组' : '角色'} 设置时发生网络错误: ${error.message}`);
        return false;
    }
}

// Debounced version of the save function for background updates
const saveCurrentHideSettingsDebounced = debounce(async (hideLastN) => {
    // No need to re-check context or enabled status here, assume caller did checks.
    // The debounce wrapper handles potential state changes before execution.
    console.log(`[${extensionName}] Debounced save executing...`);
    await saveCurrentHideSettings(hideLastN); // Call the raw async save function
}, 1000); // Debounce delay of 1000ms (1 second)

// --- Core Hiding Logic ---

// Check if processing should occur (plugin enabled & user configured)
function shouldProcessHiding() {
    if (!extension_settings[extensionName].enabled) {
        return false;
    }
    const settings = getCurrentHideSettings();
    // Only process if user has explicitly configured settings for this chat
    return settings?.userConfigured === true;
}

// Schedule DOM updates using setTimeout 0 for minimal delay
function scheduleDomUpdate(indicesToHide, indicesToShow) {
    if (indicesToHide.length === 0 && indicesToShow.length === 0) return;

    setTimeout(() => {
        try {
            if (indicesToHide.length > 0) {
                const hideSelector = indicesToHide.map(id => `.mes[mesid="${id}"]`).join(',');
                // console.debug(`[${extensionName}] DOM Hiding: ${hideSelector}`);
                $(hideSelector).attr('is_system', 'true');
            }
            if (indicesToShow.length > 0) {
                const showSelector = indicesToShow.map(id => `.mes[mesid="${id}"]`).join(',');
                // console.debug(`[${extensionName}] DOM Showing: ${showSelector}`);
                $(showSelector).attr('is_system', 'false');
            }
        } catch (error) {
            console.error(`[${extensionName}] Error updating DOM:`, error);
        }
    }, 0); // Schedule immediately after current execution context
}


/**
 * Incremental Hide Check (Data First, DOM Later)
 * Called on new messages.
 */
function runIncrementalHideCheck() {
    if (!shouldProcessHiding()) return; // Check global enabled and user config

    const context = getContextOptimized();
    if (!context?.chat) return; // Need chat context

    const chat = context.chat;
    const currentChatLength = chat.length;
    const settings = getCurrentHideSettings(); // Assumed to exist due to shouldProcessHiding

    // This should theoretically not happen if shouldProcessHiding passed, but belt and suspenders
    if (!settings || settings.userConfigured !== true) return;

    const { hideLastN, lastProcessedLength } = settings;

    // Basic conditions check
    if (currentChatLength === 0 || hideLastN <= 0) {
        if (currentChatLength !== lastProcessedLength) {
            // Length changed (e.g., chat cleared), trigger debounced save to update length
             saveCurrentHideSettingsDebounced(hideLastN);
        }
        return;
    }

    // Only proceed if chat length increased
    if (currentChatLength <= lastProcessedLength) {
        return; // Deletes etc. handled by full check
    }

    const targetVisibleStart = currentChatLength - hideLastN;
    const previousVisibleStart = Math.max(0, lastProcessedLength - hideLastN);

    const indicesToHide = [];
    let dataChanged = false;

    // *** 1. Update Data Immediately ***
    if (targetVisibleStart > previousVisibleStart) {
        const startIndex = previousVisibleStart;
        const endIndex = Math.min(currentChatLength, targetVisibleStart);

        for (let i = startIndex; i < endIndex; i++) {
            if (chat[i] && chat[i].is_system === false) {
                chat[i].is_system = true; // Update data model instantly
                indicesToHide.push(i);
                dataChanged = true;
            }
        }
    }

    // *** 2. Schedule DOM Update ***
    if (indicesToHide.length > 0) {
        // console.log(`[${extensionName}] Incremental Data: Hiding ${indicesToHide.length} messages.`);
        scheduleDomUpdate(indicesToHide, []); // Schedule only hiding
    }

    // *** 3. Trigger Debounced Save if needed ***
    const lengthChanged = currentChatLength !== lastProcessedLength;
    if (dataChanged || lengthChanged) {
        // Pass the current hideLastN; the save function will use the latest chat length
        saveCurrentHideSettingsDebounced(hideLastN);
    }
}


/**
 * Full Hide Check (Data First, DOM Later)
 * Used on load, chat change, delete, settings change.
 */
function runFullHideCheck() {
    // No debouncing here, it's called explicitly or via debounced wrappers
    if (!shouldProcessHiding()) {
        // If disabling, ensure all are visible? Optional. Current logic keeps state.
        // If no user config, do nothing.
        return;
    }

    const startTime = performance.now();
    const context = getContextOptimized();
    if (!context?.chat) return;

    const chat = context.chat;
    const currentChatLength = chat.length;
    const settings = getCurrentHideSettings(); // Assumed non-null & configured

    if (!settings) return; // Should not happen, but safeguard
    const { hideLastN, lastProcessedLength } = settings;

    // *** 1. Calculate and Update Data Immediately ***
    const visibleStart = hideLastN <= 0 ? currentChatLength : Math.max(0, currentChatLength - hideLastN);
    const indicesToHide = [];
    const indicesToShow = [];
    let dataChanged = false;

    for (let i = 0; i < currentChatLength; i++) {
        const msg = chat[i];
        if (!msg) continue;

        const isCurrentlyHidden = msg.is_system === true;
        const shouldBeHidden = i < visibleStart;

        if (shouldBeHidden && !isCurrentlyHidden) {
            msg.is_system = true; // Update data
            indicesToHide.push(i);
            dataChanged = true;
        } else if (!shouldBeHidden && isCurrentlyHidden) {
            msg.is_system = false; // Update data
            indicesToShow.push(i);
            dataChanged = true;
        }
    }

    // *** 2. Schedule DOM Update ***
    if (dataChanged) {
         console.log(`[${extensionName}] Full Check Data: Hiding ${indicesToHide.length}, Showing ${indicesToShow.length}`);
        scheduleDomUpdate(indicesToHide, indicesToShow);
    }

    // *** 3. Trigger Debounced Save if length changed ***
    const lengthChanged = currentChatLength !== lastProcessedLength;
    if (lengthChanged) {
         saveCurrentHideSettingsDebounced(hideLastN);
    }
    // console.debug(`[${extensionName}] Full check completed in ${performance.now() - startTime}ms`);
}

// Debounced version for frequent events like delete/stream end
const runFullHideCheckDebounced = debounce(runFullHideCheck, 200);

/**
 * Unhide All Messages (Data First, DOM Later)
 * Resets hide setting to 0 and saves immediately.
 */
async function unhideAllMessages() {
    const startTime = performance.now();
    const context = getContextOptimized();
    if (!context?.chat) {
        console.warn(`[${extensionName}] Unhide all aborted: Chat data not available.`);
        // Still try to save 0 if context exists (e.g., empty chat)
        if (context) await saveCurrentHideSettings(0);
        updateCurrentHideSettingsDisplay();
        return;
    }
    const chat = context.chat;
    if (chat.length === 0) {
        await saveCurrentHideSettings(0); // Reset setting even for empty chat
        updateCurrentHideSettingsDisplay();
        return;
    }

    const indicesToShow = [];
    let dataChanged = false;

    // *** 1. Update Data Immediately ***
    for (let i = 0; i < chat.length; i++) {
        if (chat[i] && chat[i].is_system === true) {
            chat[i].is_system = false; // Update data
            indicesToShow.push(i);
            dataChanged = true;
        }
    }

    // *** 2. Schedule DOM Update ***
    if (dataChanged) {
        console.log(`[${extensionName}] Unhide All Data: Marking ${indicesToShow.length} messages visible.`);
        scheduleDomUpdate([], indicesToShow); // Schedule only showing
    } else {
        // console.log(`[${extensionName}] Unhide All: No hidden messages found in data.`);
    }

    // *** 3. Cancel pending saves and Save 0 Immediately ***
    console.log(`[${extensionName}] Cancelling any pending debounced saves.`);
    saveCurrentHideSettingsDebounced.cancel(); // Cancel pending background saves

    console.log(`[${extensionName}] Saving hideLastN = 0 immediately.`);
    const success = await saveCurrentHideSettings(0); // Explicitly save 0 NOW

    if (success) {
        updateCurrentHideSettingsDisplay(); // Update UI on successful save
        toastr.success('所有消息已取消隐藏');
    } else {
        toastr.error("无法重置隐藏设置到服务器。");
        // Consider reverting data changes if save fails? More complex.
    }
    // console.debug(`[${extensionName}] Unhide all process finished in ${performance.now() - startTime}ms`);
}

// --- UI Functions ---

// 更新当前设置显示 - Use DOM Cache
function updateCurrentHideSettingsDisplay() {
    const currentSettings = getCurrentHideSettings(); // Get latest from context

    if (!domCache.currentValueDisplay || !domCache.hideLastNInput) {
        domCache.init(); // Ensure cache is initialized
        if (!domCache.currentValueDisplay || !domCache.hideLastNInput) return; // Still not found? Bail.
    }

    const displayValue = currentSettings?.userConfigured && currentSettings.hideLastN > 0 ? currentSettings.hideLastN : '无';
    const inputValue = currentSettings?.userConfigured && currentSettings.hideLastN > 0 ? currentSettings.hideLastN : '';

    domCache.currentValueDisplay.textContent = displayValue;
    domCache.hideLastNInput.value = inputValue;
}

// 创建UI面板 - Simplified
function createUI() {
    const settingsHtml = `
    <div id="hide-helper-settings" class="hide-helper-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>隐藏助手</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="hide-helper-section">
                    <div class="hide-helper-toggle-row">
                        <span class="hide-helper-label">插件状态:</span>
                        <select id="hide-helper-toggle">
                            <option value="enabled">开启</option>
                            <option value="disabled">关闭</option>
                        </select>
                    </div>
                </div>
                <hr class="sysHR">
            </div>
        </div>
    </div>`;
    $("#extensions_settings").append(settingsHtml);

    createInputWandButton();
    createPopup();

    // Init DOM cache after elements are added
    setTimeout(() => domCache.init(), 100);

    setupEventListeners(); // Setup listeners after creating elements
}

// Create wand button
function createInputWandButton() {
    const buttonHtml = `
    <div id="hide-helper-wand-button" class="list-group-item flex-container flexGap5" title="隐藏助手 设置">
        <span style="padding-top: 2px;"><i class="fa-solid fa-ghost"></i></span>
        <span>隐藏</span>
    </div>`;
    $('#data_bank_wand_container').prepend(buttonHtml); // Use prepend to appear before data bank
}

// Create popup dialog
function createPopup() {
    const popupHtml = `
    <div id="hide-helper-popup" class="hide-helper-popup" style="display: none;">
        <div class="hide-helper-popup-title">隐藏助手设置</div>
        <div class="hide-helper-input-row">
            <input type="number" id="hide-last-n" min="0" placeholder="保留最近N条消息" style="flex-grow: 1; margin-right: 5px;">
            <button id="hide-save-settings-btn" class="hide-helper-btn">保存</button>
            <button id="hide-unhide-all-btn" class="hide-helper-btn danger-btn">全部显示</button> <!-- Added danger style -->
        </div>
        <div class="hide-helper-current">
            <strong>当前设置:</strong> 保留最近 <span id="hide-current-value">无</span> 条
        </div>
        <div class="hide-helper-popup-footer">
            <button id="hide-helper-popup-close" class="hide-helper-close-btn">关闭</button>
        </div>
    </div>`;
    $('body').append(popupHtml);
}

// --- Event Listeners ---
function setupEventListeners() {
    if (!domCache.wandBtn) domCache.init(); // Ensure cache before setting listeners

    // Wand Button: Open Popup
    $(domCache.wandBtn).on('click', function() {
        if (!extension_settings[extensionName].enabled) {
            toastr.warning('隐藏助手当前已禁用，请在扩展设置中启用。');
            return;
        }
        updateCurrentHideSettingsDisplay(); // Update display values before showing

        // 简化弹出窗口显示逻辑，避免重复设置CSS中已定义的样式
        $(domCache.popup).show();
    });

    // Popup Close Button
    $(domCache.popupCloseBtn).on('click', function() {
        $(domCache.popup).hide();
    });

    // Global Enable/Disable Toggle
    $(domCache.hideHelperToggle).on('change', function() {
        const isEnabled = $(this).val() === 'enabled';
        extension_settings[extensionName].enabled = isEnabled;
        globalSaveSettingsDebounced(); // Save global extension settings state

        if (isEnabled) {
            toastr.success('隐藏助手已启用');
            runFullHideCheck(); // Run check immediately on enable
        } else {
            toastr.warning('隐藏助手已禁用');
            // Optionally run unhideAll or leave messages hidden when disabled?
            // Current logic leaves them as they are.
        }
        // Ensure popup closes if disabled while open
        if (!isEnabled) $(domCache.popup).hide();
    });

    // Input Validation (Non-negative integer)
    $(domCache.hideLastNInput).on('input', function() {
        const value = parseInt(this.value, 10);
        if (isNaN(value) || value < 0) {
            this.value = ''; // Clear if invalid or negative
        } else {
            this.value = value; // Allow valid non-negative integer
        }
    });

    // Save Button in Popup (Immediate Save)
    $(domCache.saveBtn).on('click', async function() {
        const valueStr = domCache.hideLastNInput.value;
        // Treat empty input as 0 (meaning don't hide anything based on N)
        const valueToSave = valueStr === '' ? 0 : Math.max(0, parseInt(valueStr, 10) || 0);

        const currentSettings = getCurrentHideSettings();
        const currentValue = currentSettings?.hideLastN ?? 0; // Use 0 if no settings yet

        if (valueToSave !== currentValue || !currentSettings?.userConfigured) { // Save if value changed OR if first time configuring
            const $btn = $(this);
            const originalText = $btn.text();
            $btn.text('保存中...').prop('disabled', true);

            console.log(`[${extensionName}] User manually saving hideLastN = ${valueToSave}`);
            saveCurrentHideSettingsDebounced.cancel(); // Cancel any pending background saves
            const success = await saveCurrentHideSettings(valueToSave); // Save immediately

            if (success) {
                updateCurrentHideSettingsDisplay(); // Update display after save
                runFullHideCheck(); // Apply the new setting immediately
                toastr.success('隐藏设置已保存');
            }
            // No else toastr here, saveCurrentHideSettings handles API errors

            $btn.text(originalText).prop('disabled', false);
            $(domCache.popup).hide(); // Close popup on save
        } else {
            toastr.info('设置未更改');
            $(domCache.popup).hide(); // Close popup even if no change
        }
    });

    // Unhide All Button (Immediate Action)
    $(domCache.unhideBtn).on('click', async function() {
        const $btn = $(this);
        const originalText = $btn.text();
        $btn.text('处理中...').prop('disabled', true);

        await unhideAllMessages(); // Handles its own saving and UI updates

        $btn.text(originalText).prop('disabled', false);
        $(domCache.popup).hide(); // Close popup after action
    });

    // --- SillyTavern Event Listeners ---

    // Chat Change
    eventSource.on(event_types.CHAT_CHANGED, () => {
        // console.debug(`[${extensionName}] Event: ${event_types.CHAT_CHANGED}`);
        cachedContext = null; // Invalidate context cache
        if (!domCache.hideHelperToggle) domCache.init(); // Ensure cache

        // Update global toggle state display
        $(domCache.hideHelperToggle).val(extension_settings[extensionName].enabled ? 'enabled' : 'disabled');
        updateCurrentHideSettingsDisplay(); // Update popup values for the new chat

        if (extension_settings[extensionName].enabled) {
            runFullHideCheck(); // Run full check on chat change
        }
    });

    // New Messages (Sent or Received)
    const handleNewMessageWrapper = () => {
        // console.debug(`[${extensionName}] Event: MESSAGE_SENT/RECEIVED`);
        if (extension_settings[extensionName].enabled) {
            // No setTimeout needed here, incremental check is fast
            runIncrementalHideCheck();
        }
    };
    eventSource.on(event_types.MESSAGE_RECEIVED, handleNewMessageWrapper);
    eventSource.on(event_types.MESSAGE_SENT, handleNewMessageWrapper);

    // Message Deleted
    eventSource.on(event_types.MESSAGE_DELETED, () => {
        // console.debug(`[${extensionName}] Event: ${event_types.MESSAGE_DELETED}`);
        if (extension_settings[extensionName].enabled) {
            // Deleting can affect indices, run debounced full check
            runFullHideCheckDebounced();
        }
    });

    // Stream End (Multiple messages might have arrived)
    eventSource.on(event_types.STREAM_END, () => {
        // console.debug(`[${extensionName}] Event: ${event_types.STREAM_END}`);
        if (extension_settings[extensionName].enabled) {
            // Stream end might change length significantly or finalize messages
            // A full check is safer than incremental after streaming.
             runFullHideCheckDebounced(); // Use debounced full check
             // Alternatively, could run incremental first, then schedule a debounced full check
             // runIncrementalHideCheck();
             // runFullHideCheckDebounced();
        }
    });
}

// --- Initialization ---
jQuery(async () => {
    loadSettings(); // Load global enable/disable state
    createUI();     // Create UI elements and setup listeners

    // Initial setup after UI is ready and ST likely initialized
    setTimeout(() => {
        if (!domCache.hideHelperToggle) domCache.init(); // Ensure cache

        // Set initial state of the global toggle
        $(domCache.hideHelperToggle).val(extension_settings[extensionName].enabled ? 'enabled' : 'disabled');

        // Update display for the initially loaded chat
        updateCurrentHideSettingsDisplay();

        // Run initial check ONLY if enabled AND user has configured for this chat before
        if (extension_settings[extensionName].enabled && getCurrentHideSettings()?.userConfigured === true) {
             console.log(`[${extensionName}] Running initial full check on load.`);
             runFullHideCheck();
        } else {
             console.log(`[${extensionName}] Skipping initial check (disabled or not configured).`);
        }
    }, 1500); // Delay to ensure ST context is fully loaded
});
