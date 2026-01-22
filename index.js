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

let currentChatId = '';

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
    finalCheckPrompt: DEFAULT_FINAL_CHECK
};

// ============================================
// Data Access Helpers
// ============================================

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...defaultSettings };
    }
    return extension_settings[MODULE_NAME];
}

function getChatData() {
    if (!chat_metadata[MODULE_NAME]) {
        chat_metadata[MODULE_NAME] = { ...defaultChatData };
    }
    return chat_metadata[MODULE_NAME];
}

function saveChatData() {
    saveMetadataDebounced();
}

function saveSettings() {
    saveSettingsDebounced();
}

// ============================================
// Prompt Generation
// ============================================

function generatePrompt() {
    const settings = getSettings();
    const data = getChatData();
    
    if (!settings.enabled) {
        return '';
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
    
    // Status buttons
    updateStatusButtons(data.status, data.montage);
    
    // Text areas - sidebar
    $('#scripter-caution').val(data.caution);
    $('#scripter-current-scene').val(data.currentScene);
    $('#scripter-next-scene').val(data.nextScene);
    $('#scripter-core-principle').val(data.corePrinciple);
    
    // Text areas - popup
    $('#scripter-caution-popup').val(data.caution);
    $('#scripter-current-scene-popup').val(data.currentScene);
    $('#scripter-next-scene-popup').val(data.nextScene);
    $('#scripter-core-principle-popup').val(data.corePrinciple);
    
    // Auto-action checkbox
    $('#scripter-auto-action').prop('checked', data.autoAction);
    $('#scripter-auto-action-popup').prop('checked', data.autoAction);
    
    // Queue count
    updateQueueCount();
    
    // Rollback button state
    const hasRollback = data.rollbackData !== null;
    $('#scripter-rollback-btn').prop('disabled', !hasRollback);
    $('#scripter-rollback-btn-popup').prop('disabled', !hasRollback);
    
    // Settings panel
    $('#scripter-enabled').prop('checked', settings.enabled);
    $('#scripter-quick-btn-enabled').prop('checked', settings.quickButtonEnabled);
    $('#scripter-shortcut-enabled').prop('checked', settings.shortcutEnabled);
    $('#scripter-final-check-prompt').val(settings.finalCheckPrompt);
    
    // Quick button visibility
    updateQuickButtonVisibility();
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
    const data = getChatData();
    const count = data.queue.length;
    $('#scripter-queue-count-num').text(count);
    $('#scripter-queue-count-num-popup').text(count);
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

// ============================================
// CUT! Action
// ============================================

function executeCut() {
    const data = getChatData();
    const settings = getSettings();
    
    if (!settings.enabled) {
        toastr.warning('Scripter is disabled');
        return;
    }
    
    // Save rollback data
    data.rollbackData = {
        currentScene: data.currentScene,
        nextScene: data.nextScene,
        queue: [...data.queue]
    };
    
    // Get preview for toast
    const nextPreview = data.nextScene.trim().substring(0, 20) + (data.nextScene.length > 20 ? '...' : '');
    
    // Promote scenes
    data.currentScene = data.nextScene;
    
    if (data.queue.length > 0) {
        data.nextScene = data.queue.shift();
    } else {
        data.nextScene = '';
    }
    
    // Reset status to READY
    data.status = 'ready';
    
    saveChatData();
    syncUIFromData();
    
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
    
    data.currentScene = data.rollbackData.currentScene;
    data.nextScene = data.rollbackData.nextScene;
    data.queue = [...data.rollbackData.queue];
    data.rollbackData = null;
    
    saveChatData();
    syncUIFromData();
    
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

function addQueueItem() {
    const data = getChatData();
    data.queue.push('');
    saveChatData();
    renderQueueList();
    updateQueueCount();
}

function updateQueueItem(index, value) {
    const data = getChatData();
    if (index >= 0 && index < data.queue.length) {
        data.queue[index] = value;
        saveChatData();
    }
}

function deleteQueueItem(index) {
    const data = getChatData();
    if (index >= 0 && index < data.queue.length) {
        data.queue.splice(index, 1);
        saveChatData();
        renderQueueList();
        updateQueueCount();
    }
}

function moveQueueItem(index, direction) {
    const data = getChatData();
    const newIndex = index + direction;
    
    if (newIndex >= 0 && newIndex < data.queue.length) {
        const temp = data.queue[index];
        data.queue[index] = data.queue[newIndex];
        data.queue[newIndex] = temp;
        saveChatData();
        renderQueueList();
    }
}

function clearQueue() {
    const data = getChatData();
    data.queue = [];
    saveChatData();
    renderQueueList();
    updateQueueCount();
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
            
            const data = getChatData();
            data.queue = scenes;
            saveChatData();
            renderQueueList();
            updateQueueCount();
            
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
    const content = header.next('.scripter-block-content');
    header.toggleClass('collapsed');
    content.toggleClass('collapsed');
}

// ============================================
// Text Area Sync (Sidebar <-> Popup)
// ============================================

function setupTextAreaSync() {
    // Caution
    $('#scripter-caution').on('input', function() {
        const val = $(this).val();
        $('#scripter-caution-popup').val(val);
        getChatData().caution = val;
        saveChatData();
    });
    $('#scripter-caution-popup').on('input', function() {
        const val = $(this).val();
        $('#scripter-caution').val(val);
        getChatData().caution = val;
        saveChatData();
    });
    
    // Current Scene
    $('#scripter-current-scene').on('input', function() {
        const val = $(this).val();
        $('#scripter-current-scene-popup').val(val);
        getChatData().currentScene = val;
        saveChatData();
    });
    $('#scripter-current-scene-popup').on('input', function() {
        const val = $(this).val();
        $('#scripter-current-scene').val(val);
        getChatData().currentScene = val;
        saveChatData();
    });
    
    // Next Scene
    $('#scripter-next-scene').on('input', function() {
        const val = $(this).val();
        $('#scripter-next-scene-popup').val(val);
        getChatData().nextScene = val;
        saveChatData();
    });
    $('#scripter-next-scene-popup').on('input', function() {
        const val = $(this).val();
        $('#scripter-next-scene').val(val);
        getChatData().nextScene = val;
        saveChatData();
    });
    
    // Core Principle
    $('#scripter-core-principle').on('input', function() {
        const val = $(this).val();
        $('#scripter-core-principle-popup').val(val);
        getChatData().corePrinciple = val;
        saveChatData();
    });
    $('#scripter-core-principle-popup').on('input', function() {
        const val = $(this).val();
        $('#scripter-core-principle').val(val);
        getChatData().corePrinciple = val;
        saveChatData();
    });
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
}

// ============================================
// Wand Menu & Quick Button
// ============================================

function addWandMenuItem() {
    const container = $('#extensionsMenu');
    
    const menuItem = $(`
        <div id="scripter-wand-menu-item" class="list-group-item flex-container flexGap5">
            <div class="extensionsMenuExtensionButton fa-solid fa-film"></div>
            Scripter
        </div>
    `);
    
    menuItem.on('click', () => {
        toggleSidebar();
        // Close the wand menu
        $('#extensionsMenu').removeClass('openDrawer');
    });
    
    container.append(menuItem);
}

function addQuickButton() {
    // Find the send button area
    const sendForm = $('#send_form');
    const sendButton = $('#send_but');
    
    // Create quick button
    const quickBtn = $(`
        <button id="scripter-quick-btn" title="CUT! (Ctrl+Shift+C)">🎬</button>
    `);
    
    quickBtn.on('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        executeCut();
    });
    
    // Insert before send button
    sendButton.before(quickBtn);
    updateQuickButtonVisibility();
}

// ============================================
// Keyboard Shortcuts
// ============================================

function setupShortcuts() {
    $(document).on('keydown', (e) => {
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
    $('#scripter-enabled').on('change', function() {
        const settings = getSettings();
        settings.enabled = $(this).prop('checked');
        saveSettings();
        updateQuickButtonVisibility();
    });
    
    // Quick button checkbox
    $('#scripter-quick-btn-enabled').on('change', function() {
        const settings = getSettings();
        settings.quickButtonEnabled = $(this).prop('checked');
        saveSettings();
        updateQuickButtonVisibility();
    });
    
    // Shortcut checkbox
    $('#scripter-shortcut-enabled').on('change', function() {
        const settings = getSettings();
        settings.shortcutEnabled = $(this).prop('checked');
        saveSettings();
    });
    
    // Save final check prompt
    $('#scripter-save-settings').on('click', () => {
        const settings = getSettings();
        settings.finalCheckPrompt = $('#scripter-final-check-prompt').val();
        saveSettings();
        toastr.success('Settings saved');
    });
    
    // Reset final check prompt
    $('#scripter-reset-settings').on('click', () => {
        $('#scripter-final-check-prompt').val(DEFAULT_FINAL_CHECK);
        const settings = getSettings();
        settings.finalCheckPrompt = DEFAULT_FINAL_CHECK;
        saveSettings();
        toastr.info('Final check prompt reset to default');
    });
    
    // Clear all data
    $('#scripter-clear-all-data').on('click', () => {
        if (confirm('Are you sure you want to clear all Scripter data from all chats?')) {
            // This only clears current chat's data
            // For full clear, we'd need server-side support
            chat_metadata[MODULE_NAME] = { ...defaultChatData };
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
    // Status buttons - Sidebar
    $('#scripter-ready-btn').on('click', function() {
        const data = getChatData();
        if (data.montage) return;
        data.status = 'ready';
        saveChatData();
        updateStatusButtons(data.status, data.montage);
    });
    
    $('#scripter-action-btn').on('click', function() {
        const data = getChatData();
        if (data.montage) return;
        data.status = 'action';
        saveChatData();
        updateStatusButtons(data.status, data.montage);
    });
    
    $('#scripter-montage-btn').on('click', function() {
        const data = getChatData();
        data.montage = !data.montage;
        saveChatData();
        updateStatusButtons(data.status, data.montage);
    });
    
    // Status buttons - Popup
    $('#scripter-ready-btn-popup').on('click', function() {
        const data = getChatData();
        if (data.montage) return;
        data.status = 'ready';
        saveChatData();
        updateStatusButtons(data.status, data.montage);
    });
    
    $('#scripter-action-btn-popup').on('click', function() {
        const data = getChatData();
        if (data.montage) return;
        data.status = 'action';
        saveChatData();
        updateStatusButtons(data.status, data.montage);
    });
    
    $('#scripter-montage-btn-popup').on('click', function() {
        const data = getChatData();
        data.montage = !data.montage;
        saveChatData();
        updateStatusButtons(data.status, data.montage);
    });
    
    // CUT buttons
    $('#scripter-cut-btn').on('click', executeCut);
    $('#scripter-cut-btn-popup').on('click', executeCut);
    
    // Auto-action checkboxes
    $('#scripter-auto-action').on('change', function() {
        const data = getChatData();
        data.autoAction = $(this).prop('checked');
        $('#scripter-auto-action-popup').prop('checked', data.autoAction);
        saveChatData();
    });
    
    $('#scripter-auto-action-popup').on('change', function() {
        const data = getChatData();
        data.autoAction = $(this).prop('checked');
        $('#scripter-auto-action').prop('checked', data.autoAction);
        saveChatData();
    });
    
    // Rollback buttons
    $('#scripter-rollback-btn').on('click', showRollbackConfirm);
    $('#scripter-rollback-btn-popup').on('click', showRollbackConfirm);
    
    // Upcoming buttons
    $('#scripter-upcoming-btn').on('click', openQueuePopup);
    $('#scripter-upcoming-btn-popup').on('click', openQueuePopup);
    
    // Sidebar controls
    $('#scripter-sidebar-close').on('click', closeSidebar);
    $('#scripter-popout-btn').on('click', openCenterPopup);
    
    // Center popup controls
    $('#scripter-center-close').on('click', closeCenterPopup);
    
    // Queue popup controls
    $('#scripter-queue-close').on('click', closeQueuePopup);
    $('#scripter-queue-add').on('click', addQueueItem);
    $('#scripter-queue-clear').on('click', () => {
        if (confirm('Clear all scenes from queue?')) {
            clearQueue();
        }
    });
    $('#scripter-queue-export').on('click', exportQueue);
    $('#scripter-queue-import').on('click', importQueue);
    
    // Queue item events (delegated)
    $('#scripter-queue-list').on('input', '.scripter-queue-item-textarea', function() {
        const index = $(this).closest('.scripter-queue-item').data('index');
        updateQueueItem(index, $(this).val());
    });
    
    $('#scripter-queue-list').on('click', '.move-up', function() {
        const index = $(this).closest('.scripter-queue-item').data('index');
        moveQueueItem(index, -1);
    });
    
    $('#scripter-queue-list').on('click', '.move-down', function() {
        const index = $(this).closest('.scripter-queue-item').data('index');
        moveQueueItem(index, 1);
    });
    
    $('#scripter-queue-list').on('click', '.delete', function() {
        const index = $(this).closest('.scripter-queue-item').data('index');
        deleteQueueItem(index);
    });
    
    // Collapsible block headers
    $(document).on('click', '.scripter-block-header', function() {
        toggleBlock($(this));
    });
}

// ============================================
// Chat Events
// ============================================

function setupChatEvents() {
    // When chat changes, reload data
    eventSource.on(event_types.CHAT_CHANGED, () => {
        const context = getContext();
        currentChatId = context.chatId;
        syncUIFromData();
    });
    
    // 메시지 생성 직전에 프롬프트 주입 (가장 중요!)
    eventSource.on(event_types.GENERATION_STARTED, () => {
        console.log('[Scripter] Generation started - injecting prompt');
        injectPrompt();
    });
    
    // After AI response is received, handle auto-action
    // (READY 상태에서 메시지 전송 후 AI 응답이 오면 ACTION으로 전환)
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        const data = getChatData();
        const settings = getSettings();
        
        if (!settings.enabled) return;
        
        // If auto-action is enabled and status is READY, switch to ACTION
        if (data.autoAction && data.status === 'ready' && !data.montage) {
            console.log('[Scripter] Auto-proceeding to ACTION');
            data.status = 'action';
            saveChatData();
            updateStatusButtons(data.status, data.montage);
        }
    });
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
    // Load settings HTML
    const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings');
    $('#extensions_settings').append(settingsHtml);
    
    // Load sidebar HTML
    const sidebarHtml = await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'sidebar');
    $('body').append(sidebarHtml);
    
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
    
    // Initial sync (UI만 동기화, 프롬프트는 생성 시점에 주입)
    syncUIFromData();
    
    console.log('Scripter extension loaded');
});
