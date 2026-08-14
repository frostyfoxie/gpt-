import { LLMClient } from '../lib/llm/unified-client';
import { callWithBackoff } from '../lib/rate-limit';
import { KeyManager } from '../config/keys';
import { ModelManager } from '../config/models';
import { ConversationSync } from '../lib/supabase/conversation-sync';
import { explainGeminiAuthError } from '../lib/gemini-error';
import { onActiveProjectChanged, getActiveProjectId } from '../engine/active-project';
import { WebResearchTools } from '../tools/web-research-tools';
import { formatExternalWebContent } from '../lib/untrusted-content';
import { formatAgentContextForPrompt, getRecentAgentContext, publishAgentContext } from '../engine/agent-context';

const MAX_CONVERSATION_PROMPT_CHARS = 6000;

export class MikoChatAdapter {
  private ai: LLMClient | null = null;
  private currentKey: string | null = null;
  private conversation: string[] = [];

  constructor() {
    if (typeof window !== 'undefined') {
      this.bindMikoEvents();
      (window as any).mikoAdapter = this;
      onActiveProjectChanged(() => this.rehydrateConversation());
      void this.rehydrateConversation();
    }
  }

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

  private persistConversation(): void {
    void ConversationSync.save('miko', this.conversation);
  }

  private getConversationForPrompt(): string {
    if (!this.conversation.length) return '';
    let text = this.conversation.join('\n');
    if (text.length > MAX_CONVERSATION_PROMPT_CHARS) {
      text = '... [earlier messages truncated]\n' + text.slice(-MAX_CONVERSATION_PROMPT_CHARS);
    }
    return text;
  }

  private getClient(model: string): LLMClient {
    if (!this.ai) {
      const provider = ModelManager.getProvider(model);
      this.currentKey = KeyManager.getAvailableKey('miko', model, provider);
      this.ai = new LLMClient(this.currentKey, provider);
    }
    return this.ai;
  }

  private releaseClient(): void {
    if (this.currentKey) KeyManager.releaseKey(this.currentKey);
    this.currentKey = null;
    this.ai = null;
  }

  private bindMikoEvents() {
    const mikoTabBtn = document.getElementById('tab-miko');
    if (mikoTabBtn) mikoTabBtn.addEventListener('click', () => this.onMikoTabSelected());
  }

  private onMikoTabSelected() {
    console.log('[Miko] Conversational/research mode active.');
  }

  public async handleUserQuery(userQuery: string): Promise<string> {
    const model = ModelManager.getModel('miko');
    this.conversation.push(`User: ${userQuery}`);
    this.persistConversation();

    if (ModelManager.isImageModel(model)) {
      const result = await this.generateImage(userQuery, model);
      this.conversation.push(result.startsWith('__IMAGE__:') ? 'Miko: [Generated an image]' : `Miko: ${result}`);
      this.persistConversation();
      publishAgentContext({ projectId: getActiveProjectId() ?? undefined, source: 'miko', kind: 'observation', text: `Miko handled the user's request: ${userQuery}` });
      return result;
    }

    const currentCodebase = typeof window !== 'undefined' ? (window as any).rootProject || {} : {};
    let codebaseContextStr = '';
    try {
      codebaseContextStr = JSON.stringify(currentCodebase, null, 2);
      if (codebaseContextStr.length > 8000) codebaseContextStr = codebaseContextStr.substring(0, 8000) + '\n... [truncated]';
    } catch {
      codebaseContextStr = '{ "error": "Unable to serialize workspace tree" }';
    }

    let webContext = '';
    if (/(https?:\/\/|research|documentation|docs|latest|current|inspiration|reference|awwwards|design|library|api)/i.test(userQuery)) {
      try {
        const result = await WebResearchTools.research({
          query: userQuery,
          mode: /design|inspiration|awwwards/i.test(userQuery) ? 'ui-ux' : 'current-tech',
          projectId: getActiveProjectId() ?? undefined,
        });
        if (result.ok) {
          webContext = formatExternalWebContent(
            result.sources.map((s) => s.uri).join(', ') || 'web research',
            JSON.stringify({ summary: result.summary, technicalUpdates: result.technicalUpdates, designPatterns: result.designPatterns, sources: result.sources }, null, 2)
          );
        }
      } catch (error) {
        console.warn('[Miko] Web research unavailable:', error);
      }
    }

    const sharedContext = formatAgentContextForPrompt(getRecentAgentContext(getActiveProjectId() ?? undefined, 12, 'miko'));
    const conversationBlock = this.getConversationForPrompt();
    const prompt = `You are Miko, Theta's conversational and research assistant.

You may READ the current codebase and research the web, but you MUST NOT modify files, run coding tasks, or pretend that you executed changes. Chief is the sole project mutation/execution authority.

Current codebase context:
${codebaseContextStr}

Shared observations from Chief:
${sharedContext}

Live web research, when available:
${webContext || '(no web research was needed)'}

Conversation:
${conversationBlock}

Respond naturally to the user's latest message. If you notice something Chief should know, state it clearly so the shared context can carry it to Chief.`;

    try {
      const ai = this.getClient(model);
      const response = await callWithBackoff<any>(() => ai.models.generateContent({ model, contents: prompt }));
      const reply = response.text || 'I am observing the project. How can I help?';
      this.conversation.push(`Miko: ${reply}`);
      this.persistConversation();
      publishAgentContext({ projectId: getActiveProjectId() ?? undefined, source: 'miko', kind: 'observation', text: reply });
      return reply;
    } catch (error: any) {
      if (error?.name === 'PoolExhaustedError') return `Miko Assistant Error: ${error.message}`;
      if (typeof window !== 'undefined' && typeof (window as any).openApiKeysModal === 'function' && /Missing API key/i.test(error?.message || '')) {
        (window as any).openApiKeysModal();
      }
      const authExplanation = explainGeminiAuthError(error);
      return `Miko Assistant Error: ${authExplanation || 'The model request could not be completed.'}`;
    } finally {
      this.releaseClient();
    }
  }

  private async generateImage(userQuery: string, model: string): Promise<string> {
    try {
      const ai = this.getClient(model);
      const response = await callWithBackoff<any>(() => ai.models.generateContent({
        model,
        contents: userQuery,
        config: { responseModalities: ['IMAGE'], imageConfig: { imageSize: '2K' } },
      }));
      const parts = (response as any)?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p: any) => p.inlineData?.data);
      if (imagePart) {
        const mimeType = imagePart.inlineData.mimeType || 'image/png';
        return `__IMAGE__:data:${mimeType};base64,${imagePart.inlineData.data}`;
      }
      return response.text || 'I could not generate an image from that prompt.';
    } catch (error: any) {
      const authExplanation = explainGeminiAuthError(error);
      return `Miko Assistant Error (image generation): ${authExplanation || error.message || 'Image generation is temporarily unavailable.'}`;
    } finally {
      this.releaseClient();
    }
  }

  public renderMikoMessage(text: string) {
    if (typeof window === 'undefined') return;
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    const msgHtml = `<div class="flex space-x-2.5 items-start min-w-0 max-w-full my-2"><div class="w-6 h-6 rounded-full bg-pink-600 flex items-center justify-center text-white shrink-0 shadow"><i data-lucide="sparkles" class="w-3.5 h-3.5"></i></div><div class="flex-1 space-y-1 min-w-0 max-w-full"><div class="font-semibold text-pink-400 text-xs">Miko</div><div class="bg-theta-panel border border-pink-500/20 rounded-2xl rounded-tl-none p-3 text-theta-text text-xs leading-relaxed">${text}</div></div></div>`;
    chatMessages.insertAdjacentHTML('beforeend', msgHtml);
    if ((window as any).lucide) (window as any).lucide.createIcons();
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}
