/** fixture：JavaScript（含 CommonJS 的 require 与具名导出）。 */

const path = require("node:path");

export function greet(name) {
  return `hi ${name}`;
}

export class Greeter {
  constructor(prefix) {
    this.prefix = prefix;
  }

  greet(name) {
    return this.prefix + name;
  }
}

export const VERSION = "1.0.0";

const format = (value) => `${value}`;

export default function main() {
  return format(path.join(VERSION, greet("x")));
}
