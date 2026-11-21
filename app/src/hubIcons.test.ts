import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// `@atlaskit/icon/core/*` is CommonJS. Vite hands the component back wrapped in the module object, so the first render of
// an icon throws "Element type is invalid" and blanks the whole app (seen on the Timeline tab after adding leave).
describe('hub source', () => {
  it('does not import Atlaskit icon entry points', () => {
    const dir = join(__dirname, '../static/hub/src');
    const hits = readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => /from\s+['"]@atlaskit\/icon\//.test(readFileSync(join(dir, f), 'utf8')));
    expect(hits).toEqual([]);
  });
});
