# Calculator

EveryOS's calculator (`dev.everyos.calculator`): standard and scientific modes, a unit converter,
history and memory.

## What it does

- **Exact decimals.** Addition, subtraction, multiplication, division and integer powers use
  decimal arithmetic on big integers, so 0.1 + 0.2 is 0.3 and 1/3 × 3 is 1. Functions without
  exact decimal results (sin, ln …) are computed in double precision and shown to 15 significant
  digits; results are shown to 16 significant digits, in scientific notation when very large or
  small. Division keeps 40 significant digits internally.
- **Expressions.** Type or use the keypad: + − × ÷ ^ (right-associative), parentheses, unary
  minus (−2² = −4), postfix ! and % (50% = 0.5), implicit multiplication (2π, 3(4+1)), `ans`
  for the last result, `1.5e3` notation. Functions: sin, cos, tan and their inverses, sinh, cosh,
  tanh, ln, log, logb(x, base), √, ∛, root(x, n), abs, exp. Angles in degrees or radians;
  degrees give exact values where they exist (sin 30 = 0.5). Implicit multiplication binds like
  ×, so 1/2π is (1/2)π.
- **Errors** are explained (division by zero, outside a function's domain, too large, factorial
  above 3000, unknown names, incomplete expressions) instead of showing NaN or Infinity.
- **Locale.** Results use the person's number format. Where decimals are written with a comma,
  the field takes "," as the decimal point and ";" between function arguments.
- **History** of the last 200 calculations (click an expression or a result to reuse it) and
  **memory** (MC, MR, M+, M−, MS), both kept across sessions.
- **Unit converter**: length, area, volume, mass, temperature, speed, time, data (SI and IEC
  prefixes), pressure, energy and angle, with exact SI factors.

Keyboard: type expressions anywhere in the window, Enter or = calculates, Escape or Delete
clears.

## Permissions

| Capability        | Why                                       |
| ----------------- | ----------------------------------------- |
| `storage:app`     | History, memory, mode and converter state |
| `clipboard:write` | Copy result                               |

## Storage

| Key         | Value                                                |
| ----------- | ---------------------------------------------------- |
| `settings`  | Mode, angle unit, history panel shown                |
| `history`   | Up to 200 `{ expression, result, at }`, newest first |
| `memory`    | The memory value as a decimal string, or null        |
| `converter` | Category, units and value of the converter           |

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/calculator
cd official-apps/calculator && pnpm exec everyos-app validate
```
