import { chat_metadata, saveSettingsDebounced, extension_prompt_types } from '../../../../script.js';
import { getContext, extension_settings, saveMetadataDebounced, renderExtensionTemplateAsync } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

const MODULE_NAME = 'scripter';
const EXTENSION_FOLDER = 'third-party/Extension-Scripter';

// ============================================
// Default Values & Prompt Templates
// ============================================

const DEFAULT_FINAL_CHECK = `[Silent Instruction: DO NOT OUTPUT THIS CHECKLIST]
Before generating the response, strictly verify the following internally:
1. **Boundaries:** Did I stop before the <NextScene> events?
2. **Continuity:** Did I skip events from <CurrentScene> that already happened in the chat?
3. **Consistency:** Is the response free of contradictions with World Info and recent context?
(If any answer is NO, revise explicitly before outputting.)`;

const PROTOCOL_READY = `Current status: **SCENE START (READY)**. The narrative is transitioning to a new phase.
**Maintain narrative continuity** from the previous events (do not ignore context), BUT shift the focus immediately to the opening of <CurrentScene>.
Smoothly bridge the gap and execute the very *first* beat of the writing prompt.`;

const PROTOCOL_ACTION = `Current status: **WRITING IN PROGRESS (ACTION)**. The scene is actively unfolding.
**[Continuity Check]:** Analyze the last two messages to determine the current progress within <CurrentScene>.
**DO NOT REPEAT** events, but **Drill Down** into the current moment. Focus on **micro-progression**—sensory details, psychological reactions, and immediate consequences within the current scene—rather than rushing to a conclusion.`;

const PROTOCOL_MONTAGE = `Current status: **MONTAGE SEQUENCE (FAST PACE)**.
You are executing a rapid-succession narrative covering multiple fragments or time-compressed events.
**[Objective]:** Compress time and space efficiently while maintaining atmospheric coherence. Do NOT transition into <NextScene>.`;

const STRATEGY_DEFAULT = `**[Strategy: The "Dynamic Split-Sequence" Technique]**
Before writing, perform a **Dynamic Narrative Planning**:

1.  **Locate Coordinates:** Analyze the context to determine the exact **"Start Point."** How far has the <CurrentScene> progressed? (e.g., Has 'A' finished? Is 'B' starting?)
2.  **Assess the Remainder:** From this Start Point, does the *remaining* part of <CurrentScene> contain a chain of events (e.g., B → C → D)?
3.  **Segmented Execution:** If yes, **DO NOT rush to complete the scene.** Plan to draft *only* the immediate next beat (e.g., B → C) starting from the current coordinates.
4.  **Suspenseful Stop:** **STOP** the narrative at a high-tension moment or a natural break *before* resolving the entire scene (e.g., stop right before D). Leave the rest for the next turn.
5.  **Prioritize Depth (Flesh on the Skeleton):**
    The <Synopsis> provides only the structural "skeleton." Your goal is to add the "flesh and blood."
    Do not mechanically translate the prompt into prose. Instead, utilize the **"Split-Sequence"** space to creatively expand on sensory details, atmosphere, and psychological depth.
    *Constraint:* You may improvise details to enhance immersion, but you must strictly stay within the timeline of the <CurrentScene>.`;

const STRATEGY_MONTAGE = `**[Strategy: The "Cinematic Montage" Technique]**
Apply the following rules to structure the response:

1. **Fragmented Structure:**
   - Treat <CurrentScene> as distinct vignettes (e.g., A → B → C).
   - Present them as discrete beats.

2. **Controlled Tempo:**
   - Keep each beat concise (2-4 sentences).
   - Prioritize key sensory anchors over exhaustive detail.

3. **Connective Tissue:**
   - Use transitional markers (e.g., "Hours later," "Meanwhile," "Cut to—") to smoothly link fragments.
   - Ensure thematic or visual echoes between beats.

4. **Micro-Immersion:**
   - Even in compressed time, avoid dry summary.
   - Anchor each fragment with **ONE striking sensory detail** to ground the reader.

5. **Destination Check:**
   - Rapidly cover the timeline of <CurrentScene>.
   - **STOP cleanly** exactly when the montage concludes.
   - **Strict Prohibition:** Do NOT start writing events from <NextScene>.`;

// ============================================
// State Management
// ============================================

let resizeObserver = null;
let sidebarResizeFrame = null;
let promptCache = {
    key: '',
    value: ''
};
let chatEventHandlers = null;

const EVENT_NS = '.scripter';
const CHAT_FIELD_BINDINGS = [
    { key: 'caution', selectors: ['#scripter-caution', '#scripter-caution-popup'] },
    { key: 'currentScene', selectors: ['#scripter-current-scene', '#scripter-current-scene-popup'] },
    { key: 'nextScene', selectors: ['#scripter-next-scene', '#scripter-next-scene-popup'] },
    { key: 'corePrinciple', selectors: ['#scripter-core-principle', '#scripter-core-principle-popup'] }
];

const STATUS_BUTTON_BINDINGS = [
    { selector: '#scripter-ready-btn', status: 'ready' },
    { selector: '#scripter-action-btn', status: 'action' },
    { selector: '#scripter-ready-btn-popup', status: 'ready' },
    { selector: '#scripter-action-btn-popup', status: 'action' }
];

const MONTAGE_BUTTON_SELECTORS = ['#scripter-montage-btn', '#scripter-montage-btn-popup'];

const defaultChatData = {
    status: 'ready', // 'ready' | 'action'
    montage: false,
    autoAction: false,
    caution: '',
    currentScene: '',
    nextScene: '',
    corePrinciple: '',
    queue: [],
    rollbackData: null // { currentScene, nextScene, queue }
};

const defaultSettings = {
    enabled: true,
    quickButtonEnabled: true,
    shortcutEnabled: true,
    finalCheckPrompt: DEFAULT_FINAL_CHECK,
    autoResize: true,
    // New settings
    theme: 'default',
    quickButtonAction: 'sidebar' // 'sidebar' | 'cut'
};

// ============================================
// Data Access Helpers
// ============================================

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...defaultSettings };
    }
    // Ensure new settings exist for upgrades
    if (extension_settings[MODULE_NAME].theme === undefined) {
        extension_settings[MODULE_NAME].theme = defaultSettings.theme;
    }
    if (extension_settings[MODULE_NAME].quickButtonAction === undefined) {
        extension_settings[MODULE_NAME].quickButtonAction = defaultSettings.quickButtonAction;
    }
    if (extension_settings[MODULE_NAME].autoResize === undefined) {
        extension_settings[MODULE_NAME].autoResize = defaultSettings.autoResize;
    }
    return extension_settings[MODULE_NAME];
}
function getChatData() {
    if (!chat_metadata[MODULE_NAME]) {
        // Deep copy defaults to avoid reference issues
        chat_metadata[MODULE_NAME] = JSON.parse(JSON.stringify(defaultChatData));
    } else {
        // Merge missing keys from defaults (migration safety)
        for (const key in defaultChatData) {
            if (chat_metadata[MODULE_NAME][key] === undefined) {
                chat_metadata[MODULE_NAME][key] = defaultChatData[key];
            }
        }
    }
    return chat_metadata[MODULE_NAME];
}

function saveChatData() {
    saveMetadataDebounced();
}

function saveSettings() {
    saveSettingsDebounced();
}

function updateChatData(patchOrUpdater, options = {}) {
    const { persist = true, sync = 'none' } = options;
    const data = getChatData();

    if (typeof patchOrUpdater === 'function') {
        patchOrUpdater(data);
    } else if (patchOrUpdater && typeof patchOrUpdater === 'object') {
        Object.assign(data, patchOrUpdater);
    }

    if (persist) {
        saveChatData();
    }

    if (sync === 'all') {
        syncUIFromData();
    } else if (sync === 'status') {
        syncStatusControls(data);
    } else if (sync === 'queue') {
        syncQueueUI(data);
    } else if (sync === 'autoAction') {
        syncAutoActionCheckboxes(data);
    } else if (sync === 'rollback') {
        syncRollbackButtons(data);
    }

    return data;
}

function updateSettings(patchOrUpdater, options = {}) {
    const { persist = true, sync = false } = options;
    const settings = getSettings();

    if (typeof patchOrUpdater === 'function') {
        patchOrUpdater(settings);
    } else if (patchOrUpdater && typeof patchOrUpdater === 'object') {
        Object.assign(settings, patchOrUpdater);
    }

    if (persist) {
        saveSettings();
    }

    if (sync) {
        syncSettingsUI(settings);
    }

    return settings;
}

function toNamespacedEvents(events) {
    return events
        .split(' ')
        .map(eventName => `${eventName}${EVENT_NS}`)
        .join(' ');
}

function bindEvent(selector, events, handler) {
    const namespacedEvents = toNamespacedEvents(events);
    $(selector).off(namespacedEvents).on(namespacedEvents, handler);
}

function bindDelegatedEvent(selector, events, delegatedSelector, handler) {
    const namespacedEvents = toNamespacedEvents(events);
    $(selector).off(namespacedEvents, delegatedSelector).on(namespacedEvents, delegatedSelector, handler);
}

// ============================================
// Theme Management
// ============================================

function applyTheme(themeId) {
    const sidebar = $('#scripter-sidebar-popup');
    const centerPopup = $('#scripter-center-popup');
    const queuePopup = $('#scripter-queue-popup');
    
    // Apply theme attribute to all scripter containers
    [sidebar, centerPopup, queuePopup].forEach(el => {
        if (el.length) {
            el.attr('data-scripter-theme', themeId);
        }
    });
}

// ============================================
// Sidebar Resizing
// ============================================

function setupSidebarResizing() {
    teardownSidebarResizing();

    // Try multiple possible chat container selectors
    const chatContainer = document.getElementById('sheld') || document.getElementById('chat');

    if (chatContainer) {
        resizeObserver = new ResizeObserver(() => {
            scheduleSidebarWidthUpdate();
        });

        resizeObserver.observe(chatContainer);
    }

    // Initial sizing
    scheduleSidebarWidthUpdate();
}

function teardownSidebarResizing() {
    if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
    }

    if (sidebarResizeFrame !== null) {
        cancelAnimationFrame(sidebarResizeFrame);
        sidebarResizeFrame = null;
    }
}

function scheduleSidebarWidthUpdate() {
    if (sidebarResizeFrame !== null) {
        return;
    }

    sidebarResizeFrame = requestAnimationFrame(() => {
        sidebarResizeFrame = null;
        updateSidebarWidth();
    });
}

function updateSidebarWidth() {
    const sidebar = document.getElementById('scripter-sidebar-popup');
    const settings = getSettings();
    if (!sidebar || !settings.autoResize) return; // Auto-resize check restored
    
    // Try to get chat width from ST's CSS variable or compute from element
    const sheld = document.getElementById('sheld');
    const chat = document.getElementById('chat');
    const chatContainer = sheld || chat;
    
    let sidebarWidth = 350; // default
    
    if (chatContainer) {
        const viewportWidth = window.innerWidth;
        const chatRect = chatContainer.getBoundingClientRect();
        const rightSpace = viewportWidth - chatRect.right;

        // Use 100% of the space to the right of the chat
        sidebarWidth = Math.floor(rightSpace);
    }
    
    // Apply only the lower limit of 300px
    sidebarWidth = Math.max(350, sidebarWidth);
    
    sidebar.style.width = sidebarWidth + 'px';
}

// ============================================
// Prompt Generation
// ============================================

function generatePrompt() {
    const settings = getSettings();
    const data = getChatData();

    if (!settings.enabled) {
        promptCache = { key: '', value: '' };
        return '';
    }

    const promptCacheKey = JSON.stringify({
        status: data.status,
        montage: data.montage,
        caution: data.caution,
        currentScene: data.currentScene,
        nextScene: data.nextScene,
        corePrinciple: data.corePrinciple,
        finalCheckPrompt: settings.finalCheckPrompt
    });

    if (promptCache.key === promptCacheKey) {
        return promptCache.value;
    }

    // Build PROTOCOL_VARIABLE
    let protocolVar;
    if (data.montage) {
        protocolVar = PROTOCOL_MONTAGE;
    } else if (data.status === 'ready') {
        protocolVar = PROTOCOL_READY;
    } else {
        protocolVar = PROTOCOL_ACTION;
    }
    
    // Build STRATEGY_VARIABLE
    const strategyVar = data.montage ? STRATEGY_MONTAGE : STRATEGY_DEFAULT;
    
    // Build CAUTION_BLOCK (omit if empty)
    const cautionBlock = data.caution.trim() 
        ? `<Caution>\n${data.caution.trim()}\n</Caution>` 
        : '';
    
    // Build CORE_PRINCIPLE_BLOCK (omit if empty)
    const corePrincipleBlock = data.corePrinciple.trim()
        ? `**[Core Principle]**\n*The following is the Director's guiding philosophy for this narrative:*\n${data.corePrinciple.trim()}`
        : '';
    
    // Build the full prompt
    const prompt = `[System Message]
# 1. Role & Objective
You are a **Skilled Lead Author** collaborating with a Director (the User) to write a high-stakes narrative.
- **Your Goal:** Transform the Director's <Synopsis> into a high-quality, immersive story, strictly adhering to the style and world-building rules defined in the main prompt.
- **Your Constraint:** You must strictly follow the "Operating Protocol" and never spoil future events found in <NextScene>.

# 2. Operating Protocol (Dynamic)
The protocol operates in two dimensions:
- **Phase:** READY (scene start) → ACTION (in progress)
- **Pace:** SLOW BURN (default) / MONTAGE (when specified below)

${protocolVar}

# 3. The Script (Data)
<Synopsis>
${cautionBlock}
<CurrentScene>
**[Writing Prompt]**
${data.currentScene.trim()}
</CurrentScene>
*(If <CurrentScene> is empty, improvise the next logical beat based on context.)*
==========
<NextScene>
**[Upcoming Plot - SPOILER ALERT]**
${data.nextScene.trim()}
</NextScene>
*(If <NextScene> is empty, there is no scheduled future event. Continue developing <CurrentScene> freely.)*
</Synopsis>

# 4. Writing Guidelines (Crucial)
${strategyVar}

${corePrincipleBlock}

<FinalCheck>
${settings.finalCheckPrompt}
</FinalCheck>

[System Warning]
Strict adherence to this entire protocol is mandatory. Failure to follow these instructions or disregarding the narrative direction provided constitutes a **critical violation of the user's creative rights and autonomy**.
**Specifically, generating events from <NextScene> in the current response is a fatal narrative error that ruins the story structure. You are strictly prohibited from depicting these future events now.**
You must execute the user's designed narrative exactly as directed without unauthorized deviation.`;

    promptCache = {
        key: promptCacheKey,
        value: prompt
    };

    return prompt;
}

// ============================================
// Prompt Injection
// ============================================

function injectPrompt() {
    const context = getContext();
    const prompt = generatePrompt();
    
    if (prompt) {
        // depth 1, order 9999 (very high to be at the end)
        context.setExtensionPrompt(MODULE_NAME, prompt, extension_prompt_types.IN_CHAT, 1, false, null, 9999);
    } else {
        context.setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.IN_CHAT, 0);
    }
}

// ============================================
// UI Sync Functions
// ============================================

function syncUIFromData() {
    const data = getChatData();
    const settings = getSettings();

    syncStatusControls(data);
    syncTextFields(data);
    syncAutoActionCheckboxes(data);
    syncQueueUI(data);
    syncRollbackButtons(data);
    syncSettingsUI(settings);
}

function syncStatusControls(data = getChatData()) {
    updateStatusButtons(data.status, data.montage);
}

function syncTextFields(data = getChatData()) {
    for (const binding of CHAT_FIELD_BINDINGS) {
        for (const selector of binding.selectors) {
            $(selector).val(data[binding.key]);
        }
    }
}

function syncAutoActionCheckboxes(data = getChatData()) {
    $('#scripter-auto-action').prop('checked', data.autoAction);
    $('#scripter-auto-action-popup').prop('checked', data.autoAction);
}

function syncQueueUI(data = getChatData()) {
    const count = data.queue.filter(item => item.trim() !== '').length;
    $('#scripter-queue-count-num').text(count);
    $('#scripter-queue-count-num-popup').text(count);
}

function syncRollbackButtons(data = getChatData()) {
    const hasRollback = data.rollbackData !== null;
    $('#scripter-rollback-btn').prop('disabled', !hasRollback);
    $('#scripter-rollback-btn-popup').prop('disabled', !hasRollback);
}

function syncSettingsUI(settings = getSettings()) {
    $('#scripter-enabled').prop('checked', settings.enabled);
    $('#scripter-quick-btn-enabled').prop('checked', settings.quickButtonEnabled);
    $('#scripter-shortcut-enabled').prop('checked', settings.shortcutEnabled);
    $('#scripter-final-check-prompt').val(settings.finalCheckPrompt);
    $('#scripter-theme').val(settings.theme);
    $('#scripter-auto-resize').prop('checked', settings.autoResize);
    $('#scripter-quick-btn-cut').prop('checked', settings.quickButtonAction === 'cut');

    applyTheme(settings.theme);
    updateQuickButtonVisibility();
    updateQuickButtonTooltip(settings);
}

function updateStatusButtons(status, montage) {
    // Sidebar buttons
    const readyBtn = $('#scripter-ready-btn');
    const actionBtn = $('#scripter-action-btn');
    const montageBtn = $('#scripter-montage-btn');
    
    // Popup buttons
    const readyBtnPopup = $('#scripter-ready-btn-popup');
    const actionBtnPopup = $('#scripter-action-btn-popup');
    const montageBtnPopup = $('#scripter-montage-btn-popup');
    
    // Update montage state
    montageBtn.toggleClass('active', montage);
    montageBtnPopup.toggleClass('active', montage);
    
    // Update ready/action state
    if (montage) {
        // Disable ready/action when montage is active
        readyBtn.removeClass('active').addClass('disabled');
        actionBtn.removeClass('active').addClass('disabled');
        readyBtnPopup.removeClass('active').addClass('disabled');
        actionBtnPopup.removeClass('active').addClass('disabled');
    } else {
        readyBtn.removeClass('disabled');
        actionBtn.removeClass('disabled');
        readyBtnPopup.removeClass('disabled');
        actionBtnPopup.removeClass('disabled');
        
        if (status === 'ready') {
            readyBtn.addClass('active');
            actionBtn.removeClass('active');
            readyBtnPopup.addClass('active');
            actionBtnPopup.removeClass('active');
            readyBtn.find('.indicator').text('●');
            actionBtn.find('.indicator').text('○');
            readyBtnPopup.find('.indicator').text('●');
            actionBtnPopup.find('.indicator').text('○');
        } else {
            readyBtn.removeClass('active');
            actionBtn.addClass('active');
            readyBtnPopup.removeClass('active');
            actionBtnPopup.addClass('active');
            readyBtn.find('.indicator').text('○');
            actionBtn.find('.indicator').text('●');
            readyBtnPopup.find('.indicator').text('○');
            actionBtnPopup.find('.indicator').text('●');
        }
    }
}

function updateQueueCount() {
    syncQueueUI();
}

function updateQuickButtonVisibility() {
    const settings = getSettings();
    const quickBtn = $('#scripter-quick-btn');
    if (settings.enabled && settings.quickButtonEnabled) {
        quickBtn.show();
    } else {
        quickBtn.hide();
    }
}

function updateQuickButtonTooltip(settings = getSettings()) {
    const tooltip = settings.quickButtonAction === 'cut'
        ? 'CUT! (Ctrl+Shift+C)'
        : 'Scripter (Ctrl+Shift+C)';
    $('#scripter-quick-btn').attr('title', tooltip);
}

// ============================================
// CUT! Action
// ============================================

function executeCut() {
    const settings = getSettings();

    if (!settings.enabled) {
        toastr.warning('Scripter is disabled');
        return;
    }

    const data = getChatData();
    const nextPreview = data.nextScene.trim().substring(0, 20) + (data.nextScene.length > 20 ? '...' : '');

    updateChatData(currentData => {
        currentData.rollbackData = {
            currentScene: currentData.currentScene,
            nextScene: currentData.nextScene,
            queue: [...currentData.queue]
        };

        currentData.currentScene = currentData.nextScene;
        currentData.nextScene = currentData.queue.length > 0 ? currentData.queue.shift() : '';
        currentData.status = 'ready';
    }, { sync: 'all' });

    // Show toast
    if (nextPreview) {
        toastr.success(`OK, Cut! Proceeding to next scene: "${nextPreview}"`, 'Scene Change');
    } else {
        toastr.info('OK, Cut! No next scene defined.', 'Scene Change');
    }
}

// ============================================
// Rollback Action
// ============================================

function showRollbackConfirm() {
    const data = getChatData();
    if (!data.rollbackData) {
        toastr.warning('No rollback data available');
        return;
    }
    
    // Create confirmation popup
    const overlay = $('<div class="scripter-confirm-overlay"></div>');
    const popup = $(`
        <div class="scripter-confirm-popup">
            <p>Restore previous scene?</p>
            <div class="scripter-confirm-buttons">
                <button class="scripter-confirm-btn" id="scripter-rollback-cancel">Cancel</button>
                <button class="scripter-confirm-btn primary" id="scripter-rollback-confirm">Restore</button>
            </div>
        </div>
    `);
    
    $('body').append(overlay).append(popup);
    
    $('#scripter-rollback-cancel').on('click', () => {
        overlay.remove();
        popup.remove();
    });
    
    $('#scripter-rollback-confirm').on('click', () => {
        executeRollback();
        overlay.remove();
        popup.remove();
    });
    
    overlay.on('click', () => {
        overlay.remove();
        popup.remove();
    });
}

function executeRollback() {
    const data = getChatData();
    if (!data.rollbackData) {
        return;
    }

    updateChatData(currentData => {
        currentData.currentScene = currentData.rollbackData.currentScene;
        currentData.nextScene = currentData.rollbackData.nextScene;
        currentData.queue = [...currentData.rollbackData.queue];
        currentData.rollbackData = null;
    }, { sync: 'all' });

    toastr.success('Scene restored', 'Rollback');
}

// ============================================
// Queue Management
// ============================================

function openQueuePopup() {
    renderQueueList();
    $('#scripter-queue-popup-overlay').removeClass('hidden');
}

function closeQueuePopup() {
    $('#scripter-queue-popup-overlay').addClass('hidden');
}

function renderQueueList() {
    const data = getChatData();
    const container = $('#scripter-queue-list');
    container.empty();
    
    data.queue.forEach((scene, index) => {
        const item = $(`
            <div class="scripter-queue-item" data-index="${index}">
                <span class="scripter-queue-item-number">${index + 1}.</span>
                <textarea class="scripter-queue-item-textarea">${escapeHtml(scene)}</textarea>
                <div class="scripter-queue-item-buttons">
                    <button class="scripter-queue-item-btn move-up" title="Move up">↑</button>
                    <button class="scripter-queue-item-btn move-down" title="Move down">↓</button>
                    <button class="scripter-queue-item-btn delete" title="Delete">✕</button>
                </div>
            </div>
        `);
        container.append(item);
    });
}

function refreshQueueItemIndices(startIndex = 0) {
    $('#scripter-queue-list .scripter-queue-item').each(function(domIndex) {
        if (domIndex < startIndex) {
            return;
        }

        $(this).attr('data-index', domIndex);
        $(this).find('.scripter-queue-item-number').text(`${domIndex + 1}.`);
    });
}

function addQueueItem() {
    const data = updateChatData(currentData => {
        currentData.queue.push('');
    }, { sync: 'queue' });

    const index = data.queue.length - 1;
    const item = $(`
        <div class="scripter-queue-item" data-index="${index}">
            <span class="scripter-queue-item-number">${index + 1}.</span>
            <textarea class="scripter-queue-item-textarea"></textarea>
            <div class="scripter-queue-item-buttons">
                <button class="scripter-queue-item-btn move-up" title="Move up">↑</button>
                <button class="scripter-queue-item-btn move-down" title="Move down">↓</button>
                <button class="scripter-queue-item-btn delete" title="Delete">✕</button>
            </div>
        </div>
    `);
    $('#scripter-queue-list').append(item);
}

function updateQueueItem(index, value) {
    const data = getChatData();
    if (index >= 0 && index < data.queue.length && data.queue[index] !== value) {
        updateChatData(currentData => {
            currentData.queue[index] = value;
        }, { sync: 'queue' });
    }
}

function deleteQueueItem(index) {
    const data = getChatData();
    if (index >= 0 && index < data.queue.length) {
        updateChatData(currentData => {
            currentData.queue.splice(index, 1);
        }, { sync: 'queue' });

        $('#scripter-queue-list .scripter-queue-item').eq(index).remove();
        refreshQueueItemIndices(index);
    }
}

function moveQueueItem(index, direction) {
    const data = getChatData();
    const newIndex = index + direction;
    
    if (newIndex >= 0 && newIndex < data.queue.length) {
        updateChatData(currentData => {
            const temp = currentData.queue[index];
            currentData.queue[index] = currentData.queue[newIndex];
            currentData.queue[newIndex] = temp;
        });

        const container = $('#scripter-queue-list');
        const currentItem = container.children('.scripter-queue-item').eq(index);
        const targetItem = container.children('.scripter-queue-item').eq(newIndex);

        if (direction < 0) {
            targetItem.before(currentItem);
        } else {
            targetItem.after(currentItem);
        }

        refreshQueueItemIndices(Math.min(index, newIndex));
    }
}

function clearQueue() {
    updateChatData({ queue: [] }, { sync: 'queue' });
    $('#scripter-queue-list').empty();
    toastr.info('Queue cleared');
}

function exportQueue() {
    const data = getChatData();
    const exportText = data.queue.join('\n---\n');
    
    // Create download
    const blob = new Blob([exportText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scripter_queue.txt';
    a.click();
    URL.revokeObjectURL(url);
    
    toastr.success('Queue exported');
}

function importQueue() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt';
    
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            const content = event.target.result;
            const scenes = content.split('\n---\n').map(s => s.trim()).filter(s => s);
            
            updateChatData({ queue: scenes }, { sync: 'queue' });
            renderQueueList();
            
            toastr.success(`Imported ${scenes.length} scenes`);
        };
        reader.readAsText(file);
    };
    
    input.click();
}

// ============================================
// Collapsible Blocks
// ============================================

function toggleBlock(header) {
    // Don't toggle if inside center popup
    if (header.closest('#scripter-center-popup').length > 0) {
        return;
    }
    
    const content = header.next('.scripter-block-content');
    header.toggleClass('collapsed');
    content.toggleClass('collapsed');
}

// ============================================
// Text Area Sync (Sidebar <-> Popup)
// ============================================

function setupTextAreaSync() {
    for (const binding of CHAT_FIELD_BINDINGS) {
        for (const sourceSelector of binding.selectors) {
            bindEvent(sourceSelector, 'input change', function() {
                const value = $(this).val();

                for (const targetSelector of binding.selectors) {
                    if (targetSelector !== sourceSelector) {
                        $(targetSelector).val(value);
                    }
                }

                updateChatData({ [binding.key]: value });
            });
        }
    }
}

// ============================================
// Sidebar & Popup Toggle
// ============================================

function toggleSidebar() {
    const sidebar = $('#scripter-sidebar-popup');
    sidebar.toggleClass('hidden');
    
    if (!sidebar.hasClass('hidden')) {
        syncUIFromData();
    }
}

function closeSidebar() {
    $('#scripter-sidebar-popup').addClass('hidden');
}

function openCenterPopup() {
    closeSidebar();
    syncUIFromData();
    $('#scripter-center-popup-overlay').removeClass('hidden');
}

function closeCenterPopup() {
    $('#scripter-center-popup-overlay').addClass('hidden');
    $('#scripter-sidebar-popup').removeClass('hidden');
    syncUIFromData();
}

// ============================================
// Wand Menu & Quick Button
// ============================================

function addWandMenuItem() {
    const container = $('#extensionsMenu');

    let menuItem = $('#scripter-wand-menu-item');
    if (!menuItem.length) {
        menuItem = $(`
            <div id="scripter-wand-menu-item" class="list-group-item flex-container flexGap5">
                <div class="extensionsMenuExtensionButton fa-solid fa-clapperboard"></div>
                Scripter
            </div>
        `);
        container.append(menuItem);
    }

    bindEvent('#scripter-wand-menu-item', 'click', () => {
        toggleSidebar();
        // Close the wand menu
        $('#extensionsMenu').removeClass('openDrawer');
    });
}

function addQuickButton() {
    if ($('#scripter-quick-btn').length) {
        bindEvent('#scripter-quick-btn', 'click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleQuickButtonClick();
        });
        updateQuickButtonVisibility();
        return;
    }

    // Find the send button area
    const sendButton = $('#send_but');

    // Create quick button with Font Awesome icon
    const quickBtn = $(`
        <button id="scripter-quick-btn" title="Scripter (Ctrl+Shift+C)">
            <i class="fa-solid fa-clapperboard"></i>
        </button>
    `);

    quickBtn.on(toNamespacedEvents('click'), (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleQuickButtonClick();
    });
    
    // Insert before send button
    sendButton.before(quickBtn);
    updateQuickButtonVisibility();
}

function handleQuickButtonClick() {
    const settings = getSettings();
    
    if (settings.quickButtonAction === 'cut') {
        executeCut();
    } else {
        toggleSidebar();
    }
}

// ============================================
// Keyboard Shortcuts
// ============================================

function setupShortcuts() {
    bindEvent(document, 'keydown', (e) => {
        const settings = getSettings();

        if (!settings.enabled || !settings.shortcutEnabled) {
            return;
        }

        // Ctrl+Shift+C for CUT!
        if (e.ctrlKey && e.shiftKey && e.key === 'C') {
            e.preventDefault();
            executeCut();
        }
    });
}

// ============================================
// Settings Panel Handlers
// ============================================

function setupSettingsHandlers() {
    // Enabled checkbox
    bindEvent('#scripter-enabled', 'change', function() {
        updateSettings({ enabled: $(this).prop('checked') });
        updateQuickButtonVisibility();
    });

    // Quick button checkbox
    bindEvent('#scripter-quick-btn-enabled', 'change', function() {
        updateSettings({ quickButtonEnabled: $(this).prop('checked') });
        updateQuickButtonVisibility();
    });

    // Shortcut checkbox
    bindEvent('#scripter-shortcut-enabled', 'change', function() {
        updateSettings({ shortcutEnabled: $(this).prop('checked') });
    });

    // Theme select
    bindEvent('#scripter-theme', 'change', function() {
        const settings = updateSettings({ theme: $(this).val() });
        applyTheme(settings.theme);
    });

    // Auto resize checkbox
    bindEvent('#scripter-auto-resize', 'change', function() {
        const settings = updateSettings({ autoResize: $(this).prop('checked') });
        if (settings.autoResize) {
            scheduleSidebarWidthUpdate();
        }
    });

    // Reset width button
    bindEvent('#scripter-reset-width', 'click', () => {
        const sidebar = document.getElementById('scripter-sidebar-popup');
        if (sidebar) {
            sidebar.style.width = '350px';
            toastr.info('Sidebar width reset to default');
        }
    });

    // Quick button action checkbox
    bindEvent('#scripter-quick-btn-cut', 'change', function() {
        const settings = updateSettings({
            quickButtonAction: $(this).prop('checked') ? 'cut' : 'sidebar'
        });
        updateQuickButtonTooltip(settings);
    });

    // Save final check prompt
    bindEvent('#scripter-save-settings', 'click', () => {
        updateSettings({ finalCheckPrompt: $('#scripter-final-check-prompt').val() });
        toastr.success('Settings saved');
    });

    // Reset final check prompt
    bindEvent('#scripter-reset-settings', 'click', () => {
        $('#scripter-final-check-prompt').val(DEFAULT_FINAL_CHECK);
        updateSettings({ finalCheckPrompt: DEFAULT_FINAL_CHECK });
        toastr.info('Final check prompt reset to default');
    });

    // Clear all data
    bindEvent('#scripter-clear-all-data', 'click', () => {
        if (confirm('Are you sure you want to clear all Scripter data from all chats?')) {
            // This only clears current chat's data
            // For full clear, we'd need server-side support
            chat_metadata[MODULE_NAME] = JSON.parse(JSON.stringify(defaultChatData));
            saveChatData();
            syncUIFromData();
            toastr.info('Scripter data cleared for current chat');
        }
    });
}

// ============================================
// Event Handlers Setup
// ============================================

function setupEventHandlers() {
    for (const binding of STATUS_BUTTON_BINDINGS) {
        bindEvent(binding.selector, 'click', () => {
            const data = getChatData();
            if (data.montage || data.status === binding.status) {
                return;
            }

            updateChatData({ status: binding.status }, { sync: 'status' });
        });
    }

    for (const selector of MONTAGE_BUTTON_SELECTORS) {
        bindEvent(selector, 'click', () => {
            const data = getChatData();
            updateChatData({ montage: !data.montage }, { sync: 'status' });
        });
    }

    // CUT buttons
    bindEvent('#scripter-cut-btn', 'click', executeCut);
    bindEvent('#scripter-cut-btn-popup', 'click', executeCut);

    // Auto-action checkboxes
    bindEvent('#scripter-auto-action', 'change', function() {
        updateChatData({ autoAction: $(this).prop('checked') }, { sync: 'autoAction' });
    });
    bindEvent('#scripter-auto-action-popup', 'change', function() {
        updateChatData({ autoAction: $(this).prop('checked') }, { sync: 'autoAction' });
    });

    // Rollback buttons
    bindEvent('#scripter-rollback-btn', 'click', showRollbackConfirm);
    bindEvent('#scripter-rollback-btn-popup', 'click', showRollbackConfirm);

    // Upcoming buttons
    bindEvent('#scripter-upcoming-btn', 'click', openQueuePopup);
    bindEvent('#scripter-upcoming-btn-popup', 'click', openQueuePopup);

    // Sidebar controls
    bindEvent('#scripter-sidebar-close', 'click', closeSidebar);
    bindEvent('#scripter-popout-btn', 'click', openCenterPopup);

    // Center popup controls
    bindEvent('#scripter-center-close', 'click', closeCenterPopup);

    // Queue popup controls
    bindEvent('#scripter-queue-close', 'click', closeQueuePopup);
    bindEvent('#scripter-queue-add', 'click', addQueueItem);
    bindEvent('#scripter-queue-clear', 'click', () => {
        if (confirm('Clear all scenes from queue?')) {
            clearQueue();
        }
    });
    bindEvent('#scripter-queue-export', 'click', exportQueue);
    bindEvent('#scripter-queue-import', 'click', importQueue);

    // Queue item events (delegated)
    bindDelegatedEvent('#scripter-queue-list', 'input', '.scripter-queue-item-textarea', function() {
        const index = $(this).closest('.scripter-queue-item').data('index');
        updateQueueItem(index, $(this).val());
    });
    bindDelegatedEvent('#scripter-queue-list', 'click', '.move-up', function() {
        const index = $(this).closest('.scripter-queue-item').data('index');
        moveQueueItem(index, -1);
    });
    bindDelegatedEvent('#scripter-queue-list', 'click', '.move-down', function() {
        const index = $(this).closest('.scripter-queue-item').data('index');
        moveQueueItem(index, 1);
    });
    bindDelegatedEvent('#scripter-queue-list', 'click', '.delete', function() {
        const index = $(this).closest('.scripter-queue-item').data('index');
        deleteQueueItem(index);
    });

    // Collapsible block headers
    bindDelegatedEvent(document, 'click', '.scripter-block-header', function() {
        toggleBlock($(this));
    });
}

// ============================================
// Chat Events
// ============================================

function setupChatEvents() {
    teardownChatEvents();

    chatEventHandlers = {
        onChatChanged: () => {
            syncUIFromData();
        },
        onGenerationStarted: () => {
            console.log('[Scripter] Generation started - injecting prompt');
            injectPrompt();
        },
        onMessageReceived: () => {
            const data = getChatData();
            const settings = getSettings();

            if (!settings.enabled) {
                return;
            }

            // If auto-action is enabled and status is READY, switch to ACTION
            if (data.autoAction && data.status === 'ready' && !data.montage) {
                console.log('[Scripter] Auto-proceeding to ACTION');
                updateChatData({ status: 'action' }, { sync: 'status' });
            }
        }
    };

    eventSource.on(event_types.CHAT_CHANGED, chatEventHandlers.onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, chatEventHandlers.onGenerationStarted);
    eventSource.on(event_types.MESSAGE_RECEIVED, chatEventHandlers.onMessageReceived);
}

function teardownChatEvents() {
    if (!chatEventHandlers || typeof eventSource.off !== 'function') {
        chatEventHandlers = null;
        return;
    }

    eventSource.off(event_types.CHAT_CHANGED, chatEventHandlers.onChatChanged);
    eventSource.off(event_types.GENERATION_STARTED, chatEventHandlers.onGenerationStarted);
    eventSource.off(event_types.MESSAGE_RECEIVED, chatEventHandlers.onMessageReceived);
    chatEventHandlers = null;
}

function teardownDomEvents() {
    $(document).off(EVENT_NS);
    $(window).off(EVENT_NS);
    $('#scripter-queue-list').off(EVENT_NS);
    $('#scripter-wand-menu-item').off(EVENT_NS);
    $('#scripter-quick-btn').off(EVENT_NS);
}

function cleanupLifecycle() {
    teardownSidebarResizing();
    teardownChatEvents();
    teardownDomEvents();
}

// ============================================
// Utility Functions
// ============================================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// Initialization
// ============================================

jQuery(async () => {
    // Remove stale containers if extension hot-reloads.
    $('#scripter_settings').remove();
    $('#scripter-sidebar-popup').remove();
    $('#scripter-center-popup-overlay').remove();
    $('#scripter-queue-popup-overlay').remove();
    $('#scripter-wand-menu-item').remove();
    $('#scripter-quick-btn').remove();

    // Load settings HTML
    const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings');
    $('#extensions_settings').append(settingsHtml);
    
    // Load sidebar HTML
    const sidebarHtml = await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'sidebar');
    $('body').append(sidebarHtml);

    // Ensure hot-reloads don't accumulate handlers/observers.
    cleanupLifecycle();

    // Update Montage button text to English
    $('#scripter-montage-btn').text('MONTAGE');
    $('#scripter-montage-btn-popup').text('MONTAGE');
    
    // Add wand menu item
    addWandMenuItem();
    
    // Add quick button
    addQuickButton();
    
    // Setup all handlers
    setupEventHandlers();
    setupTextAreaSync();
    setupSettingsHandlers();
    setupShortcuts();
    setupChatEvents();
    
    // Setup sidebar resizing
    setupSidebarResizing();

    // Handle window resize
    bindEvent(window, 'resize', () => {
        scheduleSidebarWidthUpdate();
    });
    
    // Initial sync
    syncUIFromData();
    
    console.log('Scripter extension loaded');
});
