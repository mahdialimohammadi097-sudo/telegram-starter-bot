export function createRuntimeHealthState() {
  let databaseReady = false;
  let telegramApiConnected = false;
  let telegramReceiverActive = false;
  let schedulerReady = false;
  let shuttingDown = false;

  function snapshot() {
    const telegramReady = telegramApiConnected && telegramReceiverActive;
    return {
      ready: databaseReady && telegramReady && schedulerReady && !shuttingDown,
      database: databaseReady ? "connected" : "unavailable",
      telegram: telegramReady ? "connected" : "unavailable",
      telegramApi: telegramApiConnected ? "connected" : "unavailable",
      telegramReceiver: telegramReceiverActive ? "active" : "inactive",
      scheduler: schedulerReady ? "ready" : "unavailable",
      shuttingDown
    };
  }

  return {
    setSchedulerReady(value) { schedulerReady = Boolean(value); },
    setDatabaseReady(value) { databaseReady = Boolean(value); },
    setTelegramApiConnected(value) { telegramApiConnected = Boolean(value); },
    setTelegramReceiverActive(value) { telegramReceiverActive = Boolean(value); },
    setShuttingDown(value) { shuttingDown = Boolean(value); },
    snapshot
  };
}
