/** Entry shim: install the TS loader, then run the check. */
import { register } from 'node:module';
register('./ts-loader.mjs', import.meta.url);
