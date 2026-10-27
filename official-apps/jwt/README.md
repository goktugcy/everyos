# JWT Inspector

EveryOS's JSON Web Token inspector (`dev.everyos.jwt`). Everything happens on this device: tokens
and keys are never sent anywhere, and the app has no network access.

## What it does

- **Decode** a token (with or without `Bearer`): header and payload as JSON, each part colored.
  Broken tokens say what is wrong and where (three parts, Base64URL, JSON). Encrypted tokens
  (JWE) are recognized; they cannot be read without their private key.
- **Claims** in a table with what the registered ones mean; times (`exp`, `nbf`, `iat`,
  `auth_time`) as dates in your time zone with relative times. The status says whether the token
  is valid, expired or not valid yet, with an adjustable clock tolerance. Unsigned tokens
  (`alg: none`) are flagged.
- **Verify the signature** with a key you paste — never fetched: an HMAC secret (text, Base64
  or Base64URL) for HS256/384/512; a PEM public key, a certificate, a JWK or a JWK set (chosen by
  `kid`) for RS, PS and ES 256/384/512 and EdDSA. Results distinguish a wrong signature, a key
  of the wrong kind, a private key pasted by mistake (refused), a set without the token's `kid`
  and an unreadable key. Unsigned tokens are never accepted.
- **Export redacted claims**: personal claims (subject, name, email, phone …) are hidden by
  default; choose others, then copy or save the JSON.
- **Nothing kept by default.** The token stays in the window; _Remember the last token_ (off by
  default) keeps it on this EveryOS account. Keys are never stored.

## Permissions

| Capability        | Why                                                     |
| ----------------- | ------------------------------------------------------- |
| `storage:app`     | Only the "remember" choice and, when on, the last token |
| `clipboard:write` | Copying redacted claims                                 |
| `files:save`      | Saving redacted claims as JSON                          |

## Storage

| Key        | Value                                       |
| ---------- | ------------------------------------------- |
| `remember` | Whether to keep the last token              |
| `token`    | The last token, only while `remember` is on |

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/jwt
cd official-apps/jwt && pnpm exec everyos-app validate
```
