/**
 * OpenVault Data Utilities
 *
 * Data persistence and metadata access utilities.
 */

import { getDeps } from '../deps.js';
import { extensionName, METADATA_KEY, MEMORIES_KEY, CHARACTERS_KEY, RELATIONSHIPS_KEY, LAST_PROCESSED_KEY } from '../constants.js';
import { showToast } from './dom.js';

/**
 * Log message if debug mode is enabled
 * @param {string} message
 */
function log(message) {
    const settings = getDeps().getExtensionSettings()[extensionName];
    if (settings?.debugMode) {
        getDeps().console.log(`[OpenVault] ${message}`);
    }
}

/**
 * Get OpenVault data from chat metadata
 * @returns {Object|null} Returns null if context is not available
 */
export function getOpenVaultData() {
    const context = getDeps().getContext();
    if (!context) {
        getDeps().console.warn('[OpenVault] getContext() returned null/undefined');
        return null;
    }
    if (!context.chatMetadata) {
        context.chatMetadata = {};
    }
    if (!context.chatMetadata[METADATA_KEY]) {
        context.chatMetadata[METADATA_KEY] = {
            [MEMORIES_KEY]: [],
            [CHARACTERS_KEY]: {},
            [RELATIONSHIPS_KEY]: {},
            [LAST_PROCESSED_KEY]: -1,
        };
    }
    return context.chatMetadata[METADATA_KEY];
}

/**
 * Get current chat ID for tracking across async operations
 * @returns {string|null}
 */
export function getCurrentChatId() {
    const context = getDeps().getContext();
    return context?.chatId || context?.chat_metadata?.chat_id || null;
}

/**
 * Save OpenVault data to chat metadata
 * @param {string} [expectedChatId] - If provided, verify chat hasn't changed before saving
 * @returns {Promise<boolean>} True if save succeeded, false otherwise
 */
export async function saveOpenVaultData(expectedChatId = null) {
    // If expectedChatId provided, verify we're still on the same chat
    if (expectedChatId !== null) {
        const currentId = getCurrentChatId();
        if (currentId !== expectedChatId) {
            getDeps().console.warn(`[OpenVault] Chat changed during operation (expected: ${expectedChatId}, current: ${currentId}), aborting save`);
            return false;
        }
    }

    try {
        await getDeps().saveChatConditional();
        log('Data saved to chat metadata');
        return true;
    } catch (error) {
        getDeps().console.error('[OpenVault] Failed to save data:', error);
        showToast('error', `Failed to save data: ${error.message}`);
        return false;
    }
}

/**
 * Generate a unique ID
 * @returns {string}
 */
export function generateId() {
    return `${getDeps().Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Prune memories that reference messages beyond the current chat length.
 * This handles the case when a user creates a branch from an earlier point
 * in the conversation - memories from messages that don't exist in the branch
 * should be removed.
 *
 * Also cleans up:
 * - Character states (removes references to pruned memories)
 * - Relationships (resets last_updated_message_id if beyond chat length)
 * - last_processed_message_id (resets if beyond chat length)
 *
 * @returns {{prunedMemories: number, prunedCharacterEvents: number, prunedRelationships: number}} Count of pruned items
 */
export function pruneMemoriesForBranch() {
    const context = getDeps().getContext();
    const chat = context?.chat || [];
    const chatLength = chat.length;

    const data = getOpenVaultData();
    if (!data) {
        return { prunedMemories: 0, prunedCharacterEvents: 0, prunedRelationships: 0 };
    }

    const memories = data[MEMORIES_KEY] || [];
    let prunedMemories = 0;
    let prunedCharacterEvents = 0;
    let prunedRelationships = 0;

    // If chat is empty or has no memories, nothing to prune
    if (chatLength === 0 || memories.length === 0) {
        return { prunedMemories: 0, prunedCharacterEvents: 0, prunedRelationships: 0 };
    }

    // Find memories that reference messages beyond chat length
    // A memory is invalid if ANY of its message_ids >= chatLength
    const validMemories = [];
    const prunedMemoryIds = new Set();

    for (const memory of memories) {
        const messageIds = memory.message_ids || [];
        // Check if any message ID is beyond the current chat length
        const hasInvalidMessageId = messageIds.some(id => id >= chatLength);

        if (hasInvalidMessageId) {
            prunedMemoryIds.add(memory.id);
            prunedMemories++;
            log(`Pruning memory "${memory.summary?.substring(0, 50)}..." - references message(s) beyond chat length ${chatLength}`);
        } else {
            validMemories.push(memory);
        }
    }

    // Update memories array
    if (prunedMemories > 0) {
        data[MEMORIES_KEY] = validMemories;
    }

    // Clean up character states - remove references to pruned memories
    const characterStates = data[CHARACTERS_KEY] || {};
    for (const [charName, state] of Object.entries(characterStates)) {
        if (state.known_events && Array.isArray(state.known_events)) {
            const originalLength = state.known_events.length;
            state.known_events = state.known_events.filter(eventId => !prunedMemoryIds.has(eventId));
            const removed = originalLength - state.known_events.length;
            if (removed > 0) {
                prunedCharacterEvents += removed;
                log(`Removed ${removed} known_events from character "${charName}"`);
            }
        }

        // Reset emotion_from_messages if it references messages beyond chat length
        if (state.emotion_from_messages) {
            const { min, max } = state.emotion_from_messages;
            if (max >= chatLength) {
                // Clamp to valid range or reset
                if (min >= chatLength) {
                    delete state.emotion_from_messages;
                } else {
                    state.emotion_from_messages.max = chatLength - 1;
                }
            }
        }
    }

    // Clean up relationships - reset last_updated_message_id if beyond chat length
    const relationships = data[RELATIONSHIPS_KEY] || {};
    for (const [key, relationship] of Object.entries(relationships)) {
        if (typeof relationship.last_updated_message_id === 'number' &&
            relationship.last_updated_message_id >= chatLength) {
            // Reset to the last valid message or -1
            relationship.last_updated_message_id = chatLength > 0 ? chatLength - 1 : -1;
            prunedRelationships++;
            log(`Reset last_updated_message_id for relationship "${key}"`);
        }

        // Also clean up history if it has message IDs
        if (relationship.history && Array.isArray(relationship.history)) {
            relationship.history = relationship.history.filter(h =>
                typeof h.message_id !== 'number' || h.message_id < chatLength
            );
        }
    }

    // Reset last_processed_message_id if beyond chat length
    if (typeof data[LAST_PROCESSED_KEY] === 'number' && data[LAST_PROCESSED_KEY] >= chatLength) {
        data[LAST_PROCESSED_KEY] = chatLength > 0 ? chatLength - 1 : -1;
        log(`Reset last_processed_message_id to ${data[LAST_PROCESSED_KEY]}`);
    }

    return { prunedMemories, prunedCharacterEvents, prunedRelationships };
}
