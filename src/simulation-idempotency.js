// Telegram message IDs are unique within a chat, not globally across all customers.
export function simulationRequestKey(kind, userId, messageId) {
  if (!["investment", "withdrawal"].includes(kind)) throw new Error("Unknown simulation request kind");
  if ((typeof userId === "number" && !Number.isSafeInteger(userId)) ||
      (typeof messageId === "number" && !Number.isSafeInteger(messageId))) {
    throw new Error("Unsafe numeric simulation request identity");
  }
  const user = String(userId);
  const message = String(messageId);
  if (!/^[1-9]\d*$/.test(user) || !/^[1-9]\d*$/.test(message)) {
    throw new Error("Invalid simulation request identity");
  }
  return `telegram-${kind}:${user}:${message}`;
}
