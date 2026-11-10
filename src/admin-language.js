import { pool } from "./database.js";
export async function getAdminLanguage(ctx) {
  const id = ctx.from?.id;
  if (!id) return "en";
  try {
    const result = await pool.query(`SELECT ap.language FROM users u LEFT JOIN admin_preferences ap ON ap.user_id = u.id WHERE u.telegram_id = $1 LIMIT 1`, [id]);
    return result.rows[0]?.language === "fa" ? "fa" : "en";
  } catch (error) {
    console.error("[admin-language] lookup failed:", error.message);
    return "en";
  }
}
export function adminText(language, en, fa) { return language === "fa" ? fa : en; }
