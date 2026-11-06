export const packageSafetyTr = {
  unsafeEnvironment:
    "Paket kurulumu güvenlik nedeniyle başlatılmadı: servis gerçek çekirdek modüllerine, /boot veya paket veritabanına gerekli erişimi doğrulayamadı. EveryOS servis yapılandırmasını yöneticiye kontrol ettirin; bu ortamda kuruluma zorlamayın.",
  unsafeState:
    "Paket veritabanında tamamlanmamış işlemler var. Güncelleme başarılı sayılmadı. Yeniden başlatmadan önce bir yönetici paket ve önyükleme durumunu kontrol etmeli.",
};
export const packageSafetyEn: Record<keyof typeof packageSafetyTr, string> = {
  unsafeEnvironment:
    "Package installation was blocked: the service could not verify access to the real kernel modules, /boot or package database. Have an administrator check the EveryOS service configuration; do not force installation in this environment.",
  unsafeState:
    "The package database contains unfinished operations. The update was not considered successful. An administrator should check package and boot state before restarting.",
};
