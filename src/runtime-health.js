export function createRuntimeHealthState() {
  let databaseReady = false;
  let telegramReady = false;
  let shuttingDown = false;

  function snapshot() {
    return {
      ready: databaseReady && telegramReady && !shuttingDown,
      database: databaseReady ? "connected" : "unavailable",
      telegram: telegramReady ? "connected" : "unavailable",
      shuttingDown
    };
  }

  return {
    setDatabaseReady(value) {
      databaseReady = Boolean(value);
    },
    setTelegramReady(value) {
      telegramReady = Boolean(value);
    },
    setShuttingDown(value) {
      shuttingDown = Boolean(value);
    },
    snapshot
  };
}
