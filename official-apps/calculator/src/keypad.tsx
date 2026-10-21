import { useT } from "@everyos/app-ui";
import { Delete } from "lucide-react";
import type { ReactNode } from "react";

export type KeyAction =
  | { kind: "insert"; text: string }
  | { kind: "equals" }
  | { kind: "clear" }
  | { kind: "backspace" }
  | { kind: "negate" }
  | { kind: "reciprocal" }
  | { kind: "random" }
  | { kind: "memory-clear" }
  | { kind: "memory-recall" }
  | { kind: "memory-add" }
  | { kind: "memory-subtract" }
  | { kind: "memory-store" };

interface Key {
  label: ReactNode;
  /** The accessible name when the label is a symbol (`keys.<name>`). */
  name: string;
  action: KeyAction;
  tone?: "operator" | "accent" | "function" | "memory";
}

const insert = (text: string): KeyAction => ({ kind: "insert", text });

const MEMORY: Key[] = [
  { label: "MC", name: "memoryClear", action: { kind: "memory-clear" }, tone: "memory" },
  { label: "MR", name: "memoryRecall", action: { kind: "memory-recall" }, tone: "memory" },
  { label: "M+", name: "memoryAdd", action: { kind: "memory-add" }, tone: "memory" },
  { label: "M−", name: "memorySubtract", action: { kind: "memory-subtract" }, tone: "memory" },
  { label: "MS", name: "memoryStore", action: { kind: "memory-store" }, tone: "memory" },
];

const SCIENTIFIC: Key[] = [
  { label: "sin", name: "sin", action: insert("sin("), tone: "function" },
  { label: "cos", name: "cos", action: insert("cos("), tone: "function" },
  { label: "tan", name: "tan", action: insert("tan("), tone: "function" },
  { label: "(", name: "open", action: insert("("), tone: "function" },
  { label: ")", name: "close", action: insert(")"), tone: "function" },
  { label: "sin⁻¹", name: "asin", action: insert("asin("), tone: "function" },
  { label: "cos⁻¹", name: "acos", action: insert("acos("), tone: "function" },
  { label: "tan⁻¹", name: "atan", action: insert("atan("), tone: "function" },
  { label: "π", name: "pi", action: insert("π"), tone: "function" },
  { label: "e", name: "e", action: insert("e"), tone: "function" },
  { label: "sinh", name: "sinh", action: insert("sinh("), tone: "function" },
  { label: "cosh", name: "cosh", action: insert("cosh("), tone: "function" },
  { label: "tanh", name: "tanh", action: insert("tanh("), tone: "function" },
  { label: "x²", name: "square", action: insert("^2"), tone: "function" },
  { label: "x³", name: "cube", action: insert("^3"), tone: "function" },
  { label: "xʸ", name: "power", action: insert("^"), tone: "function" },
  { label: "√x", name: "sqrt", action: insert("√("), tone: "function" },
  { label: "∛x", name: "cbrt", action: insert("∛("), tone: "function" },
  { label: "ʸ√x", name: "root", action: insert("root("), tone: "function" },
  { label: "1/x", name: "reciprocal", action: { kind: "reciprocal" }, tone: "function" },
  { label: "ln", name: "ln", action: insert("ln("), tone: "function" },
  { label: "log", name: "log", action: insert("log("), tone: "function" },
  { label: "logᵧx", name: "logb", action: insert("logb("), tone: "function" },
  { label: "n!", name: "factorial", action: insert("!"), tone: "function" },
  { label: "|x|", name: "abs", action: insert("abs("), tone: "function" },
  { label: "eˣ", name: "exp", action: insert("exp("), tone: "function" },
  { label: "EXP", name: "exponent", action: insert("e"), tone: "function" },
  { label: "Ans", name: "ans", action: insert("ans"), tone: "function" },
  { label: "rand", name: "random", action: { kind: "random" }, tone: "function" },
  { label: ",", name: "comma", action: insert(","), tone: "function" },
];

function standard(decimal: "." | ","): Key[] {
  return [
    { label: "C", name: "clear", action: { kind: "clear" }, tone: "operator" },
    {
      label: <Delete size={18} aria-hidden />,
      name: "backspace",
      action: { kind: "backspace" },
      tone: "operator",
    },
    { label: "%", name: "percent", action: insert("%"), tone: "operator" },
    { label: "÷", name: "divide", action: insert("÷"), tone: "operator" },
    ...["7", "8", "9"].map((digit) => ({ label: digit, name: digit, action: insert(digit) })),
    { label: "×", name: "multiply", action: insert("×"), tone: "operator" as const },
    ...["4", "5", "6"].map((digit) => ({ label: digit, name: digit, action: insert(digit) })),
    { label: "−", name: "subtract", action: insert("−"), tone: "operator" as const },
    ...["1", "2", "3"].map((digit) => ({ label: digit, name: digit, action: insert(digit) })),
    { label: "+", name: "add", action: insert("+"), tone: "operator" as const },
    { label: "±", name: "negate", action: { kind: "negate" } },
    { label: "0", name: "0", action: insert("0") },
    { label: decimal, name: "decimal", action: insert(".") },
    { label: "=", name: "equals", action: { kind: "equals" }, tone: "accent" },
  ];
}

export function Keypad({
  scientific,
  decimal,
  onPress,
}: {
  scientific: boolean;
  decimal: "." | ",";
  onPress: (action: KeyAction) => void;
}) {
  const t = useT();
  const button = (key: Key) => (
    <button
      key={key.name}
      type="button"
      className="calc-key"
      data-tone={key.tone}
      aria-label={/^\d$/.test(key.name) ? key.name : t(`keys.${key.name}`)}
      title={/^\d$/.test(key.name) ? undefined : t(`keys.${key.name}`)}
      onClick={() => onPress(key.action)}
    >
      {key.label}
    </button>
  );
  return (
    <div className="calc-pad" data-scientific={scientific || undefined}>
      <div className="calc-memory-row" role="group" aria-label={t("memory.label")}>
        {MEMORY.map(button)}
      </div>
      <div className="calc-keys">
        {scientific ? (
          <div className="calc-scientific" role="group" aria-label={t("modes.scientific")}>
            {SCIENTIFIC.map((key) =>
              button(key.name === "comma" ? { ...key, label: decimal === "," ? ";" : "," } : key),
            )}
          </div>
        ) : null}
        <div className="calc-standard" role="group" aria-label={t("modes.standard")}>
          {standard(decimal).map(button)}
        </div>
      </div>
    </div>
  );
}
