/**
 * Test support: give a test file the runtime's own `fetch`, `Request` and
 * `Response` back.
 *
 * The view tests install happy-dom's browser globals for the whole test
 * process. A browser's `Request` drops headers a page may not set — `Origin`
 * among them — and its streams are not Bun's, so anything that exercises real
 * HTTP semantics has to run on the native ones. Importing this module *first*
 * restores them before any other import is evaluated: `unregister` puts the
 * globals back synchronously and only its own clean-up is asynchronous.
 *
 * Safe in any file order. The view tests register happy-dom again when they
 * load, and `bun test --isolate` makes all of this moot.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator';

if (GlobalRegistrator.isRegistered) void GlobalRegistrator.unregister();
