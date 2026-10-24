# SSH keys for desktop apps

Apps holding `secrets:ssh` (a sensitive capability approved at install) manage the person's own
SSH keys, kept by EveryOS. Each person sees only their own keys, whatever app they use.

## Keys

- **Generate**: Ed25519, ECDSA (P-256, P-384, P-521) or RSA (3072, 4096 bits), made with Node's
  own cryptography on the server. The public key is one `authorized_keys` line; the private key is
  written in OpenSSH's own format (`openssh-key-v1`) and sealed with the server secret at once.
- **Import**: public keys only (`ssh-ed25519`, `ssh-rsa` from 2048 bits, `ecdsa-sha2-nistp*`,
  `sk-*` security keys), one line, checked: the type inside the key must match the line's type.
  Fields must consume the whole blob. RSA integers must be canonical and positive, with an odd
  modulus and an odd exponent of at least 3; the minimum size is measured in actual bits. ECDSA
  curve names must match the algorithm and points must be valid uncompressed points on that curve.
  Security keys include their required NUL-free application field.
- **Fingerprints** are `SHA256:` and the unpadded base64 digest, exactly as `ssh-keygen -l`
  prints them.
- **Organize**: rename a key and change its comment (the public line follows).
- Up to 100 keys per person; the same key cannot be listed twice.

## Private keys

A private key leaves EveryOS only through `ssh.keys.export` with `private: true`, and only after
the person confirms in a dialog the desktop draws itself (_EveryOS asks for …_, showing the key's
fingerprint). The app cannot answer or skip that dialog: the server refuses a private export the
desktop did not mark as confirmed, and so it does for deleting a key that has a private part (a
private key cannot be made again). Widgets can do neither.

An export may be protected with a passphrase (8 characters or more). EveryOS then has
`ssh-keygen` encrypt a copy in a private temporary directory (OpenSSH's bcrypt KDF and AES-256),
handing it the passphrase through an askpass helper's environment, never on the command line,
which other users of the host could read. Without `ssh-keygen` installed, a protected export
reports `HOST_CAPABILITY_UNAVAILABLE`; an unprotected one still works.

Generating, importing, metadata changes, deletion attempts and every private export (confirmed or
refused) are audited with identifiers, fingerprints and outcome metadata, never key material or
passphrases. Private exports and deletion of private keys also check the instance's window kind
on the server, even if a caller supplies a confirmation flag.

Protected export passphrases contain at least 8 characters and at most 1,023 UTF-8 bytes, with no
NUL, CR or LF. The byte and line limits match [OpenSSH's askpass reader](https://github.com/openssh/openssh-portable/blob/master/readpass.c),
which uses a 1,024-byte buffer and stops at a line break. Rejecting incompatible input prevents
silently encrypting with a truncated passphrase. Shared request schemas remain independent of
Node/DOM globals. Public wire validation follows the [OpenSSH public-key deserializer](https://github.com/openssh/openssh-portable/blob/master/sshkey.c)
and the algorithm-specific curve/security-key field contracts.

Generation uses Node's asynchronous cryptography API. Each API service permits one expensive
generation or protected-export operation at a time; another attempt receives `RATE_LIMITED` and
can retry. Metadata reads remain available. The 100-key ceiling is checked before generation
and again at insertion, including races with public imports.

## Keys on disk stay out of reach

File access never hands SSH secrets to apps, whatever the person picks: nothing inside a `.ssh`
folder except public keys (`*.pub`), not the `.ssh` folder itself (it cannot be granted, listed or
created in), and nothing named like a host key (`ssh_host_*_key`).

## Operations

`ssh.keys.list`, `ssh.keys.generate { name, type, comment }`, `ssh.keys.import { name, publicKey }`,
`ssh.keys.update { id, name, comment }`, `ssh.keys.export { id, private, passphrase? }` →
`{ text, fileName }` (save it with `files.save`), `ssh.keys.delete { id }`. Types are exported by
`@everyos/app-sdk` (`SshKey`, `SSH_KEY_TYPES`).
