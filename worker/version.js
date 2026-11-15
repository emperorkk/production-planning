// Single source of truth: package.json "version". Bump it on EVERY merge to main.
import pkg from '../package.json';
export const VERSION = pkg.version;
