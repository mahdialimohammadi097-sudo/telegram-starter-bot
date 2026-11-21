// Ignore only Telegram's idempotent unchanged-message response.
export async function editAdminMessageSafely(ctx, message, options) {
  try {
    return await ctx.editMessageText(message, options);
  } catch (error) {
    if (error?.error_code === 400 &&
        /message is not modified/i.test(error?.description ?? "")) return;
    throw error;
  }
}
