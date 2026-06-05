import { useEffect, useState } from "react";
import AppShell, { type AgentStatus } from "./components/layout/AppShell";
import ConversationSidebar from "./features/conversations/ConversationSidebar";
import ChatPanel from "./features/chat/ChatPanel";
import WorkspacePanel from "./features/workspace/WorkspacePanel";
import QuickFillModal from "./features/onboarding/QuickFillModal";
import { usePlan } from "./lib/usePlan";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  postChatMessage,
  type ChatMessage,
  type ChatTurnStatus,
  type Conversation,
  type ConversationSummary,
} from "./lib/api";

const ACTIVE_KEY = "hpo:activeConversationId";

export default function App() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_KEY),
  );
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [lastStatus, setLastStatus] = useState<ChatTurnStatus | null>(null);
  const [quickFillOpen, setQuickFillOpen] = useState(false);

  const refreshList = () =>
    listConversations().then(setConversations).catch(() => {});

  useEffect(() => {
    refreshList();
  }, []);

  // Load the active conversation whenever the id changes.
  useEffect(() => {
    if (!conversationId) {
      setConversation(null);
      setSelectedVersionId(null);
      localStorage.removeItem(ACTIVE_KEY);
      return;
    }
    localStorage.setItem(ACTIVE_KEY, conversationId);
    let active = true;
    getConversation(conversationId)
      .then((c) => {
        if (!active) return;
        setConversation(c);
        setSelectedVersionId(c.versions[c.versions.length - 1]?.version_id ?? null);
      })
      .catch(() => {
        if (active) setConversationId(null); // stale id
      });
    return () => {
      active = false;
    };
  }, [conversationId]);

  const selectedVersion =
    conversation?.versions.find((v) => v.version_id === selectedVersionId) ?? null;
  const activePlanId = selectedVersion?.plan_id ?? null;
  const { plan, status: planStatus } = usePlan(activePlanId);

  const newChat = async () => {
    const c = await createConversation();
    setConversation(c);
    setConversationId(c.id);
    setSelectedVersionId(null);
    setLastStatus(null);
    refreshList();
  };

  const selectConversation = (id: string) => {
    if (id !== conversationId) {
      setLastStatus(null);
      setConversationId(id);
    }
  };

  const removeConversation = async (id: string) => {
    await deleteConversation(id);
    if (id === conversationId) setConversationId(null);
    refreshList();
  };

  const sendMessage = async (content: string) => {
    setSending(true);
    try {
      let conv = conversation;
      if (!conv) {
        conv = await createConversation();
        setConversation(conv);
        setConversationId(conv.id);
      }
      const optimistic: ChatMessage = {
        role: "user",
        content,
        created_at: new Date().toISOString(),
      };
      setConversation((c) =>
        c ? { ...c, messages: [...c.messages, optimistic] } : c,
      );
      const resp = await postChatMessage(conv.id, content, selectedVersionId);
      setConversation(resp.conversation);
      setLastStatus(resp.status);
      if (resp.version) setSelectedVersionId(resp.version.version_id);
      refreshList();
    } catch {
      const err: ChatMessage = {
        role: "assistant",
        content: "⚠ Something went wrong. Please try again.",
        created_at: new Date().toISOString(),
      };
      setConversation((c) => (c ? { ...c, messages: [...c.messages, err] } : c));
    } finally {
      setSending(false);
    }
  };

  const status: AgentStatus = sending
    ? "running"
    : activePlanId && planStatus === "pending"
      ? "running"
      : plan
        ? "done"
        : "ready";

  return (
    <AppShell
      status={status}
      sidebar={
        <ConversationSidebar
          conversations={conversations}
          activeId={conversationId}
          onSelect={selectConversation}
          onNew={newChat}
          onDelete={removeConversation}
        />
      }
      chat={
        <ChatPanel
          conversation={conversation}
          sending={sending}
          lastStatus={lastStatus}
          onSend={sendMessage}
          onQuickFill={() => setQuickFillOpen(true)}
        />
      }
      workspace={
        <WorkspacePanel
          planId={activePlanId}
          versions={conversation?.versions ?? []}
          selectedVersionId={selectedVersionId}
          onSelectVersion={setSelectedVersionId}
          plan={plan}
          planStatus={planStatus}
        />
      }
      modal={
        quickFillOpen ? (
          <QuickFillModal
            onClose={() => setQuickFillOpen(false)}
            onSubmit={sendMessage}
          />
        ) : null
      }
    />
  );
}
