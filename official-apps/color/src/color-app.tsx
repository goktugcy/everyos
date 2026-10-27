import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Select,
  Spacer,
  Tabs,
  TextField,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  saveTextFile,
  useApp,
  useNarrow,
  usePersistentState,
  useT,
  useToast,
} from "@everyos/app-ui";
import { ArrowLeftRight, Copy, Pipette, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  contrast,
  cssVariables,
  gradientCss,
  harmony,
  HARMONIES,
  parseColor,
  scale,
  toHex,
  toHslString,
  toOklchString,
  toRgbString,
  wcag,
  type Gradient,
  type Harmony,
  type Rgb,
} from "./color.ts";
import { Picker } from "./picker.tsx";

type Panel = "palette" | "gradient" | "contrast" | "saved" | "theme";

interface Palette {
  id: string;
  name: string;
  colors: string[];
}

const DEFAULT_COLOR = "#0284c7";
interface StoredGradient {
  kind: "linear" | "radial";
  angle: number;
  stops: Array<{ color: string; at: number }>;
}

const DEFAULT_GRADIENT: StoredGradient = {
  kind: "linear",
  angle: 135,
  stops: [
    { color: "#0284c7", at: 0 },
    { color: "#4f46e5", at: 100 },
  ],
};

/** Unique even for two saves in the same millisecond (crypto.randomUUID needs a secure context). */
const paletteId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function useEyeDropper(): (() => Promise<string | null>) | null {
  const supported = typeof window !== "undefined" && "EyeDropper" in window;
  if (!supported) return null;
  return async () => {
    const dropper = new (
      window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }
    ).EyeDropper();
    try {
      return (await dropper.open()).sRGBHex;
    } catch {
      return null;
    }
  };
}

function Swatch({
  color,
  label,
  onPick,
  size = "md",
}: {
  color: Rgb;
  label: string;
  onPick?: () => void;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      className="cs-swatch"
      data-size={size}
      title={label}
      aria-label={label}
      onClick={onPick}
    >
      <span style={{ background: toHex(color) }} />
    </button>
  );
}

export function ColorApp() {
  const app = useApp();
  const t = useT();
  const toast = useToast();
  const narrow = useNarrow(860);
  const [hex, setHex] = usePersistentState("color", DEFAULT_COLOR);
  const [panel, setPanel] = usePersistentState<Panel>("panel", "palette");
  const [palettes, setPalettes] = usePersistentState<Palette[]>("palettes", []);
  const color = parseColor(hex) ?? parseColor(DEFAULT_COLOR)!;
  const setColor = (next: Rgb) => setHex(toHex(next));
  const pickFromScreen = useEyeDropper();

  const copy = async (text: string) => {
    try {
      await app.clipboard.writeText(text);
      toast(t("ui.copied"));
    } catch (caught) {
      toast(errorMessage(t, caught), "danger");
    }
  };

  const formats = [
    { id: "hex", value: toHex(color) },
    { id: "rgb", value: toRgbString(color) },
    { id: "hsl", value: toHslString(color) },
    { id: "oklch", value: toOklchString(color) },
  ];

  return (
    <div className="cs-app">
      <Toolbar label={t("app.name")}>
        <ToolbarTitle>{t("app.name")}</ToolbarTitle>
        <Spacer />
        {pickFromScreen ? (
          <IconButton
            label={t("actions.eyedropper")}
            icon={<Pipette size={16} aria-hidden />}
            onClick={async () => {
              const picked = await pickFromScreen();
              if (picked) setHex(picked);
            }}
          />
        ) : null}
      </Toolbar>
      <div className="cs-body" data-narrow={narrow || undefined}>
        <section className="cs-left" aria-label={t("color.section")}>
          <div
            className="cs-preview"
            style={{ "--cs-color": toHex(color) } as React.CSSProperties}
            aria-label={t("color.preview", { color: toHex(color) })}
          />
          <Picker color={color} onChange={setColor} />
          <div className="cs-formats">
            {formats.map((format) => (
              <FormatField
                key={format.id}
                id={format.id}
                value={format.value}
                onColor={setColor}
                onCopy={copy}
              />
            ))}
          </div>
        </section>
        <section className="cs-right" aria-label={t(`panels.${panel}`)}>
          <Tabs<Panel>
            label={t("panels.label")}
            value={panel}
            onChange={setPanel}
            tabs={(["palette", "gradient", "contrast", "saved", "theme"] as const).map((value) => ({
              value,
              label: t(`panels.${value}`),
            }))}
          />
          <div className="cs-panel">
            {panel === "palette" ? (
              <PalettePanel
                color={color}
                onPick={setColor}
                onCopy={copy}
                onSave={(name, colors) =>
                  setPalettes((list) => [
                    ...list,
                    { id: paletteId(), name, colors: colors.map((entry) => toHex(entry)) },
                  ])
                }
              />
            ) : panel === "gradient" ? (
              <GradientPanel color={color} onCopy={copy} />
            ) : panel === "contrast" ? (
              <ContrastPanel color={color} />
            ) : panel === "saved" ? (
              <SavedPanel
                color={color}
                palettes={palettes}
                setPalettes={setPalettes}
                onPick={setColor}
                onCopy={copy}
              />
            ) : (
              <ThemePanel color={color} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function FormatField({
  id,
  value,
  onColor,
  onCopy,
}: {
  id: string;
  value: string;
  onColor: (color: Rgb) => void;
  onCopy: (text: string) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  const valid = parseColor(draft) !== null;
  return (
    <div className="cs-format">
      <TextField
        label={t(`formats.${id}`)}
        mono
        value={draft}
        error={!valid ? t("formats.invalid") : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setDraft(value);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          const parsed = parseColor(event.target.value);
          if (parsed) onColor(parsed);
        }}
      />
      <IconButton
        size="sm"
        label={t("formats.copy", { format: t(`formats.${id}`) })}
        icon={<Copy size={14} aria-hidden />}
        onClick={() => void onCopy(value)}
      />
    </div>
  );
}

function PalettePanel({
  color,
  onPick,
  onCopy,
  onSave,
}: {
  color: Rgb;
  onPick: (color: Rgb) => void;
  onCopy: (text: string) => Promise<void>;
  onSave: (name: string, colors: Rgb[]) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [kind, setKind] = usePersistentState<Harmony>("harmony", "complementary");
  const colors = useMemo(() => harmony(color, kind), [color, kind]);
  const tones = useMemo(() => scale(color), [color]);
  return (
    <div className="cs-stack">
      <Select<Harmony>
        label={t("harmony.label")}
        value={kind}
        onChange={setKind}
        options={HARMONIES.map((value) => ({ value, label: t(`harmony.${value}`) }))}
      />
      <div className="cs-row" role="group" aria-label={t(`harmony.${kind}`)}>
        {colors.map((entry, index) => (
          <div key={index} className="cs-chip">
            <Swatch
              color={entry}
              label={t("swatch.use", { color: toHex(entry) })}
              onPick={() => onPick(entry)}
            />
            <code>{toHex(entry)}</code>
          </div>
        ))}
      </div>
      <h2>{t("scale.title")}</h2>
      <div className="cs-scale">
        {tones.map(({ step, color: tone }) => (
          <button
            key={step}
            type="button"
            className="cs-tone"
            style={{ background: toHex(tone), color: step >= 500 ? "#fff" : "#000" }}
            onClick={() => onPick(tone)}
            aria-label={t("scale.step", { step, color: toHex(tone) })}
          >
            <span>{step}</span>
            <span>{toHex(tone)}</span>
          </button>
        ))}
      </div>
      <div className="cs-row">
        <Button
          size="sm"
          icon={<Copy size={14} aria-hidden />}
          onClick={() =>
            void onCopy(
              cssVariables(
                "brand",
                tones.map((tone) => tone.color),
                tones.map((tone) => tone.step),
              ),
            )
          }
        >
          {t("scale.copyCss")}
        </Button>
        <Button
          size="sm"
          icon={<Plus size={14} aria-hidden />}
          onClick={() => {
            onSave(t(`harmony.${kind}`), colors);
            toast(t("saved.added"));
          }}
        >
          {t("harmony.save")}
        </Button>
        <Button
          size="sm"
          icon={<Plus size={14} aria-hidden />}
          onClick={() => {
            onSave(
              t("scale.title"),
              tones.map((tone) => tone.color),
            );
            toast(t("saved.added"));
          }}
        >
          {t("scale.save")}
        </Button>
      </div>
    </div>
  );
}

function GradientPanel({ color, onCopy }: { color: Rgb; onCopy: (text: string) => Promise<void> }) {
  const t = useT();
  const [stored, setStored] = usePersistentState<StoredGradient>("gradient", DEFAULT_GRADIENT);
  const gradient: Gradient = {
    kind: stored.kind,
    angle: stored.angle,
    stops: stored.stops.map((stop) => ({ color: parseColor(stop.color) ?? color, at: stop.at })),
  };
  const css = gradientCss(gradient);
  const update = (next: Partial<StoredGradient>) =>
    setStored((current) => ({ ...current, ...next }));
  return (
    <div className="cs-stack">
      <div
        className="cs-gradient"
        style={{ background: css }}
        role="img"
        aria-label={t("gradient.preview")}
      />
      <div className="cs-row">
        <Select<"linear" | "radial">
          label={t("gradient.kind")}
          value={stored.kind}
          onChange={(kind) => update({ kind })}
          options={[
            { value: "linear", label: t("gradient.linear") },
            { value: "radial", label: t("gradient.radial") },
          ]}
        />
        {stored.kind === "linear" ? (
          <label className="eui-field cs-range">
            <span className="eui-label">{t("gradient.angle", { angle: stored.angle })}</span>
            <input
              type="range"
              min={0}
              max={360}
              value={stored.angle}
              onChange={(event) => update({ angle: Number(event.target.value) })}
            />
          </label>
        ) : null}
      </div>
      <ul className="cs-stops" aria-label={t("gradient.stops")}>
        {stored.stops.map((stop, index) => (
          <li key={index}>
            <Swatch
              color={parseColor(stop.color) ?? color}
              size="sm"
              label={t("gradient.useCurrent", { number: index + 1 })}
              onPick={() =>
                update({
                  stops: stored.stops.map((entry, i) =>
                    i === index ? { ...entry, color: toHex(color) } : entry,
                  ),
                })
              }
            />
            <code>{stop.color}</code>
            <input
              type="number"
              className="eui-input cs-at"
              aria-label={t("gradient.position", { number: index + 1 })}
              min={0}
              max={100}
              value={stop.at}
              onChange={(event) => {
                const at = Math.min(100, Math.max(0, Number(event.target.value) || 0));
                update({
                  stops: stored.stops.map((entry, i) => (i === index ? { ...entry, at } : entry)),
                });
              }}
            />
            <span>%</span>
            <IconButton
              size="sm"
              label={t("gradient.remove", { number: index + 1 })}
              icon={<X size={13} aria-hidden />}
              disabled={stored.stops.length <= 2}
              onClick={() => update({ stops: stored.stops.filter((_, i) => i !== index) })}
            />
          </li>
        ))}
      </ul>
      <p className="eui-hint">{t("gradient.hint")}</p>
      <div className="cs-row">
        <Button
          size="sm"
          icon={<Plus size={14} aria-hidden />}
          disabled={stored.stops.length >= 8}
          onClick={() => update({ stops: [...stored.stops, { color: toHex(color), at: 50 }] })}
        >
          {t("gradient.add")}
        </Button>
      </div>
      <pre className="cs-code">{`background: ${css};`}</pre>
      <Button
        size="sm"
        icon={<Copy size={14} aria-hidden />}
        onClick={() => void onCopy(`background: ${css};`)}
      >
        {t("gradient.copy")}
      </Button>
    </div>
  );
}

function ContrastPanel({ color }: { color: Rgb }) {
  const t = useT();
  const [pair, setPair] = usePersistentState("contrast", {
    text: "#111827",
    background: "#ffffff",
  });
  const text = parseColor(pair.text);
  const background = parseColor(pair.background);
  const ratio = text && background ? contrast(text, background) : null;
  const levels = ratio ? wcag(ratio) : null;
  const badge = (ok: boolean, label: string) => (
    <Badge
      tone={ok ? "success" : "danger"}
    >{`${label} ${ok ? t("contrast.pass") : t("contrast.fail")}`}</Badge>
  );
  return (
    <div className="cs-stack">
      <div className="cs-row">
        <TextField
          label={t("contrast.text")}
          mono
          value={pair.text}
          error={text ? undefined : t("formats.invalid")}
          onChange={(event) => setPair((current) => ({ ...current, text: event.target.value }))}
        />
        <IconButton
          label={t("contrast.swap")}
          icon={<ArrowLeftRight size={16} aria-hidden />}
          onClick={() =>
            setPair((current) => ({ text: current.background, background: current.text }))
          }
        />
        <TextField
          label={t("contrast.background")}
          mono
          value={pair.background}
          error={background ? undefined : t("formats.invalid")}
          onChange={(event) =>
            setPair((current) => ({ ...current, background: event.target.value }))
          }
        />
      </div>
      <div className="cs-row">
        <Button
          size="sm"
          onClick={() => setPair((current) => ({ ...current, text: toHex(color) }))}
        >
          {t("contrast.useAsText")}
        </Button>
        <Button
          size="sm"
          onClick={() => setPair((current) => ({ ...current, background: toHex(color) }))}
        >
          {t("contrast.useAsBackground")}
        </Button>
      </div>
      {ratio && text && background && levels ? (
        <>
          <div className="cs-sample" style={{ color: toHex(text), background: toHex(background) }}>
            <p className="cs-sample-large">{t("contrast.sampleLarge")}</p>
            <p>{t("contrast.sample")}</p>
          </div>
          <p className="cs-ratio" aria-label={t("contrast.ratio")}>
            {ratio.toFixed(2)}:1
          </p>
          <div className="cs-row">
            {badge(levels.aa, t("contrast.aa"))}
            {badge(levels.aaLarge, t("contrast.aaLarge"))}
            {badge(levels.aaa, t("contrast.aaa"))}
            {badge(levels.aaaLarge, t("contrast.aaaLarge"))}
          </div>
          <p className="eui-hint">{t("contrast.hint")}</p>
        </>
      ) : null}
    </div>
  );
}

function SavedPanel({
  color,
  palettes,
  setPalettes,
  onPick,
  onCopy,
}: {
  color: Rgb;
  palettes: Palette[];
  setPalettes: (update: (current: Palette[]) => Palette[]) => void;
  onPick: (color: Rgb) => void;
  onCopy: (text: string) => Promise<void>;
}) {
  const app = useApp();
  const t = useT();
  const toast = useToast();
  const [name, setName] = useState("");
  return (
    <div className="cs-stack">
      <form
        className="cs-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          setPalettes((list) => [
            ...list,
            { id: paletteId(), name: name.trim().slice(0, 60), colors: [toHex(color)] },
          ]);
          setName("");
        }}
      >
        <TextField
          label={t("saved.newName")}
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          {t("saved.create")}
        </Button>
      </form>
      {palettes.length ? (
        <ul className="cs-palettes">
          {palettes.map((palette) => {
            const colors = palette.colors
              .map((entry) => parseColor(entry))
              .filter((entry): entry is Rgb => entry !== null);
            return (
              <li key={palette.id}>
                <div className="cs-palette-head">
                  <strong>{palette.name}</strong>
                  <Spacer />
                  <IconButton
                    size="sm"
                    label={t("saved.addCurrent", { name: palette.name })}
                    icon={<Plus size={14} aria-hidden />}
                    onClick={() =>
                      setPalettes((list) =>
                        list.map((entry) =>
                          entry.id === palette.id
                            ? { ...entry, colors: [...entry.colors, toHex(color)].slice(0, 32) }
                            : entry,
                        ),
                      )
                    }
                  />
                  <IconButton
                    size="sm"
                    label={t("saved.copyCss", { name: palette.name })}
                    icon={<Copy size={14} aria-hidden />}
                    onClick={() => void onCopy(cssVariables(palette.name, colors))}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        if (
                          await saveTextFile(
                            app,
                            `${palette.name}.css`,
                            cssVariables(palette.name, colors),
                            { accept: [".css"] },
                          )
                        )
                          toast(t("ui.exported"));
                      } catch (caught) {
                        toast(errorMessage(t, caught), "danger");
                      }
                    }}
                  >
                    {t("saved.exportCss")}
                  </Button>
                  <IconButton
                    size="sm"
                    label={t("saved.delete", { name: palette.name })}
                    icon={<Trash2 size={14} aria-hidden />}
                    onClick={async () => {
                      if (
                        await app.dialogs.confirm(
                          t("saved.deleteTitle", { name: palette.name }),
                          t("ui.deleteBody"),
                          { confirm: t("ui.delete"), destructive: true },
                        )
                      )
                        setPalettes((list) => list.filter((entry) => entry.id !== palette.id));
                    }}
                  />
                </div>
                <div className="cs-row">
                  {colors.map((entry, index) => (
                    <div key={`${palette.id}-${index}`} className="cs-chip">
                      <Swatch
                        color={entry}
                        size="sm"
                        label={t("swatch.use", { color: toHex(entry) })}
                        onPick={() => onPick(entry)}
                      />
                      <IconButton
                        size="sm"
                        label={t("saved.removeColor", { color: toHex(entry) })}
                        icon={<X size={12} aria-hidden />}
                        onClick={() =>
                          setPalettes((list) =>
                            list.map((item) =>
                              item.id === palette.id
                                ? { ...item, colors: item.colors.filter((_, i) => i !== index) }
                                : item,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title={t("saved.empty")} text={t("saved.emptyText")} />
      )}
    </div>
  );
}

/** "2 132 199" → a color. */
function tokenColor(value: string | undefined): Rgb | null {
  const parts = value?.trim().split(/\s+/).map(Number);
  return parts?.length === 3 && parts.every((part) => Number.isFinite(part))
    ? { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: 1 }
    : null;
}

function ThemePanel({ color }: { color: Rgb }) {
  const app = useApp();
  const t = useT();
  const [theme, setTheme] = useState(app.theme.current);
  useEffect(() => app.theme.onChange(setTheme), [app]);
  const tokens = [
    "accent",
    "accent-strong",
    "text",
    "text-muted",
    "surface",
    "inset",
    "danger",
    "success",
    "warning",
  ]
    .map((name) => ({ name, color: tokenColor(theme.tokens[`--everyos-${name}`]) }))
    .filter((entry): entry is { name: string; color: Rgb } => entry.color !== null);
  const white: Rgb = { r: 255, g: 255, b: 255, a: 1 };
  const light: Rgb = { r: 248, g: 250, b: 252, a: 1 };
  const dark: Rgb = { r: 15, g: 23, b: 42, a: 1 };
  return (
    <div className="cs-stack">
      <h2>{t("theme.current", { scheme: t(`theme.schemes.${theme.scheme}`) })}</h2>
      <div className="cs-row">
        {tokens.map((token) => (
          <div key={token.name} className="cs-chip">
            <span className="cs-token" style={{ background: toHex(token.color) }} />
            <span>{t(`theme.tokens.${token.name}`)}</span>
            <code>{toHex(token.color)}</code>
          </div>
        ))}
      </div>
      <h2>{t("theme.previewTitle")}</h2>
      <div className="cs-row cs-mocks">
        {[
          { surface: light, text: dark, label: t("theme.schemes.light") },
          { surface: dark, text: light, label: t("theme.schemes.dark") },
        ].map((mock) => (
          <div
            key={mock.label}
            className="cs-mock"
            style={{ background: toHex(mock.surface), color: toHex(mock.text) }}
            aria-label={mock.label}
          >
            <strong>{mock.label}</strong>
            <span
              className="cs-mock-button"
              style={{
                background: toHex(color),
                color: contrast(white, color) >= 3 ? "#fff" : "#000",
              }}
            >
              {t("theme.button")}
            </span>
            <span style={{ color: toHex(color) }}>{t("theme.link")}</span>
            <span className="cs-mock-toggle" style={{ background: toHex(color) }} />
            <small>
              {t("theme.linkContrast", { ratio: contrast(color, mock.surface).toFixed(2) })}
            </small>
          </div>
        ))}
      </div>
      <p className="eui-hint">{t("theme.hint")}</p>
    </div>
  );
}
