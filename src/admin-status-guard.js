const ALLOWED_USER_STATUSES = new Set(["active", "suspended"]);

export function isConfirmationCurrent(currentStatus, expectedStatus, requestedStatus) {
  return ALLOWED_USER_STATUSES.has(currentStatus) &&
    ALLOWED_USER_STATUSES.has(expectedStatus) &&
    ALLOWED_USER_STATUSES.has(requestedStatus) &&
    currentStatus === expectedStatus &&
    currentStatus !== requestedStatus;
}
