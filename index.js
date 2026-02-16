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
// Theme Definitions
// ============================================

const AVAILABLE_THEMES = [
    { id: 'default', name: 'Default' },
    { id: 'glassmorphism', name: 'Glassmorphism' }
];

// ============================================
// State Management
// ============================================

let resizeObserver = null;

const defaultChatData = {
    status: 'ready', // 'ready' | 'action'
    montage: false,
    autoAction: false,
    promptEnabled: true, // NEW: controls prompt injection per-chat
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
    theme: 'default',
    sidebarPosition: 'right', // 'left' | 'right'
    quickButtonClick: 'sidebar', // 'sidebar' | 'toggle' | 'cut'
    quickButtonDblClick: 'toggle' // 'sidebar' | 'toggle' | 'cut' | 'none'
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
    if (extension_settings[MODULE_NAME].sidebarPosition === undefined) {
        extension_settings[MODULE_NAME].sidebarPosition = defaultSettings.sidebarPosition;
    }
    // Migrate old quickButtonAction to new settings
    if (extension_settings[MODULE_NAME].quickButtonClick === undefined) {
        const oldAction = extension_settings[MODULE_NAME].quickButtonAction;
        extension_settings[MODULE_NAME].quickButtonClick = oldAction === 'cut' ? 'cut' : 'sidebar';
        extension_settings[MODULE_NAME].quickButtonDblClick = 'toggle';
        delete extension_settings[MODULE_NAME].quickButtonAction;
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

function applySidebarPosition(position) {
    const sidebar = $('#scripter-sidebar-popup');
    if (position === 'left') {
        sidebar.addClass('scripter-left');
    } else {
        sidebar.removeClass('scripter-left');
    }
}

// ============================================
// Sidebar Resizing
// ============================================

function setupSidebarResizing() {
    // Try multiple possible chat container selectors
    const chatContainer = document.getElementById('sheld') || document.getElementById('chat');
    
    if (chatContainer) {
        // Disconnect existing observer if any
        if (resizeObserver) {
            resizeObserver.disconnect();
        }
        
        resizeObserver = new ResizeObserver(() => {
            updateSidebarWidth();
        });
        
        resizeObserver.observe(chatContainer);
    }
    
    // Initial sizing
    updateSidebarWidth();
}

function updateSidebarWidth() {
    const sidebar = document.getElementById('scripter-sidebar-popup');
    const settings = getSettings();
    if (!sidebar || !settings.autoResize) return;

    const sheld = document.getElementById('sheld');
    const chat = document.getElementById('chat');
    const chatContainer = sheld || chat;

    let sidebarWidth = 350; // default

    if (chatContainer) {
        const viewportWidth = window.innerWidth;
        const chatRect = chatContainer.getBoundingClientRect();

        // Calculate available space based on sidebar position
        let availableSpace;
        if (settings.sidebarPosition === 'left') {
            availableSpace = chatRect.left;
        } else {
            availableSpace = viewportWidth - chatRect.right;
        }

        sidebarWidth = Math.floor(availableSpace * 0.99);
    }

    // Apply minimum width
    sidebarWidth = Math.max(350, sidebarWidth);

    sidebar.style.width = sidebarWidth + 'px';
}

// ============================================
// Prompt Generation
// ============================================

function generatePrompt() {
    const settings = getSettings();
    const data = getChatData();

    // Check both global enabled and per-chat prompt toggle
    if (!settings.enabled || !data.promptEnabled) {
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

    // Prompt toggle state (also updates quick button)
    updatePromptToggle(data.promptEnabled);

    // Settings panel
    $('#scripter-enabled').prop('checked', settings.enabled);
    $('#scripter-quick-btn-enabled').prop('checked', settings.quickButtonEnabled);
    $('#scripter-shortcut-enabled').prop('checked', settings.shortcutEnabled);
    $('#scripter-final-check-prompt').val(settings.finalCheckPrompt);
    $('#scripter-theme').val(settings.theme);
    $('#scripter-auto-resize').prop('checked', settings.autoResize);
    $('#scripter-sidebar-position').val(settings.sidebarPosition);
    $('#scripter-quick-btn-click').val(settings.quickButtonClick);
    $('#scripter-quick-btn-dblclick').val(settings.quickButtonDblClick);

    // Apply theme and sidebar position
    applyTheme(settings.theme);
    applySidebarPosition(settings.sidebarPosition);

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
    const count = data.queue.filter(item => item.trim() !== '').length;
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

function updatePromptToggle(enabled) {
    const toggles = $('#scripter-prompt-toggle, #scripter-prompt-toggle-popup');
    toggles.toggleClass('active', enabled);
    toggles.attr('title', enabled ? 'Prompt injection ON' : 'Prompt injection OFF');
    updateQuickButtonState();
}

function updateQuickButtonState() {
    const data = getChatData();
    const quickBtn = $('#scripter-quick-btn');
    quickBtn.toggleClass('prompt-off', !data.promptEnabled);
}

function updateQuickButtonTooltip() {
    const settings = getSettings();
    const actionLabels = {
        sidebar: '사이드바',
        toggle: '전송토글',
        cut: 'CUT!',
        none: '없음'
    };
    const clickLabel = actionLabels[settings.quickButtonClick];
    const dblClickLabel = actionLabels[settings.quickButtonDblClick];

    let tooltip = `클릭: ${clickLabel}`;
    if (settings.quickButtonDblClick !== 'none') {
        tooltip += ` / 더블클릭: ${dblClickLabel}`;
    }
    $('#scripter-quick-btn').attr('title', tooltip);
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
        updateQueueCount();
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

const TEXT_FIELD_MAP = [
    { id: 'caution', dataKey: 'caution' },
    { id: 'current-scene', dataKey: 'currentScene' },
    { id: 'next-scene', dataKey: 'nextScene' },
    { id: 'core-principle', dataKey: 'corePrinciple' }
];

function setupTextAreaSync() {
    TEXT_FIELD_MAP.forEach(({ id, dataKey }) => {
        const sidebarSel = `#scripter-${id}`;
        const popupSel = `#scripter-${id}-popup`;

        // Sidebar → Popup sync
        $(sidebarSel).on('input change', function() {
            const val = $(this).val();
            $(popupSel).val(val);
            getChatData()[dataKey] = val;
            saveChatData();
        });

        // Popup → Sidebar sync
        $(popupSel).on('input change', function() {
            const val = $(this).val();
            $(sidebarSel).val(val);
            getChatData()[dataKey] = val;
            saveChatData();
        });
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
    $('#scripter-sidebar-popup').removeClass('hidden');
    syncUIFromData();
}

// ============================================
// Wand Menu & Quick Button
// ============================================

function addWandMenuItem() {
    const container = $('#extensionsMenu');
    
    const menuItem = $(`
        <div id="scripter-wand-menu-item" class="list-group-item flex-container flexGap5">
            <div class="extensionsMenuExtensionButton fa-solid fa-clapperboard"></div>
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

let quickBtnClickTimer = null;
const DBLCLICK_DELAY = 250; // ms

function addQuickButton() {
    // Find the send button area
    const sendButton = $('#send_but');

    // Create quick button with Font Awesome icon
    const quickBtn = $(`
        <button id="scripter-quick-btn" title="Scripter (Click: Open, DblClick: Toggle Prompt)">
            <i class="fa-solid fa-clapperboard"></i>
        </button>
    `);

    // Handle single vs double click
    quickBtn.on('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const settings = getSettings();

        // If double-click is disabled, execute single click immediately
        if (settings.quickButtonDblClick === 'none') {
            executeQuickButtonAction(settings.quickButtonClick);
            return;
        }

        if (quickBtnClickTimer) {
            // Double click detected
            clearTimeout(quickBtnClickTimer);
            quickBtnClickTimer = null;
            executeQuickButtonAction(settings.quickButtonDblClick);
        } else {
            // Wait to see if it's a double click
            quickBtnClickTimer = setTimeout(() => {
                quickBtnClickTimer = null;
                executeQuickButtonAction(settings.quickButtonClick);
            }, DBLCLICK_DELAY);
        }
    });

    // Insert before send button
    sendButton.before(quickBtn);
    updateQuickButtonVisibility();
    updateQuickButtonState();
    updateQuickButtonTooltip();
}

function executeQuickButtonAction(action) {
    switch (action) {
        case 'sidebar':
            toggleSidebar();
            break;
        case 'toggle':
            handlePromptToggle();
            break;
        case 'cut':
            executeCut();
            break;
    }
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
    
    // Theme select
    $('#scripter-theme').on('change', function() {
        const settings = getSettings();
        settings.theme = $(this).val();
        saveSettings();
        applyTheme(settings.theme);
    });

    // Auto resize checkbox
    $('#scripter-auto-resize').on('change', function() {
        const settings = getSettings();
        settings.autoResize = $(this).prop('checked');
        saveSettings();
        if (settings.autoResize) updateSidebarWidth();
    });

    // Reset width button
    $('#scripter-reset-width').on('click', () => {
        const sidebar = document.getElementById('scripter-sidebar-popup');
        if (sidebar) {
            sidebar.style.width = '350px';
            toastr.info('Sidebar width reset to default');
        }
    });

    // Sidebar position select
    $('#scripter-sidebar-position').on('change', function() {
        const settings = getSettings();
        settings.sidebarPosition = $(this).val();
        saveSettings();
        applySidebarPosition(settings.sidebarPosition);
    });

    // Quick button click action
    $('#scripter-quick-btn-click').on('change', function() {
        const settings = getSettings();
        settings.quickButtonClick = $(this).val();
        saveSettings();
        updateQuickButtonTooltip();
    });

    // Quick button double-click action
    $('#scripter-quick-btn-dblclick').on('change', function() {
        const settings = getSettings();
        settings.quickButtonDblClick = $(this).val();
        saveSettings();
        updateQuickButtonTooltip();
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

// Helper: Set status (ready/action)
function handleStatusClick(newStatus) {
    const data = getChatData();
    if (data.montage) return;
    data.status = newStatus;
    saveChatData();
    updateStatusButtons(data.status, data.montage);
}

// Helper: Toggle montage
function handleMontageClick() {
    const data = getChatData();
    data.montage = !data.montage;
    saveChatData();
    updateStatusButtons(data.status, data.montage);
}

// Helper: Sync auto-action checkboxes
function handleAutoActionChange(checked) {
    const data = getChatData();
    data.autoAction = checked;
    $('#scripter-auto-action, #scripter-auto-action-popup').prop('checked', checked);
    saveChatData();
}

// Helper: Toggle prompt injection
function handlePromptToggle() {
    const data = getChatData();
    data.promptEnabled = !data.promptEnabled;
    saveChatData();
    updatePromptToggle(data.promptEnabled);

    if (data.promptEnabled) {
        toastr.success('Prompt injection enabled');
    } else {
        toastr.info('Prompt injection disabled');
    }
}

function setupEventHandlers() {
    // Status buttons (sidebar + popup)
    $('#scripter-ready-btn, #scripter-ready-btn-popup').on('click', () => handleStatusClick('ready'));
    $('#scripter-action-btn, #scripter-action-btn-popup').on('click', () => handleStatusClick('action'));
    $('#scripter-montage-btn, #scripter-montage-btn-popup').on('click', handleMontageClick);

    // CUT buttons
    $('#scripter-cut-btn, #scripter-cut-btn-popup').on('click', executeCut);

    // Auto-action checkboxes
    $('#scripter-auto-action, #scripter-auto-action-popup').on('change', function() {
        handleAutoActionChange($(this).prop('checked'));
    });

    // Rollback buttons
    $('#scripter-rollback-btn, #scripter-rollback-btn-popup').on('click', showRollbackConfirm);

    // Upcoming buttons
    $('#scripter-upcoming-btn, #scripter-upcoming-btn-popup').on('click', openQueuePopup);
    
    // Prompt toggle buttons
    $('#scripter-prompt-toggle, #scripter-prompt-toggle-popup').on('click', handlePromptToggle);

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
        syncUIFromData();
    });
    
    // Inject prompt before generation
    eventSource.on(event_types.GENERATION_STARTED, () => {
        console.log('[Scripter] Generation started - injecting prompt');
        injectPrompt();
    });
    
    // After AI response is received, handle auto-action
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
    $(window).on('resize', () => {
        updateSidebarWidth();
    });
    
    // Initial sync
    syncUIFromData();
    
    console.log('Scripter extension loaded');
});
