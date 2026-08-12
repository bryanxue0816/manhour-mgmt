import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server bundle at .next/standalone (D-007: the target is an
  // on-premises box, so the deployment artefact has to be copyable rather than
  // `npm install`-able - the intranet has no registry access).
  //
  // What standalone does NOT copy, and why each omission matters here:
  //   - `public/` and `.next/static/` are excluded by design. Next documents this;
  //     they must be copied alongside or every asset 404s while pages still render,
  //     which looks like a CSS bug rather than a missing-files bug.
  //   - `prisma/` (schema + migrations) is not traced, because nothing in the request
  //     path imports it - `migrate deploy` is a separate CLI step at release time.
  //   - the `.node` addon for better-sqlite3 IS traced, but only because
  //     serverExternalPackages above keeps it out of the bundle; if that list ever
  //     loses better-sqlite3, tracing follows a bundled copy instead and the addon
  //     goes missing at runtime, not at build time.
  //
  // Interaction with `turbopack.root` below: the trace is rooted at the same
  // directory, so the copied node_modules subtree stays inside this app instead of
  // reaching up into the parent workspace's node_modules.
  output: "standalone",

  // Next 16 defaults to Turbopack and walks upward looking for a lockfile to
  // infer the workspace root. This project sits at projects/manhour-mgmt/app
  // under a parent directory that also carries a package-lock.json, so the
  // inferred root landed outside the git repository and page resolution broke
  // ("Cannot find module for page: /"). Pinning the root to this directory is
  // the documented fix and keeps module resolution anchored to the app.
  turbopack: {
    root: projectRoot,
  },

  // better-sqlite3 loads a .node addon through the `bindings` package, which
  // resolves the addon path by reading the caller's filename off the stack
  // (Error.prepareStackTrace). A bundler rewrites those frames to internal
  // scheme URLs, getFileName() comes back undefined, and the connection dies on
  // `undefined.indexOf` before any query runs - a failure invisible to both
  // `tsc --noEmit` and `next build`, because it only happens when a request
  // actually opens the database.
  //
  // Listing the adapter alongside better-sqlite3 keeps the pair on the same
  // side of the bundling boundary; excluding only the leaf still leaves the
  // adapter holding a bundled copy of it.
  //
  // Renamed in Next 16: this was `experimental.serverComponentsExternalPackages`
  // and is now a top-level `serverExternalPackages`. The old key is rejected as
  // an unrecognised experimental option, so the externalisation silently stops
  // applying if it is left in place.
  serverExternalPackages: [
    "better-sqlite3",
    "@prisma/adapter-better-sqlite3",
    // xlsx needs no such workaround - it is pure JS - but it is 7.8MB and only
    // ever runs in the import Server Action, so bundling it would inflate the
    // server output for nothing. Externalising also keeps its conditional
    // `require("fs")` out of the bundler's path.
    "xlsx",
  ],

  // Server Actions cap request bodies at 1MB by default, which is below what this app
  // actually posts. One daily attendance export is ~450KB, Monday carries the weekend
  // backlog (3 files is routine), and D-159 has the client send the same bytes twice -
  // once to preview, once to commit - because caching parsed rows server-side would
  // decouple "the bytes the admin approved" from "the rows that got written".
  //
  // This is the transport ceiling only. The real limits are enforced in
  // lib/attendance/upload-guard.ts (4MB per file, 12MB per batch, 10 files), where a
  // rejection can name the offending file instead of failing the whole POST with an
  // opaque 413. Headroom here is deliberate so that HR adding people or columns raises
  // a readable guard error rather than a framework-level one.
  experimental: {
    serverActions: {
      bodySizeLimit: "16mb",
    },
  },
};

export default nextConfig;
