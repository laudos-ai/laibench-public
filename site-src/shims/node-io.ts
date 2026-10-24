// Browser stubs for node:fs/promises and node:path. The in-browser scorer never
// touches the filesystem; these exist only so the shared modules bundle.
const unavailable = (name: string) => () => { throw new Error(`${name} is not available in the browser scorer`); };
export const readFile = unavailable("fs.readFile");
export const writeFile = unavailable("fs.writeFile");
export const mkdir = unavailable("fs.mkdir");
export const readdir = unavailable("fs.readdir");
export function resolve(...parts: string[]): string { return parts.filter(Boolean).join("/").replace(/\/+/g, "/"); }
export function dirname(p: string): string { const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : "."; }
export function basename(p: string): string { return p.slice(p.lastIndexOf("/") + 1); }
export function join(...parts: string[]): string { return resolve(...parts); }
export function fileURLToPath(u: string): string { return String(u).replace(/^file:\/\//, ""); }
export function pathToFileURL(p: string): { href: string } { return { href: `file://${p}` }; }
export default { readFile, writeFile, mkdir, readdir, resolve, dirname, basename, join, fileURLToPath, pathToFileURL };
