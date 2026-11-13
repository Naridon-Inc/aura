// What an admin sends someone they just added. Adding a GitHub username puts
// it on the team's roster, but Aura sends no email or notification, so the
// person only finds out from this message.

export const DOWNLOAD_URL = "https://auravcs.com/download";

/** The username as typed, without a leading "@" or spaces. */
export function githubHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "");
}

/** The message to send: where to get Aura and which account to sign in with. */
export function inviteMessage(orgName: string, handle: string): string {
  return [
    `I added you to ${orgName} on Aura.`,
    `Get the app at ${DOWNLOAD_URL} and sign in with GitHub as @${handle}. You'll land in the team.`,
  ].join(" ");
}
