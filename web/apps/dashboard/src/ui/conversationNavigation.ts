export const inboxUrlForConversation = (conversationId?: string) =>
  conversationId
    ? `/inbox?conversationId=${encodeURIComponent(conversationId)}`
    : "/inbox";

export const conversationIdFromLocation = () =>
  new URLSearchParams(location.search).get("conversationId") ?? undefined;
