EveryOS 0.1.49 fixes a serious Linux package-update service configuration issue.

- APT and EveryOS release services can access the host's real kernel module tree. The previous
  ProtectKernelModules=yes policy hid modules from package hooks and could cause failed kernel
  configuration or incomplete initramfs images, including during non-kernel updates.
- Package operations now check their actual filesystem namespace before running hooks. Hidden
  module trees, missing running-kernel metadata, read-only boot/package mounts or an unverifiable
  host view block the operation. The unprivileged HTTP API keeps its existing sandbox.
- Package installation audits dpkg state before mutation and after a successful command exit.
  Unfinished configuration is reported as a failure. Recovery retains its transaction until the
  environment and package state are safe; another update cannot overwrite pending recovery.
- Real systemd module visibility and isolated preflight regression checks are now part of the
  required AMD64 and ARM64 CI jobs.

Existing installations: before updating through an older EveryOS worker, a host administrator
must apply the package-service configuration migration described at
https://github.com/goktugcy/everyos/blob/main/docs/updates.md#existing-installations-affected-by-the-old-unit-policy.
Wait for all APT/dpkg/initramfs and EveryOS release operations to finish before changing or
restarting package services. Reloading systemd alone does not replace a running service namespace.

This release does not automatically repair existing initramfs images or certify their bootability.
Hosts affected by an earlier incomplete update need administrator verification of package and
boot state before rebooting; unbootable hosts need recovery outside EveryOS.
