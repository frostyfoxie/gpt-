import { LLMClient } from '../lib/llm/unified-client';
import { callWithBackoff } from '../lib/rate-limit';
import { KeyManager } from '../config/keys';
import { ModelManager } from '../config/models';
import { ConversationSync } from '../lib/supabase/conversation-sync';
import { explainGeminiAuthError } from '../lib/gemini-error';
import { onActiveProjectChanged } from '../engine/active-project';

/** Cap on how much conversation history gets fed back into Miko's prompt (most recent wins). */
const MAX_CONVERSATION_PROMPT_CHARS = 6000;

export class MikoChatAdapter {
  private ai: LLMClient | null = null;
  /** The pooled key currently backing `ai` — released once the in-flight query/image call finishes. */
  private currentKey: string | null = null;
  private conversation: string[] = [];

  constructor() {
    // SSR guard before binding DOM listeners. The Gemini client is created lazily
    // (see getClient()) so a missing key never crashes app boot.
    if (typeof window !== 'undefined') {
      this.bindMikoEvents();
      (window as any).mikoAdapter = this;
      onActiveProjectChanged(() => this.rehydrateConversation());
      void this.rehydrateConversation();
    }
  }

  /**
   * Restores Miko's discussion history from Supabase (or its localStorage fallback) on load,
   * so a page refresh doesn't lose the thread of an ongoing deployment/UI conversation.
   */
  private async rehydrateConversation(): Promise<void> {
    try {
      this.conversation = [];
      const saved = await ConversationSync.load('miko');
      if (saved.length > 0) {
        this.conversation = saved;
        if (typeof (window as any).renderRestoredConversation === 'function') {
          (window as any).renderRestoredConversation('miko', this.conversation);
        }
      }
    } catch (err) {
      console.warn('[MikoChatAdapter] Failed to rehydrate conversation:', err);
    }
  }

  /** Fire-and-forget persistence — never blocks the chat turn on a network round trip. */
  private persistConversation(): void {
    void ConversationSync.save('miko', this.conversation);
  }

  /** Joins the transcript for the prompt, keeping only the most recent messages within the char budget. */
  private getConversationForPrompt(): string {
    if (this.conversation.length === 0) return '';
    let text = this.conversation.join('\n');
    if (text.length > MAX_CONVERSATION_PROMPT_CHARS) {
      text = '... [earlier messages truncated for prompt size]\n' + text.slice(-MAX_CONVERSATION_PROMPT_CHARS);
    }
    return text;
  }

  /**
   * Lazily creates (and caches) the Gemini client for Miko, throwing a friendly error only
   * at the moment a message is actually sent. Phase 3: pulls from the shared key pool
   * (keyed by whatever model Miko is currently set to) instead of a fixed 'miko' key, and
   * releases the claimed key once the call it was acquired for finishes (see
   * handleUserQuery/generateImage) so it's immediately available again for other roles.
   */
  private getClient(model: string): LLMClient {
    if (!this.ai) {
      const provider = ModelManager.getProvider(model);
      const mikoKey = KeyManager.getAvailableKey('miko', model, provider);
      this.currentKey = mikoKey;
      this.ai = new LLMClient(mikoKey, provider);
    }
    return this.ai;
  }

  /** Releases the currently-held pooled key (if any) and drops the cached client so the next call re-acquires. */
  private releaseClient(): void {
    if (this.currentKey) {
      KeyManager.releaseKey(this.currentKey);
      this.currentKey = null;
    }
    this.ai = null;
  }

  private bindMikoEvents() {
    // Hooks into the Miko tab interface in the UI
    const mikoTabBtn = document.getElementById('tab-miko');
    if (mikoTabBtn) {
      mikoTabBtn.addEventListener('click', () => this.onMikoTabSelected());
    }
  }

  private onMikoTabSelected() {
    console.log('[Miko Assistant] Active and observing codebase state.');
  }

  /**
   * Handles user inquiries sent specifically to Miko. If the user has selected an image
   * model in the model picker, this generates an image instead of text and returns it as
   * a special "__IMAGE__:<dataURL>" sentinel that the chat UI knows to render as an <img>.
   */
  public async handleUserQuery(userQuery: string): Promise<string> {
    const model = ModelManager.getModel('miko');

    this.conversation.push(`User: ${userQuery}`);
    this.persistConversation();

    if (ModelManager.isImageModel(model)) {
      const result = await this.generateImage(userQuery, model);
      // Don't store the actual data URL in the transcript — it's huge and would bloat both
      // the prompt budget and the persisted row. A short placeholder keeps the thread coherent.
      this.conversation.push(
        result.startsWith('__IMAGE__:') ? 'Miko: [Generated an image]' : `Miko: ${result}`
      );
      this.persistConversation();
      return result;
    }

    // Safely retrieve current codebase state
    const currentCodebase = typeof window !== 'undefined' ? (window as any).rootProject || {} : {};

    // Stringify with a character limit safeguard
    let codebaseContextStr = '';
    try {
      codebaseContextStr = JSON.stringify(currentCodebase, null, 2);
      if (codebaseContextStr.length > 8000) {
        codebaseContextStr = codebaseContextStr.substring(0, 8000) + '\n... [Context Truncated for Prompt Safety]';
      }
    } catch {
      codebaseContextStr = '{ "error": "Unable to serialize workspace tree" }';
    }

    const conversationBlock = this.getConversationForPrompt();

    const prompt = `You are Miko, a friendly and highly knowledgeable developer support assistant inside Theta Workbench.

Your Role:
1. Help the user with deployment questions (e.g., Git, Firebase integration, Vercel).
2. Suggest UI/UX enhancements and code optimization strategies.
3. Answer technical questions about the current project.

STRICT BOUNDARIES:
- You are an assistant ONLY.
- You CANNOT write code directly to files or trigger dev execution steps.
- Do not pretend to be Chief or issue developer orders.

Current Codebase Context:
${codebaseContextStr}

Conversation so far (the last line is the user's current message — respond to that, using the earlier lines for context so you don't re-ask or re-explain things already covered):
${conversationBlock}`;

    try {
      const ai = this.getClient(model);
      const response = await callWithBackoff<any>(() =>
        ai.models.generateContent({
          model,
          contents: prompt,
        })
      );

      const reply = response.text || 'I am observing your codebase. How can I help you deploy or refine your project?';
      this.conversation.push(`Miko: ${reply}`);
      this.persistConversation();
      return reply;
    } catch (error: any) {
      if (error?.name === 'PoolExhaustedError') {
        return `Miko Assistant Error: ${error.message}`;
      }
      if (typeof window !== 'undefined' && typeof (window as any).openApiKeysModal === 'function' && /Missing API key/i.test(error?.message || '')) {
        (window as any).openApiKeysModal();
      }
      const authExplanation = explainGeminiAuthError(error);
      return `Miko Assistant Error: ${authExplanation || 'The model request could not be completed.'}`;
    } finally {
      this.releaseClient();
    }
  }

  /** Generates an image via a Nano Banana model and returns it as a data URL sentinel string. */
  private async generateImage(userQuery: string, model: string): Promise<string> {
    try {
      const ai = this.getClient(model);
      const response = await callWithBackoff<any>(() =>
        ai.models.generateContent({
          model,
          contents: userQuery,
          config: {
            responseModalities: ['IMAGE'],
            imageConfig: { imageSize: '2K' },
          },
        })
      );

      const parts = (response as any)?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p: any) => p.inlineData?.data);

      if (imagePart) {
        const mimeType = imagePart.inlineData.mimeType || 'image/png';
        return `__IMAGE__:data:${mimeType};base64,${imagePart.inlineData.data}`;
      }

      return response.text || 'I could not generate an image from that prompt — try describing it differently.';
    } catch (error: any) {
      if (error?.name === 'PoolExhaustedError') {
        return `Miko Assistant Error (image generation): ${error.message}`;
      }
      if (typeof window !== 'undefined' && typeof (window as any).openApiKeysModal === 'function' && /Missing API key/i.test(error?.message || '')) {
        (window as any).openApiKeysModal();
      }
      const authExplanation = explainGeminiAuthError(error);
      return `Miko Assistant Error (image generation): ${authExplanation || 'Image generation is temporarily unavailable.'}`;
    } finally {
      this.releaseClient();
    }
  }

  /**
   * Renders Miko's chat response into the right panel UI.
   */
  public renderMikoMessage(text: string) {
    if (typeof window === 'undefined') return;
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;

    const msgHtml = `
      <div class="flex space-x-2.5 items-start min-w-0 max-w-full my-2">
        <div class="w-6 h-6 rounded-full bg-pink-600 flex items-center justify-center text-white shrink-0 shadow">
          <i data-lucide="sparkles" class="w-3.5 h-3.5"></i>
        </div>
        <div class="flex-1 space-y-1 min-w-0 max-w-full">
          <div class="flex items-center justify-between">
            <span class="font-semibold text-pink-400 text-xs">Miko Assistant</span>
          </div>
          <div class="bg-theta-panel border border-pink-500/20 rounded-2xl rounded-tl-none p-3 text-theta-text text-xs leading-relaxed">
            ${text}
          </div>
        </div>
      </div>
    `;

    chatMessages.insertAdjacentHTML('beforeend', msgHtml);
    if ((window as any).lucide) (window as any).lucide.createIcons();
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}
