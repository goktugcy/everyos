import { SUPPORTED_LOCALES, type Locale } from "@otuken/shared";
import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { applyLocale } from "../app/i18n.ts";
import { Button } from "./ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

/** Language picker. `onChange` lets signed-in users persist the choice. */
export function LanguageSwitcher({
  onChange,
  compact = false,
}: {
  onChange?: (locale: Locale) => void;
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const select = (value: string) => {
    const locale = value as Locale;
    applyLocale(locale);
    onChange?.(locale);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size={compact ? "icon" : "sm"} aria-label={t("common.language")}>
          <Languages className="size-4" aria-hidden />
          {compact ? null : <span>{t(`languages.${i18n.language as Locale}`)}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel>{t("common.language")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={i18n.language} onValueChange={select}>
          {SUPPORTED_LOCALES.map((locale) => (
            <DropdownMenuRadioItem key={locale} value={locale} lang={locale}>
              {t(`languages.${locale}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
