import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  dts: true,
  clean: true,
  // `ai` is a peerDependency, so it must never be bundled: a copy compiled into
  // dist would be a SECOND AI SDK instance in the user's process, and the tool
  // objects it produced would not be the ones their `generateText` recognises.
  external: ['ai', 'zod', 'livetennisapi'],
});
