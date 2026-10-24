import { Decimal } from "./decimal.ts";

/*
 * Unit conversion with exact factors (decimal strings, SI definitions): a value goes to the
 * category's base unit and back. Temperatures have offsets and use formulas instead.
 */

export interface Unit {
  id: string;
  /** How many base units one of this unit is. */
  factor: string;
  /** The international symbol (names are translated, symbols are not). */
  symbol: string;
}

export interface Category {
  id: string;
  units: Unit[];
}

const u = (id: string, factor: string, symbol: string): Unit => ({ id, factor, symbol });

export const CATEGORIES: readonly Category[] = [
  {
    id: "length",
    units: [
      u("mm", "0.001", "mm"),
      u("cm", "0.01", "cm"),
      u("m", "1", "m"),
      u("km", "1000", "km"),
      u("in", "0.0254", "in"),
      u("ft", "0.3048", "ft"),
      u("yd", "0.9144", "yd"),
      u("mi", "1609.344", "mi"),
      u("nmi", "1852", "NM"),
      u("um", "0.000001", "µm"),
    ],
  },
  {
    id: "area",
    units: [
      u("mm2", "0.000001", "mm²"),
      u("cm2", "0.0001", "cm²"),
      u("m2", "1", "m²"),
      u("ha", "10000", "ha"),
      u("km2", "1000000", "km²"),
      u("in2", "0.00064516", "in²"),
      u("ft2", "0.09290304", "ft²"),
      u("yd2", "0.83612736", "yd²"),
      u("acre", "4046.8564224", "ac"),
      u("mi2", "2589988.110336", "mi²"),
    ],
  },
  {
    id: "volume",
    units: [
      u("ml", "0.001", "mL"),
      u("cl", "0.01", "cL"),
      u("l", "1", "L"),
      u("m3", "1000", "m³"),
      u("cm3", "0.001", "cm³"),
      u("tsp", "0.00492892159375", "tsp"),
      u("tbsp", "0.01478676478125", "tbsp"),
      u("floz", "0.0295735295625", "fl oz"),
      u("cup", "0.2365882365", "cup"),
      u("pt", "0.473176473", "pt"),
      u("qt", "0.946352946", "qt"),
      u("gal", "3.785411784", "gal"),
      u("ukgal", "4.54609", "gal (UK)"),
    ],
  },
  {
    id: "mass",
    units: [
      u("mg", "0.000001", "mg"),
      u("g", "0.001", "g"),
      u("kg", "1", "kg"),
      u("t", "1000", "t"),
      u("oz", "0.028349523125", "oz"),
      u("lb", "0.45359237", "lb"),
      u("st", "6.35029318", "st"),
      u("ct", "0.0002", "ct"),
    ],
  },
  { id: "temperature", units: [u("c", "1", "°C"), u("f", "1", "°F"), u("k", "1", "K")] },
  {
    id: "speed",
    units: [
      u("mps", "1", "m/s"),
      u("kph", "0.27777777777777777777777777777777777778", "km/h"),
      u("mph", "0.44704", "mph"),
      u("knot", "0.51444444444444444444444444444444444444", "kn"),
      u("fps", "0.3048", "ft/s"),
    ],
  },
  {
    id: "time",
    units: [
      u("ms", "0.001", "ms"),
      u("s", "1", "s"),
      u("min", "60", "min"),
      u("h", "3600", "h"),
      u("d", "86400", "d"),
      u("wk", "604800", "wk"),
      u("yr", "31557600", "yr"),
    ],
  },
  {
    id: "data",
    units: [
      u("bit", "0.125", "bit"),
      u("B", "1", "B"),
      u("kB", "1000", "kB"),
      u("MB", "1000000", "MB"),
      u("GB", "1000000000", "GB"),
      u("TB", "1000000000000", "TB"),
      u("KiB", "1024", "KiB"),
      u("MiB", "1048576", "MiB"),
      u("GiB", "1073741824", "GiB"),
      u("TiB", "1099511627776", "TiB"),
      u("kbit", "125", "kbit"),
      u("Mbit", "125000", "Mbit"),
      u("Gbit", "125000000", "Gbit"),
    ],
  },
  {
    id: "pressure",
    units: [
      u("Pa", "1", "Pa"),
      u("kPa", "1000", "kPa"),
      u("bar", "100000", "bar"),
      u("atm", "101325", "atm"),
      u("psi", "6894.757293168361", "psi"),
      u("mmHg", "133.322387415", "mmHg"),
    ],
  },
  {
    id: "energy",
    units: [
      u("J", "1", "J"),
      u("kJ", "1000", "kJ"),
      u("cal", "4.184", "cal"),
      u("kcal", "4184", "kcal"),
      u("Wh", "3600", "Wh"),
      u("kWh", "3600000", "kWh"),
      u("eV", "0.0000000000000000001602176634", "eV"),
      u("BTU", "1055.05585262", "BTU"),
    ],
  },
  {
    id: "angle",
    units: [
      u("deg", "1", "°"),
      u("rad", "57.295779513082320876798154814105170332", "rad"),
      u("grad", "0.9", "gon"),
      u("turn", "360", "tr"),
      u("arcmin", "0.016666666666666666666666666666666666667", "′"),
      u("arcsec", "0.00027777777777777777777777777777777777778", "″"),
    ],
  },
];

export function category(id: string): Category | undefined {
  return CATEGORIES.find((entry) => entry.id === id);
}

const NINE = new Decimal(9n);
const FIVE = new Decimal(5n);
const THIRTY_TWO = new Decimal(32n);
const KELVIN = Decimal.parse("273.15");

function temperature(value: Decimal, from: string, to: string): Decimal {
  const celsius =
    from === "f"
      ? value.sub(THIRTY_TWO).mul(FIVE).div(NINE)
      : from === "k"
        ? value.sub(KELVIN)
        : value;
  if (to === "f") return celsius.mul(NINE).div(FIVE).add(THIRTY_TWO);
  if (to === "k") return celsius.add(KELVIN);
  return celsius;
}

/** `value` in `from` expressed in `to` (units of the same category). */
export function convert(categoryId: string, value: Decimal, from: string, to: string): Decimal {
  const found = category(categoryId);
  if (!found) throw new RangeError(`Unknown category ${categoryId}`);
  if (categoryId === "temperature") return temperature(value, from, to);
  const source = found.units.find((unit) => unit.id === from);
  const target = found.units.find((unit) => unit.id === to);
  if (!source || !target) throw new RangeError("Unknown unit");
  if (from === to) return value;
  return value.mul(Decimal.parse(source.factor)).div(Decimal.parse(target.factor));
}
