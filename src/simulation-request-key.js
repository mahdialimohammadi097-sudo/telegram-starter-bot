export function simulationRequestKey(kind, telegramId, messageId) {
  if (!["telegram-preview", "telegram-withdraw"].includes(kind)) {
    throw new TypeError("Unsupported simulation request kind");
  }
  for (const value of [telegramId, messageId]) {
    if (!/^[1-9]\d*$/.test(String(value))) {
      throw new TypeError("Simulation request identifiers must be positive decimal integers");
    }
  }
  return kind + ":" + telegramId + ":" + messageId;
}
