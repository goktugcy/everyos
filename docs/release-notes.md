EveryOS 0.1.9 removes the extra administrator password prompt from version updates.

- Install from Settings → About or Updates → EveryOS using the signed-in administrator session
  and the existing update confirmation. No additional EveryOS password is requested or sent.
- The API also accepts passwordless installation requests. An optional password from older
  clients is accepted for upgrade compatibility and is not used.
- Current administrator permissions, session locking, CSRF, linked Linux sudo privileges,
  publisher signatures, package checks and fresh verified database/home backups still apply.
- The CLI uses the same installation contract; its initial login remains authenticated.

The publisher key and GitHub release source remain unchanged. Automatic App Store defaults,
available-port allocation, adaptive icon captions, durable Linux privilege durations, version
notifications and Home Assistant integration from previous releases are included.
