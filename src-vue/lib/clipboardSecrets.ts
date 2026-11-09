/** The clipboard outlives the view that initiated the copy. */
export function clearCopiedSecretLater(copiedValue: string): void {
  setTimeout(async () => {
    try {
      if ((await navigator.clipboard.readText()) === copiedValue) {
        await navigator.clipboard.writeText('');
      }
    } catch {
      // Clipboard access can be revoked while the app is in the background.
    }
  }, 180_000);
}
