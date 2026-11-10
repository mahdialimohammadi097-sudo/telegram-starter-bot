export function createRuntimeHealthState() {
  let databaseReady = false;
  let telegramApiConnected = false;
  let telegramReceiverActive = false;
  let shuttingDown = false;

  function snapshot() {
    const telegramReady = telegramApiConnected && telegramReceiverActive;
    return {
      ready: databaseReady && telegramReady && !shuttingDown,
      database: databaseReady ? "connected" : "unavailable",
      telegram: telegramReady ? "connected" : "unavailable",
      telegramApi: telegramApiConnected ? "connected" : "unavailable",
      telegramReceiver: telegramReceiverActive ? "active" : "inactive",
      shuttingDown
    };
  }

  return {
    setDatabaseReady(value) { databaseReady = Boolean(value); },
    setTelegramApiConnected(value) { telegramApiConnected = Boolean(value); },
    setTelegramReceiverActive(value) { telegramReceiverActive = Boolean(value); },
    setShuttingDown(value) { shuttingDown = Boolean(value); },
    snapshot
  };
}
