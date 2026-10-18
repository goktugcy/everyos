/*
 * HTTPS for EveryOS (docs/security-model.md): a one-button Tailscale Serve handler with the
 * tailnet's real certificate, and a built-in HTTPS listener for the local network with
 * certificates from EveryOS's own local certificate authority.
 */

/** Default port of the built-in local-network HTTPS listener. */
export const LAN_HTTPS_PORT = 7443;

export interface HttpsView {
  tailscale: {
    /** EveryOS turned on its Serve handler; the address it answers at. */
    url: string | null;
    enabledAt: number | null;
    enabledBy: string | null;
  };
  lan: {
    enabled: boolean;
    port: number;
    /** Accepting connections now (false while stopped, after an error or without a server). */
    listening: boolean;
    /** Why it is not listening ("port-in-use", "permission-denied", "failed"). */
    error: string | null;
    /** Addresses that work once a device trusts the certificate authority. */
    urls: string[];
    authority: { fingerprint: string; createdAt: number } | null;
    certificate: { fingerprint: string; notAfter: number; names: string[] } | null;
    /** EveryOS listens on loopback only, so other devices cannot reach either port. */
    loopbackOnly: boolean;
  };
}
