export const desktopAppNotificationsTr = {
  "desktop-app-updated": {
    title: "Uygulama otomatik güncellendi",
    body: "{{app}}, {{version}} sürümüne güncellendi. Uygulama verileriniz korundu.",
  },
  "desktop-app-update-approval": {
    title: "Uygulama güncellemesi onay bekliyor",
    body: "{{app}} {{version}} yeni izinler istiyor. Güncellemeyi Uygulama Mağazası'ndan inceleyin.",
  },
  "desktop-app-update-failed": {
    title: "Uygulama güncellenemedi",
    body: "{{app}} {{version}} kurulamadı. Mevcut sürüm korundu; daha sonra yeniden denenecek. {{reason}}",
  },
};
export const desktopAppNotificationsEn: typeof desktopAppNotificationsTr = {
  "desktop-app-updated": {
    title: "App updated automatically",
    body: "{{app}} was updated to {{version}}. Your app data was preserved.",
  },
  "desktop-app-update-approval": {
    title: "App update needs approval",
    body: "{{app}} {{version}} requests new permissions. Review the update in the App Store.",
  },
  "desktop-app-update-failed": {
    title: "App update failed",
    body: "{{app}} {{version}} could not be installed. The current version was kept; it will be retried later. {{reason}}",
  },
};
