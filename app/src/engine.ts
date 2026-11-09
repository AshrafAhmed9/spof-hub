// Single import point for the pure engine.
// Choice: import by relative path and let Forge's bundler pull it in (no build step).
// UNVERIFIED on a real `forge deploy`: if the bundler refuses files outside app/, run
// `npm run vendor-engine`, which copies ../engine/src to src/vendor/engine and rewrites this line.
export * from '../../engine/src/index';
