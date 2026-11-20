// Simulation financial interactions are intentionally limited to a one-to-one
// conversation with the authenticated Telegram sender.
export function isPrivateSimulationChat(ctx) {
  const sender = ctx?.from?.id;
  const chat = ctx?.chat;
  return Number.isSafeInteger(sender) && sender > 0 &&
    chat?.type === "private" && chat.id === sender;
}
