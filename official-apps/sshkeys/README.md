# SSH Keys

Manage the signed-in user's EveryOS SSH key vault. The vault is shared with apps granted
`secrets:ssh`; it is not a view of the host's `.ssh` directory. The app never opens existing host
private-key files and has no generic file-picking capability.

- Generate Ed25519, ECDSA P-256/P-384/P-521 or RSA 3072/4096 pairs on the server.
- Import a single OpenSSH public-key line. The server validates the complete wire structure,
  curve, point or RSA modulus; private imports are not supported.
- Search public metadata, filter by private-key availability, inspect SHA-256 fingerprints,
  rename keys and edit comments. Public metadata refreshes every 15 seconds while active;
  a failed refresh keeps the previous snapshot and its retrieval time.
- Copy public keys and fingerprints or save public keys through the EveryOS picker.
- Export a private key as a passphrase-protected OpenSSH file, after EveryOS displays the
  fingerprint and asks for explicit approval. Passphrases must match, contain at least eight
  characters and at most 1,023 UTF-8 bytes, and contain no NUL or line breaks.
- Confirm public-only deletion in an EveryOS dialog. Deleting a private key requires the
  desktop's own fingerprint confirmation.

`secrets:ssh`, `files:save` and `clipboard:write` are the only app permissions. Names, comments
and encrypted private keys persist in the server vault; private fields use `SecretBox` with a
context string. The app has no app-storage permission. Drafts and passphrases stay in memory;
passphrase inputs clear before export, on cancellation, permission change and suspend. Export
results are used only for the selected file write. Late export or picker results after permission
change or suspend cannot trigger a write. JavaScript strings are garbage-collected; clearing
inputs is not a promise to overwrite process memory.

The vault holds at most 100 keys per user. One key generation or protected export runs at a time
per API service; reads remain available. Protected export requires the server's OpenSSH
`ssh-keygen` tool. The app reports unavailable tools, busy crypto, permission errors and refresh
failures. No simulated production data is used. All ten EveryOS locales are included.

See [SSH key SDK contract](../../docs/app-sdk/ssh-keys.md) for the server boundary and native
interoperability tests. Run app tests with:

```bash
pnpm exec vitest run --project official-apps official-apps/sshkeys
```

The real-browser SSH Keys workflow in `tests/e2e/official-apps.spec.ts` exercises actual key
generation, import, metadata, desktop confirmation, file exports, deletion and mobile layout.
