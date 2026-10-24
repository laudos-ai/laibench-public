// Browser stub for node:process (the reference agent's CLI entry point is inert in the browser).
export const stdin = { setEncoding() {}, on() {} };
export const stdout = { write() { return true; } };
export const argv: string[] = [];
export default { stdin, stdout, argv };
