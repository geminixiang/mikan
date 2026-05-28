# Mama Chrome Extension MVP

Load this directory as an unpacked Chrome extension to pair a browser with a mama conversation.

1. Start mama with `MAMA_LINK_URL` or `MAMA_LINK_PORT`.
2. In chat, run `/pi-login browser`.
3. Open the extension popup, enter the server URL and pairing code.
4. Try commands in the same conversation:
   - `browser list`
   - `browser tabs`
   - `browser open https://example.com`
   - `browser active`
   - `browser reload`
   - `browser screenshot`
   - `browser inspect`
   - `browser wait text:Example Domain`
   - `browser reload-until text:Example Domain 5`
   - `browser find iframe`
   - `browser iframes player.gliacloud.com`

This MVP is intentionally broad: once paired, mama can operate tabs in this Chrome profile.
