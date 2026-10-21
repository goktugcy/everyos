# SSH keys for desktop apps

Apps holding `secrets:ssh` (a sensitive capability approved at install) manage the person's own
SSH keys, kept by EveryOS. Each person sees only their own keys, whatever app they use.

## Keys

- **Generate**: Ed25519, ECDSA (P-256, P-384, P-521) or RSA (3072, 4096 bits), made with Node's
  own cryptography on the server. The public key is one `authorized_keys` line; the private key is
  written in OpenSSH's own format (`openssh-key-v1`) and sealed with the server secret at once.
- **Import**: public keys only (`ssh-ed25519`, `ssh-rsa` from 2048 bits, `ecdsa-sha2-nistp*`,
  `sk-*` security keys), one line, checked: the type inside the key must match the line's type.
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

Generating, importing, deleting and every private export (confirmed or refused) are audited with
the key's id and fingerprint, never key material.

## Keys on disk stay out of reach

File access never hands SSH secrets to apps, whatever the person picks: nothing inside a `.ssh`
folder except public keys (`*.pub`), not the `.ssh` folder itself (it cannot be granted, listed or
created in), and nothing named like a host key (`ssh_host_*_key`).

## Operations

`ssh.keys.list`, `ssh.keys.generate { name, type, comment }`, `ssh.keys.import { name, publicKey }`,
`ssh.keys.update { id, name, comment }`, `ssh.keys.export { id, private, passphrase? }` →
`{ text, fileName }` (save it with `files.save`), `ssh.keys.delete { id }`. Types are exported by
`@everyos/app-sdk` (`SshKey`, `SSH_KEY_TYPES`).
