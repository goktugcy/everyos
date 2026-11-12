export const remoteAccessTr = {
  title: "Uzaktan Erişim",
  description: "VPN bağlantılarınızı, cihazları ve ağ tercihlerini tek yerden yönetin.",
  tailscaleDescription: "Tailnet'inize güvenli erişim",
  netbirdDescription: "Bulut veya kendi sunucunuz",
  installDescription:
    "Bağlanmaya başlamak için sağlayıcıyı kurun. Diğer VPN kurulumlarınız ve bağlantılarınız korunur.",
  connectionChecks: "Bağlantı denetimi",
  acceptDNSHint: "Sağlayıcının DNS sunucularını ve arama alanlarını kullanır.",
  acceptRoutesHint: "Paylaşılan ağlara bu VPN üzerinden erişilmesini sağlar.",
  tailscale: "Tailscale",
  netbird: "NetBird",
  provider: "VPN sağlayıcısı",
  refresh: "Durumu yenile",
  state_connected: "Bağlı",
  state_connecting: "Bağlanıyor",
  state_disconnected: "Bağlı değil",
  state_needsLogin: "Kayıt gerekiyor",
  state_needsApproval: "Yönetici onayı gerekiyor",
  state_unknown: "Bilinmiyor",
  notInstalled: "Kurulu değil",
  unavailable: "Arka plan servisine ulaşılamıyor",
  simulated: "Simüle veri · Bu geliştirme ortamı gerçek VPN'i değiştirmez.",
  install: "Kur",
  connect: "Bağlan",
  reconnect: "Yeniden bağlan",
  disconnect: "Bağlantıyı kes",
  configure: "Bağlantı ayarları",
  save: "Ayarları kaydet",
  saved: "Ayarlar kaydedildi. Bir sonraki bağlantıda uygulanacak.",
  settingsHint:
    "Kaydedilen ayarlar bir sonraki Bağlan işleminde uygulanır; mevcut bağlantıyı kendiliğinden değiştirmez.",
  saveFirst: "Bağlanmadan önce değiştirdiğiniz ayarları kaydedin.",
  management: "Yönetim sunucusu",
  mode: "NetBird sunucusu",
  cloud: "NetBird Cloud",
  selfHosted: "Kendi sunucum",
  managementHint:
    "Yalnızca HTTPS sunucu adresi kullanın; kullanıcı adı, parola, sorgu veya yol eklemeyin.",
  acceptDNS: "Sağlayıcının DNS ayarlarını kullan",
  acceptRoutes: "Sağlayıcının ağ rotalarını kabul et",
  credential: "Kayıt anahtarı",
  credentialHint:
    "İlk kayıt için sağlayıcı panelindeki auth/setup key'i girin. Önceden kayıtlı cihazda boş bırakabilirsiniz. EveryOS bu anahtarı saklamaz.",
  host: "Cihaz",
  version: "Sürüm",
  addresses: "VPN adresleri",
  dns: "DNS yönetimi",
  routes: "Etkin VPN rotaları",
  exitNode: "Exit node kullanımı",
  exitNodeAdvertisement: "Exit node sunumu",
  exitNodeHint:
    "Kullanım, bu cihazın trafiğini bir VPN çıkışına göndermesidir. Duyuru, bu cihazı diğer cihazlara çıkış olarak sunar; sağlayıcı onayı gerekebilir. Okunamayan durumlar Bilinmiyor olarak gösterilir.",
  approvalHint:
    "Bu cihaz sağlayıcının yönetim panelinde onay bekliyor. Onayladıktan sonra durumu yenileyin.",
  registeredCredentialHint:
    "Bu Tailscale cihazı zaten kayıtlı. Mevcut SSH, exit node ve diğer tercihleri koruyarak bağlanmak için anahtar alanını boş bırakın.",
  yes: "Evet",
  no: "Hayır",
  unknown: "Bilinmiyor",
  none: "Yok",
  peers: "Cihazlar",
  peerCounts: "{{online}} / {{total}} çevrimiçi",
  showPeers: "Cihazları göster",
  hidePeers: "Cihazları gizle",
  noPeers: "Bu sağlayıcı için başka cihaz görünmüyor.",
  peersPrivate: "Diğer cihazların ad ve adreslerini yalnızca yöneticiler görebilir.",
  peer: "Cihaz",
  connection: "Bağlantı",
  traffic: "Alınan / gönderilen",
  direct: "Doğrudan",
  relay: "Aktarmalı",
  idle: "Boşta",
  lastSeen: "Son görülme",
  diagnostics: "Tailscale ayrıntıları ve Serve",
  viewer:
    "Bu görünüm salt okunur. Kurulum ve bağlantı değişiklikleri yönetici ve yetkilendirilmiş Linux hesabı gerektirir.",
  confirmConnect: "{{provider}} bağlantısını başlat",
  confirmReconnect: "{{provider}} bağlantısını yeniden başlat",
  reconnectHint:
    "Kaydedilen ayarların uygulanması için bu NetBird bağlantısı kısa süre kesilip yeniden kurulacak. EveryOS'a bu VPN üzerinden erişiyorsanız erişiminiz kesilebilir; başka bir erişim yolunuz olsun. Diğer VPN değiştirilmez.",
  connectHint:
    "Kaydedilen DNS ve rota ayarları bu sağlayıcıya uygulanacak. Diğer VPN bağlantısı kapatılmaz.",
  confirmDisconnect: "{{provider}} bağlantısını kes",
  disconnectHint:
    "EveryOS'a bu VPN üzerinden bağlıysanız erişiminiz kesilebilir. Başka bir erişim yolunuz olduğundan emin olun. Diğer sağlayıcı değiştirilmez.",
  confirmInstall: "{{provider}} kurulumunu başlat",
  installHint:
    "İmzalı paket APT ile kurulacak. Gerekirse {{repository}} resmî paket deposu eklenir. Diğer VPN kaldırılmaz veya kapatılmaz.",
  configureRepository: "Gerekirse resmî imzalı paket deposunu ekle",
  acknowledge:
    "Diğer VPN'in aktif olduğunu ve DNS, ağ rotası veya exit node çakışması olabileceğini anladım.",
  installationUnsupported:
    "Otomatik kurulum yalnızca desteklenen Debian/Ubuntu sistemlerinde kullanılabilir.",
  stage_preparing: "Kurulum hazırlanıyor",
  stage_refreshing: "Paket listeleri yenileniyor",
  stage_installing: "Paket kuruluyor",
  stage_checking: "Kurulum doğrulanıyor",
  stage_done: "Kurulum tamamlandı",
  installSucceeded: "Kurulum tamamlandı. Kayıt anahtarıyla bağlanabilirsiniz.",
  installFailed: "Kurulum tamamlanamadı",
  installationRunning: "Kurulum agent tarafından sürdürülüyor; bu pencereyi kapatabilirsiniz.",
  warning_multipleActive: "Birden fazla VPN aktif. EveryOS sağlayıcıları kendiliğinden kapatmaz.",
  warning_dns: "İki sağlayıcı da DNS yönetiyor. Ad çözümleme ve arama alanları çakışabilir.",
  warning_subnet:
    "VPN ağ rotaları kesişiyor. Aynı hedef için birden fazla yol var; trafik beklenmeyen sağlayıcıya gidebilir.",
  warning_exitNode:
    "İki sağlayıcının da varsayılan rotası / exit node'u aktif. İnternet trafiği ve geri dönüş yolları çakışabilir.",
  warning_routePolicy:
    "İki sağlayıcı da ağ rotalarını kabul ediyor. Yeni rotalar eklendiğinde çakışma oluşabilir.",
  warning_visibility:
    "Bazı DNS veya rota bilgileri okunamadı. EveryOS çakışma olmadığını doğrulayamıyor.",
  error_AUTH_REQUIRED: "Bu cihaz için kayıt anahtarı gerekli.",
  error_PROVIDER_SETTINGS: "Bu ayarlar seçilen VPN sağlayıcısı için geçerli değil.",
  error_APPROVAL_REQUIRED: "Bu cihaz sağlayıcının yönetim panelinde yönetici onayı bekliyor.",
  error_ALREADY_REGISTERED:
    "Bu Tailscale cihazı zaten kayıtlı. Anahtar alanını boş bırakıp tekrar bağlanın; yeniden kayıt mevcut tercihleri değiştirebilir.",
  error_SETTINGS_NOT_APPLIED:
    "VPN istemcisi istenen ayarları uygulamadı. İstemci/servis sürümlerini ve yönetim politikasını kontrol edin; EveryOS mevcut tercihleri sıfırlamaz.",
  error_NOT_INSTALLED: "Sağlayıcı kurulu değil.",
  error_DAEMON_UNAVAILABLE: "VPN servisi başlatılamadı veya okunamadı.",
  error_STATUS_UNAVAILABLE: "VPN durumu veya cihaz listesi okunamadı.",
  error_COMMAND_FAILED:
    "VPN işlemi tamamlanamadı. Yönetim sunucusunu, anahtarı ve servis durumunu kontrol edin.",
  error_CREDENTIAL_INPUT_UNAVAILABLE:
    "EveryOS kayıt anahtarını VPN istemcisine güvenli biçimde aktaramadı. EveryOS'u güncelleyin ve sistemin Python 3 desteğini kontrol edin.",
  error_AUTH_REJECTED:
    "VPN sağlayıcısı kayıt anahtarını kabul etmedi. Auth/Setup Key'in süresini, iptal durumunu, kullanım sınırını ve doğru hesaba ait olduğunu kontrol edin.",
  error_PEER_IDENTITY_CONFLICT:
    "Bu cihaz farklı bir kullanıcı veya kayıt yöntemiyle zaten kayıtlı. NetBird hesabındaki mevcut cihaz kaydını kontrol edin.",
  error_CERTIFICATE_FAILED:
    "VPN yönetim sunucusunun TLS sertifikası doğrulanamadı. Sistem saatini ve sunucunun sertifika zincirini kontrol edin.",
  error_CONFIGURATION_LOCKED:
    "NetBird servisi yapılandırma değişikliklerine kapalı. Sunucu veya istemci yöneticinizin belirlediği politikayı kontrol edin.",
  error_NETWORK_UNREACHABLE:
    "VPN yönetim sunucusuna ulaşılamadı. İnternet bağlantısını, DNS'i ve varsa proxy veya güvenlik duvarı ayarlarını kontrol edin.",
  error_COMMAND_TIMEOUT:
    "VPN işlemi zaman aşımına uğradı. Durumu yenileyip yönetim sunucusuna erişimi kontrol edin.",
  error_CONFLICT_ACK_REQUIRED: "Diğer VPN aktif. Durumu yenileyip çakışma uyarısını onaylayın.",
  error_VERSION_UNSUPPORTED:
    "Kurulu istemci bu güvenli bağlantı seçeneklerini desteklemiyor. İstemciyi güncelleyin.",
  error_BUSY: "Başka bir VPN işlemi sürüyor.",
  error_INSTALL_UNSUPPORTED: "Bu sistemde otomatik kurulum desteklenmiyor.",
  error_REPOSITORY_REQUIRED:
    "Paket deposu yapılandırılmamış. Resmî depoyu ekleme seçeneğini onaylayın.",
  error_REPOSITORY_KEY: "Resmî paket deposunun imza anahtarı doğrulanamadı. Kurulum durduruldu.",
  error_REPOSITORY_CONFLICT:
    "Mevcut paket deposu veya anahtar dosyasıyla çakışma var. Mevcut dosyaların içeriği değiştirilmedi.",
  error_REPOSITORY_PERMISSIONS:
    "Paket deposu dosyaları APT'nin okuyabileceği izinlerle hazırlanamadı. Anahtar ve depo dizinlerinin izinlerini kontrol edin.",
  error_PACKAGE_BUSY: "Paket yöneticisi başka bir işlem yapıyor. Tamamlanmasını bekleyin.",
  error_REFRESH_FAILED: "Paket listeleri yenilenemedi.",
  error_REFRESH_SIGNATURE:
    "Bir paket deposunun imzası doğrulanamadı. Depo anahtarlarını ve APT'nin anahtar dosyalarını okuyabildiğini kontrol edin.",
  error_REFRESH_NETWORK:
    "Paket depolarına ulaşılamadı. İnternet bağlantısını, DNS'i ve varsa proxy ayarlarını kontrol edin.",
  error_REFRESH_REPOSITORY:
    "Bir paket deposunun adresi veya yapılandırması geçersiz ya da depo bilgileri güncel değil. Linux paket kaynaklarını kontrol edin.",
  error_REFRESH_PERMISSIONS:
    "APT, paket listesi veya anahtar dosyalarına erişemedi. Paket dizinlerinin izinlerini ve dosya sisteminin yazılabilir olduğunu kontrol edin.",
  error_REFRESH_SPACE: "Paket listelerini yenilemek için yeterli boş disk alanı yok.",
  error_PACKAGE_UNAVAILABLE: "İmzalı depoda kurulabilir paket bulunamadı.",
  error_PACKAGE_VERSION: "Paket sürümü geçersiz.",
  error_INSTALL_FAILED: "VPN paketi kurulamadı. Paket yöneticisi durumunu kontrol edin.",
  error_INSTALL_VERIFY_FAILED: "Kurulum sonrası VPN istemcisi bulunamadı.",
  error_INSTALL_EVERYOS_VERSION:
    "Kurulu EveryOS sürümü güvenle sabitlenemedi; paket kurulumu durduruldu.",
};
export const remoteAccessEn: Record<keyof typeof remoteAccessTr, string> = {
  title: "Remote Access",
  description: "Manage your VPN connections, devices and network preferences in one place.",
  tailscaleDescription: "Secure access to your tailnet",
  netbirdDescription: "Cloud or your own server",
  installDescription:
    "Install this provider to start connecting. Your other VPN installations and connections are preserved.",
  connectionChecks: "Connection checks",
  acceptDNSHint: "Uses the provider's DNS servers and search domains.",
  acceptRoutesHint: "Allows access to shared networks through this VPN.",
  tailscale: "Tailscale",
  netbird: "NetBird",
  provider: "VPN provider",
  refresh: "Refresh status",
  state_connected: "Connected",
  state_connecting: "Connecting",
  state_disconnected: "Disconnected",
  state_needsLogin: "Registration required",
  state_needsApproval: "Administrator approval required",
  state_unknown: "Unknown",
  notInstalled: "Not installed",
  unavailable: "The background service is unavailable",
  simulated: "Simulated data · This development environment does not change a real VPN.",
  install: "Install",
  connect: "Connect",
  reconnect: "Reconnect",
  disconnect: "Disconnect",
  configure: "Connection settings",
  save: "Save settings",
  saved: "Settings saved. They apply the next time you connect.",
  settingsHint:
    "Saved settings apply the next time you choose Connect; they do not change the current connection automatically.",
  saveFirst: "Save changed settings before connecting.",
  management: "Management server",
  mode: "NetBird server",
  cloud: "NetBird Cloud",
  selfHosted: "Self-hosted",
  managementHint: "Use an HTTPS server address without credentials, a query or a path.",
  acceptDNS: "Use the provider's DNS settings",
  acceptRoutes: "Accept the provider's network routes",
  credential: "Registration key",
  credentialHint:
    "For initial registration, enter the auth/setup key from your provider's dashboard. Leave blank for an already registered device. EveryOS does not save this key.",
  host: "Device",
  version: "Version",
  addresses: "VPN addresses",
  dns: "DNS control",
  routes: "Active VPN routes",
  exitNode: "Uses an exit node",
  exitNodeAdvertisement: "Offers an exit node",
  exitNodeHint:
    "Use sends this device's traffic through a VPN exit. Advertisement offers this device as an exit to other devices; provider approval may be required. Unreadable states are shown as Unknown.",
  approvalHint:
    "This device is awaiting approval in the provider's administration console. Refresh status after approving it.",
  registeredCredentialHint:
    "This Tailscale device is already registered. Leave the key empty to reconnect while preserving SSH, exit-node and other preferences.",
  yes: "Yes",
  no: "No",
  unknown: "Unknown",
  none: "None",
  peers: "Devices",
  peerCounts: "{{online}} / {{total}} online",
  showPeers: "Show devices",
  hidePeers: "Hide devices",
  noPeers: "No other devices are visible for this provider.",
  peersPrivate: "Only administrators can see other devices' names and addresses.",
  peer: "Device",
  connection: "Connection",
  traffic: "Received / sent",
  direct: "Direct",
  relay: "Relayed",
  idle: "Idle",
  lastSeen: "Last seen",
  diagnostics: "Tailscale details and Serve",
  viewer:
    "This view is read-only. Installation and connection changes require an administrator and an authorized Linux account.",
  confirmConnect: "Connect {{provider}}",
  confirmReconnect: "Reconnect {{provider}}",
  reconnectHint:
    "This NetBird connection will briefly disconnect and reconnect to apply the saved settings. If you access EveryOS through this VPN, you may lose access; have another access path available. The other VPN is unchanged.",
  connectHint:
    "Saved DNS and route settings will be applied to this provider. The other VPN stays connected.",
  confirmDisconnect: "Disconnect {{provider}}",
  disconnectHint:
    "If you access EveryOS through this VPN, you may lose access. Make sure you have another way in. The other provider is unchanged.",
  confirmInstall: "Install {{provider}}",
  installHint:
    "APT will install the signed package, adding the official {{repository}} repository if needed. The other VPN is not removed or stopped.",
  configureRepository: "Add the official signed package repository if needed",
  acknowledge:
    "I understand the other VPN is active and DNS, network routes or exit nodes may conflict.",
  installationUnsupported:
    "Automatic installation is available only on supported Debian/Ubuntu systems.",
  stage_preparing: "Preparing installation",
  stage_refreshing: "Refreshing package lists",
  stage_installing: "Installing package",
  stage_checking: "Verifying installation",
  stage_done: "Installation finished",
  installSucceeded: "Installation completed. You can now connect using a registration key.",
  installFailed: "Installation failed",
  installationRunning: "The agent is continuing installation; you can close this window.",
  warning_multipleActive:
    "Multiple VPNs are active. EveryOS never turns a provider off automatically.",
  warning_dns: "Both providers manage DNS. Name resolution and search domains may conflict.",
  warning_subnet:
    "VPN network routes overlap. Traffic to the same destination may use an unexpected provider.",
  warning_exitNode:
    "Both providers have active default routes / exit nodes. Internet traffic and return paths may conflict.",
  warning_routePolicy: "Both providers accept network routes. New routes may introduce conflicts.",
  warning_visibility:
    "Some DNS or route data could not be read. EveryOS cannot confirm that there are no conflicts.",
  error_AUTH_REQUIRED: "A registration key is required for this device.",
  error_PROVIDER_SETTINGS: "These settings are not valid for the selected VPN provider.",
  error_APPROVAL_REQUIRED:
    "This device is awaiting administrator approval in the provider's administration console.",
  error_ALREADY_REGISTERED:
    "This Tailscale device is already registered. Clear the key and reconnect; enrolling again could change existing preferences.",
  error_SETTINGS_NOT_APPLIED:
    "The VPN client did not apply the requested settings. Check client/service versions and management policy; EveryOS does not reset existing preferences.",
  error_NOT_INSTALLED: "The provider is not installed.",
  error_DAEMON_UNAVAILABLE: "The VPN service could not be started or read.",
  error_STATUS_UNAVAILABLE: "VPN status or devices could not be read.",
  error_COMMAND_FAILED:
    "The VPN operation failed. Check the management server, key and service status.",
  error_CREDENTIAL_INPUT_UNAVAILABLE:
    "EveryOS could not securely pass the registration key to the VPN client. Update EveryOS and check the system's Python 3 support.",
  error_AUTH_REJECTED:
    "The VPN provider rejected the registration key. Check the Auth/Setup Key's expiry, revocation, usage limit and that it belongs to the correct account.",
  error_PEER_IDENTITY_CONFLICT:
    "This device is already registered under a different user or registration method. Check the existing device in your NetBird account.",
  error_CERTIFICATE_FAILED:
    "The VPN management server's TLS certificate could not be verified. Check the system clock and the server's certificate chain.",
  error_CONFIGURATION_LOCKED:
    "The NetBird service does not allow configuration changes. Check the policy set by your server or client administrator.",
  error_NETWORK_UNREACHABLE:
    "The VPN management server could not be reached. Check the internet connection, DNS and any proxy or firewall settings.",
  error_COMMAND_TIMEOUT:
    "The VPN operation timed out. Refresh status and check access to the management server.",
  error_CONFLICT_ACK_REQUIRED:
    "The other VPN is active. Refresh status and acknowledge the conflict warning.",
  error_VERSION_UNSUPPORTED:
    "The installed client does not support these secure connection options. Update the client.",
  error_BUSY: "Another VPN operation is in progress.",
  error_INSTALL_UNSUPPORTED: "Automatic installation is unsupported on this system.",
  error_REPOSITORY_REQUIRED:
    "The package repository is not configured. Allow adding the official repository.",
  error_REPOSITORY_KEY:
    "The official repository signing key could not be verified. Installation was stopped.",
  error_REPOSITORY_CONFLICT:
    "An existing repository or key file conflicts. Its contents were not changed.",
  error_REPOSITORY_PERMISSIONS:
    "Repository files could not be prepared with permissions readable by APT. Check the keyring and source directory permissions.",
  error_PACKAGE_BUSY: "The package manager is busy. Wait for the other operation to finish.",
  error_REFRESH_FAILED: "Package lists could not be refreshed.",
  error_REFRESH_SIGNATURE:
    "A package repository signature could not be verified. Check repository keys and ensure APT can read the key files.",
  error_REFRESH_NETWORK:
    "Package repositories could not be reached. Check the internet connection, DNS and any proxy settings.",
  error_REFRESH_REPOSITORY:
    "A package repository address or configuration is invalid, or its metadata is out of date. Check the Linux package sources.",
  error_REFRESH_PERMISSIONS:
    "APT could not access package-list or key files. Check package directory permissions and that the filesystem is writable.",
  error_REFRESH_SPACE: "There is not enough free disk space to refresh package lists.",
  error_PACKAGE_UNAVAILABLE: "No installable package was found in the signed repository.",
  error_PACKAGE_VERSION: "The package version is invalid.",
  error_INSTALL_FAILED: "The VPN package could not be installed. Check the package manager state.",
  error_INSTALL_VERIFY_FAILED: "The VPN client was not found after installation.",
  error_INSTALL_EVERYOS_VERSION:
    "The installed EveryOS version could not be pinned safely; package installation was stopped.",
};
